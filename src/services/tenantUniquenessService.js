const { Op } = require('sequelize');
const db = require('../models');
const { AppError } = require('../utils/errors');
const { normalizeRcNumber } = require('./cacService');

function normalizeRcForStorage(rcNumber) {
  const normalized = normalizeRcNumber(rcNumber);
  return normalized || null;
}

async function findTenantByRc(rcNumber, excludeTenantId = null) {
  const normalized = normalizeRcForStorage(rcNumber);
  if (!normalized) return null;

  const where = { rc_number: normalized };
  if (excludeTenantId) {
    where.id = { [Op.ne]: excludeTenantId };
  }

  return db.Tenant.findOne({ where });
}

async function assertRcAvailable(rcNumber, excludeTenantId = null) {
  const normalized = normalizeRcForStorage(rcNumber);
  if (!normalized) {
    throw new AppError('RC Number is required', 400, 'VALIDATION_ERROR');
  }

  const existing = await findTenantByRc(normalized, excludeTenantId);
  if (existing) {
    throw new AppError(
      'This RC Number is already registered with Taxora.',
      409,
      'RC_NUMBER_EXISTS'
    );
  }

  return normalized;
}

module.exports = {
  normalizeRcForStorage,
  findTenantByRc,
  assertRcAvailable,
};
