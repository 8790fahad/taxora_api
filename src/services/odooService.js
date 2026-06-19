const config = require('../config');
const tokenCrypto = require('../utils/tokenCrypto');

// Odoo integration via the JSON-RPC API (`/jsonrpc`).
//
// Auth model: call `common.authenticate(db, login, password|apiKey, {})` which
// returns a numeric uid. All subsequent data calls go through
// `object.execute_kw(db, uid, password, model, method, args, kwargs)`.
//
// Credentials (base URL, database, username, API key) are supplied per
// connection and stored AES-256 encrypted at rest. The API key/password is
// itself used as the RPC password, so we keep it encrypted and only decrypt in
// memory for the duration of a call.

const INVOICE_MOVE_TYPES = ['out_invoice', 'out_refund'];
const DEFAULT_TIMEOUT_MS = 20000;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function assertCredentials(creds) {
  const missing = [];
  if (!creds?.baseUrl) missing.push('baseUrl');
  if (!creds?.database) missing.push('database');
  if (!creds?.username) missing.push('username');
  if (!creds?.apiKey) missing.push('apiKey');
  if (missing.length) {
    const err = new Error(`Missing Odoo credentials: ${missing.join(', ')}`);
    err.code = 'ODOO_MISSING_CREDENTIALS';
    throw err;
  }
}

/**
 * Low-level JSON-RPC call to an Odoo instance.
 * Throws a tagged Error on transport failures, timeouts, or Odoo faults.
 */
async function jsonRpc(baseUrl, service, method, args) {
  const url = `${normalizeBaseUrl(baseUrl)}/jsonrpc`;
  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: { service, method, args },
    id: Date.now(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(
      e.name === 'AbortError'
        ? 'Odoo request timed out'
        : `Could not reach Odoo at ${normalizeBaseUrl(baseUrl)}: ${e.message}`
    );
    err.code = e.name === 'AbortError' ? 'ODOO_TIMEOUT' : 'ODOO_NETWORK';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = new Error(`Odoo HTTP ${res.status}`);
    err.code = 'ODOO_HTTP_ERROR';
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (data.error) {
    const msg = data.error?.data?.message || data.error?.message || 'Odoo RPC error';
    const err = new Error(msg);
    err.code = 'ODOO_RPC_ERROR';
    err.odoo = data.error;
    throw err;
  }
  return data.result;
}

/**
 * Authenticate and return the numeric uid. A falsy uid means bad credentials.
 */
async function authenticate(creds) {
  assertCredentials(creds);
  const uid = await jsonRpc(creds.baseUrl, 'common', 'authenticate', [
    creds.database,
    creds.username,
    creds.apiKey,
    {},
  ]);
  if (!uid) {
    const err = new Error('Odoo authentication failed — check database, username, and API key.');
    err.code = 'ODOO_AUTH_FAILED';
    throw err;
  }
  return uid;
}

async function getServerVersion(creds) {
  try {
    const info = await jsonRpc(creds.baseUrl, 'common', 'version', []);
    return info?.server_version || null;
  } catch {
    return null;
  }
}

/**
 * Validate credentials during connection setup. Returns { uid, serverVersion }.
 * In mock mode this succeeds without a live instance.
 */
async function validateConnection(creds) {
  if (config.odooMock) {
    return { uid: 1, serverVersion: 'mock-17.0', mock: true };
  }
  const uid = await authenticate(creds);
  const serverVersion = await getServerVersion(creds);
  return { uid, serverVersion, mock: false };
}

// execute_kw helper with a freshly authenticated uid.
async function executeKw(creds, uid, model, method, args = [], kwargs = {}) {
  return jsonRpc(creds.baseUrl, 'object', 'execute_kw', [
    creds.database,
    uid,
    creds.apiKey,
    model,
    method,
    args,
    kwargs,
  ]);
}

function relName(field) {
  // Odoo many2one fields serialize as [id, "Display Name"].
  return Array.isArray(field) ? field[1] : null;
}

function relId(field) {
  return Array.isArray(field) ? field[0] : field || null;
}

function mockInvoices() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      id: Math.floor(Date.now() / 1000),
      name: `INV/${new Date().getFullYear()}/${Math.floor(Math.random() * 9000) + 1000}`,
      invoice_date: today,
      invoice_date_due: today,
      partner_id: [101, 'Odoo Demo Customer Ltd'],
      currency_id: [1, 'NGN'],
      state: 'posted',
      move_type: 'out_invoice',
      amount_tax: 1500,
      amount_total: 21500,
      __lines: [
        {
          id: 1,
          name: 'Consulting Service',
          quantity: 2,
          price_unit: 10000,
          price_subtotal: 20000,
          tax_ids: [10],
          product_id: [55, 'Consulting'],
        },
      ],
      __partner: {
        id: 101,
        name: 'Odoo Demo Customer Ltd',
        email: 'customer@example.com',
        phone: '+2348010000000',
        vat: '12345678-0001',
        street: '12 Marina Road',
        city: 'Lagos',
        country_id: [161, 'Nigeria'],
      },
      __taxes: { 10: { name: 'VAT 7.5%', amount: 7.5, amount_type: 'percent', type_tax_use: 'sale' } },
    },
  ];
}

