const OAuthClient = require('intuit-oauth');
const config = require('../config');
const tokenCrypto = require('../utils/tokenCrypto');

let cachedClient = null;

function getClient() {
  if (!config.qbClientId || !config.qbClientSecret) {
    throw new Error(
      'QuickBooks is not configured. Set QB_CLIENT_ID and QB_CLIENT_SECRET, or QB_MOCK=true.'
    );
  }
  if (!cachedClient) {
    cachedClient = new OAuthClient({
      clientId: config.qbClientId,
      clientSecret: config.qbClientSecret,
      environment: config.qbEnvironment,
      redirectUri: config.qbRedirectUri,
    });
  }
  return cachedClient;
}

/**
 * Build the QuickBooks authorization URL the user is redirected to.
 * `state` is our signed JWT identifying the tenant/user.
 */
function buildAuthorizeUrl(state) {
  if (config.qbMock) {
    return `${config.qbRedirectUri}?mock=1&state=${encodeURIComponent(state)}`;
  }

  const client = getClient();
  return client.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state,
  });
}

/**
 * Exchange the callback URL (?code=...&realmId=...) for tokens.
 * Returns a serializable token bundle to persist on the connection.
 */
async function exchangeCallback(callbackUrl, realmId) {
  if (config.qbMock) {
    return {
      mock: true,
      realmId: realmId || 'MOCK-REALM',
      token: {
        access_token: `mock-access-${Date.now()}`,
        refresh_token: `mock-refresh-${Date.now()}`,
        token_type: 'bearer',
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
        createdAt: Date.now(),
      },
    };
  }

  const client = getClient();
  const authResponse = await client.createToken(callbackUrl);
  const token = authResponse.getToken();
  // Persist only the plain token fields. The SDK's Token object carries the
  // full HTTP response, which blows past MySQL's max_allowed_packet if stored.
  return {
    mock: false,
    realmId: token.realmId || realmId,
    token: {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type,
      expires_in: token.expires_in,
      x_refresh_token_expires_in: token.x_refresh_token_expires_in,
      id_token: token.id_token || '',
      realmId: token.realmId || realmId,
      createdAt: token.createdAt || Date.now(),
    },
  };
}

function slimToken(token, fallbackRealm) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    expires_in: token.expires_in,
    x_refresh_token_expires_in: token.x_refresh_token_expires_in,
    id_token: token.id_token || '',
    realmId: token.realmId || fallbackRealm,
    createdAt: token.createdAt || Date.now(),
  };
}

function isAccessTokenValid(storedToken) {
  if (!storedToken || !storedToken.createdAt || !storedToken.expires_in) return false;
  // Refresh 60s early to avoid edge expiry during a request.
  const expiresAt = storedToken.createdAt + (storedToken.expires_in - 60) * 1000;
  return Date.now() < expiresAt;
}

/**
 * Refresh an access token using a stored token bundle.
 */
async function refreshToken(storedToken) {
  if (config.qbMock) {
    return {
      ...storedToken,
      access_token: `mock-access-${Date.now()}`,
      createdAt: Date.now(),
    };
  }

  const client = getClient();
  client.setToken(storedToken);
  const authResponse = await client.refresh();
  return slimToken(authResponse.getToken(), storedToken.realmId);
}

/**
 * Best-effort revoke of a QuickBooks token at Intuit. Never throws.
 */
async function revokeToken(storedToken) {
  if (config.qbMock || !storedToken) return;
  try {
    const client = getClient();
    client.setToken(storedToken);
    await client.revoke();
  } catch (e) {
    console.error('[QB revoke] failed (ignored):', e.error || e.message);
  }
}

/**
 * Return a valid token, refreshing if expired. `onRefresh(newToken)` is called
 * when a refresh happens so the caller can persist it.
 */
async function ensureFreshToken(storedToken, onRefresh) {
  if (isAccessTokenValid(storedToken)) return storedToken;
  const refreshed = await refreshToken(storedToken);
  if (onRefresh) await onRefresh(refreshed);
  return refreshed;
}

function qbApiBase() {
  return config.qbEnvironment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function mockInvoices() {
  const now = new Date().toISOString().slice(0, 10);
  return [
    {
      Id: `QB-${Date.now()}`,
      DocNumber: `INV-${Math.floor(Math.random() * 9000) + 1000}`,
      TxnDate: now,
      CurrencyRef: { value: 'NGN' },
      CustomerRef: { name: 'Demo Customer Ltd' },
      BillEmail: { Address: 'customer@example.com' },
      TotalAmt: 10750,
      Line: [
        {
          DetailType: 'SalesItemLineDetail',
          Amount: 10000,
          SalesItemLineDetail: {
            Qty: 10,
            UnitPrice: 1000,
            ItemRef: { name: 'Consulting' },
          },
        },
      ],
    },
  ];
}

/**
 * Fetch invoices from QuickBooks updated since `sinceIso` (ISO timestamp or null).
 */
async function fetchInvoices(storedToken, realmId, sinceIso) {
  if (config.qbMock) {
    return mockInvoices();
  }

  const client = getClient();
  client.setToken(storedToken);

  let query = 'SELECT * FROM Invoice';
  if (sinceIso) {
    query += ` WHERE Metadata.LastUpdatedTime > '${sinceIso}'`;
  }
  query += ' ORDERBY MetaData.LastUpdatedTime ASC MAXRESULTS 100';

  const url = `${qbApiBase()}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
  const response = await client.makeApiCall({
    url,
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  const data = response.json || response.data || {};
  return data.QueryResponse?.Invoice || [];
}

/**
 * Fetch QuickBooks company information to confirm the connection and identify
 * the company. Returns a small subset suitable for display/storage.
 */
async function getCompanyInfo(storedToken, realmId) {
  if (config.qbMock) {
    return {
      companyName: 'Mock Company Ltd',
      legalName: 'Mock Company Ltd',
      country: 'NG',
      email: 'company@example.com',
    };
  }

  const client = getClient();
  client.setToken(storedToken);

  const url = `${qbApiBase()}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`;
  const response = await client.makeApiCall({
    url,
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  const data = response.json || response.data || {};
  const ci = data.CompanyInfo || {};
  return {
    companyName: ci.CompanyName || null,
    legalName: ci.LegalName || ci.CompanyName || null,
    country: ci.Country || null,
    email: ci.Email?.Address || null,
    fetchedAt: new Date().toISOString(),
  };
}

// Encrypt a slim token bundle for storage at rest (AES-256-GCM).
function encodeToken(tokenObj) {
  return tokenCrypto.encryptJson(tokenObj);
}

// Decode a stored token. Handles both the encrypted string format and legacy
// plaintext objects stored before encryption was introduced.
function decodeToken(stored) {
  if (!stored) return null;
  if (typeof stored === 'object') return stored; // legacy plaintext object
  if (tokenCrypto.isEncrypted(stored)) return tokenCrypto.decryptJson(stored);
  // Legacy plaintext JSON string fallback.
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
  fetchInvoices,
  getCompanyInfo,
  revokeToken,
  encodeToken,
  decodeToken,
};
