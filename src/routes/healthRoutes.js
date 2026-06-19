const healthController = require('../controllers/healthController');

module.exports = (router) => {
  router.get('/health', healthController.health);
};
