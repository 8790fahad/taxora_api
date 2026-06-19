const billingController = require('../controllers/billingController');
const { authenticateJWT } = require('../middleware/auth');
const { attachCurrentTenant } = require('../middleware/tenantScope');

module.exports = (router) => {
  router.get('/plans', billingController.listPlans);
  router.get('/dashboard', authenticateJWT, attachCurrentTenant, billingController.getDashboard);
  router.get('/billing/current', authenticateJWT, attachCurrentTenant, billingController.getCurrentBilling);
  router.post('/billing/checkout', authenticateJWT, attachCurrentTenant, billingController.checkout);
  router.post('/billing/verify', authenticateJWT, attachCurrentTenant, billingController.verifyPayment);
};
