const cacController = require('../controllers/cacController');

module.exports = (router) => {
  router.get('/cac/classifications', cacController.getClassifications);
  router.post('/cac/lookup', cacController.lookup);
};
