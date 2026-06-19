const config = require('../config');
const tokenCrypto = require('../utils/tokenCrypto');

// Sage (Intacct) integration over OAuth 2.0 + REST.
//
// Tokens (access + refresh) are stored per connection, AES-256-GCM encrypted at
// rest (see utils/tokenCrypto). Access tokens are refreshed automatically before
// expiry, and refresh tokens are rotated correctly: Sage may return a new
// refresh token on each refresh, and we always persist the latest one.
//
// The OAuth/API hosts are configurable (SAGE_AUTH_URL/SAGE_TOKEN_URL/
// SAGE_API_BASE) so the same connector works across Sage environments. Set
// SAGE_MOCK=true for local development without live credentials.

function assertConfigured() {
  if (!config.sageClientId || !config.sageClientSecret) {
    throw new Error(
      'Sage is not configured. Set SAGE_CLIENT_ID and SAGE_CLIENT_SECRET, or SAGE_MOCK=true.'
    );
  }
}

/**
 * Build the Sage authorization URL. `state` is our signed JWT identifying the
 * tenant/user. We request offline access so we receive a refresh token.
 */
function buildAuthorizeUrl(state) {
  if (config.sageMock) {
    return `${config.sageRedirectUri}?mock=1&code=mock-code&state=${encodeURIComponent(state)}`;
  }
  assertConfigured();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.sageClientId,
    redirect_uri: config.sageRedirectUri,
    scope: config.sageScope,
    state,
  });
  return `${config.sageAuthUrl}?${params.toString()}`;
}

async function postToken(params) {
  const res = await fetch(config.sageTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // Never log token values; only the error code/status.
    throw new Error(`Sage token error: ${data.error || res.status}`);
  }
  return data;
}

// Keep only the fields we need, and stamp createdAt so we can compute expiry.
function slimToken(raw, existing = {}) {
  return {
    access_token: raw.access_token,
    // Rotate: prefer the freshly issued refresh token, else keep the prior one.
    refresh_token: raw.refresh_token || existing.refresh_token || null,
    token_type: raw.token_type || 'Bearer',
    expires_in: raw.expires_in || 3600,
    scope: raw.scope || existing.scope || config.sageScope,
    createdAt: Date.now(),
  };
}

/**
 * Exchange the authorization code for tokens.
 */
