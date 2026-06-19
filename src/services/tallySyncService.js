const db = require('../models');
const tallyService = require('./tallyService');
const invoiceService = require('./invoiceService');
const { AppError } = require('../utils/errors');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Tally numbers can arrive as "-21500.00" strings; inventory qty as "2 Nos"
// and rate as "10000.00/Nos". Strip units defensively.
function num(value) {
  if (value == null) return 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseQty(value) {
  const n = num(value);
  return n || 1;
}

function isSalesVoucher(v) {
  const type = String(v?.VOUCHERTYPENAME || v?.['@_VCHTYPE'] || '').toLowerCase();
  return type.includes('sales') || type.includes('invoice');
}

function isTaxLedger(name) {
  return /vat|gst|tax|cess/i.test(String(name || ''));
}

// Tally dates are YYYYMMDD.
function fromTallyDate(value) {
  const s = String(value || '');
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/**
 * Transform a Tally sales VOUCHER (already parsed to JSON) into Taxora's
 * canonical "raw" shape. Amounts are recomputed downstream by nrsInvoiceBuilder.
 */
function transformTallyVoucher(v) {
  const inventory = tallyService.asArray(v['ALLINVENTORYENTRIES.LIST'] || v['INVENTORYENTRIES.LIST']);
  const ledgers = tallyService.asArray(v['LEDGERENTRIES.LIST'] || v['ALLLEDGERENTRIES.LIST']);

  // Total tax = sum of |amount| on tax-type ledgers.
  const totalTax = round2(
    ledgers
      .filter((l) => isTaxLedger(l.LEDGERNAME))
      .reduce((sum, l) => sum + Math.abs(num(l.AMOUNT)), 0)
  );

  let lineItems = inventory.map((it, idx) => {
    const quantity = parseQty(it.ACTUALQTY || it.BILLEDQTY || 1);
    const amount = Math.abs(num(it.AMOUNT));
    const rate = it.RATE != null ? Math.abs(num(it.RATE)) : amount / quantity;
    const unitPrice = rate || (quantity ? amount / quantity : amount);
    const name = it.STOCKITEMNAME || `Item ${idx + 1}`;
    return {
      lineNo: idx + 1,
      name,
      description: name,
      sellersItemIdentification: String(name),
      isicCode: 'SVC-001',
      serviceCategory: 'General Services',
      nrsProductCode: 'SVC-001',
      quantity,
      unitPrice: round2(unitPrice),
      discountRate: 0,
      feeRate: 0,
      taxCode: totalTax > 0 ? 'STANDARD_VAT' : 'EXEMPT',
      taxRate: 0, // set below once we know the line base
      taxAmount: 0,
    };
  });

  // Vouchers without inventory (service invoices): synthesize a single line
  // from the non-tax ledger entries.
  if (lineItems.length === 0) {
    const base = round2(
      ledgers
        .filter((l) => !isTaxLedger(l.LEDGERNAME))
        .reduce((sum, l) => sum + Math.abs(num(l.AMOUNT)), 0)
    ) || Math.abs(num(v.AMOUNT));
    lineItems = [
      {
        lineNo: 1,
        name: v.PARTYLEDGERNAME ? `Sale to ${v.PARTYLEDGERNAME}` : 'Sales',
        description: 'Sales voucher',
        sellersItemIdentification: String(v.VOUCHERNUMBER || 'ITEM-1'),
        isicCode: 'SVC-001',
        serviceCategory: 'General Services',
        nrsProductCode: 'SVC-001',
        quantity: 1,
        unitPrice: base,
        discountRate: 0,
        feeRate: 0,
        taxCode: totalTax > 0 ? 'STANDARD_VAT' : 'EXEMPT',
        taxRate: 0,
        taxAmount: 0,
      },
    ];
  }

  const totalLineAmount = round2(
    lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0)
  );

  // Distribute the voucher's total tax across lines proportionally and derive a
  // per-line tax rate so the canonical stays internally consistent.
  lineItems = lineItems.map((li) => {
    const base = li.quantity * li.unitPrice;
    const share = totalLineAmount > 0 ? base / totalLineAmount : 0;
    const taxAmount = round2(totalTax * share);
    const taxRate = base > 0 ? round2((taxAmount / base) * 100) : 0;
    return { ...li, taxAmount, taxRate };
  });

  const grandTotal = v.AMOUNT != null ? Math.abs(num(v.AMOUNT)) : round2(totalLineAmount + totalTax);

  return {
    type: 'B2B',
    currency: 'NGN',
    issueDate: fromTallyDate(v.DATE),
    dueDate: null,
    status: 'issued',
    paymentStatus: 'PENDING',
    docNumber: String(v.VOUCHERNUMBER || v.VOUCHERKEY || ''),
    orderReference: String(v.REFERENCE || v.VOUCHERNUMBER || ''),
    voucherType: v.VOUCHERTYPENAME || 'Sales',
    buyer: {
      customerId: null,
      name: v.PARTYLEDGERNAME || v.PARTYNAME || 'Unknown Customer',
      tin: v.PARTYGSTIN || v.CONSIGNEEGSTIN || '',
      email: '',
      phone: null,
    },
    lineItems,
    totals: { totalLineAmount, totalTax, grandTotal },
  };
}

/**
 * Pull sales vouchers from a tenant's connected Tally instance, transform each
 * to canonical, and feed them into the shared invoice pipeline. Duplicates are
 * skipped by voucher number (via invoice_ref). First sync uses the go-live date.
 */
async function syncTenant(tenant) {
  const connection = await db.ErpConnection.findOne({
    where: { tenant_id: tenant.id, connector_type: 'tally', status: 'connected' },
  });

  if (!connection) {
    throw new AppError('No connected Tally instance', 400, 'TALLY_NOT_CONNECTED');
  }

  const cfg = connection.config || {};
  if (!cfg.url) {
    throw new AppError('Tally URL missing — reconnect required', 400, 'TALLY_URL_MISSING');
  }

  const fromDate = connection.last_sync_at || cfg.initialSyncDate || null;

  let vouchers;
  try {
    vouchers = await tallyService.fetchVouchers({
      url: cfg.url,
      company: cfg.companyName,
      fromDate,
      toDate: new Date(),
    });
  } catch (err) {
    await connection.update({ health_status: 'ERROR' });
    throw new AppError(err.message || 'Tally sync failed', 502, err.code || 'TALLY_SYNC_FAILED');
  }

  const salesVouchers = vouchers.filter((v) => isSalesVoucher(v));

  console.log(
    `[tally-sync] tenant=${tenant.id} company=${cfg.companyName || 'n/a'} fetched=${vouchers.length} sales=${salesVouchers.length}`
  );

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const voucher of salesVouchers) {
    const voucherNo = String(voucher.VOUCHERNUMBER || voucher.VOUCHERKEY || '');
    try {
      const canonical = transformTallyVoucher(voucher);
      await invoiceService.createInvoice(tenant, {
        erp_source: 'tally',
        // Voucher number is the unique key that prevents duplicate imports.
        erp_invoice_id: voucherNo || `TALLY-${Date.now()}`,
        raw: canonical,
        raw_source: voucher,
      });
      created += 1;
      console.log(`[tally-sync] ingested Tally voucher no=${voucherNo}`);
    } catch (err) {
      if (err.code === 'DUPLICATE_INVOICE') {
        skipped += 1;
        console.log(`[tally-sync] skipped duplicate Tally voucher no=${voucherNo}`);
      } else {
        errors.push({ voucherNo, error: err.message });
        console.error(`[tally-sync] failed Tally voucher no=${voucherNo}: ${err.message}`);
      }
    }
  }

  await connection.update({ last_sync_at: new Date(), health_status: 'OK' });

  console.log(
    `[tally-sync] tenant=${tenant.id} done: sales=${salesVouchers.length} created=${created} skipped=${skipped} errors=${errors.length}`
  );

  return { fetched: salesVouchers.length, created, skipped, errors };
}

module.exports = { syncTenant, transformTallyVoucher };
