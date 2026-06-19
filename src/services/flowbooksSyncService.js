const db = require('../models');
const flowbooksService = require('./flowbooksService');
const invoiceService = require('./invoiceService');
const { AppError } = require('../utils/errors');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function pickDate(inv, ...keys) {
  for (const k of keys) {
    if (inv[k]) return String(inv[k]).slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve a customer TIN from the invoice, the FlowBooks customer map, or the
 * per-connection override table stored in config.tinOverrides.
 */
function resolveCustomerTin(invoice, customerId, customerMap = {}, tinOverrides = {}) {
  const direct = invoice.customerTin || invoice.taxId || invoice.tin || '';
  if (direct) return String(direct).trim();
  const fromMap = customerId ? customerMap[String(customerId)]?.tin : null;
  if (fromMap) return String(fromMap).trim();
  const override = customerId ? tinOverrides[String(customerId)] : null;
  return override ? String(override).trim() : '';
}

/**
 * Transform a FlowBooks invoice (+ optional customer map) into Taxora's
 * canonical "raw" shape. Amounts are recomputed downstream by nrsInvoiceBuilder.
 */
function transformFlowbooksInvoice(invoice, { customerMap = {}, tinOverrides = {} } = {}) {
  const customerId = invoice.customerId || invoice.customer?.id || null;
  const customerName =
    invoice.customerName ||
    invoice.customer?.name ||
    (customerId ? customerMap[String(customerId)]?.name : null) ||
    'Unknown Customer';

  const lineSource = invoice.lineItems || invoice.items || invoice.lines || [];

  const lineItems = asArray(lineSource).map((li, idx) => {
    const quantity = Number(li.quantity ?? li.qty) || 1;
    const unitPrice = Number(li.unitPrice ?? li.price ?? li.rate) || 0;
    const taxRate = li.taxRate != null ? Number(li.taxRate) : 7.5;
    const taxable =
      li.taxable === true || li.taxable === 'true' || (li.taxRate != null && Number(li.taxRate) > 0);
    const taxCode = li.taxCode || (taxable ? 'STANDARD_VAT' : 'EXEMPT');
    const name = li.description || li.name || li.itemCode || `Item ${idx + 1}`;
    const amount = li.amount != null ? Number(li.amount) : round2(quantity * unitPrice);
    return {
      lineNo: idx + 1,
      name,
      description: li.description || name,
      sellersItemIdentification: String(li.itemCode || li.itemId || li.id || `ITEM-${idx + 1}`),
      isicCode: li.itemCode || 'SVC-001',
      serviceCategory: 'General Services',
      nrsProductCode: li.itemCode || 'SVC-001',
      quantity,
      unitPrice: unitPrice || (quantity ? amount / quantity : amount),
      discountRate: 0,
      feeRate: 0,
      taxCode,
      taxRate: taxable ? taxRate : 0,
      taxAmount: round2(taxable ? amount * (taxRate / 100) : 0),
    };
  });

  const totalLineAmount = round2(
    lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0)
  );
  const totalTax =
    invoice.taxAmount != null
      ? Number(invoice.taxAmount)
      : round2(lineItems.reduce((sum, li) => sum + li.taxAmount, 0));
  const grandTotal =
    invoice.totalAmount != null
      ? Number(invoice.totalAmount)
      : invoice.total != null
        ? Number(invoice.total)
        : round2(totalLineAmount + totalTax);

  const issueDate = pickDate(invoice, 'issueDate', 'date', 'invoiceDate');
  const dueDate = pickDate(invoice, 'dueDate') || null;
  const docNumber =
    invoice.invoiceNumber || invoice.number || String(invoice.id || '');

  return {
    type: 'B2B',
    currency: invoice.currency || 'NGN',
    issueDate,
    dueDate: dueDate === issueDate ? null : dueDate,
    status: 'issued',
    paymentStatus:
      invoice.paymentStatus === 'PAID' || invoice.status === 'paid' ? 'PAID' : 'PENDING',
    docNumber,
    orderReference: docNumber,
    buyer: {
      customerId,
      name: customerName,
      tin: resolveCustomerTin(invoice, customerId, customerMap, tinOverrides),
      email: invoice.customerEmail || invoice.customer?.email || '',
      phone: invoice.customerPhone || invoice.customer?.phone || null,
    },
    lineItems,
    totals: { totalLineAmount, totalTax, grandTotal },
  };
}

/**
 * Pull invoices from a tenant's connected FlowBooks org, transform each to
 * canonical, and feed them into the shared invoice pipeline. Duplicates are
 * skipped by invoice id (via invoice_ref). First sync uses initialSyncDate;
 * later syncs are incremental from last_sync_at.
 */
async function syncTenant(tenant) {
  const connection = await db.ErpConnection.findOne({
    where: { tenant_id: tenant.id, connector_type: 'flowbooks', status: 'connected' },
  });

  if (!connection) {
    throw new AppError('No connected FlowBooks account', 400, 'FLOWBOOKS_NOT_CONNECTED');
  }

  const cfg = connection.config || {};
  const storedToken = flowbooksService.decodeToken(cfg.token);
  if (!storedToken) {
    throw new AppError(
      'FlowBooks token missing — reconnect required',
      400,
      'FLOWBOOKS_TOKEN_MISSING'
    );
  }

  const token = await flowbooksService.ensureFreshToken(storedToken, async (fresh) => {
    await connection.update({ config: { ...cfg, token: flowbooksService.encodeToken(fresh) } });
  });

  const companyId = cfg.companyId || cfg.company?.companyId || null;
  const sinceIso = connection.last_sync_at
    ? new Date(connection.last_sync_at).toISOString()
    : cfg.initialSyncDate
      ? new Date(cfg.initialSyncDate).toISOString()
      : null;

  let customerMap = {};
  try {
    customerMap = await flowbooksService.fetchCustomers(token, companyId);
  } catch (err) {
    console.error(
      `[flowbooks-sync] tenant=${tenant.id} customer fetch failed (continuing): ${err.message}`
    );
  }

  const tinOverrides = cfg.tinOverrides || {};
  const list = await flowbooksService.fetchInvoices(token, companyId, sinceIso);

  console.log(
    `[flowbooks-sync] tenant=${tenant.id} company=${companyId || 'n/a'} since=${sinceIso || 'beginning'} fetched=${list.length} invoice(s)`
  );

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const summary of list) {
    const fbId = String(summary.id || summary.invoiceNumber || '');
    try {
      const detail =
        (await flowbooksService.fetchInvoiceDetail(token, fbId || summary.id)) || summary;
      const canonical = transformFlowbooksInvoice(detail, { customerMap, tinOverrides });
      await invoiceService.createInvoice(tenant, {
        erp_source: 'flowbooks',
        erp_invoice_id: fbId || canonical.docNumber,
        raw: canonical,
        raw_source: detail,
      });
      created += 1;
      console.log(
        `[flowbooks-sync] ingested FlowBooks invoice id=${fbId} number=${canonical.docNumber || 'n/a'}`
      );
    } catch (err) {
      if (err.code === 'DUPLICATE_INVOICE') {
        skipped += 1;
        console.log(`[flowbooks-sync] skipped duplicate FlowBooks invoice id=${fbId}`);
      } else {
        errors.push({ fbId, error: err.message });
        console.error(`[flowbooks-sync] failed FlowBooks invoice id=${fbId}: ${err.message}`);
      }
    }
  }

  await connection.update({ last_sync_at: new Date(), health_status: 'OK' });

  console.log(
    `[flowbooks-sync] tenant=${tenant.id} done: fetched=${list.length} created=${created} skipped=${skipped} errors=${errors.length}`
  );

  return { fetched: list.length, created, skipped, errors };
}

module.exports = { syncTenant, transformFlowbooksInvoice, resolveCustomerTin };
