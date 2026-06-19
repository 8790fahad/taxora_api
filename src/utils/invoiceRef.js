function buildInvoiceRef(tenantId, erpSource, erpInvoiceId) {
  return `${tenantId}-${erpSource}-${erpInvoiceId}`;
}

module.exports = { buildInvoiceRef };
