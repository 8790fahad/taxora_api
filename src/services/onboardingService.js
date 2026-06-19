const { validateTin } = require('./validationService');
const tenantUniqueness = require('./tenantUniquenessService');

const REGISTER_FIELDS = [
  'legal_name',
  'rc_number',
  'primary_phone',
  'address_line',
  'address_city',
  'address_country',
  'state',
  'company_classification',
  'tin',
];

const NRS_FIELDS = ['nrs_business_id', 'nrs_service_id'];

const PROFILE_FIELDS = ['logo_url', 'logo_width', 'logo_height'];

const ONBOARDING_KEYS = ['register', 'erp', 'subscribe'];
const DEFAULT_ONBOARDING = { register: false, erp: false, subscribe: false };

// The `onboarding` column is stored as longtext, so depending on the driver a
// read may return a string instead of a parsed object. Spreading a string with
// `{ ...str }` produces a char-indexed object ({0:'{',1:'"',...}) which, once
// re-saved and re-read, grows exponentially and eventually exceeds MySQL's
// max_allowed_packet. This helper always returns a clean {register,erp,subscribe}
// object, parsing JSON strings and discarding any corrupted/char-indexed values.
function normalizeOnboarding(raw) {
  let value = raw;
  for (let i = 0; i < 5 && typeof value === 'string'; i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
      break;
    }
  }

  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  // A valid onboarding object only ever has the three known boolean keys. If it
  // contains numeric keys it is corrupted char-indexed data, so fall back to
  // defaults rather than propagating the garbage.
  const isCorrupted = Object.keys(source).some((key) => /^\d+$/.test(key));
  const clean = { ...DEFAULT_ONBOARDING };
  if (!isCorrupted) {
    for (const key of ONBOARDING_KEYS) {
      clean[key] = !!source[key];
    }
  }
  return clean;
}

function isRegistrationComplete(tenant) {
  return REGISTER_FIELDS.every((field) => {
    const value = tenant[field];
    return value && String(value).trim().length > 0;
  });
}

function getOnboardingStatus(tenant, connections = [], subscription = null) {
  const onboarding = normalizeOnboarding(tenant.onboarding);
  const appReady = ['ACTIVE', 'ERP_CONNECTED'].includes(tenant.status);
  const blockers = [];

  if (!onboarding.register) {
    blockers.push({
      step: 'register',
      message: 'Complete company registration (RC, company details, state)',
    });
  }

  if (!onboarding.erp) {
    blockers.push({
      step: 'erp',
      message: 'Connect and test an ERP integration',
    });
  }

  if (!appReady) {
    blockers.push({
      step: 'activation',
      message: `Tenant status is ${tenant.status}. Connect an ERP to go live.`,
    });
  }

  const steps = [
    {
      key: 'register',
      label: 'Register',
      complete: !!onboarding.register,
      description: 'Company profile from CAC (RC, name, phone, address, state)',
    },
    {
      key: 'erp',
      label: 'Connect ERP',
      complete: !!onboarding.erp,
      description: 'Authorize QuickBooks, Sage, or Manual connector',
    },
  ];

  return {
    status: tenant.status,
    onboarding,
    steps,
    blockers,
    connectionsCount: connections.length,
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          planId: subscription.plan_id,
          activeUntil: subscription.active_until,
        }
      : null,
    canSubmitInvoices: appReady,
  };
}

async function updateTenantRegistration(tenant, data) {
  const updates = {};
  const allFields = [...REGISTER_FIELDS, ...NRS_FIELDS, ...PROFILE_FIELDS];
  for (const field of allFields) {
    if (data[field] !== undefined) {
      updates[field] = data[field];
    }
  }

  if (data.company_name !== undefined && data.legal_name === undefined) {
    updates.legal_name = data.company_name;
  }

  if (updates.tin) {
    const tinCheck = validateTin(updates.tin);
    if (!tinCheck.valid) {
      const err = new Error(tinCheck.message);
      err.statusCode = 400;
      err.code = 'INVALID_TIN';
      throw err;
    }
  }

  if (updates.rc_number !== undefined) {
    updates.rc_number = await tenantUniqueness.assertRcAvailable(
      updates.rc_number,
      tenant.id
    );
  }

  Object.assign(tenant, updates);

  const onboarding = normalizeOnboarding(tenant.onboarding);
  if (isRegistrationComplete(tenant)) {
    onboarding.register = true;
    if (['DRAFT'].includes(tenant.status)) {
      tenant.status = 'REGISTERED';
    }
  }
  tenant.onboarding = onboarding;
  await tenant.save();
  return tenant;
}

async function markErpConnected(tenant) {
  const onboarding = { ...normalizeOnboarding(tenant.onboarding), erp: true };
  tenant.onboarding = onboarding;
  if (['DRAFT', 'REGISTERED', 'ERP_CONNECTED'].includes(tenant.status)) {
    tenant.status = 'ACTIVE';
  }
  await tenant.save();
  return tenant;
}

async function markSubscribed(tenant) {
  const onboarding = { ...normalizeOnboarding(tenant.onboarding), subscribe: true };
  tenant.onboarding = onboarding;
  tenant.status = 'SUBSCRIBED';
  await tenant.save();
  tenant.status = 'ACTIVE';
  await tenant.save();
  return tenant;
}

module.exports = {
  REGISTER_FIELDS,
  NRS_FIELDS,
  normalizeOnboarding,
  isRegistrationComplete,
  getOnboardingStatus,
  updateTenantRegistration,
  markErpConnected,
  markSubscribed,
};
