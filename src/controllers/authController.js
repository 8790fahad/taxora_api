const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const db = require('../models');
const config = require('../config');
const { AppError } = require('../utils/errors');
const emailService = require('../services/emailService');
const tenantUniqueness = require('../services/tenantUniquenessService');
const { formatTenantAddress } = require('../utils/address');

function formatUser(user) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    email_verified: !!user.email_verified_at,
    created_at: user.created_at,
  };
}

function formatTenant(tenant) {
  return {
    id: tenant.id,
    legal_name: tenant.legal_name,
    tin: tenant.tin,
    rc_number: tenant.rc_number,
    primary_phone: tenant.primary_phone,
    state: tenant.state,
    company_classification: tenant.company_classification,
    incorporation_date: tenant.incorporation_date,
    address: formatTenantAddress(tenant),
    nrs_business_id: tenant.nrs_business_id,
    nrs_service_id: tenant.nrs_service_id,
    logo_url: tenant.logo_url,
    logo_width: tenant.logo_width,
    logo_height: tenant.logo_height,
    profile_status: tenant.profile_status,
    verification_method: tenant.verification_method,
    status: tenant.status,
    onboarding: tenant.onboarding,
  };
}

function buildTenantFromSignup(body) {
  const onboarding = { register: false, erp: false, subscribe: false };
  const cacVerified = body.cac_verified === true || body.cac_verified === 'true';
  const tenantData = {
    legal_name: body.company_name || body.legal_name || null,
    rc_number: tenantUniqueness.normalizeRcForStorage(body.rc_number),
    primary_phone: body.primary_phone || null,
    state: body.state || null,
    company_classification: body.company_classification || null,
    tin: body.tin || null,
    address_line: body.address_line || null,
    address_city: body.address_city || null,
    address_country: body.address_country || 'NG',
    address_postal_zone: body.address_postal_zone || null,
    nrs_business_id: body.nrs_business_id || null,
    nrs_service_id: body.nrs_service_id || null,
    verification_method: cacVerified ? 'cac' : 'manual',
    profile_status: cacVerified ? 'verified' : 'pending_review',
    profile_verified_at: cacVerified ? new Date() : null,
    status: 'DRAFT',
    onboarding,
  };

  const registerFields = [
    'legal_name',
    'rc_number',
    'primary_phone',
    'state',
    'company_classification',
    'tin',
    'address_line',
    'address_city',
    'address_country',
    'nrs_business_id',
    'nrs_service_id',
  ];
  const complete = registerFields.every((f) => tenantData[f] && String(tenantData[f]).trim());
  if (complete) {
    onboarding.register = true;
    tenantData.status = 'REGISTERED';
  }

  return tenantData;
}

function signToken(userId) {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

function newVerification() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.verificationTtlHours * 60 * 60 * 1000);
  return { token, expires };
}

function requireAdminKey(req) {
  const adminKey = config.adminApiKey;
  if (!adminKey) {
    throw new AppError('Admin API is not configured', 503, 'ADMIN_NOT_CONFIGURED');
  }
  const provided = req.headers['x-admin-key'] || req.body.admin_key;
  if (provided !== adminKey) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
}

// Step 1 — Register company + email. No password yet.
// CAC-verified signups receive the email-verification link immediately.
// Manual signups receive a "profile under review" notice; the verification
// email is sent only after an admin approves the profile.
async function signup(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400, 'VALIDATION_ERROR');
    }

    const email = String(req.body.email || '').toLowerCase();
    const cacVerified = req.body.cac_verified === true || req.body.cac_verified === 'true';
    const rcNormalized = await tenantUniqueness.assertRcAvailable(req.body.rc_number);
    const { token, expires } = newVerification();
    const recipientName = req.body.company_name || req.body.legal_name;

    const existing = await db.User.findOne({ where: { email } });
    if (existing) {
      if (existing.password_hash) {
        throw new AppError('Email already registered. Please log in.', 409, 'EMAIL_EXISTS');
      }

      const tenantUser = await db.TenantUser.findOne({
        where: { user_id: existing.id },
        include: [{ model: db.Tenant }],
      });
      const pendingTenantId = tenantUser?.Tenant?.id;
      await tenantUniqueness.assertRcAvailable(rcNormalized, pendingTenantId);

      if (tenantUser?.Tenant) {
        Object.assign(tenantUser.Tenant, buildTenantFromSignup(req.body));
        await tenantUser.Tenant.save();
      }

      existing.verification_token = token;
      existing.verification_expires_at = expires;
      await existing.save();

      if (cacVerified) {
        const sent = await emailService.sendVerificationEmail({ to: email, token, recipientName });
        return res.status(200).json({
          message: 'Verification email re-sent. Please check your inbox.',
          email,
          profileStatus: 'verified',
          ...(sent.mock ? { devVerifyUrl: sent.url } : {}),
        });
      }

      await emailService.sendProfileReviewEmail({ to: email, recipientName });
      return res.status(200).json({
        message:
          'Your profile is under review. We will email you to verify your address once approved.',
        email,
        profileStatus: 'pending_review',
      });
    }

    await db.sequelize.transaction(async (transaction) => {
      const user = await db.User.create(
        {
          email,
          password_hash: null,
          full_name: null,
          verification_token: token,
          verification_expires_at: expires,
        },
        { transaction }
      );

      const tenant = await db.Tenant.create(buildTenantFromSignup(req.body), { transaction });

      await db.TenantUser.create(
        { tenant_id: tenant.id, user_id: user.id, role: 'owner' },
        { transaction }
      );
    });

    if (cacVerified) {
      const sent = await emailService.sendVerificationEmail({ to: email, token, recipientName });
      return res.status(201).json({
        message: 'Account created. Check your email to verify and set your password.',
        email,
        profileStatus: 'verified',
        ...(sent.mock ? { devVerifyUrl: sent.url } : {}),
      });
    }

    await emailService.sendProfileReviewEmail({ to: email, recipientName });
    return res.status(201).json({
      message:
        'Registration received. Your profile is under review — we will email you to verify your address once approved.',
      email,
      profileStatus: 'pending_review',
    });
  } catch (err) {
    next(err);
  }
}

