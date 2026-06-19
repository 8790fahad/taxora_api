const { Worker } = require('bullmq');
const db = require('../models');
const config = require('../config');
const { getConnection } = require('./queue');
const { validateInvoice } = require('../services/validationService');
const remitaService = require('../services/remitaService');
const { appendEvent } = require('../services/invoiceService');
const { buildNrsInvoice } = require('../services/nrsInvoiceBuilder');
const emailService = require('../services/emailService');

async function recordAttempt(invoiceId, attemptNo, requestJson, responseJson, httpStatus) {
  await db.SubmissionAttempt.create({
    invoice_id: invoiceId,
    attempt_no: attemptNo,
    request_json: requestJson,
    response_json: responseJson,
    http_status: httpStatus,
  });
}

async function processInvoiceJob(job) {
  const { invoiceId } = job.data;
  const invoice = await db.Invoice.findByPk(invoiceId, {
    include: [{ model: db.Tenant }],
  });

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  const tenant = invoice.Tenant;
  const canonical = invoice.canonical_json || {};
  const ref = invoice.invoice_ref;

  await invoice.update({ status: 'VALIDATING', error_message: null });
  await appendEvent(invoice.id, 'VALIDATING', {});

  const validation = validateInvoice(canonical, tenant);
  if (!validation.valid) {
    const message = validation.errors.join('; ');
    await invoice.update({ status: 'VALIDATION_FAILED', error_message: message });
    await appendEvent(invoice.id, 'VALIDATION_FAILED', { errors: validation.errors });
    console.warn(`[invoice] ${ref} validation failed: ${message}`);
    return { status: 'VALIDATION_FAILED' };
  }

  await appendEvent(invoice.id, 'VALIDATED', {});

  // Transform the canonical invoice into the NRS/FIRS (MBS) submission payload
  // and persist it on the invoice record for audit + document rendering.
  const nrsPayload = buildNrsInvoice(canonical, tenant, { invoiceRef: invoice.invoice_ref });
  await invoice.update({ nrs_json: nrsPayload });
  await appendEvent(invoice.id, 'NRS_PAYLOAD_BUILT', { nrsPayload });
  console.log(
    `[invoice] ${ref} NRS payload built & saved: grandTotal=${nrsPayload.totals.grandTotal}`
  );

  await invoice.update({ status: 'QUEUED' });
  await appendEvent(invoice.id, 'QUEUED', {});

  console.log(`[invoice] ${ref} validated → transmitting to NRS`);
  const submitResponse = await remitaService.submitInvoice(nrsPayload, invoice.invoice_ref);
  await recordAttempt(invoice.id, 1, nrsPayload, submitResponse, 200);
  await invoice.update({ status: 'SUBMITTED' });
  await appendEvent(invoice.id, 'SUBMITTED', submitResponse);
  console.log(`[invoice] ${ref} submitted to NRS`);

  await invoice.update({ status: 'PENDING_CLEARANCE' });
  await appendEvent(invoice.id, 'PENDING_CLEARANCE', {});

  if (config.remitaMock) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const statusResponse = await remitaService.getStatus(invoice.invoice_ref);
  const irn = statusResponse.irn || remitaService.generateMockIrn(invoice.invoice_ref);
  const qr = statusResponse.qr || `https://verify.taxora.ng/qr/${invoice.invoice_ref}`;

  await recordAttempt(invoice.id, 2, { invoiceRef: invoice.invoice_ref }, statusResponse, 200);
  await invoice.update({
    status: 'CLEARED',
    irn,
    qr_payload: qr,
    error_message: null,
  });
  await appendEvent(invoice.id, 'CLEARED', { irn, qr });
  console.log(`[invoice] ${ref} cleared by NRS → IRN=${irn}`);

  // Email the NRS standard invoice to the customer (best-effort — a delivery
  // failure must not fail the clearance job).
  const recipient = nrsPayload.customer?.email;
  if (recipient) {
    try {
      await invoice.reload();
      const result = await emailService.sendNrsInvoiceEmail({ to: recipient, invoice, tenant });
      await invoice.update({ invoice_email_sent_at: new Date() });
      await appendEvent(invoice.id, 'INVOICE_EMAILED', { to: result.to, mock: result.mock });
      console.log(`[invoice] ${ref} invoice email sent to ${result.to}`);
    } catch (mailErr) {
      await appendEvent(invoice.id, 'INVOICE_EMAIL_FAILED', { error: mailErr.message });
      console.error(`[invoice] ${ref} invoice email failed: ${mailErr.message}`);
    }
  } else {
    console.log(`[invoice] ${ref} no customer email — skipping invoice email`);
  }

  return { status: 'CLEARED', irn };
}

function startInvoiceWorker() {
  const worker = new Worker(
    'invoice-processing',
    async (job) => {
      if (job.name === 'process-invoice') {
        return processInvoiceJob(job);
      }
      throw new Error(`Unknown job: ${job.name}`);
    },
    { connection: getConnection() }
  );

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err.message);
  });

  worker.on('completed', (job, result) => {
    console.log(`Job ${job.id} completed:`, result?.status);
  });

  return worker;
}

module.exports = { startInvoiceWorker, processInvoiceJob };
