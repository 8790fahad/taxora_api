const config = require('../config');
const tokenCrypto = require('../utils/tokenCrypto');

// FlowBooks integration over OAuth 2.0 + REST.
//
// Tokens (access + refresh) are stored per connection, AES-256-GCM encrypted at
// rest (see utils/tokenCrypto). Access tokens are refreshed automatically before
// expiry, and refresh tokens are rotated: FlowBooks may return a new refresh
// token on each refresh, and we always persist the latest one.
//
// The OAuth/API hosts are configurable (FLOWBOOKS_AUTH_URL / FLOWBOOKS_TOKEN_URL
// / FLOWBOOKS_API_BASE) so the same connector works across environments. Set
// FLOWBOOKS_MOCK=true for local development without live credentials.

function assertConfigured() {
  if (!config.flowbooksClientId || !config.flowbooksClientSecret) {
    throw new Error(
      'FlowBooks is not configured. Set FLOWBOOKS_CLIENT_ID and FLOWBOOKS_CLIENT_SECRET, or FLOWBOOKS_MOCK=true.'
    );
  }
}

/**
 * Build the FlowBooks authorization URL. `state` is our signed JWT identifying
 * the tenant/user. We request offline access so we receive a refresh token.
 */
function buildAuthorizeUrl(state) {
  if (config.flowbooksMock) {
    return `${config.flowbooksRedirectUri}?mock=1&code=mock-code&state=${encodeURIComponent(state)}`;
  }
  assertConfigured();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.flowbooksClientId,
    redirect_uri: config.flowbooksRedirectUri,
    scope: config.flowbooksScope,
    state,
  });
  return `${config.flowbooksAuthUrl}?${params.toString()}`;
}

async function postToken(params) {
  const res = await fetch(config.flowbooksTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // Never log token values; only the error code/status.
    throw new Error(`FlowBooks token error: ${data.error || res.status}`);
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
    scope: raw.scope || existing.scope || config.flowbooksScope,
    createdAt: Date.now(),
  };
}

/**
 * Exchange the authorization code for tokens.
 */
async function exchangeCallback(code) {
  if (config.flowbooksMock) {
    return {
      mock: true,
      token: {
        access_token: `mock-access-${Date.now()}`,
        refresh_token: `mock-refresh-${Date.now()}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: config.flowbooksScope,
        createdAt: Date.now(),
      },
    };
  }
  assertConfigured();
  const raw = await postToken({
    grant_type: 'authorization_code',
    client_id: config.flowbooksClientId,
    client_secret: config.flowbooksClientSecret,
    redirect_uri: config.flowbooksRedirectUri,
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
  if (config.flowbooksMock) {
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
    throw new Error('FlowBooks refresh token missing — reconnect required');
  }
  const raw = await postToken({
    grant_type: 'refresh_token',
    client_id: config.flowbooksClientId,
    client_secret: config.flowbooksClientSecret,
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

async function flowbooksApiGet(storedToken, path, query = {}) {
  const url = new URL(`${config.flowbooksApiBase}/${path.replace(/^\//, '')}`);
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
    throw new Error(`FlowBooks API ${path} failed: ${data.message || data.error || res.status}`);
  }
  return data;
}

/**
 * Identify the connected FlowBooks organization. Used after OAuth to label the
 * connection. Returns { companyId, companyName, ... } or null.
 */
async function getCompany(storedToken) {
  if (config.flowbooksMock) {
    return {
      companyId: 'MOCK-FB-ORG',
      companyName: 'Mock FlowBooks Org Ltd',
      currency: 'NGN',
      country: 'NG',
    };
  }
  try {
    const data = await flowbooksApiGet(storedToken, 'organization');
    const c = data?.organization || data?.data || data;
    return {
      companyId: c.id || c.organizationId || null,
      companyName: c.name || c.companyName || null,
      currency: c.currency || c.baseCurrency || 'NGN',
      country: c.country || 'NG',
    };
  } catch (e) {
    console.error('[flowbooks] getCompany failed (ignored):', e.message);
    return null;
  }
}

function mockInvoices() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      id: `FB-${Date.now()}`,
      invoiceNumber: `FB-INV-${Math.floor(Math.random() * 9000) + 1000}`,
      issueDate: today,
      dueDate: today,
      currency: 'NGN',
      status: 'issued',
      paymentStatus: 'PENDING',
      customerId: 'FB-CUST-1',
      customerName: 'FlowBooks Demo Customer Ltd',
      customerTin: '20011223-0001',
      customerEmail: 'customer@flowbooksdemo.com',
      customerPhone: '+2348030000000',
      totalAmount: 21500,
      subtotal: 20000,
      taxAmount: 1500,
      lineItems: [
        {
          itemCode: 'SVC-CONSULT',
          description: 'Consulting Service',
          quantity: 2,
          unitPrice: 10000,
          amount: 20000,
          taxable: true,
          taxCode: 'STANDARD_VAT',
          taxRate: 7.5,
        },
      ],
    },
  ];
}

/**
 * Fetch invoices, optionally only those modified since a date for incremental
 * sync.
 */
async function fetchInvoices(storedToken, companyId, sinceIso) {
  if (config.flowbooksMock) {
    return mockInvoices();
  }
  const query = { limit: 200, sort: 'updatedAt:asc' };
  if (companyId) query.organizationId = companyId;
  if (sinceIso) query.updatedSince = sinceIso;
  const data = await flowbooksApiGet(storedToken, 'invoices', query);
  return data.data || data.invoices || [];
}

/**
 * Fetch a single invoice's full detail (line items + customer info).
 */
async function fetchInvoiceDetail(storedToken, invoiceId) {
  if (config.flowbooksMock) {
    return mockInvoices()[0];
  }
  const data = await flowbooksApiGet(
    storedToken,
    `invoices/${encodeURIComponent(invoiceId)}`
  );
  return data.data || data.invoice || null;
}

/**
 * Fetch customers for TIN enrichment. Returns a map of customerId ->
 * { name, tin }.
 */
async function fetchCustomers(storedToken, companyId) {
  if (config.flowbooksMock) {
    return { 'FB-CUST-1': { name: 'FlowBooks Demo Customer Ltd', tin: '20011223-0001' } };
  }
  const query = { limit: 500 };
  if (companyId) query.organizationId = companyId;
  const data = await flowbooksApiGet(storedToken, 'customers', query);
  const rows = data.data || data.customers || [];
  const map = {};
  for (const c of rows) {
    const id = c.id || c.customerId;
    if (!id) continue;
    map[String(id)] = {
      name: c.name || c.customerName || null,
      tin: c.tin || c.taxId || c.vatNumber || null,
    };
  }
  return map;
}

async function revokeToken() {
  // FlowBooks tokens expire naturally; deleting the connection drops the stored
  // tokens. If a revocation endpoint is added later, call it here.
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
