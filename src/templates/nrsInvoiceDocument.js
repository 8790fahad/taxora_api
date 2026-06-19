// Renders an NRS standard invoice as a standalone, email-safe HTML document.
// Used both for in-app viewing and as the body of the invoice email.

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount, currency = 'NGN') {
  const n = Number(amount) || 0;
  return `${esc(currency)} ${n.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildNrsInvoiceDocumentHtml({
  nrs = {},
  tenant = {},
  irn = null,
  qr = null,
  status = null,
  companyName = 'Taxora',
  companyLogoUrl = '',
  companyLogoWidth = null,
  companyLogoHeight = null,
  brandColor = '#0f766e',
  // When true, the document auto-opens the browser print dialog on load so the
  // user can save it as a PDF. Used by the "Download PDF" action.
  autoPrint = false,
}) {
  const customer = nrs.customer || {};
  const custAddr = customer.address || {};
  const totals = nrs.totals || {};
  const firs = nrs.firsSpecific || {};
  const currency = nrs.currency || 'NGN';

  const sellerAddressParts = [
    tenant.address_line,
    tenant.address_city,
    tenant.state,
    tenant.address_country || 'NG',
  ].filter(Boolean);

  const lineRows = (nrs.lineItems || [])
    .map((li, idx) => {
      const classification = li.hsnCode
        ? `${esc(li.hsnCode)} · ${esc(li.productCategory || '')}`
        : `${esc(li.isicCode || '')} · ${esc(li.serviceCategory || '')}`;
      return `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;">
            <div style="font-weight:600;color:#111;">${esc(li.name || `Item ${idx + 1}`)}</div>
            <div style="font-size:11px;color:#888;">${esc(li.description || '')}</div>
            <div style="font-size:11px;color:#aaa;margin-top:2px;">${classification}</div>
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;">${esc(li.quantity)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;">${money(li.unitPrice, currency)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;">${money(li.discountAmount, currency)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;">${money(li.feeAmount, currency)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;">${esc(li.taxRate)}% · ${money(li.taxAmount, currency)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;color:#111;text-align:right;font-weight:600;">${money(li.totalAmount, currency)}</td>
        </tr>`;
    })
    .join('');

  const statusBadge = status
    ? `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${brandColor}1a;color:${brandColor};font-size:12px;font-weight:600;">${esc(status)}</span>`
    : '';

  const irnBlock = irn
    ? `<div style="margin-top:4px;font-size:12px;color:#555;">IRN: <span style="font-family:monospace;color:#111;">${esc(irn)}</span></div>`
    : '';

  const qrBlock = qr
    ? `<div style="margin-top:12px;text-align:center;">
         <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(
           qr
         )}" width="120" height="120" alt="Verification QR" style="display:inline-block;border:1px solid #eee;border-radius:8px;" />
         <div style="font-size:11px;color:#999;margin-top:4px;">Scan to verify</div>
       </div>`
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NRS Invoice ${esc(nrs.invoiceRef)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    @media print {
      body { background:#ffffff !important; }
      .doc-card { box-shadow:none !important; border:1px solid #e5e7eb; }
      .no-print { display:none !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f7;font-family:Arial,Helvetica,sans-serif;">
  <div style="background-color:#f5f5f7;padding:24px 0;">
    <div class="doc-card" style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.06);overflow:hidden;">

      <div style="padding:24px;border-bottom:3px solid ${brandColor};display:flex;justify-content:space-between;align-items:center;">
        <div style="display:flex;align-items:center;gap:12px;">
          ${
            companyLogoUrl
              ? `<img src="${esc(companyLogoUrl)}" alt="${esc(companyName)}" style="${
                  companyLogoWidth && companyLogoHeight
                    ? `max-width:${Number(companyLogoWidth)}px;max-height:${Number(companyLogoHeight)}px;`
                    : 'height:40px;width:40px;'
                }object-fit:contain;border-radius:10px;" />`
              : ''
          }
          <div>
            <div style="font-size:18px;font-weight:bold;color:#111;">${esc(
              tenant.legal_name || companyName
            )}</div>
            <div style="font-size:12px;color:#777;">NRS Standard E-Invoice</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;color:#777;">Invoice</div>
          <div style="font-size:16px;font-weight:bold;color:${brandColor};">${esc(
            nrs.invoiceRef
          )}</div>
          ${statusBadge}
        </div>
      </div>

      <div style="padding:20px 24px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div style="min-width:220px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#999;margin-bottom:6px;">From (Merchant)</div>
          <div style="font-size:14px;font-weight:600;color:#111;">${esc(
            tenant.legal_name || companyName
          )}</div>
          <div style="font-size:12px;color:#666;">TIN: ${esc(tenant.tin || '—')}</div>
          <div style="font-size:12px;color:#666;">Merchant ID: ${esc(
            nrs.merchantId || '—'
          )}</div>
          <div style="font-size:12px;color:#666;">${esc(sellerAddressParts.join(', '))}</div>
        </div>
        <div style="min-width:220px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#999;margin-bottom:6px;">Bill To (Customer)</div>
          <div style="font-size:14px;font-weight:600;color:#111;">${esc(customer.name)}</div>
          <div style="font-size:12px;color:#666;">TIN: ${esc(
            customer.identifiers?.tin || '—'
          )}</div>
          <div style="font-size:12px;color:#666;">${esc(customer.email || '')}</div>
          <div style="font-size:12px;color:#666;">${esc(
            [custAddr.line, custAddr.city, custAddr.country].filter(Boolean).join(', ')
          )}</div>
        </div>
        <div style="min-width:160px;text-align:right;">
          <div style="font-size:12px;color:#666;">Issue date: <strong style="color:#111;">${esc(
            nrs.issueDate
          )}</strong></div>
          <div style="font-size:12px;color:#666;">Due date: <strong style="color:#111;">${esc(
            nrs.dueDate
          )}</strong></div>
          <div style="font-size:12px;color:#666;">Type: <strong style="color:#111;">${esc(
            firs.invoiceKind || 'B2B'
          )}</strong></div>
          <div style="font-size:12px;color:#666;">Order ref: <strong style="color:#111;">${esc(
            nrs.orderReference || '—'
          )}</strong></div>
          ${irnBlock}
        </div>
      </div>

      <div style="padding:0 24px 8px 24px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#fafafa;">
              <th style="padding:8px;text-align:left;font-size:11px;color:#999;text-transform:uppercase;">Item</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#999;text-transform:uppercase;">Qty</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#999;text-transform:uppercase;">Unit</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#999;text-transform:uppercase;">Discount</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#999;text-transform:uppercase;">Fee</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#999;text-transform:uppercase;">VAT</th>
              <th style="padding:8px;text-align:right;font-size:11px;color:#999;text-transform:uppercase;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${lineRows}
          </tbody>
        </table>
      </div>

      <div style="padding:8px 24px 24px 24px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div>${qrBlock}</div>
        <div style="min-width:240px;margin-left:auto;">
          <div style="display:flex;justify-content:space-between;font-size:13px;color:#555;padding:4px 0;">
            <span>Subtotal</span><span>${money(totals.totalLineAmount, currency)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:13px;color:#555;padding:4px 0;">
            <span>Total VAT</span><span>${money(totals.totalTax, currency)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:bold;color:#111;padding:8px 0;border-top:2px solid #eee;margin-top:4px;">
            <span>Grand total</span><span>${money(totals.grandTotal, currency)}</span>
          </div>
        </div>
      </div>

      <div style="border-top:1px solid #eee;padding:14px 24px;font-size:11px;color:#999;text-align:center;">
        Generated by ${esc(companyName)} · Nigeria Revenue Service (NRS) e-invoicing
      </div>
    </div>
  </div>
  ${
    autoPrint
      ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.focus();window.print();},300);});</script>`
      : ''
  }
</body>
</html>`.trim();
}

module.exports = { buildNrsInvoiceDocumentHtml };
