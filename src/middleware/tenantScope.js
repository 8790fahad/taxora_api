const db = require('../models');
const { AppError } = require('../utils/errors');

async function attachCurrentTenant(req, res, next) {
  try {
    const tenantUser = await db.TenantUser.findOne({
      where: { user_id: req.userId },
      include: [{ model: db.Tenant }],
    });

    if (!tenantUser || !tenantUser.Tenant) {
      throw new AppError('No tenant found for user', 404, 'TENANT_NOT_FOUND');
    }

    req.tenant = tenantUser.Tenant;
    req.tenantId = tenantUser.Tenant.id;
    req.tenantRole = tenantUser.role;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { attachCurrentTenant };
