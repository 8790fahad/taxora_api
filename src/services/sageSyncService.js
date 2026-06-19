const db = require('../models');
const sageService = require('./sageService');
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
 * Resolve a customer TIN from the invoice, the Sage customer map, or the
 * per-connection override table stored in config.tinOverrides.
 */
function resolveCustomerTin(invoice, customerId, customerMap = {}, tinOverrides = {}) {
  const direct = invoice.TAXID || invoice.taxId || invoice.VATREGNO || '';
  if (direct) return String(direct).trim();
  const fromMap = customerId ? customerMap[String(customerId)]?.tin : null;
  if (fromMap) return String(fromMap).trim();
  const override = customerId ? tinOverrides[String(customerId)] : null;
  return override ? String(override).trim() : '';
}

/**
 * Transform a Sage AR invoice (+ optional customer map) into Taxora's canonical
 * "raw" shape. Amounts are recomputed downstream by nrsInvoiceBuilder.
 */
function transformSageInvoice(invoice, { customerMap = {}, tinOverrides = {} } = {}) {
  const customerId = invoice.CUSTOMERID || invoice.customerId || invoice.CUSTOMER?.id || null;
  const customerName =
    invoice.CUSTOMERNAME ||
    invoice.customerName ||
    (customerId ? customerMap[String(customerId)]?.name : null) ||
    'Unknown Customer';

  const lineSource =
    invoice.ARINVOICEITEMS ||
    invoice.lineItems ||
    invoice.items ||
    invoice.ARINVOICELINES ||
    [];

  const lineItems = asArray(lineSource).map((li, idx) => {
    const quantity = Number(li.QUANTITY ?? li.quantity) || 1;
    const unitPrice = Number(li.PRICE ?? li.unitPrice ?? li.rate) || 0;
    const taxRate = li.TAXRATE != null ? Number(li.TAXRATE) : li.taxRate != null ? Number(li.taxRate) : 7.5;
    const taxable = li.TAXABLE === true || li.TAXABLE === 'true' || li.taxable === true;
    const taxCode = li.TAXCODE || li.taxCode || (taxable ? 'STANDARD_VAT' : 'EXEMPT');
    const name = li.MEMO || li.description || li.ITEMID || li.itemCode || `Item ${idx + 1}`;
    const amount =
      li.AMOUNT != null
        ? Number(li.AMOUNT)
        : round2(quantity * unitPrice);
    return {
      lineNo: idx + 1,
      name,
      description: li.MEMO || li.description || name,
      sellersItemIdentification: String(li.ITEMID || li.itemCode || li.itemId || `ITEM-${idx + 1}`),
      isicCode: li.ITEMID || 'SVC-001',
      serviceCategory: 'General Services',
      nrsProductCode: li.ITEMID || 'SVC-001',
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
    invoice.TRX_TOTALTAX != null
      ? Number(invoice.TRX_TOTALTAX)
      : invoice.taxAmount != null
        ? Number(invoice.taxAmount)
        : round2(lineItems.reduce((sum, li) => sum + li.taxAmount, 0));
  const grandTotal =
    invoice.TOTAL != null
      ? Number(invoice.TOTAL)
      : invoice.totalAmount != null
        ? Number(invoice.totalAmount)
        : round2(totalLineAmount + totalTax);

  const issueDate = pickDate(invoice, 'WHENCREATED', 'whenCreated', 'issueDate', 'date');
  const dueDate = pickDate(invoice, 'WHENDUE', 'whenDue', 'dueDate') || null;

  return {
    type: 'B2B',
    currency: invoice.CURRENCY || invoice.currency || 'NGN',
    issueDate,
    dueDate: dueDate === issueDate ? null : dueDate,
    status: 'issued',
    paymentStatus: invoice.STATE === 'Paid' || invoice.paymentStatus === 'PAID' ? 'PAID' : 'PENDING',
    docNumber: invoice.DOCNUMBER || invoice.invoiceNumber || String(invoice.RECORDNO || invoice.id),
    orderReference: invoice.DOCNUMBER || invoice.invoiceNumber || String(invoice.RECORDNO || invoice.id),
    buyer: {
      customerId,
      name: customerName,
      tin: resolveCustomerTin(invoice, customerId, customerMap, tinOverrides),
      email: invoice.EMAIL1 || invoice.email || '',
      phone: invoice.PHONE1 || invoice.phone || null,
    },
    lineItems,
    totals: { totalLineAmount, totalTax, grandTotal },
  };
}

/**
 * Pull AR invoices from a tenant's connected Sage company, transform each to
 * canonical, and feed them into the shared invoice pipeline. Duplicates are
 * skipped by invoice id (via invoice_ref). First sync uses initialSyncDate;
 * later syncs are incremental from last_sync_at.
 */
async function syncTenant(tenant) {
  const connection = await db.ErpConnection.findOne({
    where: { tenant_id: tenant.id, connector_type: 'sage', status: 'connected' },
  });

  if (!connection) {
    throw new AppError('No connected Sage account', 400, 'SAGE_NOT_CONNECTED');
  }

  const cfg = connection.config || {};
  const storedToken = sageService.decodeToken(cfg.token);
  if (!storedToken) {
    throw new AppError('Sage token missing — reconnect required', 400, 'SAGE_TOKEN_MISSING');
  }

  const token = await sageService.ensureFreshToken(storedToken, async (fresh) => {
    await connection.update({ config: { ...cfg, token: sageService.encodeToken(fresh) } });
  });

  const companyId = cfg.companyId || cfg.company?.companyId || null;
  const sinceIso = connection.last_sync_at
    ? new Date(connection.last_sync_at).toISOString()
    : cfg.initialSyncDate
      ? new Date(cfg.initialSyncDate).toISOString()
      : null;

  let customerMap = {};
  try {
    customerMap = await sageService.fetchCustomers(token, companyId);
  } catch (err) {
    console.error(`[sage-sync] tenant=${tenant.id} customer fetch failed (continuing): ${err.message}`);
  }

  const tinOverrides = cfg.tinOverrides || {};
  const list = await sageService.fetchInvoices(token, companyId, sinceIso);

  console.log(
    `[sage-sync] tenant=${tenant.id} company=${companyId || 'n/a'} since=${sinceIso || 'beginning'} fetched=${list.length} invoice(s)`
  );

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const summary of list) {
    const sageId = String(summary.RECORDNO || summary.id || summary.DOCNUMBER || '');
    try {
      const detail =
        (await sageService.fetchInvoiceDetail(token, sageId || summary.RECORDNO || summary.id)) ||
        summary;
      const canonical = transformSageInvoice(detail, { customerMap, tinOverrides });
      await invoiceService.createInvoice(tenant, {
        erp_source: 'sage',
        erp_invoice_id: sageId || canonical.docNumber,
        raw: canonical,
        raw_source: detail,
      });
      created += 1;
      console.log(
        `[sage-sync] ingested Sage invoice id=${sageId} number=${canonical.docNumber || 'n/a'}`
      );
    } catch (err) {
      if (err.code === 'DUPLICATE_INVOICE') {
        skipped += 1;
        console.log(`[sage-sync] skipped duplicate Sage invoice id=${sageId}`);
      } else {
        errors.push({ sageId, error: err.message });
        console.error(`[sage-sync] failed Sage invoice id=${sageId}: ${err.message}`);
      }
    }
  }

  await connection.update({ last_sync_at: new Date(), health_status: 'OK' });

  console.log(
    `[sage-sync] tenant=${tenant.id} done: fetched=${list.length} created=${created} skipped=${skipped} errors=${errors.length}`
  );

  return { fetched: list.length, created, skipped, errors };
}

module.exports = { syncTenant, transformSageInvoice, resolveCustomerTin };
