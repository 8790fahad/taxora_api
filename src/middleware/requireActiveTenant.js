const { AppError } = require('../utils/errors');

function requireActiveTenant(req, res, next) {
  if (!req.tenant) {
    return next(new AppError('Tenant context required', 403, 'TENANT_REQUIRED'));
  }

  if (!['ACTIVE', 'ERP_CONNECTED'].includes(req.tenant.status)) {
    return next(
      new AppError(
        'Invoice submission requires an ERP-connected tenant. Complete onboarding first.',
        403,
        'TENANT_NOT_ACTIVE'
      )
    );
  }

  next();
}

module.exports = { requireActiveTenant };