/**
 * Fetch sales invoices from account.move, optionally only those modified since
 * `sinceIso` (incremental sync). Returns lightweight move records.
 */
async function fetchInvoices(creds, uid, sinceIso, limit = 200) {
  if (config.odooMock) return mockInvoices();

  const domain = [['move_type', 'in', INVOICE_MOVE_TYPES]];
  if (sinceIso) {
    // Odoo expects 'YYYY-MM-DD HH:mm:ss' (UTC).
    const odooDate = new Date(sinceIso).toISOString().slice(0, 19).replace('T', ' ');
    domain.push(['write_date', '>=', odooDate]);
  }

  return executeKw(creds, uid, 'account.move', 'search_read', [domain], {
    fields: [
      'name',
      'invoice_date',
      'invoice_date_due',
      'partner_id',
      'currency_id',
      'state',
      'move_type',
      'amount_tax',
      'amount_total',
      'amount_untaxed',
      'invoice_line_ids',
    ],
    limit,
    order: 'write_date asc',
  });
}

/**
 * Enrich a move with its invoice lines, customer (res.partner), and the tax
 * definitions (account.tax) referenced by the lines.
 */
async function fetchInvoiceDetail(creds, uid, move) {
  if (config.odooMock) {
    return {
      lines: move.__lines || [],
      partner: move.__partner || null,
      taxes: move.__taxes || {},
    };
  }

  const lineIds = move.invoice_line_ids || [];
  const lines = lineIds.length
    ? await executeKw(creds, uid, 'account.move.line', 'read', [lineIds], {
        fields: [
          'name',
          'quantity',
          'price_unit',
          'price_subtotal',
          'price_total',
          'tax_ids',
          'product_id',
          'discount',
        ],
      })
    : [];
  // account.move.line includes non-product lines (tax/section); keep only those
  // tied to the customer invoice display (exclude_from_invoice_tab is internal),
  // so we filter to lines that carry a quantity/price.
  const productLines = lines.filter((l) => l.price_subtotal !== undefined);

  let partner = null;
  const partnerId = relId(move.partner_id);
  if (partnerId) {
    const partners = await executeKw(creds, uid, 'res.partner', 'read', [[partnerId]], {
      fields: ['name', 'email', 'phone', 'vat', 'street', 'street2', 'city', 'zip', 'country_id'],
    });
    partner = partners[0] || null;
  }

  const taxIdSet = new Set();
  productLines.forEach((l) => (l.tax_ids || []).forEach((id) => taxIdSet.add(id)));
  const taxes = {};
  if (taxIdSet.size) {
    const taxRecords = await executeKw(
      creds,
      uid,
      'account.tax',
      'read',
      [[...taxIdSet]],
      { fields: ['name', 'amount', 'amount_type', 'type_tax_use'] }
    );
    taxRecords.forEach((t) => {
      taxes[t.id] = t;
    });
  }

  return { lines: productLines, partner, taxes };
}

function encodeCredentials(creds) {
  return tokenCrypto.encryptJson({
    baseUrl: normalizeBaseUrl(creds.baseUrl),
    database: creds.database,
    username: creds.username,
    apiKey: creds.apiKey,
  });
}

function decodeCredentials(stored) {
  if (!stored) return null;
  if (typeof stored === 'object') return stored;
  if (tokenCrypto.isEncrypted(stored)) return tokenCrypto.decryptJson(stored);
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

module.exports = {
  normalizeBaseUrl,
  authenticate,
  validateConnection,
  getServerVersion,
  fetchInvoices,
  fetchInvoiceDetail,
  executeKw,
  encodeCredentials,
  decodeCredentials,
  relName,
  relId,
  INVOICE_MOVE_TYPES,
};
