const webhookController = require('../controllers/webhookController');

module.exports = (router) => {
  router.post('/webhooks/remita', webhookController.remitaWebhook);
};
