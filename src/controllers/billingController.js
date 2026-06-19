const db = require('../models');
const config = require('../config');
const onboardingService = require('../services/onboardingService');
const invoiceService = require('../services/invoiceService');
const remitaPaymentService = require('../services/remitaPaymentService');
const { AppError } = require('../utils/errors');

async function listPlans(req, res, next) {
  try {
    const plans = await db.Plan.findAll({ order: [['price_ngn', 'ASC']] });
    res.json({ data: plans });
  } catch (err) {
    next(err);
  }
}

// Step 1: create a pending subscription and generate a Remita RRR for payment.
async function checkout(req, res, next) {
  try {
    const { plan_code } = req.body;
    if (!plan_code) {
      throw new AppError('plan_code is required', 400, 'VALIDATION_ERROR');
    }

    const plan = await db.Plan.findOne({ where: { code: plan_code } });
    if (!plan) {
      throw new AppError('Plan not found', 404, 'PLAN_NOT_FOUND');
    }

    // Determine how much to collect via Remita:
    //  - per_invoice: a wallet top-up (>= minimum funding) drawn down per invoice
    //  - flat: the fixed plan price
    let chargeAmount;
    let description;
    if (plan.billing_type === 'per_invoice') {
      const fundAmount = parseInt(req.body.fund_amount, 10);
      if (!Number.isFinite(fundAmount) || fundAmount < config.perInvoiceMinFundingNgn) {
        throw new AppError(
          `Minimum wallet funding is ₦${config.perInvoiceMinFundingNgn.toLocaleString()}`,
          400,
          'MIN_FUNDING'
        );
      }
      chargeAmount = fundAmount;
      description = `Taxora wallet funding (₦${config.perInvoiceRateNgn}/invoice)`;
    } else {
      chargeAmount = plan.price_ngn;
      description = `Taxora ${plan.name} subscription`;
    }

    const payment = await remitaPaymentService.initPayment({
      amount: chargeAmount,
      payerName: req.tenant.legal_name || req.user.full_name || 'Taxora Customer',
      payerEmail: req.user.email,
      payerPhone: req.tenant.primary_phone || '',
      description,
    });

    const subscription = await db.Subscription.create({
      tenant_id: req.tenantId,
      plan_id: plan.id,
      status: 'pending',
      amount_ngn: chargeAmount,
      paystack_reference: payment.rrr,
    });

    res.json({
      subscription,
      plan,
      payment: {
        requiresPayment: true,
        rrr: payment.rrr,
        orderId: payment.orderId,
        mock: !!payment.mock,
        merchantId: config.remitaMerchantId,
        publicKey: config.remitaPublicKey,
        inlineScript: config.remitaInlineScript,
        amount: chargeAmount,
      },
      message: payment.mock
        ? 'Mock payment created — confirm to activate.'
        : 'Remita payment initialized.',
    });
  } catch (err) {
    next(err);
  }
}

// Step 2: verify the Remita payment, then activate the subscription + tenant.
async function verifyPayment(req, res, next) {
  try {
    const { rrr } = req.body;
    if (!rrr) {
      throw new AppError('rrr is required', 400, 'VALIDATION_ERROR');
    }

    const subscription = await db.Subscription.findOne({
      where: { tenant_id: req.tenantId, paystack_reference: rrr },
      order: [['created_at', 'DESC']],
    });
    if (!subscription) {
      throw new AppError('Payment reference not found', 404, 'PAYMENT_NOT_FOUND');
    }

    if (subscription.status === 'active') {
      return res.json({
        subscription,
        tenant: {
          id: req.tenant.id,
          status: req.tenant.status,
          onboarding: req.tenant.onboarding,
        },
        message: 'Subscription already active.',
      });
    }

    const result = await remitaPaymentService.verifyPayment(rrr);
    if (!result.paid) {
      throw new AppError(
        'Payment not completed yet. Please finish the Remita payment.',
        402,
        'PAYMENT_PENDING'
      );
    }

    const plan = await db.Plan.findByPk(subscription.plan_id);
    const isPerInvoice = plan && plan.billing_type === 'per_invoice';

    // Credit the prepaid wallet for pay-as-you-go funding.
    if (isPerInvoice && subscription.amount_ngn > 0) {
      await req.tenant.increment('wallet_balance_ngn', { by: subscription.amount_ngn });
    }

    const activeUntil = new Date();
    if (plan && plan.billing_period === 'year') {
      activeUntil.setFullYear(activeUntil.getFullYear() + 1);
    } else {
      activeUntil.setMonth(activeUntil.getMonth() + 1);
    }
    await subscription.update({ status: 'active', active_until: activeUntil });

    await onboardingService.markSubscribed(req.tenant);
    await req.tenant.reload();

    res.json({
      subscription,
      tenant: {
        id: req.tenant.id,
        status: req.tenant.status,
        onboarding: req.tenant.onboarding,
        wallet_balance_ngn: req.tenant.wallet_balance_ngn,
      },
      message: isPerInvoice
        ? `Wallet funded with ₦${subscription.amount_ngn.toLocaleString()}. You're live!`
        : 'Payment confirmed. Subscription activated!',
    });
  } catch (err) {
    next(err);
  }
}

async function getCurrentBilling(req, res, next) {
  try {
    const subscription = await db.Subscription.findOne({
      where: { tenant_id: req.tenantId, status: 'active' },
      include: [{ model: db.Plan }],
      order: [['created_at', 'DESC']],
    });

    const plans = await db.Plan.findAll({ order: [['price_ngn', 'ASC']] });

    res.json({
      subscription,
      plans,
      wallet: {
        balance_ngn: Number(req.tenant.wallet_balance_ngn || 0),
        per_invoice_rate_ngn: config.perInvoiceRateNgn,
        min_funding_ngn: config.perInvoiceMinFundingNgn,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getDashboard(req, res, next) {
  try {
    const stats = await invoiceService.getDashboardStats(req.tenant);
    res.json({
      tenant: {
        id: req.tenant.id,
        status: req.tenant.status,
        onboarding: req.tenant.onboarding,
      },
      stats: {
        pending: stats.pending,
        cleared: stats.cleared,
        rejected: stats.rejected,
      },
      recentInvoices: stats.recent,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPlans, checkout, verifyPayment, getCurrentBilling, getDashboard };