// Step 2 — Confirm the email link is valid (before showing the set-password form).
async function verifyEmail(req, res, next) {
  try {
    const token = req.body.token || req.query.token;
    if (!token) {
      throw new AppError('Verification token is required', 400, 'VALIDATION_ERROR');
    }

    const user = await db.User.findOne({ where: { verification_token: token } });
    if (!user) {
      throw new AppError('Invalid or already-used verification link', 400, 'INVALID_TOKEN');
    }
    if (user.verification_expires_at && user.verification_expires_at < new Date()) {
      throw new AppError('Verification link has expired. Please register again.', 400, 'TOKEN_EXPIRED');
    }

    if (!user.email_verified_at) {
      user.email_verified_at = new Date();
      await user.save();
    }

    res.json({
      email: user.email,
      full_name: user.full_name,
      password_set: !!user.password_hash,
    });
  } catch (err) {
    next(err);
  }
}

// Step 3 — Set password using the verification token, then log in.
async function setPassword(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400, 'VALIDATION_ERROR');
    }

    const { token, password } = req.body;

    const user = await db.User.findOne({ where: { verification_token: token } });
    if (!user) {
      throw new AppError('Invalid or already-used verification link', 400, 'INVALID_TOKEN');
    }
    if (user.verification_expires_at && user.verification_expires_at < new Date()) {
      throw new AppError('Verification link has expired. Please register again.', 400, 'TOKEN_EXPIRED');
    }

    const tenantUser = await db.TenantUser.findOne({
      where: { user_id: user.id },
      include: [{ model: db.Tenant }],
    });

    user.password_hash = await bcrypt.hash(password, 10);
    user.full_name =
      tenantUser?.Tenant?.legal_name?.trim() ||
      user.email.split('@')[0] ||
      'Account Owner';
    user.email_verified_at = user.email_verified_at || new Date();
    user.verification_token = null;
    user.verification_expires_at = null;
    await user.save();

    const authToken = signToken(user.id);

    res.json({
      token: authToken,
      user: formatUser(user),
      tenant: tenantUser?.Tenant ? formatTenant(tenantUser.Tenant) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new AppError(errors.array()[0].msg, 400, 'VALIDATION_ERROR');
    }

    const { email, password } = req.body;
    const user = await db.User.findOne({ where: { email: String(email).toLowerCase() } });
    if (!user) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    if (!user.password_hash) {
      throw new AppError(
        'Finish setting up your account from the verification email before logging in.',
        403,
        'ACCOUNT_NOT_SET_UP'
      );
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const tenantUser = await db.TenantUser.findOne({
      where: { user_id: user.id },
      include: [{ model: db.Tenant }],
    });

    const token = signToken(user.id);

    res.json({
      token,
      user: formatUser(user),
      tenant: tenantUser?.Tenant ? formatTenant(tenantUser.Tenant) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    res.json({
      user: formatUser(req.user),
      tenant: formatTenant(req.tenant),
    });
  } catch (err) {
    next(err);
  }
}

async function listPendingProfiles(req, res, next) {
  try {
    requireAdminKey(req);

    const tenantUsers = await db.TenantUser.findAll({
      where: { role: 'owner' },
      include: [
        {
          model: db.Tenant,
          where: { profile_status: 'pending_review' },
        },
        { model: db.User },
      ],
      order: [[db.Tenant, 'created_at', 'ASC']],
    });

    res.json({
      data: tenantUsers.map((tenantUser) => ({
        tenant: formatTenant(tenantUser.Tenant),
        owner: tenantUser.User ? formatUser(tenantUser.User) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// Admin — approve a manually-registered company profile and send the
// email-verification link to the account owner.
async function approveProfile(req, res, next) {
  try {
    requireAdminKey(req);

    const tenantId = req.params.tenantId || req.body.tenant_id;
    if (!tenantId) {
      throw new AppError('tenant_id is required', 400, 'VALIDATION_ERROR');
    }

    const tenant = await db.Tenant.findByPk(tenantId);
    if (!tenant) {
      throw new AppError('Tenant not found', 404, 'NOT_FOUND');
    }
    if (tenant.profile_status === 'verified') {
      throw new AppError('Profile is already verified', 400, 'ALREADY_VERIFIED');
    }

    const tenantUser = await db.TenantUser.findOne({
      where: { tenant_id: tenant.id, role: 'owner' },
      include: [{ model: db.User }],
    });
    const user = tenantUser?.User;
    if (!user) {
      throw new AppError('No owner account found for this tenant', 404, 'NO_OWNER');
    }

    tenant.profile_status = 'verified';
    tenant.profile_verified_at = new Date();
    await tenant.save();

    const { token, expires } = newVerification();
    user.verification_token = token;
    user.verification_expires_at = expires;
    await user.save();

    const sent = await emailService.sendVerificationEmail({
      to: user.email,
      token,
      recipientName: tenant.legal_name,
    });

    res.json({
      message: 'Profile approved. Verification email sent to the account owner.',
      email: user.email,
      tenantId: tenant.id,
      ...(sent.mock ? { devVerifyUrl: sent.url } : {}),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  signup,
  verifyEmail,
  setPassword,
  login,
  me,
  listPendingProfiles,
  approveProfile,
};
