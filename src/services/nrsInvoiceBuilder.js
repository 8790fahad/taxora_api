const crypto = require('crypto');
const config = require('../config');

// Round to 2 decimal places, avoiding binary float drift (e.g. 977.0625 -> 977.06).
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// NRS expects dates as DD-MM-YYYY. Accepts a Date, an ISO date, or YYYY-MM-DD.
function toNrsDate(input) {
  if (!input) return null;
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) return null;
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = dt.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function addDays(input, days) {
  const dt = input instanceof Date ? new Date(input) : new Date(input);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt;
}

// Compute the full financial breakdown for a single line item.
//   gross        = unitPrice * quantity
//   discountAmt  = gross * discountRate%
//   feeAmt       = gross * feeRate%
//   totalAmount  = gross - discountAmt + feeAmt   (net, excludes tax)
//   taxAmount    = totalAmount * taxRate%
function computeLineFinancials(line) {
  const quantity = Number(line.quantity) || 0;
  const unitPrice = Number(line.unitPrice) || 0;
  const discountRate = Number(line.discountRate) || 0;
  const feeRate = Number(line.feeRate) || 0;
  const taxRate = line.taxRate != null ? Number(line.taxRate) : 7.5;

  const gross = quantity * unitPrice;
  const discountAmount =
    line.discountAmount != null ? Number(line.discountAmount) : round2((gross * discountRate) / 100);
  const feeAmount =
    line.feeAmount != null ? Number(line.feeAmount) : round2((gross * feeRate) / 100);
  const totalAmount =
    line.totalAmount != null ? Number(line.totalAmount) : round2(gross - discountAmount + feeAmount);
  const taxAmount =
    line.taxAmount != null ? Number(line.taxAmount) : round2((totalAmount * taxRate) / 100);

  return {
    quantity,
    unitPrice,
    discountRate,
    discountAmount,
    feeRate,
    feeAmount,
    totalAmount,
    taxRate,
    taxAmount,
  };
}

// NRS wants exactly one classification pair per line:
//   goods   -> hsnCode + productCategory
//   service -> isicCode + serviceCategory
// We honour explicit fields on the canonical line; otherwise fall back to the
// generic nrsProductCode as a service classification.
function buildClassification(line) {
  if (line.hsnCode || line.productCategory) {
    return {
      hsnCode: line.hsnCode || line.nrsProductCode || null,
      productCategory: line.productCategory || 'General',
    };
  }
  if (line.isicCode || line.serviceCategory) {
    return {
      isicCode: line.isicCode || line.nrsProductCode || null,
      serviceCategory: line.serviceCategory || 'General Services',
    };
  }
  return {
    isicCode: line.nrsProductCode || 'SVC-001',
    serviceCategory: line.serviceCategory || 'General Services',
  };
}

function buildLineItem(line, idx) {
  const fin = computeLineFinancials(line);
  return {
    name: line.name || line.description || `Item ${idx + 1}`,
    description: line.description || line.name || '',
    sellersItemIdentification:
      line.sellersItemIdentification || line.nrsProductCode || `ITEM-${idx + 1}`,
    ...buildClassification(line),
    unitPrice: fin.unitPrice,
    discountRate: fin.discountRate,
    discountAmount: fin.discountAmount,
    feeRate: fin.feeRate,
    feeAmount: fin.feeAmount,
    quantity: fin.quantity,
    totalAmount: fin.totalAmount,
    taxCode: line.taxCode || 'STANDARD_VAT',
    taxRate: fin.taxRate,
    taxAmount: fin.taxAmount,
  };
}

// Build the merchant-generated IRN: <invoiceRef>-<8 hex>-<YYYYMMDD of issue date>.
function buildIrn(invoiceRef, issueDate) {
  const dt = issueDate instanceof Date ? issueDate : new Date(issueDate);
  const ymd = Number.isNaN(dt.getTime())
    ? new Date().toISOString().slice(0, 10).replace(/-/g, '')
    : `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(
        dt.getUTCDate()
      ).padStart(2, '0')}`;
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${invoiceRef}-${rand}-${ymd}`;
}

function buildCustomer(buyer = {}) {
  const customer = {
    customerId: buyer.customerId || buyer.id || null,
    name: buyer.name || 'Unknown Customer',
    email: buyer.email || null,
    phone: buyer.phone || null,
    identifiers: {
      tin: buyer.tin || buyer.identifiers?.tin || null,
    },
  };

  const address = buyer.address;
  if (address) {
    customer.address = {
      line: address.line || null,
      city: address.city || null,
      country: address.country || 'NG',
      postalZone: address.postalZone || null,
    };
  }

  return customer;
}

/**
 * Build the NRS/FIRS (MBS) submission payload from a canonical invoice.
 *
 * The IRN is intentionally NOT generated here — it is assigned by NRS once the
 * invoice is cleared, and is stored separately on the invoice record.
 *
 * @param {object} canonical - the stored canonical_json invoice
 * @param {object} tenant - the owning tenant (merchant)
 * @param {object} [options]
 * @param {string} [options.invoiceRef] - human invoice ref (defaults to ERP doc number)
 */
function buildNrsInvoice(canonical = {}, tenant = {}, options = {}) {
  const issueDateRaw = canonical.issueDate || new Date().toISOString().slice(0, 10);
  const dueDateRaw = canonical.dueDate || addDays(issueDateRaw, 30);

  const invoiceRef =
    options.invoiceRef ||
    canonical.docNumber ||
    canonical.source?.erpInvoiceId ||
    canonical.invoiceRef;

  const lineItems = (canonical.lineItems || []).map(buildLineItem);

  const totalLineAmount = round2(
    lineItems.reduce((sum, li) => sum + li.totalAmount, 0)
  );
  const totalTax = round2(lineItems.reduce((sum, li) => sum + li.taxAmount, 0));
  const grandTotal = round2(totalLineAmount + totalTax);

  const invoiceKind = canonical.type || 'B2B';

  return {
    invoiceRef,
    merchantId: tenant.nrs_business_id || config.nrsMerchantId || null,
    currency: canonical.currency || 'NGN',
    issueDate: toNrsDate(issueDateRaw),
    dueDate: toNrsDate(dueDateRaw),
    status: canonical.status || 'issued',
    orderReference: canonical.orderReference || invoiceRef,
    customer: buildCustomer(canonical.buyer),
    lineItems,
    totals: {
      totalLineAmount,
      totalTax,
      grandTotal,
    },
    firsSpecific: {
      invoiceTypeCode: canonical.invoiceTypeCode || config.nrsInvoiceTypeCode || '396',
      paymentStatus: canonical.paymentStatus || 'PENDING',
      invoiceKind,
    },
  };
}

module.exports = {
  buildNrsInvoice,
  computeLineFinancials,
  buildIrn,
  toNrsDate,
  round2,
};
