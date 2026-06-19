const { Op } = require('sequelize');
const db = require('../models');
const { buildInvoiceRef } = require('../utils/invoiceRef');
const { AppError } = require('../utils/errors');
const { getInvoiceQueue } = require('../jobs/queue');
const { formatTenantAddress } = require('../utils/address');

async function appendEvent(invoiceId, eventType, payload = {}, transaction) {
  return db.InvoiceEvent.create(
    { invoice_id: invoiceId, event_type: eventType, payload },
    { transaction }
  );
}

function buildDefaultCanonical(tenant, erpSource, erpInvoiceId, raw = {}) {
  return {
    source: { erp: erpSource, erpInvoiceId },
    tenantId: tenant.id,
    invoiceRef: buildInvoiceRef(tenant.id, erpSource, erpInvoiceId),
    type: raw.type || 'B2B',
    currency: raw.currency || 'NGN',
    issueDate: raw.issueDate || new Date().toISOString().slice(0, 10),
    seller: {
      tin: tenant.tin,
      name: tenant.legal_name,
      address: formatTenantAddress(tenant),
    },
    buyer: raw.buyer || {
      tin: '12345678-0001',
      name: 'Demo Buyer Ltd',
      email: 'buyer@example.com',
    },
    lineItems: raw.lineItems || [
      {
        lineNo: 1,
        quantity: 10,
        unitPrice: 1000,
        nrsProductCode: 'SVC-001',
        taxRate: 7.5,
        taxAmount: 750,
      },
    ],
    totals: raw.totals || {
      totalLineAmount: 10000,
      totalTax: 750,
      grandTotal: 10750,
    },
  };
}

async function createInvoice(tenant, body) {
  const erpSource = body.erp_source || body.source?.erp;
  const erpInvoiceId = body.erp_invoice_id || body.source?.erpInvoiceId;

  if (!erpSource || !erpInvoiceId) {
    throw new AppError('erp_source and erp_invoice_id are required', 400, 'INVALID_PAYLOAD');
  }

  const invoiceRef = buildInvoiceRef(tenant.id, erpSource, erpInvoiceId);
  const existing = await db.Invoice.findOne({ where: { invoice_ref: invoiceRef } });
  if (existing) {
    throw new AppError('Invoice already exists for this ERP reference', 409, 'DUPLICATE_INVOICE');
  }

  const canonical =
    body.canonical_json ||
    body.raw ||
    buildDefaultCanonical(tenant, erpSource, erpInvoiceId, body.raw || body);

  canonical.invoiceRef = invoiceRef;
  canonical.tenantId = tenant.id;

  // The untransformed payload exactly as it came from the ERP (e.g. raw
  // QuickBooks invoice JSON), kept for audit so we can compare what we received
  // against what we formatted and transmitted.
  const rawSource = body.raw_source || null;

  const invoice = await db.sequelize.transaction(async (transaction) => {
    const created = await db.Invoice.create(
      {
        tenant_id: tenant.id,
        invoice_ref: invoiceRef,
        erp_source: erpSource,
        erp_invoice_id: erpInvoiceId,
        status: 'RECEIVED',
        canonical_json: canonical,
      },
      { transaction }
    );

    await appendEvent(
      created.id,
      'RECEIVED',
      { erpSource, erpInvoiceId, invoiceRef },
      transaction
    );

    // Record the fetch + format step so the original ERP payload and the
    // canonical document we derived are both visible in the invoice timeline.
    await appendEvent(
      created.id,
      'INGESTED',
      { erpSource, erpInvoiceId, rawSource, canonical },
      transaction
    );

    return created;
  });

  console.log(
    `[invoice] received ${invoiceRef} from ${erpSource} (erpId=${erpInvoiceId}) → queued for processing`
  );

  const queue = getInvoiceQueue();
  await queue.add('process-invoice', { invoiceId: invoice.id });

  return invoice;
}

async function retryInvoice(tenant, invoiceId) {
  const invoice = await db.Invoice.findOne({
    where: { id: invoiceId, tenant_id: tenant.id },
  });

  if (!invoice) {
    throw new AppError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  }

  if (!['REJECTED', 'VALIDATION_FAILED'].includes(invoice.status)) {
    throw new AppError('Only rejected or failed invoices can be retried', 400, 'INVALID_STATUS');
  }

  await invoice.update({
    status: 'RECEIVED',
    error_message: null,
  });

  await appendEvent(invoice.id, 'RETRY_REQUESTED', {});

  const queue = getInvoiceQueue();
  await queue.add('process-invoice', { invoiceId: invoice.id });

  return invoice;
}

async function getInvoiceDetail(tenant, invoiceId) {
  const invoice = await db.Invoice.findOne({
    where: { id: invoiceId, tenant_id: tenant.id },
    include: [
      {
        model: db.InvoiceEvent,
        separate: true,
        order: [['created_at', 'ASC']],
      },
      {
        model: db.SubmissionAttempt,
        separate: true,
        order: [['attempt_no', 'ASC']],
      },
    ],
  });

  if (!invoice) {
    throw new AppError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  }

  return invoice;
}

async function listInvoices(tenant, { page = 1, limit = 20, status } = {}) {
  const where = { tenant_id: tenant.id };
  if (status) where.status = status;

  const offset = (page - 1) * limit;

  const { rows, count } = await db.Invoice.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    data: rows,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil(count / limit),
    },
  };
}

async function getDashboardStats(tenant) {
  const statuses = ['RECEIVED', 'VALIDATING', 'QUEUED', 'SUBMITTED', 'PENDING_CLEARANCE'];
  const pending = await db.Invoice.count({
    where: { tenant_id: tenant.id, status: statuses },
  });
  const cleared = await db.Invoice.count({
    where: { tenant_id: tenant.id, status: 'CLEARED' },
  });
  const rejected = await db.Invoice.count({
    where: {
      tenant_id: tenant.id,
      status: { [Op.in]: ['REJECTED', 'VALIDATION_FAILED'] },
    },
  });

  const recent = await db.Invoice.findAll({
    where: { tenant_id: tenant.id },
    order: [['created_at', 'DESC']],
    limit: 5,
  });

  return { pending, cleared, rejected, recent };
}

module.exports = {
  appendEvent,
  createInvoice,
  retryInvoice,
  getInvoiceDetail,
  listInvoices,
  getDashboardStats,
  buildDefaultCanonical,
};
