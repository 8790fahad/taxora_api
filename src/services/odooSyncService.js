const db = require('../models');
const odooService = require('./odooService');
const invoiceService = require('./invoiceService');
const { AppError } = require('../utils/errors');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Pick the dominant percentage tax on a line. Odoo lines can carry multiple
// taxes; for NRS we use the summed percentage of percent-type sale taxes.
function lineTaxRate(line, taxes) {
  const ids = line.tax_ids || [];
  let rate = 0;
  for (const id of ids) {
    const t = taxes[id];
    if (t && t.amount_type === 'percent') rate += Number(t.amount) || 0;
  }
  return rate;
}

/**
 * Transform an Odoo account.move (+ its lines, partner, taxes) into Taxora's
 * canonical "raw" shape. Amounts are recomputed by nrsInvoiceBuilder downstream
 * so they remain internally consistent.
 */
function transformOdooInvoice(move, detail) {
  const taxes = detail.taxes || {};
  const partner = detail.partner || {};

  const lineItems = (detail.lines || []).map((l, idx) => {
    const quantity = Number(l.quantity) || 1;
    const unitPrice = Number(l.price_unit) || 0;
    const discountRate = Number(l.discount) || 0;
    const taxRate = lineTaxRate(l, taxes) || 0;
    const itemName = l.name || odooService.relName(l.product_id) || `Item ${idx + 1}`;
    const sku = odooService.relName(l.product_id) || `ITEM-${idx + 1}`;
    const subtotal =
      l.price_subtotal != null
        ? Number(l.price_subtotal)
        : round2(quantity * unitPrice * (1 - discountRate / 100));
    return {
      lineNo: idx + 1,
      name: itemName,
      description: itemName,
      sellersItemIdentification: String(odooService.relId(l.product_id) || sku),
      isicCode: 'SVC-001',
      serviceCategory: 'General Services',
      nrsProductCode: 'SVC-001',
      quantity,
      unitPrice,
      discountRate,
      feeRate: 0,
      taxCode: taxRate > 0 ? 'STANDARD_VAT' : 'EXEMPT',
      taxRate,
      taxAmount: round2(subtotal * (taxRate / 100)),
    };
  });

  const totalLineAmount = round2(
    lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice * (1 - li.discountRate / 100), 0)
  );
  const totalTax =
    move.amount_tax != null
      ? Number(move.amount_tax)
      : round2(lineItems.reduce((sum, li) => sum + li.taxAmount, 0));
  const grandTotal =
    move.amount_total != null ? Number(move.amount_total) : round2(totalLineAmount + totalTax);

  const issueDate = move.invoice_date || new Date().toISOString().slice(0, 10);

  return {
    type: 'B2B',
    currency: odooService.relName(move.currency_id) || 'NGN',
    issueDate,
    dueDate: move.invoice_date_due || null,
    status: move.state === 'posted' ? 'issued' : 'draft',
    paymentStatus: move.payment_state === 'paid' ? 'PAID' : 'PENDING',
    docNumber: move.name || String(move.id),
    orderReference: move.name || String(move.id),
    buyer: {
      customerId: odooService.relId(move.partner_id),
      name: partner.name || odooService.relName(move.partner_id) || 'Unknown Customer',
      tin: partner.vat || '',
      email: partner.email || '',
      phone: partner.phone || null,
      address: partner.street
        ? {
            line: [partner.street, partner.street2].filter(Boolean).join(', ') || null,
            city: partner.city || null,
            country: odooService.relName(partner.country_id) || 'NG',
            postalZone: partner.zip || null,
          }
        : undefined,
    },
    lineItems,
    totals: { totalLineAmount, totalTax, grandTotal },
  };
}

/**
 * Pull invoices from a tenant's connected Odoo instance, transform each to the
 * canonical format, and feed them into the shared invoice pipeline. Duplicates
 * are skipped. The first sync uses the go-live date (initialSyncDate); later
 * syncs are incremental from last_sync_at.
 */
async function syncTenant(tenant) {
  const connection = await db.ErpConnection.findOne({
    where: { tenant_id: tenant.id, connector_type: 'odoo', status: 'connected' },
  });

  if (!connection) {
    throw new AppError('No connected Odoo account', 400, 'ODOO_NOT_CONNECTED');
  }

  const cfg = connection.config || {};
  const creds = odooService.decodeCredentials(cfg.credentials);
  if (!creds) {
    throw new AppError('Odoo credentials missing — reconnect required', 400, 'ODOO_CREDS_MISSING');
  }

  let uid;
  try {
    uid = await odooService.authenticate(creds);
  } catch (err) {
    await connection.update({ health_status: 'AUTH_FAILED' });
    throw new AppError(
      err.message || 'Odoo authentication failed',
      401,
      err.code || 'ODOO_AUTH_FAILED'
    );
  }

  const sinceIso = connection.last_sync_at
    ? new Date(connection.last_sync_at).toISOString()
    : cfg.initialSyncDate
      ? new Date(cfg.initialSyncDate).toISOString()
      : null;

  const moves = await odooService.fetchInvoices(creds, uid, sinceIso);

  console.log(
    `[odoo-sync] tenant=${tenant.id} db=${creds.database} since=${sinceIso || 'beginning'} fetched=${moves.length} invoice(s)`
  );

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const move of moves) {
    try {
      const detail = await odooService.fetchInvoiceDetail(creds, uid, move);
      const canonical = transformOdooInvoice(move, detail);
      await invoiceService.createInvoice(tenant, {
        erp_source: 'odoo',
        erp_invoice_id: String(move.id),
        raw: canonical,
        raw_source: { move, detail },
      });
      created += 1;
      console.log(
        `[odoo-sync] ingested Odoo invoice id=${move.id} name=${move.name || 'n/a'}`
      );
    } catch (err) {
      if (err.code === 'DUPLICATE_INVOICE') {
        skipped += 1;
        console.log(`[odoo-sync] skipped duplicate Odoo invoice id=${move.id}`);
      } else {
        errors.push({ odooId: move.id, error: err.message });
        console.error(`[odoo-sync] failed Odoo invoice id=${move.id}: ${err.message}`);
      }
    }
  }

  await connection.update({ last_sync_at: new Date(), health_status: 'OK' });

  console.log(
    `[odoo-sync] tenant=${tenant.id} done: fetched=${moves.length} created=${created} skipped=${skipped} errors=${errors.length}`
  );

  return { fetched: moves.length, created, skipped, errors };
}

module.exports = { syncTenant, transformOdooInvoice };
