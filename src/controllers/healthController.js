const db = require('../models');
const { getConnection } = require('../jobs/queue');

async function health(req, res) {
  const checks = { api: 'ok', database: 'unknown', redis: 'unknown' };

  try {
    await db.sequelize.authenticate();
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  try {
    const redis = getConnection();
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'error';
  } catch {
    checks.redis = 'error';
  }

  const healthy = checks.database === 'ok' && checks.redis === 'ok';
  res.status(healthy ? 200 : 503).json(checks);
}

module.exports = { health };
