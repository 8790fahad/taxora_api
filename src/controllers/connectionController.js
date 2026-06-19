const jwt = require('jsonwebtoken');
const db = require('../models');
const config = require('../config');
const onboardingService = require('../services/onboardingService');
const quickbooksService = require('../services/quickbooksService');
const quickbooksSyncService = require('../services/quickbooksSyncService');
const zohoService = require('../services/zohoService');
const zohoSyncService = require('../services/zohoSyncService');
const odooService = require('../services/odooService');
const odooSyncService = require('../services/odooSyncService');
const tallyService = require('../services/tallyService');
const tallySyncService = require('../services/tallySyncService');
const sageService = require('../services/sageService');
const sageSyncService = require('../services/sageSyncService');
const flowbooksService = require('../services/flowbooksService');
const flowbooksSyncService = require('../services/flowbooksSyncService');
const { AppError } = require('../utils/errors');

// Strip secrets (OAuth tokens) from a connection before returning it to clients.
function sanitizeConnection(connection) {
  const json = connection.toJSON ? connection.toJSON() : connection;
  const cfg = json.config || {};
  const { token, ...safeConfig } = cfg;
  return { ...json, config: { ...safeConfig, hasToken: !!token } };
}

async function listConnections(req, res, next) {
  try {
    const connections = await db.ErpConnection.findAll({
      where: { tenant_id: req.tenantId },
      order: [['created_at', 'DESC']],
    });
    res.json({ data: connections.map(sanitizeConnection) });
  } catch (err) {
    next(err);
  }
}

async function createConnection(req, res, next) {
  try {
    const { connector_type } = req.body;
    const allowed = ['quickbooks', 'sage', 'zoho', 'manual'];
    if (!allowed.includes(connector_type)) {
      throw new AppError('Invalid connector_type', 400, 'INVALID_CONNECTOR');
    }

    let status = 'pending';
    let config = {};

    if (connector_type === 'manual') {
      status = 'connected';
      config = { mode: 'manual', note: 'MVP manual entry connector' };
    } else {
      // Phase 2: real OAuth flow for QuickBooks/Sage
      status = 'connected';
      config = {
        mode: 'stub',
        oauth: { access_token: 'stub-token', refresh_token: 'stub-refresh' },
        note: 'MVP stub — replace with real OAuth in Phase 2',
      };
    }

    const connection = await db.ErpConnection.create({
      tenant_id: req.tenantId,
      connector_type,
      status,
      config,
      health_status: status === 'connected' ? 'unknown' : null,
    });

    res.status(201).json({ connection });
  } catch (err) {
    next(err);
  }
}

