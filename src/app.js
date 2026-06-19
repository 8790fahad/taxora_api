require('dotenv').config();

const express = require('express');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const db = require('./models');
const { AppError, sendError } = require('./utils/errors');
const { startInvoiceWorker } = require('./jobs/invoiceProcessor');
const { startSyncScheduler } = require('./jobs/syncScheduler');

const app = express();

app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);
app.use(express.json());

app.use('/api/v1', routes);

app.use((err, req, res, next) => {
  console.error(err);

  if (err.name === 'SequelizeUniqueConstraintError') {
    const field = err.errors?.[0]?.path;
    if (field === 'email') {
      return sendError(
        res,
        new AppError('Email already registered. Please log in.', 409, 'EMAIL_EXISTS')
      );
    }
    if (field === 'rc_number') {
      return sendError(
        res,
        new AppError('This RC Number is already registered with Taxora.', 409, 'RC_NUMBER_EXISTS')
      );
    }
  }

  sendError(res, err);
});

async function start() {
  try {
    await db.sequelize.authenticate();
    console.log('Database connected');

    if (config.runWorker) {
      startInvoiceWorker();
      console.log('Invoice worker started');
      await startSyncScheduler();
    }

    app.listen(config.port, () => {
      console.log(`Taxora API listening on http://localhost:${config.port}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

module.exports = app;
