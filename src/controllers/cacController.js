const cacService = require('../services/cacService');
const { COMPANY_CLASSIFICATIONS } = require('../constants/registration');
const { AppError } = require('../utils/errors');

async function lookup(req, res, next) {
  try {
    const { rc_number, rcNumber, classification } = req.body;
    const rc = rc_number || rcNumber;

    if (!rc || !classification) {
      throw new AppError('rc_number and classification are required', 400, 'VALIDATION_ERROR');
    }

    const result = await cacService.lookupCac(rc, classification);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getClassifications(req, res) {
  res.json({ data: COMPANY_CLASSIFICATIONS });
}

module.exports = { lookup, getClassifications };
