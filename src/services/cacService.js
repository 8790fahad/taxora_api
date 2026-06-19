const config = require('../config');
const { AppError } = require('../utils/errors');
const { COMPANY_CLASSIFICATIONS } = require('../constants/registration');

function normalizeRcNumber(rcNumber) {
  return String(rcNumber || '')
    .trim()
    .replace(/^RC/i, '');
}

function mapCacData(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const rawState = (raw.stateId || raw.townCity || '').trim().replace(/\s+/g, ' ');
  const state = rawState
    ? rawState.charAt(0).toUpperCase() + rawState.slice(1).toLowerCase()
    : '';
  const addressLine = (raw.addressId || '').trim();
  const city = (raw.townCity || '').trim().replace(/\s+/g, ' ');
  const tin = (raw.identifiers && raw.identifiers.tin ? String(raw.identifiers.tin) : '').trim();

  return {
    company_name: (raw.custName || '').trim(),
    rc_number: normalizeRcNumber(raw.rcNumber),
    email: (raw.entryEmail || '').trim(),
    primary_phone: (raw.entryPhone || '').trim(),
    address_line: addressLine,
    address_city: city,
    address_country: 'NG',
    address_postal_zone: (raw.postalCode || raw.postalZone || '').trim(),
    state: state.replace(/\s+/g, ' '),
    tin,
    cust_type: raw.custType || null,
    raw,
  };
}

async function lookupCac(rcNumber, classification) {
  const normalizedRc = normalizeRcNumber(rcNumber);
  const classificationKey = String(classification || '').trim();

  if (!normalizedRc) {
    throw new AppError('RC Number is required', 400, 'VALIDATION_ERROR');
  }

  if (!COMPANY_CLASSIFICATIONS[classificationKey]) {
    throw new AppError('Invalid company classification', 400, 'INVALID_CLASSIFICATION');
  }

  if (!config.kirsCsrfToken) {
    throw new AppError(
      'CAC lookup is not configured. Set KIRS_CSRF_TOKEN in server environment.',
      503,
      'CAC_NOT_CONFIGURED'
    );
  }

  const response = await fetch(config.kirsCacUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-TOKEN': config.kirsCsrfToken,
    },
    body: JSON.stringify({
      rcNumber: normalizedRc,
      classification: classificationKey,
    }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AppError('Invalid response from CAC service', 502, 'CAC_BAD_RESPONSE');
  }

  if (payload.status === 'error') {
    return {
      found: false,
      status: payload.status,
      message: payload.message || 'RC Number not found',
      company: null,
    };
  }

  const company = mapCacData(payload.data);

  return {
    found: !!company?.company_name,
    status: payload.status,
    message: payload.message || null,
    company,
  };
}

module.exports = { lookupCac, normalizeRcNumber, mapCacData };
