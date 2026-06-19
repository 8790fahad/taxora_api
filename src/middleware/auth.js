const jwt = require('jsonwebtoken');
const config = require('../config');
const { AppError } = require('../utils/errors');
const db = require('../models');

async function authenticateJWT(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await db.User.findByPk(payload.userId);
    if (!user) {
      throw new AppError('Invalid token', 401, 'UNAUTHORIZED');
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return next(new AppError('Invalid or expired token', 401, 'UNAUTHORIZED'));
    }
    next(err);
  }
}

module.exports = { authenticateJWT };
