const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const PAYMENT_INIT_PATH =
  '/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit';

function sha512(value) {
  return crypto.createHash('sha512').update(value).digest('hex');
}

// Remita responses are wrapped in a JSONP-style callback: jsonp ({...})
function parseRemitaResponse(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
}

function assertConfigured() {
  const missing = [];
  if (!config.remitaMerchantId) missing.push('REMITA_MERCHANT_ID');
  if (!config.remitaServiceTypeId) missing.push('REMITA_SERVICE_TYPE_ID');
  if (!config.remitaApiKey) missing.push('REMITA_API_KEY');
  if (missing.length) {
    throw new Error(
      `Remita payment is not configured. Set ${missing.join(', ')} or REMITA_MOCK=true.`
    );
  }
}

/**
 * Generate a Remita Retrieval Reference (RRR) for a subscription payment.
 * Returns inline-widget config the frontend uses to open the Remita modal.
 */
async function initPayment({ amount, payerName, payerEmail, payerPhone, description }) {
  const orderId = `TAXORA-${Date.now()}-${uuidv4().slice(0, 8)}`;

  if (config.remitaMock) {
    return {
      mock: true,
      orderId,
      rrr: `MOCK-RRR-${Date.now()}`,
    };
  }

  assertConfigured();

  const { remitaMerchantId, remitaServiceTypeId, remitaApiKey } = config;
  const apiHash = sha512(
    `${remitaMerchantId}${remitaServiceTypeId}${orderId}${amount}${remitaApiKey}`
  );

  const { data } = await axios.post(
    `${config.remitaBaseUrl}${PAYMENT_INIT_PATH}`,
    {
      serviceTypeId: remitaServiceTypeId,
      amount: String(amount),
      orderId,
      payerName,
      payerEmail,
      payerPhone,
      description,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `remitaConsumerKey=${remitaMerchantId},remitaConsumerToken=${apiHash}`,
      },
      timeout: 20000,
    }
  );

  const parsed = parseRemitaResponse(data);
  if (!parsed.RRR && !parsed.rrr) {
    throw new Error(parsed.statusMessage || 'Remita did not return an RRR');
  }

  return {
    mock: false,
    orderId,
    rrr: parsed.RRR || parsed.rrr,
  };
}

/**
 * Check whether a Remita RRR has been paid.
 * Returns { paid, status, raw }.
 */
async function verifyPayment(rrr) {
  if (config.remitaMock) {
    return { paid: true, status: '01', mock: true };
  }

  assertConfigured();

  const { remitaMerchantId, remitaApiKey } = config;
  const statusHash = sha512(`${rrr}${remitaApiKey}${remitaMerchantId}`);
  const url = `${config.remitaBaseUrl}/remita/ecomm/${remitaMerchantId}/${rrr}/${statusHash}/status.reg`;

  // Accept any HTTP status so an unpaid/unknown RRR (which Remita may answer
  // with 403/404) is reported as "not paid yet" instead of throwing a 500.
  const response = await axios.get(url, {
    timeout: 20000,
    validateStatus: () => true,
  });
  const parsed = parseRemitaResponse(response.data);

  // Remita: status "00" or "01" indicates a successful/settled payment.
  const status = parsed.status || parsed.statuscode;
  const paid = ['00', '01'].includes(String(status));

  return { paid, status, raw: parsed, httpStatus: response.status };
}

module.exports = { initPayment, verifyPayment };
