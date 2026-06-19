const invoiceService = require('../services/invoiceService');
const emailService = require('../services/emailService');
const { AppError } = require('../utils/errors');

async function listInvoices(req, res, next) {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const { status } = req.query;

    const result = await invoiceService.listInvoices(req.tenant, { page, limit, status });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getInvoice(req, res, next) {
  try {
    const invoice = await invoiceService.getInvoiceDetail(req.tenant, req.params.id);
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
}

async function createInvoice(req, res, next) {
  try {
    const invoice = await invoiceService.createInvoice(req.tenant, req.body);
    res.status(202).json({
      invoice,
      message: 'Invoice queued for processing',
    });
  } catch (err) {
    next(err);
  }
}

async function retryInvoice(req, res, next) {
  try {
    const invoice = await invoiceService.retryInvoice(req.tenant, req.params.id);
    res.json({
      invoice,
      message: 'Invoice re-queued for processing',
    });
  } catch (err) {
    next(err);
  }
}

// Return the rendered NRS standard invoice document as HTML so the UI can open
// or preview it. Returns { html } as JSON (the SPA fetches with auth headers).
async function getInvoiceDocument(req, res, next) {
  try {
    const invoice = await invoiceService.getInvoiceDetail(req.tenant, req.params.id);
    if (!invoice.nrs_json) {
      throw new AppError(
        'NRS invoice not generated yet for this invoice',
        409,
        'NRS_NOT_READY'
      );
    }
    const autoPrint = req.query.print === '1' || req.query.print === 'true';
    const html = emailService.renderNrsInvoiceDocument(invoice, req.tenant, { autoPrint });
    res.json({ html });
  } catch (err) {
    next(err);
  }
}

// Send (or resend) the NRS standard invoice email. Optional body.to overrides
// the customer email on the invoice.
async function sendInvoice(req, res, next) {
  try {
    const invoice = await invoiceService.getInvoiceDetail(req.tenant, req.params.id);
    if (!invoice.nrs_json) {
      throw new AppError(
        'NRS invoice not generated yet for this invoice',
        409,
        'NRS_NOT_READY'
      );
    }
    const result = await emailService.sendNrsInvoiceEmail({
      to: req.body?.to,
      invoice,
      tenant: req.tenant,
    });
    await invoice.update({ invoice_email_sent_at: new Date() });
    await invoiceService.appendEvent(invoice.id, 'INVOICE_EMAILED', {
      to: result.to,
      mock: result.mock,
      manual: true,
    });
    res.json({
      ok: true,
      to: result.to,
      mock: result.mock,
      message: `Invoice sent to ${result.to}${result.mock ? ' (mock mode)' : ''}.`,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listInvoices,
  getInvoice,
  createInvoice,
  retryInvoice,
  getInvoiceDocument,
  sendInvoice,
};
