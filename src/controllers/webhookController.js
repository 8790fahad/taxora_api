const db = require('../models');
const { appendEvent } = require('../services/invoiceService');
const { AppError } = require('../utils/errors');

async function remitaWebhook(req, res, next) {
  try {
    // Phase 2: verify Remita webhook signature
    const { invoiceRef, status, irn, qr } = req.body;

    if (!invoiceRef) {
      throw new AppError('invoiceRef is required', 400, 'VALIDATION_ERROR');
    }

    const invoice = await db.Invoice.findOne({ where: { invoice_ref: invoiceRef } });
    if (!invoice) {
      throw new AppError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    }

    const mappedStatus = (status || 'CLEARED').toUpperCase();
    const updates = { status: mappedStatus };

    if (irn) updates.irn = irn;
    if (qr) updates.qr_payload = qr;

    await invoice.update(updates);
    await appendEvent(invoice.id, 'WEBHOOK_RECEIVED', { status: mappedStatus, irn, qr });

    res.json({ ok: true, invoiceId: invoice.id, status: mappedStatus });
  } catch (err) {
    next(err);
  }
}

module.exports = { remitaWebhook };
