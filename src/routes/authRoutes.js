const { body } = require('express-validator');
const authController = require('../controllers/authController');
const { authenticateJWT } = require('../middleware/auth');
const { attachCurrentTenant } = require('../middleware/tenantScope');

const signupValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('rc_number').trim().notEmpty().withMessage('RC Number is required'),
  body('tin').trim().notEmpty().withMessage('TIN is required'),
  body('nrs_business_id').trim().notEmpty().withMessage('NRS Business ID is required'),
  body('nrs_service_id').trim().notEmpty().withMessage('NRS Service ID is required'),
];

const setPasswordValidation = [
  body('token').notEmpty().withMessage('Verification token is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
];

const loginValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

module.exports = (router) => {
  router.post('/auth/signup', signupValidation, authController.signup);
  router.post('/auth/verify-email', authController.verifyEmail);
  router.post('/auth/set-password', setPasswordValidation, authController.setPassword);
  router.post('/auth/login', loginValidation, authController.login);
  router.get('/auth/me', authenticateJWT, attachCurrentTenant, authController.me);
  router.get('/admin/profile-reviews', authController.listPendingProfiles);
  router.post('/admin/tenants/:tenantId/approve-profile', authController.approveProfile);
};
