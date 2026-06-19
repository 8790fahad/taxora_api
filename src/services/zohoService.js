const config = require('../config');
const tokenCrypto = require('../utils/tokenCrypto');

// Zoho is region-specific. Each data center has its own accounts (OAuth) and
// API domains. The api_domain is also returned in the token response, but we
// need the accounts domain to build the authorize/token URLs.
const REGION_DOMAINS = {
  com: { accounts: 'accounts.zoho.com', api: 'www.zohoapis.com' },
  eu: { accounts: 'accounts.zoho.eu', api: 'www.zohoapis.eu' },
  in: { accounts: 'accounts.zoho.in', api: 'www.zohoapis.in' },
  'com.au': { accounts: 'accounts.zoho.com.au', api: 'www.zohoapis.com.au' },
  au: { accounts: 'accounts.zoho.com.au', api: 'www.zohoapis.com.au' },
  jp: { accounts: 'accounts.zoho.jp', api: 'www.zohoapis.jp' },
  ca: { accounts: 'accounts.zohocloud.ca', api: 'www.zohoapis.ca' },
  sa: { accounts: 'accounts.zoho.sa', api: 'www.zohoapis.sa' },
};

const ZOHO_SCOPE = 'ZohoBooks.invoices.READ,ZohoBooks.contacts.READ,ZohoBooks.settings.READ';

// `location` values Zoho returns in the OAuth callback -> accounts server.
const LOCATION_TO_ACCOUNTS = {
  us: 'https://accounts.zoho.com',
  eu: 'https://accounts.zoho.eu',
  in: 'https://accounts.zoho.in',
  au: 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp',
  ca: 'https://accounts.zohocloud.ca',
  sa: 'https://accounts.zoho.sa',
  uk: 'https://accounts.zoho.uk',
};

// The DC we *start* auth at. Zoho automatically redirects the user to their own
// data center, and the callback tells us which one via `accounts-server`.
function defaultDomains() {
  return REGION_DOMAINS[config.zohoRegion] || REGION_DOMAINS.com;
}

// Resolve the accounts server (OAuth host) for a given callback. Prefer the
// `accounts-server` param Zoho sends; fall back to mapping `location`; finally
// fall back to the configured default DC.
function resolveAccountsServer({ accountsServer, location } = {}) {
  if (accountsServer) return accountsServer.replace(/\/$/, '');
  if (location && LOCATION_TO_ACCOUNTS[location]) return LOCATION_TO_ACCOUNTS[location];
  return `https://${defaultDomains().accounts}`;
}

function assertConfigured() {
  if (!config.zohoClientId || !config.zohoClientSecret) {
    throw new Error(
      'Zoho is not configured. Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET, or ZOHO_MOCK=true.'
    );
  }
}

/**
 * Build the Zoho authorization URL. `state` is our signed JWT identifying the
 * tenant/user. access_type=offline so we receive a refresh token.
 */
