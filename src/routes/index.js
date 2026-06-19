const express = require('express');
const authRoutes = require('./authRoutes');
const tenantRoutes = require('./tenantRoutes');
const connectionRoutes = require('./connectionRoutes');
const billingRoutes = require('./billingRoutes');
const invoiceRoutes = require('./invoiceRoutes');
const webhookRoutes = require('./webhookRoutes');
const healthRoutes = require('./healthRoutes');
const cacRoutes = require('./cacRoutes');

const router = express.Router();

authRoutes(router);
tenantRoutes(router);
connectionRoutes(router);
billingRoutes(router);
invoiceRoutes(router);
webhookRoutes(router);
healthRoutes(router);
cacRoutes(router);

module.exports = router;
