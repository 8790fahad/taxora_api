const { Queue, Worker } = require('bullmq');
const config = require('../config');
const { getConnection } = require('./queue');

// Scheduled ERP sync. A single repeatable BullMQ job runs every
// ERP_AUTO_SYNC_HOURS and pulls invoices for every connected ERP across all
// active tenants. Manual sync still happens via the per-ERP /sync endpoints.

const QUEUE_NAME = 'erp-auto-sync';
const REPEAT_JOB_ID = 'erp-auto-sync-cron';
const ACTIVE_STATUSES = ['ACTIVE', 'ERP_CONNECTED'];
const VALID_SCHEDULES = ['hourly', 'daily', 'weekly', 'off'];
const SCHEDULE_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

function isConnectionDue(connection) {
  const schedule = connection.config?.syncSchedule || 'hourly';
  if (schedule === 'off' || !VALID_SCHEDULES.includes(schedule)) return false;
  const interval = SCHEDULE_MS[schedule];
  if (!connection.last_sync_at) return true;
  const elapsed = Date.now() - new Date(connection.last_sync_at).getTime();
  return elapsed >= interval;
}

let autoSyncQueue;

function getAutoSyncQueue() {
  if (!autoSyncQueue) {
    autoSyncQueue = new Queue(QUEUE_NAME, { connection: getConnection() });
  }
  return autoSyncQueue;
}

function getSyncers() {
  return {
    quickbooks: require('../services/quickbooksSyncService'),
    zoho: require('../services/zohoSyncService'),
    odoo: require('../services/odooSyncService'),
    tally: require('../services/tallySyncService'),
    sage: require('../services/sageSyncService'),
    flowbooks: require('../services/flowbooksSyncService'),
  };
}

// Run one full sync pass over all connected ERPs. Failures on one connection
// never abort the rest; each is logged and counted.
async function runAutoSync() {
  const db = require('../models');
  const syncers = getSyncers();
  const types = Object.keys(syncers);

  const connections = await db.ErpConnection.findAll({
    where: { status: 'connected', connector_type: types },
    include: [{ model: db.Tenant }],
  });

  const startedAt = Date.now();
  let synced = 0;
  let skipped = 0;
  let createdTotal = 0;
  const failures = [];

  for (const connection of connections) {
    const tenant = connection.Tenant;
    if (!tenant || !ACTIVE_STATUSES.includes(tenant.status)) continue;
    const syncer = syncers[connection.connector_type];
    if (!syncer) continue;
    if (!isConnectionDue(connection)) {
      skipped += 1;
      continue;
    }

    try {
      const result = await syncer.syncTenant(tenant);
      synced += 1;
      createdTotal += result.created || 0;
      console.log(
        `[auto-sync] ${connection.connector_type} tenant=${tenant.id} created=${result.created} skipped=${result.skipped}`
      );
    } catch (err) {
      failures.push({ connectorType: connection.connector_type, tenantId: tenant.id, error: err.message });
      console.error(
        `[auto-sync] ${connection.connector_type} tenant=${tenant.id} FAILED: ${err.message}`
      );
    }
  }

  console.log(
    `[auto-sync] pass complete in ${Date.now() - startedAt}ms: connections=${connections.length} synced=${synced} skipped=${skipped} created=${createdTotal} failed=${failures.length}`
  );

  return { connections: connections.length, synced, skipped, created: createdTotal, failures };
}

/**
 * Start the auto-sync worker and (re)register the repeatable job. Retries failed
 * passes with exponential backoff. Returns the Worker instance.
 */
async function startSyncScheduler() {
  const worker = new Worker(QUEUE_NAME, async () => runAutoSync(), {
    connection: getConnection(),
  });

  worker.on('failed', (job, err) => {
    console.error(`[auto-sync] job ${job?.id} failed: ${err.message}`);
  });

  const hours = config.erpAutoSyncHours;
  if (hours > 0) {
    const queue = getAutoSyncQueue();
    // Clear any stale repeatable definitions so an interval change takes effect.
    const existing = await queue.getRepeatableJobs().catch(() => []);
    await Promise.all(
      existing
        .filter((j) => j.id === REPEAT_JOB_ID)
        .map((j) => queue.removeRepeatableByKey(j.key))
    );

    await queue.add(
      'auto-sync',
      {},
      {
        repeat: { every: hours * 60 * 60 * 1000 },
        jobId: REPEAT_JOB_ID,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: 50,
        removeOnFail: 50,
      }
    );
    console.log(`[auto-sync] scheduled every ${hours}h`);
  }

  return worker;
}

module.exports = { startSyncScheduler, runAutoSync, getAutoSyncQueue };
