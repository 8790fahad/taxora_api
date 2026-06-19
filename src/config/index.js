require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // Dedicated AES-256 key for encrypting OAuth tokens at rest. Falls back to
  // JWT_SECRET for dev; set a strong, separate value in production.
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  frontendUrl: process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173',
  emailMock: process.env.EMAIL_MOCK !== 'false',
  mailtrapToken: process.env.MAILTRAP_TOKEN || '',
  mailFrom: process.env.MAIL_FROM || '"Taxora" <no-reply@inventria.app>',
  companyName: process.env.COMPANY_NAME || 'Taxora',
  companyLogoUrl:
    process.env.COMPANY_LOGO_URL ||
    'http://localhost:5173/brand/taxora-icon-192.svg',
  companyWebsite: process.env.COMPANY_WEBSITE || 'http://localhost:5173',
  companyEmail: process.env.COMPANY_EMAIL || 'hello@taxora.app',
  companyPhone: process.env.COMPANY_PHONE || '+2348067643479',
  companyTwitter: process.env.COMPANY_TWITTER || 'https://x.com/flowbooksng',
  companyInstagram: process.env.COMPANY_INSTAGRAM || 'https://www.instagram.com/flowbooksng',
  companyLinkedIn:
    process.env.COMPANY_LINKEDIN || 'https://www.linkedin.com/company/flowbooksng',
  companyFacebook:
    process.env.COMPANY_FACEBOOK ||
    process.env.COMPANY_FACESBOOK ||
    'https://www.facebook.com/flowbooksng',
  brandColor: process.env.BRAND_COLOR || '#0f766e',
  verificationTtlHours: parseInt(process.env.VERIFICATION_TTL_HOURS || '24', 10),
  remitaMock: process.env.REMITA_MOCK === 'true',
  remitaBaseUrl: process.env.REMITA_BASE_URL || 'https://api.remita.net',
  remitaMerchantId: process.env.REMITA_MERCHANT_ID || '',
  remitaServiceTypeId: process.env.REMITA_SERVICE_TYPE_ID || '',
  remitaApiKey: process.env.REMITA_API_KEY || '',
  remitaPublicKey: process.env.REMITA_PUBLIC_KEY || '',
  remitaInlineScript:
    process.env.REMITA_INLINE_SCRIPT ||
    'https://login.remita.net/payment/v1/remita-pay-inline.bundle.js',
  apiPublicUrl: process.env.API_PUBLIC_URL || 'http://localhost:4000',
  qbMock: process.env.QB_MOCK !== 'false',
  qbClientId: process.env.QB_CLIENT_ID || '',
  qbClientSecret: process.env.QB_CLIENT_SECRET || '',
  qbEnvironment: process.env.QB_ENVIRONMENT || 'sandbox',
  qbRedirectUri:
    process.env.QB_REDIRECT_URI ||
    `${process.env.API_PUBLIC_URL || 'http://localhost:4000'}/api/v1/connections/quickbooks/callback`,
  perInvoiceRateNgn: parseInt(process.env.PER_INVOICE_RATE_NGN || '10', 10),
  perInvoiceMinFundingNgn: parseInt(process.env.PER_INVOICE_MIN_FUNDING_NGN || '50000', 10),

  // Zoho Books OAuth. ZOHO_MOCK=true skips real OAuth for local dev.
  zohoMock: process.env.ZOHO_MOCK !== 'false',
  zohoClientId: process.env.ZOHO_CLIENT_ID || '',
  zohoClientSecret: process.env.ZOHO_CLIENT_SECRET || '',
  // Region: com | eu | in | com.au | jp | ca | sa (controls Zoho data center domains)
  zohoRegion: process.env.ZOHO_REGION || 'com',
  zohoRedirectUri:
    process.env.ZOHO_REDIRECT_URI ||
    `${process.env.API_PUBLIC_URL || 'http://localhost:4000'}/api/v1/connections/zoho/callback`,

  // Odoo (JSON-RPC). ODOO_MOCK=true returns sample data without a live Odoo
  // instance for local dev. Credentials are supplied per-connection (base URL,
  // database, username, API key) and encrypted at rest.
  odooMock: process.env.ODOO_MOCK === 'true',
  // TallyPrime (HTTP/XML). TALLY_MOCK=true returns sample XML without a running
  // Tally instance. Connection is by URL only (no credentials).
  tallyMock: process.env.TALLY_MOCK === 'true',

  // Sage (Intacct) OAuth 2.0 REST API. SAGE_MOCK=true skips real OAuth and
  // returns sample data for local dev. The OAuth/API hosts are configurable so
  // the same connector works across Sage environments.
  sageMock: process.env.SAGE_MOCK !== 'false',
  sageClientId: process.env.SAGE_CLIENT_ID || '',
  sageClientSecret: process.env.SAGE_CLIENT_SECRET || '',
  sageAuthUrl: process.env.SAGE_AUTH_URL || 'https://api.intacct.com/ia/api/v1/oauth2/authorize',
  sageTokenUrl: process.env.SAGE_TOKEN_URL || 'https://api.intacct.com/ia/api/v1/oauth2/token',
  sageApiBase: process.env.SAGE_API_BASE || 'https://api.intacct.com/ia/api/v1',
  sageScope: process.env.SAGE_SCOPE || 'openid offline_access',
  sageRedirectUri:
    process.env.SAGE_REDIRECT_URI ||
    `${process.env.API_PUBLIC_URL || 'http://localhost:4000'}/api/v1/connections/sage/callback`,

  // FlowBooks OAuth 2.0 REST API. FLOWBOOKS_MOCK=true skips real OAuth and
  // returns sample data for local dev. The OAuth/API hosts are configurable so
  // the same connector works across FlowBooks environments.
  flowbooksMock: process.env.FLOWBOOKS_MOCK !== 'false',
  flowbooksClientId: process.env.FLOWBOOKS_CLIENT_ID || '',
  flowbooksClientSecret: process.env.FLOWBOOKS_CLIENT_SECRET || '',
  flowbooksAuthUrl: process.env.FLOWBOOKS_AUTH_URL || 'https://app.flowbooks.ng/oauth/authorize',
  flowbooksTokenUrl: process.env.FLOWBOOKS_TOKEN_URL || 'https://app.flowbooks.ng/oauth/token',
  flowbooksApiBase: process.env.FLOWBOOKS_API_BASE || 'https://api.flowbooks.ng/v1',
  flowbooksScope: process.env.FLOWBOOKS_SCOPE || 'invoices.read customers.read offline_access',
  flowbooksRedirectUri:
    process.env.FLOWBOOKS_REDIRECT_URI ||
    `${process.env.API_PUBLIC_URL || 'http://localhost:4000'}/api/v1/connections/flowbooks/callback`,

  // Auto-sync interval (hours) for the scheduled ERP sync job. 0 disables it.
  erpAutoSyncHours: parseInt(process.env.ERP_AUTO_SYNC_HOURS || '1', 10),

  // NRS / FIRS e-invoicing (MBS) identifiers used when building the NRS payload.
  nrsAggregatorId: process.env.NRS_AGGREGATOR_ID || '',
  nrsMerchantId: process.env.NRS_MERCHANT_ID || '',
  nrsServiceId: process.env.NRS_SERVICE_ID || '',
  nrsInvoiceTypeCode: process.env.NRS_INVOICE_TYPE_CODE || '396',
  runWorker: process.env.RUN_WORKER === 'true',
  kirsCacUrl: process.env.KIRS_CAC_URL || 'https://etax.kirs.gov.ng/check-cac',
  kirsCsrfToken: process.env.KIRS_CSRF_TOKEN || '',
  // Secret key for admin-only endpoints (e.g. approve manual signup profiles).
  adminApiKey: process.env.ADMIN_API_KEY || '',
};