async function testConnection(req, res, next) {
  try {
    const connection = await db.ErpConnection.findOne({
      where: { id: req.params.id, tenant_id: req.tenantId },
    });

    if (!connection) {
      throw new AppError('Connection not found', 404, 'CONNECTION_NOT_FOUND');
    }

    await connection.update({
      status: 'connected',
      health_status: 'OK',
      last_sync_at: new Date(),
    });

    await onboardingService.markErpConnected(req.tenant);
    await req.tenant.reload();

    res.json({
      connection,
      tenant: {
        id: req.tenant.id,
        status: req.tenant.status,
        onboarding: req.tenant.onboarding,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getConnectionHealth(req, res, next) {
  try {
    const connection = await db.ErpConnection.findOne({
      where: { id: req.params.id, tenant_id: req.tenantId },
    });

    if (!connection) {
      throw new AppError('Connection not found', 404, 'CONNECTION_NOT_FOUND');
    }

    res.json({
      id: connection.id,
      health_status: connection.health_status || 'unknown',
      last_sync_at: connection.last_sync_at,
      status: connection.status,
    });
  } catch (err) {
    next(err);
  }
}

// Step 1: return the QuickBooks authorization URL. `state` is a short-lived
// signed token so the browser-redirect callback can identify the tenant.
async function quickbooksAuthorize(req, res, next) {
  try {
    const state = jwt.sign(
      { tenantId: req.tenantId, userId: req.userId, purpose: 'qb_oauth' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const url = quickbooksService.buildAuthorizeUrl(state);
    res.json({ url, mock: config.qbMock });
  } catch (err) {
    next(err);
  }
}

// Step 2: QuickBooks redirects the browser back here with ?code & ?realmId.
// We verify state, exchange the code for tokens, persist the connection,
// then redirect back to the onboarding UI.
async function quickbooksCallback(req, res, next) {
  const redirectBase = `${config.frontendUrl}/onboarding`;
  try {
    const { state, realmId, error } = req.query;

    if (error) {
      return res.redirect(`${redirectBase}?qb=error`);
    }

    let payload;
    try {
      payload = jwt.verify(state, config.jwtSecret);
    } catch (e) {
      console.error('[QB callback] invalid state:', e.message);
      return res.redirect(`${redirectBase}?qb=error`);
    }
    if (payload.purpose !== 'qb_oauth') {
      console.error('[QB callback] wrong state purpose');
      return res.redirect(`${redirectBase}?qb=error`);
    }

    const callbackUrl = `${config.qbRedirectUri}?${new URLSearchParams(req.query).toString()}`;
    const result = await quickbooksService.exchangeCallback(callbackUrl, realmId);

    const tenant = await db.Tenant.findByPk(payload.tenantId);
    if (!tenant) {
      return res.redirect(`${redirectBase}?qb=error`);
    }

    // Confirm the connection and identify the company (best-effort — a failure
    // here must not block storing the connection).
    let companyInfo = null;
    try {
      companyInfo = await quickbooksService.getCompanyInfo(result.token, result.realmId);
      console.log(
        `[QB callback] connected company "${companyInfo?.companyName || 'unknown'}" realm=${result.realmId}`
      );
    } catch (ciErr) {
      console.error('[QB callback] company info fetch failed (ignored):', ciErr.error || ciErr.message);
    }

    const existing = await db.ErpConnection.findOne({
      where: { tenant_id: payload.tenantId, connector_type: 'quickbooks' },
    });

    // Preserve a previously chosen go-live date across reconnects; otherwise
    // default the initial sync date to now (only invoices from here onward sync).
    const existingInitial = existing?.config?.initialSyncDate;

    const connectionData = {
      status: 'connected',
      health_status: 'OK',
      last_sync_at: null,
      config: {
        mode: result.mock ? 'mock' : 'oauth',
        realmId: result.realmId,
        // Token is AES-256 encrypted at rest.
        token: quickbooksService.encodeToken(result.token),
        company: companyInfo,
        initialSyncDate: existingInitial || new Date().toISOString(),
      },
    };

    if (existing) {
      await existing.update(connectionData);
    } else {
      await db.ErpConnection.create({
        tenant_id: payload.tenantId,
        connector_type: 'quickbooks',
        ...connectionData,
      });
    }

    await onboardingService.markErpConnected(tenant);

    return res.redirect(`${redirectBase}?qb=connected`);
  } catch (err) {
    console.error('[QB callback] failed:', err.error || err.message, err.intuit_tid || '');
    if (!res.headersSent) {
      return res.redirect(`${redirectBase}?qb=error`);
    }
    next(err);
  }
}

// Step 1 (Zoho): return the Zoho authorization URL with a signed state token.
async function zohoAuthorize(req, res, next) {
  try {
    const state = jwt.sign(
      { tenantId: req.tenantId, userId: req.userId, purpose: 'zoho_oauth' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const url = zohoService.buildAuthorizeUrl(state);
    res.json({ url, mock: config.zohoMock });
  } catch (err) {
    next(err);
  }
}

// Step 2 (Zoho): Zoho redirects back with ?code & ?state. Verify state,
// exchange the code, fetch the organization, persist the encrypted token,
// then redirect back to the onboarding UI.
async function zohoCallback(req, res, next) {
  const redirectBase = `${config.frontendUrl}/onboarding`;
  try {
    const { state, code, error, location } = req.query;
    // Zoho sends the user's data center back as `accounts-server` (and `location`).
    const accountsServer = req.query['accounts-server'] || req.query.accounts_server;

    if (error) {
      return res.redirect(`${redirectBase}?zoho=error`);
    }

    let payload;
    try {
      payload = jwt.verify(state, config.jwtSecret);
    } catch (e) {
      console.error('[Zoho callback] invalid state:', e.message);
      return res.redirect(`${redirectBase}?zoho=error`);
    }
    if (payload.purpose !== 'zoho_oauth') {
      console.error('[Zoho callback] wrong state purpose');
      return res.redirect(`${redirectBase}?zoho=error`);
    }

    const result = await zohoService.exchangeCallback(code, { accountsServer, location });

    const tenant = await db.Tenant.findByPk(payload.tenantId);
    if (!tenant) {
      return res.redirect(`${redirectBase}?zoho=error`);
    }

    // Identify the Zoho organization (their equivalent of a company/realm).
    let organizationId = null;
    let companyInfo = null;
    try {
      const orgs = await zohoService.getOrganizations(result.token);
      const org = orgs[0];
      if (org) {
        organizationId = org.organization_id;
        companyInfo = {
          companyName: org.name || null,
          legalName: org.name || null,
          country: org.country || null,
          email: org.email || null,
          fetchedAt: new Date().toISOString(),
        };
      }
      console.log(
        `[Zoho callback] connected org "${companyInfo?.companyName || 'unknown'}" id=${organizationId}`
      );
    } catch (orgErr) {
      console.error('[Zoho callback] organization fetch failed (ignored):', orgErr.message);
    }

    const existing = await db.ErpConnection.findOne({
      where: { tenant_id: payload.tenantId, connector_type: 'zoho' },
    });
    const existingInitial = existing?.config?.initialSyncDate;

    const connectionData = {
      status: 'connected',
      health_status: 'OK',
      last_sync_at: null,
      config: {
        mode: result.mock ? 'mock' : 'oauth',
        // Per-connection data center, auto-detected from the OAuth callback.
        location: result.location || null,
        accountsServer: result.token.accounts_server || null,
        apiDomain: result.token.api_domain || null,
        organizationId,
        token: zohoService.encodeToken(result.token),
        company: companyInfo,
        initialSyncDate: existingInitial || new Date().toISOString(),
      },
    };

    if (existing) {
      await existing.update(connectionData);
    } else {
      await db.ErpConnection.create({
        tenant_id: payload.tenantId,
        connector_type: 'zoho',
        ...connectionData,
      });
    }

    await onboardingService.markErpConnected(tenant);

    return res.redirect(`${redirectBase}?zoho=connected`);
  } catch (err) {
    console.error('[Zoho callback] failed:', err.message);
    if (!res.headersSent) {
      return res.redirect(`${redirectBase}?zoho=error`);
    }
    next(err);
  }
}

// Pull invoices from Zoho Books into the Taxora pipeline.
async function zohoSync(req, res, next) {
  try {
    const result = await zohoSyncService.syncTenant(req.tenant);
    res.json({
      ...result,
      message: `Synced ${result.created} new invoice(s) from Zoho Books${
        result.skipped ? `, ${result.skipped} already imported` : ''
      }.`,
    });
  } catch (err) {
    next(err);
  }
}

// Connect (or reconnect) an Odoo instance. Validates credentials via JSON-RPC,
// then stores them AES-256 encrypted. Body: { baseUrl, database, username, apiKey }.
async function odooConnect(req, res, next) {
  try {
    const { baseUrl, database, username, apiKey } = req.body;
    const creds = { baseUrl, database, username, apiKey };

    let validation;
    try {
      validation = await odooService.validateConnection(creds);
    } catch (err) {
      throw new AppError(
        err.message || 'Could not connect to Odoo',
        400,
        err.code || 'ODOO_CONNECT_FAILED'
      );
    }

    const existing = await db.ErpConnection.findOne({
      where: { tenant_id: req.tenantId, connector_type: 'odoo' },
    });
    const existingInitial = existing?.config?.initialSyncDate;

    const connectionData = {
      status: 'connected',
      health_status: 'OK',
      last_sync_at: null,
      config: {
        mode: validation.mock ? 'mock' : 'jsonrpc',
        // Credentials (incl. API key) are encrypted at rest.
        credentials: odooService.encodeCredentials(creds),
        company: {
          companyName: odooService.normalizeBaseUrl(baseUrl),
          database,
          username,
          serverVersion: validation.serverVersion || null,
          uid: validation.uid,
        },
        initialSyncDate: existingInitial || new Date().toISOString(),
      },
    };

    let connection;
    if (existing) {
      connection = await existing.update(connectionData);
    } else {
      connection = await db.ErpConnection.create({
        tenant_id: req.tenantId,
        connector_type: 'odoo',
        ...connectionData,
      });
    }

    await onboardingService.markErpConnected(req.tenant);
    await req.tenant.reload();

    res.status(201).json({
      connection: sanitizeConnection(connection),
      tenant: {
        id: req.tenant.id,
        status: req.tenant.status,
        onboarding: req.tenant.onboarding,
      },
      message: 'Odoo connected successfully.',
    });
  } catch (err) {
    next(err);
  }
}

// Pull invoices from Odoo into the Taxora pipeline.
async function odooSync(req, res, next) {
  try {
    const result = await odooSyncService.syncTenant(req.tenant);
    res.json({
      ...result,
      message: `Synced ${result.created} new invoice(s) from Odoo${
        result.skipped ? `, ${result.skipped} already imported` : ''
      }.`,
    });
  } catch (err) {
    next(err);
  }
}

// Return the current Odoo connection status (never exposes credentials).
async function odooStatus(req, res, next) {
  try {
    const connection = await db.ErpConnection.findOne({
      where: { tenant_id: req.tenantId, connector_type: 'odoo' },
    });
    if (!connection) {
      return res.json({ connected: false });
    }
    const invoiceCount = await db.Invoice.count({
      where: { tenant_id: req.tenantId, erp_source: 'odoo' },
    });
    res.json({
      connected: connection.status === 'connected',
      connection: sanitizeConnection(connection),
      invoiceCount,
    });
  } catch (err) {
    next(err);
  }
}

// Test a Tally connection without persisting it. Body: { url, mode }.
async function tallyTest(req, res, next) {
  try {
    const { url, mode } = req.body;
    const result = await tallyService.testConnection({ url, mode });
    res.json({
      connectionStatus: 'success',
      companies: result.companies,
      mock: !!result.mock,
    });
  } catch (err) {
    if (err.code && err.code.startsWith('TALLY_')) {
      return res.status(400).json({ connectionStatus: 'fail', error: err.message, code: err.code });
    }
    next(err);
  }
}

// Connect (or reconnect) a Tally instance. Validates reachability via a test
// XML request, then stores the connection config (URL only — no credentials).
// Body: { url, companyName, mode, port }.
async function tallyConnect(req, res, next) {
  try {
    const { url, companyName, mode, port } = req.body;
    if (!url) {
      throw new AppError('Tally URL is required', 400, 'TALLY_MISSING_URL');
    }

    let test;
    try {
      test = await tallyService.testConnection({ url, mode });
    } catch (err) {
      throw new AppError(
        err.message || 'Could not connect to Tally',
        400,
        err.code || 'TALLY_CONNECT_FAILED'
      );
    }

    // Prefer the explicitly chosen company; otherwise the first one Tally reports.
    const resolvedCompany = companyName || test.companies?.[0] || null;

    const existing = await db.ErpConnection.findOne({
      where: { tenant_id: req.tenantId, connector_type: 'tally' },
    });
    const existingInitial = existing?.config?.initialSyncDate;

    const connectionData = {
      status: 'connected',
      health_status: 'OK',
      last_sync_at: null,
      config: {
        mode: mode || 'local',
        url: tallyService.normalizeUrl(url),
        port: port || 9000,
        companyName: resolvedCompany,
        company: resolvedCompany ? { companyName: resolvedCompany } : null,
        availableCompanies: test.companies || [],
        initialSyncDate: existingInitial || new Date().toISOString(),
      },
    };

    let connection;
    if (existing) {
      connection = await existing.update(connectionData);
    } else {
      connection = await db.ErpConnection.create({
        tenant_id: req.tenantId,
        connector_type: 'tally',
        ...connectionData,
      });
    }

    await onboardingService.markErpConnected(req.tenant);
    await req.tenant.reload();

    res.status(201).json({
      connection: sanitizeConnection(connection),
      tenant: {
        id: req.tenant.id,
        status: req.tenant.status,
        onboarding: req.tenant.onboarding,
      },
      message: 'Tally connected successfully.',
    });
  } catch (err) {
    next(err);
  }
}

// Pull sales vouchers from Tally into the Taxora pipeline.
async function tallySync(req, res, next) {
  try {
    const result = await tallySyncService.syncTenant(req.tenant);
    res.json({
      ...result,
      message: `Synced ${result.created} new invoice(s) from Tally${
        result.skipped ? `, ${result.skipped} already imported` : ''
      }.`,
    });
  } catch (err) {
    next(err);
  }
}

// Return the current Tally connection status (config carries no secrets).
async function tallyStatus(req, res, next) {
  try {
    const connection = await db.ErpConnection.findOne({
      where: { tenant_id: req.tenantId, connector_type: 'tally' },
    });
    if (!connection) {
      return res.json({ connected: false });
    }
    const invoiceCount = await db.Invoice.count({
      where: { tenant_id: req.tenantId, erp_source: 'tally' },
    });
    res.json({
      connected: connection.status === 'connected',
      connection: sanitizeConnection(connection),
      invoiceCount,
    });
  } catch (err) {
    next(err);
  }
}

// Step 1 (Sage): return the Sage authorization URL with a signed state token.
async function sageAuthorize(req, res, next) {
  try {
    const state = jwt.sign(
      { tenantId: req.tenantId, userId: req.userId, purpose: 'sage_oauth' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const url = sageService.buildAuthorizeUrl(state);
    res.json({ url, mock: config.sageMock });
  } catch (err) {
    next(err);
  }
}

// Step 2 (Sage): Sage redirects back with ?code & ?state. Verify state,
// exchange the code, fetch the company, persist the encrypted token, then
// redirect back to the onboarding UI.
async function sageCallback(req, res, next) {
  const redirectBase = `${config.frontendUrl}/onboarding`;
  try {
    const { state, code, error } = req.query;

    if (error) {
      return res.redirect(`${redirectBase}?sage=error`);
    }

    let payload;
    try {
      payload = jwt.verify(state, config.jwtSecret);
    } catch (e) {
      console.error('[Sage callback] invalid state:', e.message);
      return res.redirect(`${redirectBase}?sage=error`);
    }
    if (payload.purpose !== 'sage_oauth') {
      console.error('[Sage callback] wrong state purpose');
      return res.redirect(`${redirectBase}?sage=error`);
    }

    const result = await sageService.exchangeCallback(code);

    const tenant = await db.Tenant.findByPk(payload.tenantId);
    if (!tenant) {
      return res.redirect(`${redirectBase}?sage=error`);
    }

    let companyInfo = null;
    let companyId = null;
    try {
      const company = await sageService.getCompany(result.token);
      if (company) {
        companyId = company.companyId;
        companyInfo = {
          companyName: company.companyName || null,
          legalName: company.companyName || null,
          country: company.country || null,
          currency: company.currency || null,
          fetchedAt: new Date().toISOString(),
        };
      }
      console.log(
        `[Sage callback] connected company "${companyInfo?.companyName || 'unknown'}" id=${companyId}`
      );
    } catch (orgErr) {
      console.error('[Sage callback] company fetch failed (ignored):', orgErr.message);
    }

    const existing = await db.ErpConnection.findOne({
      where: { tenant_id: payload.tenantId, connector_type: 'sage' },
    });
    const existingInitial = existing?.config?.initialSyncDate;
    const existingTinOverrides = existing?.config?.tinOverrides;

    const connectionData = {
      status: 'connected',
      health_status: 'OK',
      last_sync_at: null,
      config: {
        mode: result.mock ? 'mock' : 'oauth',
        companyId,
        token: sageService.encodeToken(result.token),
        company: companyInfo,
        tinOverrides: existingTinOverrides || {},
        initialSyncDate: existingInitial || new Date().toISOString(),
      },
    };

    if (existing) {
      await existing.update(connectionData);
    } else {
      await db.ErpConnection.create({
        tenant_id: payload.tenantId,
        connector_type: 'sage',
        ...connectionData,
      });
    }

    await onboardingService.markErpConnected(tenant);

    return res.redirect(`${redirectBase}?sage=connected`);
  } catch (err) {
    console.error('[Sage callback] failed:', err.message);
    if (!res.headersSent) {
      return res.redirect(`${redirectBase}?sage=error`);
    }
    next(err);
  }
}

// Pull invoices from Sage into the Taxora pipeline.
async function sageSync(req, res, next) {
  try {
    const result = await sageSyncService.syncTenant(req.tenant);
    res.json({
      ...result,
      message: `Synced ${result.created} new invoice(s) from Sage${
        result.skipped ? `, ${result.skipped} already imported` : ''
      }.`,
    });
  } catch (err) {
    next(err);
  }
}

// Return the current Sage connection status (never exposes tokens).
async function sageStatus(req, res, next) {
  try {
    const connection = await db.ErpConnection.findOne({
      where: { tenant_id: req.tenantId, connector_type: 'sage' },
    });
    if (!connection) {
      return res.json({ connected: false });
    }
    const invoiceCount = await db.Invoice.count({
      where: { tenant_id: req.tenantId, erp_source: 'sage' },
    });
    res.json({
      connected: connection.status === 'connected',
      connection: sanitizeConnection(connection),
      invoiceCount,
      lastSyncAt: connection.last_sync_at,
      healthStatus: connection.health_status,
    });
  } catch (err) {
    next(err);
  }
}

// Step 1 (FlowBooks): return the FlowBooks authorization URL with a signed state token.
async function flowbooksAuthorize(req, res, next) {
  try {
    const state = jwt.sign(
      { tenantId: req.tenantId, userId: req.userId, purpose: 'flowbooks_oauth' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const url = flowbooksService.buildAuthorizeUrl(state);
    res.json({ url, mock: config.flowbooksMock });
  } catch (err) {
    next(err);
  }
}

// Step 2 (FlowBooks): FlowBooks redirects back with ?code & ?state. Verify
// state, exchange the code, fetch the org, persist the encrypted token, then
// redirect back to the onboarding UI.
async function flowbooksCallback(req, res, next) {
  const redirectBase = `${config.frontendUrl}/onboarding`;
  try {
    const { state, code, error } = req.query;

    if (error) {
      return res.redirect(`${redirectBase}?flowbooks=error`);
    }

    let payload;
    try {
      payload = jwt.verify(state, config.jwtSecret);
    } catch (e) {
      console.error('[FlowBooks callback] invalid state:', e.message);
      return res.redirect(`${redirectBase}?flowbooks=error`);
    }
    if (payload.purpose !== 'flowbooks_oauth') {
      console.error('[FlowBooks callback] wrong state purpose');
      return res.redirect(`${redirectBase}?flowbooks=error`);
    }

    const result = await flowbooksService.exchangeCallback(code);

    const tenant = await db.Tenant.findByPk(payload.tenantId);
    if (!tenant) {
      return res.redirect(`${redirectBase}?flowbooks=error`);
    }

    let companyInfo = null;
    let companyId = null;
    try {
      const company = await flowbooksService.getCompany(result.token);
      if (company) {
        companyId = company.companyId;
        companyInfo = {
          companyName: company.companyName || null,
          legalName: company.companyName || null,
          country: company.country || null,
          currency: company.currency || null,
          fetchedAt: new Date().toISOString(),
        };
      }
      console.log(
        `[FlowBooks callback] connected org "${companyInfo?.companyName || 'unknown'}" id=${companyId}`
      );
    } catch (orgErr) {
      console.error('[FlowBooks callback] company fetch failed (ignored):', orgErr.message);
    }

    const existing = await db.ErpConnection.findOne({
      where: { tenant_id: payload.tenantId, connector_type: 'flowbooks' },
    });
    const existingInitial = existing?.config?.initialSyncDate;
    const existingTinOverrides = existing?.config?.tinOverrides;

    const connectionData = {
      status: 'connected',
      health_status: 'OK',
      last_sync_at: null,
      config: {
        mode: result.mock ? 'mock' : 'oauth',
        companyId,
        token: flowbooksService.encodeToken(result.token),
        company: companyInfo,
        tinOverrides: existingTinOverrides || {},
        initialSyncDate: existingInitial || new Date().toISOString(),
      },
    };

    if (existing) {
      await existing.update(connectionData);
    } else {
      await db.ErpConnection.create({
        tenant_id: payload.tenantId,
        connector_type: 'flowbooks',
        ...connectionData,
      });
    }

    await onboardingService.markErpConnected(tenant);

    return res.redirect(`${redirectBase}?flowbooks=connected`);
  } catch (err) {
    console.error('[FlowBooks callback] failed:', err.message);
    if (!res.headersSent) {
      return res.redirect(`${redirectBase}?flowbooks=error`);
    }
    next(err);
  }
}

// Pull invoices from FlowBooks into the Taxora pipeline.
async function flowbooksSync(req, res, next) {
  try {
    const result = await flowbooksSyncService.syncTenant(req.tenant);
    res.json({
      ...result,
      message: `Synced ${result.created} new invoice(s) from FlowBooks${
        result.skipped ? `, ${result.skipped} already imported` : ''
      }.`,
    });
  } catch (err) {
    next(err);
  }
}

// Return the current FlowBooks connection status (never exposes tokens).
async function flowbooksStatus(req, res, next) {
  try {
    const connection = await db.ErpConnection.findOne({
      where: { tenant_id: req.tenantId, connector_type: 'flowbooks' },
    });
    if (!connection) {
      return res.json({ connected: false });
    }
    const invoiceCount = await db.Invoice.count({
      where: { tenant_id: req.tenantId, erp_source: 'flowbooks' },
    });
    res.json({
      connected: connection.status === 'connected',
      connection: sanitizeConnection(connection),
      invoiceCount,
      lastSyncAt: connection.last_sync_at,
      healthStatus: connection.health_status,
    });
  } catch (err) {
    next(err);
  }
}

// Disconnect (remove) an ERP connection. For QuickBooks, best-effort revoke
// the token at Intuit first.
async function disconnectConnection(req, res, next) {
  try {
    const connection = await db.ErpConnection.findOne({
      where: { id: req.params.id, tenant_id: req.tenantId },
    });

    if (!connection) {
      throw new AppError('Connection not found', 404, 'CONNECTION_NOT_FOUND');
    }

    if (connection.connector_type === 'quickbooks') {
      await quickbooksService.revokeToken(
        quickbooksService.decodeToken(connection.config?.token)
      );
    } else if (connection.connector_type === 'zoho') {
      await zohoService.revokeToken(zohoService.decodeToken(connection.config?.token));
    } else if (connection.connector_type === 'sage') {
      await sageService.revokeToken();
    } else if (connection.connector_type === 'flowbooks') {
      await flowbooksService.revokeToken();
    }

    await connection.destroy();

    // If no connected ERPs remain, clear the onboarding flag (without
    // downgrading an already-active tenant's status).
    const remaining = await db.ErpConnection.count({
      where: { tenant_id: req.tenantId, status: 'connected' },
    });
    if (remaining === 0) {
      req.tenant.onboarding = {
        ...onboardingService.normalizeOnboarding(req.tenant.onboarding),
        erp: false,
      };
      await req.tenant.save();
    }

    res.json({
      ok: true,
      tenant: {
        id: req.tenant.id,
        status: req.tenant.status,
        onboarding: req.tenant.onboarding,
      },
      message: `${connection.connector_type} disconnected.`,
    });
  } catch (err) {
    next(err);
  }
}

// Set sync settings for a connection: go-live date and/or automatic sync schedule.
// Body: { initialSyncDate?, syncSchedule?: 'hourly' | 'daily' | 'weekly' | 'off' }
async function updateSyncSettings(req, res, next) {
  try {
    const { initialSyncDate, syncSchedule } = req.body;
    const VALID_SCHEDULES = ['hourly', 'daily', 'weekly', 'off'];

    if (initialSyncDate === undefined && syncSchedule === undefined) {
      throw new AppError('Provide initialSyncDate and/or syncSchedule', 400, 'INVALID_BODY');
    }

    const connection = await db.ErpConnection.findOne({
      where: { id: req.params.id, tenant_id: req.tenantId },
    });
    if (!connection) {
      throw new AppError('Connection not found', 404, 'CONNECTION_NOT_FOUND');
    }

    const cfg = connection.config || {};
    const nextConfig = { ...cfg };

    if (initialSyncDate !== undefined) {
      if (!initialSyncDate || Number.isNaN(new Date(initialSyncDate).getTime())) {
        throw new AppError('A valid initialSyncDate is required', 400, 'INVALID_DATE');
      }
      nextConfig.initialSyncDate = new Date(initialSyncDate).toISOString();
    }

    if (syncSchedule !== undefined) {
      if (!VALID_SCHEDULES.includes(syncSchedule)) {
        throw new AppError(
          'syncSchedule must be hourly, daily, weekly, or off',
          400,
          'INVALID_SCHEDULE'
        );
      }
      nextConfig.syncSchedule = syncSchedule;
    }

    await connection.update({ config: nextConfig });

    const savedSchedule = connection.config.syncSchedule || 'hourly';
    const messages = [];
    if (initialSyncDate !== undefined) {
      messages.push('Go-live date saved');
    }
    if (syncSchedule !== undefined) {
      messages.push(`Sync schedule set to ${savedSchedule}`);
    }

    res.json({
      ok: true,
      initialSyncDate: connection.config.initialSyncDate,
      syncSchedule: savedSchedule,
      message: `${messages.join('. ')}.`,
    });
  } catch (err) {
    next(err);
  }
}

// Pull invoices from QuickBooks into the Taxora pipeline.
async function quickbooksSync(req, res, next) {
  try {
    const result = await quickbooksSyncService.syncTenant(req.tenant);
    res.json({
      ...result,
      message: `Synced ${result.created} new invoice(s) from QuickBooks${
        result.skipped ? `, ${result.skipped} already imported` : ''
      }.`,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listConnections,
  createConnection,
  testConnection,
  getConnectionHealth,
  quickbooksAuthorize,
  quickbooksCallback,
  quickbooksSync,
  zohoAuthorize,
  zohoCallback,
  zohoSync,
  odooConnect,
  odooSync,
  odooStatus,
  tallyTest,
  tallyConnect,
  tallySync,
  tallyStatus,
  sageAuthorize,
  sageCallback,
  sageSync,
  sageStatus,
  flowbooksAuthorize,
  flowbooksCallback,
  flowbooksSync,
  flowbooksStatus,
  updateSyncSettings,
  disconnectConnection,
};
