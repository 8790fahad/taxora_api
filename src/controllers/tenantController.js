const db = require('../models');
const onboardingService = require('../services/onboardingService');
const { AppError } = require('../utils/errors');
const { formatTenantAddress } = require('../utils/address');

async function updateCurrentTenant(req, res, next) {
  try {
    const tenant = await onboardingService.updateTenantRegistration(req.tenant, req.body);
    res.json({ tenant: formatTenant(tenant) });
  } catch (err) {
    if (err.code === 'INVALID_TIN') {
      err.statusCode = 400;
    }
    next(err);
  }
}

async function getOnboarding(req, res, next) {
  try {
    const connections = await db.ErpConnection.findAll({ where: { tenant_id: req.tenantId } });
    const subscription = await db.Subscription.findOne({
      where: { tenant_id: req.tenantId, status: 'active' },
      order: [['created_at', 'DESC']],
    });

    const status = onboardingService.getOnboardingStatus(req.tenant, connections, subscription);
    res.json(status);
  } catch (err) {
    next(err);
  }
}

function formatTenant(tenant) {
  return {
    id: tenant.id,
    legal_name: tenant.legal_name,
    tin: tenant.tin,
    rc_number: tenant.rc_number,
    primary_phone: tenant.primary_phone,
    state: tenant.state,
    company_classification: tenant.company_classification,
    incorporation_date: tenant.incorporation_date,
    address: formatTenantAddress(tenant),
    nrs_business_id: tenant.nrs_business_id,
    nrs_service_id: tenant.nrs_service_id,
    logo_url: tenant.logo_url,
    logo_width: tenant.logo_width,
    logo_height: tenant.logo_height,
    status: tenant.status,
    onboarding: tenant.onboarding,
  };
}

module.exports = { updateCurrentTenant, getOnboarding };
