const invoiceController = require('../controllers/invoiceController');
const { authenticateJWT } = require('../middleware/auth');
const { attachCurrentTenant } = require('../middleware/tenantScope');
const { requireActiveTenant } = require('../middleware/requireActiveTenant');

module.exports = (router) => {
  router.get(
    '/invoices',
    authenticateJWT,
    attachCurrentTenant,
    requireActiveTenant,
    invoiceController.listInvoices
  );
  router.get(
    '/invoices/:id',
    authenticateJWT,
    attachCurrentTenant,
    requireActiveTenant,
    invoiceController.getInvoice
  );
  router.post(
    '/invoices',
    authenticateJWT,
    attachCurrentTenant,
    requireActiveTenant,
    invoiceController.createInvoice
  );
  router.post(
    '/invoices/:id/retry',
    authenticateJWT,
    attachCurrentTenant,
    requireActiveTenant,
    invoiceController.retryInvoice
  );
  router.get(
    '/invoices/:id/document',
    authenticateJWT,
    attachCurrentTenant,
    requireActiveTenant,
    invoiceController.getInvoiceDocument
  );
  router.post(
    '/invoices/:id/send',
    authenticateJWT,
    attachCurrentTenant,
    requireActiveTenant,
    invoiceController.sendInvoice
  );
};
