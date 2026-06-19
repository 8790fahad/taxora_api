const { AppError } = require('../utils/errors');
const { normalizeOnboarding } = require('../services/onboardingService');

function requireOnboardingStep(step) {
  return (req, res, next) => {
    const onboarding = normalizeOnboarding(req.tenant?.onboarding);
    if (!onboarding[step]) {
      const messages = {
        register: 'Complete company registration before this action.',
        erp: 'Connect an ERP before this action.',
        subscribe: 'Subscribe to a plan before this action.',
      };
      return next(
        new AppError(messages[step] || 'Complete onboarding first.', 403, `ONBOARDING_${step.toUpperCase()}_REQUIRED`)
      );
    }
    next();
  };
}

module.exports = { requireOnboardingStep };
