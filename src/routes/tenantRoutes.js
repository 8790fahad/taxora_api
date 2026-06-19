const tenantController = require('../controllers/tenantController');
const { authenticateJWT } = require('../middleware/auth');
const { attachCurrentTenant } = require('../middleware/tenantScope');

module.exports = (router) => {
  router.patch(
    '/tenants/current',
    authenticateJWT,
    attachCurrentTenant,
    tenantController.updateCurrentTenant
  );
  router.get(
    '/tenants/current/onboarding',
    authenticateJWT,
    attachCurrentTenant,
    tenantController.getOnboarding
  );
};
