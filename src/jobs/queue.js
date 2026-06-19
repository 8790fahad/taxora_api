const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');

let connection;
let invoiceQueue;

function getConnection() {
  if (!connection) {
    connection = new IORedis(config.redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

function getInvoiceQueue() {
  if (!invoiceQueue) {
    invoiceQueue = new Queue('invoice-processing', {
      connection: getConnection(),
    });
  }
  return invoiceQueue;
}

module.exports = { getConnection, getInvoiceQueue };
