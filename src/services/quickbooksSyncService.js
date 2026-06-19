const db = require('../models');
const quickbooksService = require('./quickbooksService');
const invoiceService = require('./invoiceService');
const { AppError } = require('../utils/errors');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Map a raw QuickBooks invoice into Taxora's canonical "raw" shape. The canonical
// carries everything the NRS builder needs (names, classification codes, per-line
// discount/fee rates, dates); amounts are recomputed by nrsInvoiceBuilder so they
// stay internally consistent.
function transformQbInvoice(qb) {
  const lineItems = (qb.Line || [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l, idx) => {
      const detail = l.SalesItemLineDetail || {};
      const quantity = detail.Qty || 1;
      const unitPrice = detail.UnitPrice != null ? detail.UnitPrice : l.Amount;
      const taxRate = 7.5;
      const itemName = detail.ItemRef?.name || l.Description || `Item ${idx + 1}`;
      return {
        lineNo: idx + 1,
        name: itemName,
        description: l.Description || itemName,
        sellersItemIdentification: detail.ItemRef?.value || `ITEM-${idx + 1}`,
        // QuickBooks does not distinguish goods vs services on the line, so we
        // classify as a service by default; this can be overridden per item later.
        isicCode: detail.ItemRef?.value || 'SVC-001',
        serviceCategory: 'General Services',
        nrsProductCode: detail.ItemRef?.value || 'SVC-001',
        quantity,
        unitPrice,
        discountRate: 0,
        feeRate: 0,
        taxCode: 'STANDARD_VAT',
        taxRate,
        taxAmount: round2(quantity * unitPrice * (taxRate / 100)),
      };
    });

  const totalLineAmount = round2(
    lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0)
  );
  const totalTax = round2(lineItems.reduce((sum, li) => sum + li.taxAmount, 0));

  const issueDate = qb.TxnDate || new Date().toISOString().slice(0, 10);

  return {
    type: 'B2B',
    currency: qb.CurrencyRef?.value || 'NGN',
    issueDate,
    dueDate: qb.DueDate || null,
    status: 'issued',
    paymentStatus: qb.Balance === 0 ? 'PAID' : 'PENDING',
    docNumber: qb.DocNumber || String(qb.Id),
    orderReference: qb.DocNumber || String(qb.Id),
    buyer: {
      customerId: qb.CustomerRef?.value || null,
      name: qb.CustomerRef?.name || 'Unknown Customer',
      tin: qb.CustomerRef?.value || '',
      email: qb.BillEmail?.Address || '',
      phone: qb.BillAddr?.Phone || null,
      address: qb.BillAddr
        ? {
            line: [qb.BillAddr.Line1, qb.BillAddr.Line2].filter(Boolean).join(', ') || null,
            city: qb.BillAddr.City || null,
            country: qb.BillAddr.Country || 'NG',
            postalZone: qb.BillAddr.PostalCode || null,
          }
        : undefined,
    },
    lineItems,
    totals: {
      totalLineAmount,
      totalTax,
      grandTotal: qb.TotalAmt != null ? qb.TotalAmt : round2(totalLineAmount + totalTax),
    },
  };
}

/**
 * Pull invoices from a tenant's connected QuickBooks, transform each to the
 * canonical format, and feed them into the existing invoice pipeline
 * (validate -> queue -> transmit to NRS). Duplicates are skipped.
 */
async function syncTenant(tenant) {
  const connection = await db.ErpConnection.findOne({
    where: { tenant_id: tenant.id, connector_type: 'quickbooks', status: 'connected' },
  });

  if (!connection) {
    throw new AppError('No connected QuickBooks account', 400, 'QB_NOT_CONNECTED');
  }

  const cfg = connection.config || {};
  const storedToken = quickbooksService.decodeToken(cfg.token);
  const realmId = cfg.realmId;
  if (!storedToken) {
    throw new AppError('QuickBooks token missing — reconnect required', 400, 'QB_TOKEN_MISSING');
  }

  // Refresh the token if needed, persisting the new (encrypted) token back.
  const token = await quickbooksService.ensureFreshToken(storedToken, async (fresh) => {
    await connection.update({
      config: { ...cfg, token: quickbooksService.encodeToken(fresh) },
    });
  });

  // Cursor: after the first sync use last_sync_at; on the first sync use the
  // business-provided go-live date (initialSyncDate) so only invoices from that
  // date onward are pulled.
  const sinceIso = connection.last_sync_at
    ? new Date(connection.last_sync_at).toISOString()
    : cfg.initialSyncDate
      ? new Date(cfg.initialSyncDate).toISOString()
      : null;

  const qbInvoices = await quickbooksService.fetchInvoices(token, realmId, sinceIso);

  console.log(
    `[qb-sync] tenant=${tenant.id} realm=${realmId} since=${sinceIso || 'beginning'} fetched=${qbInvoices.length} invoice(s)`
  );

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const qb of qbInvoices) {
    try {
      const canonical = transformQbInvoice(qb);
      await invoiceService.createInvoice(tenant, {
        erp_source: 'quickbooks',
        erp_invoice_id: String(qb.Id),
        raw: canonical,
        // Keep the original QuickBooks payload for the audit trail.
        raw_source: qb,
      });
      created += 1;
      console.log(
        `[qb-sync] ingested QB invoice Id=${qb.Id} DocNumber=${qb.DocNumber || 'n/a'} total=${qb.TotalAmt}`
      );
    } catch (err) {
      if (err.code === 'DUPLICATE_INVOICE') {
        skipped += 1;
        console.log(`[qb-sync] skipped duplicate QB invoice Id=${qb.Id}`);
      } else {
        errors.push({ qbId: qb.Id, error: err.message });
        console.error(`[qb-sync] failed QB invoice Id=${qb.Id}: ${err.message}`);
      }
    }
  }

  await connection.update({ last_sync_at: new Date(), health_status: 'OK' });

  console.log(
    `[qb-sync] tenant=${tenant.id} done: fetched=${qbInvoices.length} created=${created} skipped=${skipped} errors=${errors.length}`
  );

  return { fetched: qbInvoices.length, created, skipped, errors };
}

module.exports = { syncTenant, transformQbInvoice };