function buildAuthorizeUrl(state) {
  if (config.zohoMock) {
    return `${config.zohoRedirectUri}?mock=1&state=${encodeURIComponent(state)}`;
  }
  assertConfigured();
  const params = new URLSearchParams({
    scope: ZOHO_SCOPE,
    client_id: config.zohoClientId,
    response_type: 'code',
    redirect_uri: config.zohoRedirectUri,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  // Start at the configured DC; Zoho redirects the user to their home DC and
  // reports it back via `accounts-server`/`location` on the callback.
  return `https://${defaultDomains().accounts}/oauth/v2/auth?${params.toString()}`;
}

async function postToken(accountsServer, params) {
  const res = await fetch(`${accountsServer}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Zoho token error: ${data.error || res.status}`);
  }
  return data;
}

function slimToken(raw, accountsServer, existing = {}) {
  return {
    access_token: raw.access_token,
    // Zoho only returns refresh_token on the first authorization, not refreshes.
    refresh_token: raw.refresh_token || existing.refresh_token || null,
    api_domain: raw.api_domain || existing.api_domain || `https://${defaultDomains().api}`,
    // Persist the per-connection DC so refresh/revoke hit the right host.
    accounts_server: accountsServer || existing.accounts_server || `https://${defaultDomains().accounts}`,
    token_type: raw.token_type || 'Bearer',
    expires_in: raw.expires_in || 3600,
    createdAt: Date.now(),
  };
}

/**
 * Exchange the authorization code for tokens. `callbackParams` carries Zoho's
 * `accounts-server` / `location` so we exchange against the user's own DC.
 */
async function exchangeCallback(code, callbackParams = {}) {
  if (config.zohoMock) {
    return {
      mock: true,
      location: 'us',
      token: {
        access_token: `mock-access-${Date.now()}`,
        refresh_token: `mock-refresh-${Date.now()}`,
        api_domain: `https://${defaultDomains().api}`,
        accounts_server: `https://${defaultDomains().accounts}`,
        token_type: 'Bearer',
        expires_in: 3600,
        createdAt: Date.now(),
      },
    };
  }
  assertConfigured();
  const accountsServer = resolveAccountsServer(callbackParams);
  const raw = await postToken(accountsServer, {
    grant_type: 'authorization_code',
    client_id: config.zohoClientId,
    client_secret: config.zohoClientSecret,
    redirect_uri: config.zohoRedirectUri,
    code,
  });
  return {
    mock: false,
    location: callbackParams.location || null,
    token: slimToken(raw, accountsServer),
  };
}

function isAccessTokenValid(storedToken) {
  if (!storedToken || !storedToken.createdAt || !storedToken.expires_in) return false;
  const expiresAt = storedToken.createdAt + (storedToken.expires_in - 60) * 1000;
  return Date.now() < expiresAt;
}

async function refreshToken(storedToken) {
  if (config.zohoMock) {
    return { ...storedToken, access_token: `mock-access-${Date.now()}`, createdAt: Date.now() };
  }
  assertConfigured();
  if (!storedToken?.refresh_token) {
    throw new Error('Zoho refresh token missing — reconnect required');
  }
  const accountsServer = storedToken.accounts_server || `https://${defaultDomains().accounts}`;
  const raw = await postToken(accountsServer, {
    grant_type: 'refresh_token',
    client_id: config.zohoClientId,
    client_secret: config.zohoClientSecret,
    refresh_token: storedToken.refresh_token,
  });
  return slimToken(raw, accountsServer, storedToken);
}

async function ensureFreshToken(storedToken, onRefresh) {
  if (isAccessTokenValid(storedToken)) return storedToken;
  const refreshed = await refreshToken(storedToken);
  if (onRefresh) await onRefresh(refreshed);
  return refreshed;
}

function apiBase(storedToken) {
  return storedToken?.api_domain || `https://${defaultDomains().api}`;
}

async function zohoApiGet(storedToken, path, query = {}) {
  const url = new URL(`${apiBase(storedToken)}/books/v3/${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Zoho-oauthtoken ${storedToken.access_token}`,
      Accept: 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Zoho API ${path} failed: ${data.message || res.status}`);
  }
  return data;
}

/**
 * Fetch the list of Zoho Books organizations for the connected user. The first
 * (or only) organization id scopes all subsequent invoice queries.
 */
async function getOrganizations(storedToken) {
  if (config.zohoMock) {
    return [
      {
        organization_id: 'MOCK-ORG',
        name: 'Mock Zoho Org',
        country: 'NG',
        currency_code: 'NGN',
      },
    ];
  }
  const data = await zohoApiGet(storedToken, 'organizations');
  return data.organizations || [];
}

function mockInvoices() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      invoice_id: `ZB-${Date.now()}`,
      invoice_number: `INV-${Math.floor(Math.random() * 9000) + 1000}`,
      date: today,
      due_date: today,
      currency_code: 'NGN',
      customer_id: 'zoho-cust-1',
      customer_name: 'Zoho Demo Customer Ltd',
      email: 'customer@example.com',
      total: 21500,
      line_items: [
        {
          name: 'Consulting Service',
          description: 'Advisory',
          rate: 10000,
          quantity: 2,
          item_total: 20000,
          tax_percentage: 7.5,
        },
      ],
    },
  ];
}

/**
 * Fetch invoices for an organization, optionally modified since a date.
 */
async function fetchInvoices(storedToken, organizationId, sinceIso) {
  if (config.zohoMock) {
    return mockInvoices();
  }
  const query = { organization_id: organizationId, per_page: 100, sort_column: 'date' };
  if (sinceIso) {
    query.last_modified_time = sinceIso;
  }
  const data = await zohoApiGet(storedToken, 'invoices', query);
  return data.invoices || [];
}

/**
 * Fetch a single invoice's full detail (line items + contact info).
 */
async function fetchInvoiceDetail(storedToken, organizationId, invoiceId) {
  if (config.zohoMock) {
    return mockInvoices()[0];
  }
  const data = await zohoApiGet(storedToken, `invoices/${invoiceId}`, {
    organization_id: organizationId,
  });
  return data.invoice || null;
}

async function revokeToken(storedToken) {
  if (config.zohoMock || !storedToken?.refresh_token) return;
  const accountsServer = storedToken.accounts_server || `https://${defaultDomains().accounts}`;
  try {
    await fetch(
      `${accountsServer}/oauth/v2/token/revoke?token=${encodeURIComponent(
        storedToken.refresh_token
      )}`,
      { method: 'POST' }
    );
  } catch (e) {
    console.error('[Zoho revoke] failed (ignored):', e.message);
  }
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
  getOrganizations,
  fetchInvoices,
  fetchInvoiceDetail,
  revokeToken,
  encodeToken,
  decodeToken,
};