async function exchangeCallback(code) {
  if (config.sageMock) {
    return {
      mock: true,
      token: {
        access_token: `mock-access-${Date.now()}`,
        refresh_token: `mock-refresh-${Date.now()}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: config.sageScope,
        createdAt: Date.now(),
      },
    };
  }
  assertConfigured();
  const raw = await postToken({
    grant_type: 'authorization_code',
    client_id: config.sageClientId,
    client_secret: config.sageClientSecret,
    redirect_uri: config.sageRedirectUri,
    code,
  });
  return { mock: false, token: slimToken(raw) };
}

function isAccessTokenValid(storedToken) {
  if (!storedToken || !storedToken.createdAt || !storedToken.expires_in) return false;
  // Refresh 60s early to avoid races at the boundary.
  const expiresAt = storedToken.createdAt + (storedToken.expires_in - 60) * 1000;
  return Date.now() < expiresAt;
}

async function refreshToken(storedToken) {
  if (config.sageMock) {
    return {
      ...storedToken,
      access_token: `mock-access-${Date.now()}`,
      // Simulate refresh-token rotation in mock mode too.
      refresh_token: `mock-refresh-${Date.now()}`,
      createdAt: Date.now(),
    };
  }
  assertConfigured();
  if (!storedToken?.refresh_token) {
    throw new Error('Sage refresh token missing — reconnect required');
  }
  const raw = await postToken({
    grant_type: 'refresh_token',
    client_id: config.sageClientId,
    client_secret: config.sageClientSecret,
    refresh_token: storedToken.refresh_token,
  });
  return slimToken(raw, storedToken);
}

/**
 * Return a valid access token, refreshing (and persisting via onRefresh) when
 * the current one is expired or about to expire.
 */
async function ensureFreshToken(storedToken, onRefresh) {
  if (isAccessTokenValid(storedToken)) return storedToken;
  const refreshed = await refreshToken(storedToken);
  if (onRefresh) await onRefresh(refreshed);
  return refreshed;
}

async function sageApiGet(storedToken, path, query = {}) {
  const url = new URL(`${config.sageApiBase}/${path.replace(/^\//, '')}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${storedToken.access_token}`,
      Accept: 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Sage API ${path} failed: ${data.message || data.error || res.status}`);
  }
  return data;
}

/**
 * Identify the connected Sage company/tenant. Used after OAuth to label the
 * connection. Returns { companyId, companyName, ... } or null.
 */
async function getCompany(storedToken) {
  if (config.sageMock) {
    return {
      companyId: 'MOCK-SAGE-CO',
      companyName: 'Mock Sage Company Ltd',
      currency: 'NGN',
      country: 'NG',
    };
  }
  try {
    const data = await sageApiGet(storedToken, 'company');
    const c = data?.company || data?.data?.[0] || data;
    return {
      companyId: c.id || c.COMPANYID || c.RECORDNO || null,
      companyName: c.name || c.COMPANYNAME || null,
      currency: c.currency || c.BASECURR || 'NGN',
      country: c.country || 'NG',
    };
  } catch (e) {
    console.error('[sage] getCompany failed (ignored):', e.message);
    return null;
  }
}

function mockInvoices() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      RECORDNO: `SAGE-${Date.now()}`,
      DOCNUMBER: `ARINV-${Math.floor(Math.random() * 9000) + 1000}`,
      WHENCREATED: today,
      WHENDUE: today,
      CURRENCY: 'NGN',
      CUSTOMERID: 'SAGE-CUST-1',
      CUSTOMERNAME: 'Sage Demo Customer Ltd',
      TAXID: '20011223-0001',
      EMAIL1: 'customer@sagedemo.com',
      PHONE1: '+2348030000000',
      TOTAL: 21500,
      TOTALENTERED: 20000,
      TRX_TOTALTAX: 1500,
      ARINVOICEITEMS: [
        {
          ITEMID: 'SVC-CONSULT',
          MEMO: 'Consulting Service',
          QUANTITY: 2,
          PRICE: 10000,
          AMOUNT: 20000,
          TAXABLE: true,
          TAXCODE: 'STANDARD_VAT',
          TAXRATE: 7.5,
        },
      ],
    },
  ];
}

/**
 * Fetch AR invoices (ARInvoices), optionally only those modified since a date
 * for incremental sync.
 */
async function fetchInvoices(storedToken, companyId, sinceIso) {
  if (config.sageMock) {
    return mockInvoices();
  }
  const query = { size: 200, orderby: 'WHENMODIFIED asc' };
  if (companyId) query.company = companyId;
  if (sinceIso) {
    // Most Sage REST list endpoints support a filter on the modified date.
    query.filter = `WHENMODIFIED gt '${sinceIso}'`;
  }
  const data = await sageApiGet(storedToken, 'objects/accounts-receivable/invoice', query);
  return data.data || data.ia?.result || data.invoices || [];
}

/**
 * Fetch a single AR invoice's full detail (line items + customer info).
 */
async function fetchInvoiceDetail(storedToken, invoiceId) {
  if (config.sageMock) {
    return mockInvoices()[0];
  }
  const data = await sageApiGet(
    storedToken,
    `objects/accounts-receivable/invoice/${encodeURIComponent(invoiceId)}`
  );
  return data.data?.[0] || data.data || data.invoice || null;
}

/**
 * Fetch AR customers (ARCustomers) for TIN enrichment. Returns a map of
 * customerId -> { name, tin }.
 */
async function fetchCustomers(storedToken, companyId) {
  if (config.sageMock) {
    return { 'SAGE-CUST-1': { name: 'Sage Demo Customer Ltd', tin: '20011223-0001' } };
  }
  const query = { size: 500 };
  if (companyId) query.company = companyId;
  const data = await sageApiGet(storedToken, 'objects/accounts-receivable/customer', query);
  const rows = data.data || data.customers || [];
  const map = {};
  for (const c of rows) {
    const id = c.CUSTOMERID || c.id || c.RECORDNO;
    if (!id) continue;
    map[String(id)] = {
      name: c.NAME || c.CUSTOMERNAME || c.name || null,
      tin: c.TAXID || c.TAX_ID || c.VATREGNO || null,
    };
  }
  return map;
}

async function revokeToken() {
  // Sage Intacct does not expose a standard token-revocation endpoint; tokens
  // expire naturally. Deleting the connection drops the stored tokens.
  return;
}

function encodeToken(tokenObj) {
  return tokenCrypto.encryptJson(tokenObj);
}

function decodeToken(stored) {
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
  buildAuthorizeUrl,
  exchangeCallback,
  refreshToken,
  ensureFreshToken,
  isAccessTokenValid,
  getCompany,
  fetchInvoices,
  fetchInvoiceDetail,
  fetchCustomers,
  revokeToken,
  encodeToken,
  decodeToken,
};
