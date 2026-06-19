const config = require('../config');
const { v4: uuidv4 } = require('uuid');

async function submitInvoice(canonical, invoiceRef) {
  if (config.remitaMock) {
    return {
      jobId: `mock-${uuidv4()}`,
      status: 'SUBMITTED',
      invoiceRef,
      mock: true,
    };
  }

  // Phase 2: real HTTP to Remita API
  throw new Error('Real Remita integration not configured. Set REMITA_MOCK=true for development.');
}

async function getStatus(invoiceRef) {
  if (config.remitaMock) {
    return {
      invoiceRef,
      status: 'CLEARED',
      irn: `IRN-MOCK-${invoiceRef.slice(-8).toUpperCase()}`,
      qr: `https://verify.taxora.ng/qr/${invoiceRef}`,
      mock: true,
    };
  }

  throw new Error('Real Remita integration not configured. Set REMITA_MOCK=true for development.');
}

function generateMockIrn(invoiceRef) {
  const suffix = invoiceRef.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toUpperCase();
  return `NG-IRN-${suffix}-${Date.now().toString(36).toUpperCase()}`;
}

module.exports = { submitInvoice, getStatus, generateMockIrn };
