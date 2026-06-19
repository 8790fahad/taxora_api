const db = require('../models');
const zohoService = require('./zohoService');
const invoiceService = require('./invoiceService');
const { AppError } = require('../utils/errors');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Map a Zoho Books invoice into Taxora's canonical "raw" shape. Amounts are
// recomputed downstream by nrsInvoiceBuilder so they stay consistent.
function transformZohoInvoice(zi) {
  const lineItems = (zi.line_items || []).map((li, idx) => {
    const quantity = Number(li.quantity) || 1;
    const unitPrice = li.rate != null ? Number(li.rate) : Number(li.item_total) || 0;
    const taxRate = li.tax_percentage != null ? Number(li.tax_percentage) : 7.5;
    const itemName = li.name || li.description || `Item ${idx + 1}`;
    return {
      lineNo: idx + 1,
      name: itemName,
      description: li.description || itemName,
      sellersItemIdentification: li.item_id || li.line_item_id || `ITEM-${idx + 1}`,
      isicCode: li.hsn_or_sac || 'SVC-001',
      serviceCategory: 'General Services',
      nrsProductCode: li.hsn_or_sac || 'SVC-001',
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
  const issueDate = zi.date || new Date().toISOString().slice(0, 10);

  return {
    type: 'B2B',
    currency: zi.currency_code || 'NGN',
    issueDate,
    dueDate: zi.due_date || null,
    status: 'issued',
    paymentStatus: zi.status === 'paid' ? 'PAID' : 'PENDING',
    docNumber: zi.invoice_number || String(zi.invoice_id),
    orderReference: zi.reference_number || zi.invoice_number || String(zi.invoice_id),
    buyer: {
      customerId: zi.customer_id || null,
      name: zi.customer_name || 'Unknown Customer',
      tin: zi.cf_tin || zi.tax_reg_no || '',
      email: zi.email || zi.contact_persons?.[0]?.email || '',
      phone: zi.phone || null,
      address: zi.billing_address
        ? {
            line: [zi.billing_address.address, zi.billing_address.street2]
              .filter(Boolean)
              .join(', ') || null,
            city: zi.billing_address.city || null,
            country: zi.billing_address.country_code || 'NG',
            postalZone: zi.billing_address.zip || null,
          }
        : undefined,
    },
    lineItems,
    totals: {
      totalLineAmount,
      totalTax,
      grandTotal: zi.total != null ? Number(zi.total) : round2(totalLineAmount + totalTax),
    },
  };
}

/**
 * Pull invoices from a tenant's connected Zoho Books org, transform each to the
 * canonical format, and feed them into the shared invoice pipeline. Duplicates
 * are skipped. The first sync uses the go-live date (initialSyncDate).
 */
async function syncTenant(tenant) {
  const connection = await db.ErpConnection.findOne({
    where: { tenant_id: tenant.id, connector_type: 'zoho', status: 'connected' },
  });

  if (!connection) {
    throw new AppError('No connected Zoho account', 400, 'ZOHO_NOT_CONNECTED');
  }

  const cfg = connection.config || {};
  const storedToken = zohoService.decodeToken(cfg.token);
  const organizationId = cfg.organizationId;
  if (!storedToken) {
    throw new AppError('Zoho token missing — reconnect required', 400, 'ZOHO_TOKEN_MISSING');
  }
  if (!organizationId) {
    throw new AppError('Zoho organization not set — reconnect required', 400, 'ZOHO_ORG_MISSING');
  }

  const token = await zohoService.ensureFreshToken(storedToken, async (fresh) => {
    await connection.update({ config: { ...cfg, token: zohoService.encodeToken(fresh) } });
  });

  const sinceIso = connection.last_sync_at
    ? new Date(connection.last_sync_at).toISOString()
    : cfg.initialSyncDate
      ? new Date(cfg.initialSyncDate).toISOString()
      : null;

  const list = await zohoService.fetchInvoices(token, organizationId, sinceIso);

  console.log(
    `[zoho-sync] tenant=${tenant.id} org=${organizationId} since=${sinceIso || 'beginning'} fetched=${list.length} invoice(s)`
  );

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const summary of list) {
    try {
      // The list endpoint omits line items, so fetch full detail per invoice.
      const detail =
        (await zohoService.fetchInvoiceDetail(token, organizationId, summary.invoice_id)) ||
        summary;
      const canonical = transformZohoInvoice(detail);
      await invoiceService.createInvoice(tenant, {
        erp_source: 'zoho',
        erp_invoice_id: String(summary.invoice_id),
        raw: canonical,
        raw_source: detail,
      });
      created += 1;
      console.log(
        `[zoho-sync] ingested Zoho invoice id=${summary.invoice_id} number=${summary.invoice_number || 'n/a'}`
      );
    } catch (err) {
      if (err.code === 'DUPLICATE_INVOICE') {
        skipped += 1;
        console.log(`[zoho-sync] skipped duplicate Zoho invoice id=${summary.invoice_id}`);
      } else {
        errors.push({ zohoId: summary.invoice_id, error: err.message });
        console.error(`[zoho-sync] failed Zoho invoice id=${summary.invoice_id}: ${err.message}`);
      }
    }
  }

  await connection.update({ last_sync_at: new Date(), health_status: 'OK' });

  console.log(
    `[zoho-sync] tenant=${tenant.id} done: fetched=${list.length} created=${created} skipped=${skipped} errors=${errors.length}`
  );

  return { fetched: list.length, created, skipped, errors };
}

module.exports = { syncTenant, transformZohoInvoice };
