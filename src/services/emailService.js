const nodemailer = require('nodemailer');
const { MailtrapTransport } = require('mailtrap');
const config = require('../config');
const { buildVerificationEmailHtml } = require('../templates/verificationEmail');
const { buildProfileReviewEmailHtml } = require('../templates/profileReviewEmail');
const { buildNrsInvoiceDocumentHtml } = require('../templates/nrsInvoiceDocument');

function buildVerificationUrl(token, email) {
  const base = `${config.frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
  if (email) {
    return `${base}&email=${encodeURIComponent(email)}`;
  }
  return base;
}

function getTransport() {
  if (!config.mailtrapToken) {
    return null;
  }
  return nodemailer.createTransport(
    MailtrapTransport({
      token: config.mailtrapToken,
    })
  );
}

async function sendVerificationEmail({ to, token, recipientName }) {
  const verificationUrl = buildVerificationUrl(token, to);
  const companyName = config.companyName;

  if (config.emailMock || !config.mailtrapToken) {
    console.log('\n──────────────────────────────────────────────');
    console.log('[email:mock] Verification email');
    console.log(`  to:      ${to}`);
    console.log(`  company: ${companyName}`);
    console.log(`  link:    ${verificationUrl}`);
    if (!config.mailtrapToken) {
      console.log('  note:    Set MAILTRAP_TOKEN and EMAIL_MOCK=false to send for real');
    }
    console.log('──────────────────────────────────────────────\n');
    return { mock: true, url: verificationUrl };
  }

  const transport = getTransport();
  const html = buildVerificationEmailHtml({
    recipientName: recipientName || null,
    verificationUrl,
    companyName,
    companyLogoUrl: config.companyLogoUrl,
    companyWebsite: config.companyWebsite,
    companyEmail: config.companyEmail,
    companyPhone: config.companyPhone,
    companyTwitter: config.companyTwitter,
    companyInstagram: config.companyInstagram,
    companyLinkedIn: config.companyLinkedIn,
    companyFacebook: config.companyFacebook,
    brandColor: config.brandColor,
  });

  const mailOptions = {
    from: config.mailFrom,
    to,
    subject: `${companyName} — Verify your email`,
    category: 'Email Verification',
    html,
  };

  const info = await transport.sendMail(mailOptions);
  console.log(`[email] Verification sent to ${to} (messageId: ${info.messageId || 'n/a'})`);

  return { mock: false, url: verificationUrl, messageId: info.messageId };
}

// Sent to manually-registered companies: their profile is queued for review and
// the email-verification link will follow once an admin approves the profile.
async function sendProfileReviewEmail({ to, recipientName }) {
  const companyName = config.companyName;

  if (config.emailMock || !config.mailtrapToken) {
    console.log('\n──────────────────────────────────────────────');
    console.log('[email:mock] Profile under review');
    console.log(`  to:      ${to}`);
    console.log(`  company: ${companyName}`);
    console.log('  note:    Verification email is sent after an admin approves the profile.');
    console.log('──────────────────────────────────────────────\n');
    return { mock: true };
  }

  const transport = getTransport();
  const html = buildProfileReviewEmailHtml({
    recipientName: recipientName || null,
    companyName,
    companyLogoUrl: config.companyLogoUrl,
    companyWebsite: config.companyWebsite,
    companyEmail: config.companyEmail,
    companyPhone: config.companyPhone,
    companyTwitter: config.companyTwitter,
    companyInstagram: config.companyInstagram,
    companyLinkedIn: config.companyLinkedIn,
    companyFacebook: config.companyFacebook,
    brandColor: config.brandColor,
  });

  const info = await transport.sendMail({
    from: config.mailFrom,
    to,
    subject: `${companyName} — Your profile is under review`,
    category: 'Profile Review',
    html,
  });
  console.log(`[email] Profile-review notice sent to ${to} (messageId: ${info.messageId || 'n/a'})`);

  return { mock: false, messageId: info.messageId };
}

// Render the NRS standard invoice document HTML for an invoice. Shared by both
// the view endpoint and the invoice email so they are always identical.
function renderNrsInvoiceDocument(invoice, tenant, options = {}) {
  const t = tenant || invoice.Tenant || {};
  return buildNrsInvoiceDocumentHtml({
    nrs: invoice.nrs_json || {},
    tenant: t,
    irn: invoice.irn || null,
    qr: invoice.qr_payload || null,
    status: invoice.status || null,
    companyName: t.legal_name || config.companyName,
    companyLogoUrl: t.logo_url || config.companyLogoUrl,
    companyLogoWidth: t.logo_width || null,
    companyLogoHeight: t.logo_height || null,
    brandColor: config.brandColor,
    autoPrint: Boolean(options.autoPrint),
  });
}

/**
 * Send the NRS standard invoice as an email. Returns { mock, messageId, to }.
 * In mock mode (or without a Mailtrap token) it logs instead of sending.
 */
async function sendNrsInvoiceEmail({ to, invoice, tenant }) {
  const recipient = to || invoice.nrs_json?.customer?.email;
  if (!recipient) {
    const err = new Error('No recipient email available for this invoice');
    err.statusCode = 400;
    err.code = 'NO_RECIPIENT';
    throw err;
  }

  const html = renderNrsInvoiceDocument(invoice, tenant);
  const ref = invoice.nrs_json?.invoiceRef || invoice.invoice_ref;
  const subject = `${config.companyName} — Invoice ${ref}`;

  if (config.emailMock || !config.mailtrapToken) {
    console.log('\n──────────────────────────────────────────────');
    console.log('[email:mock] NRS invoice email');
    console.log(`  to:      ${recipient}`);
    console.log(`  invoice: ${ref}`);
    console.log(`  irn:     ${invoice.irn || 'n/a'}`);
    if (!config.mailtrapToken) {
      console.log('  note:    Set MAILTRAP_TOKEN and EMAIL_MOCK=false to send for real');
    }
    console.log('──────────────────────────────────────────────\n');
    return { mock: true, to: recipient };
  }

  const transport = getTransport();
  const info = await transport.sendMail({
    from: config.mailFrom,
    to: recipient,
    subject,
    category: 'NRS Invoice',
    html,
  });
  console.log(
    `[email] NRS invoice ${ref} sent to ${recipient} (messageId: ${info.messageId || 'n/a'})`
  );

  return { mock: false, to: recipient, messageId: info.messageId };
}

module.exports = {
  sendVerificationEmail,
  sendProfileReviewEmail,
  buildVerificationUrl,
  sendNrsInvoiceEmail,
  renderNrsInvoiceDocument,
};
