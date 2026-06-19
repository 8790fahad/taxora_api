/**
 * HTML verification email (Mailtrap / nodemailer).
 * Branding is driven entirely from config / env.
 */
function buildVerificationEmailHtml({
  recipientName,
  verificationUrl,
  companyName,
  companyLogoUrl,
  companyWebsite,
  companyEmail,
  companyPhone,
  companyTwitter,
  companyInstagram,
  companyLinkedIn,
  companyFacebook,
  brandColor,
}) {
  const greeting = recipientName ? `Hi ${recipientName}!` : 'Hi there!';
  const safeName = companyName || 'Taxora';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeName} — Verify your email</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f7;font-family:Arial,Helvetica,sans-serif;">
  <div style="background-color:#f5f5f7;padding:24px 0;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;box-shadow:0 4px 12px rgba(0,0,0,0.06);overflow:hidden;">
      <div style="padding:20px 24px 0 24px;">
        <img
          src="${companyLogoUrl}"
          alt="${safeName}"
          style="display:block;height:40px;width:40px;object-fit:contain;border-radius:10px;"
        />
      </div>

      <div style="padding:24px 24px 16px 24px;">
        <h2 style="margin:0 0 16px 0;font-size:22px;color:#111;">${greeting}</h2>
        <p style="margin:0 0 12px 0;font-size:14px;color:#333;line-height:1.6;">
          Welcome to <strong style="color:${brandColor};">${safeName}</strong> 🎉
        </p>
        <p style="margin:0 0 20px 0;font-size:14px;color:#333;line-height:1.6;">
          Thanks for registering your company. To finish setting up your account and set your password,
          please verify your email address.
        </p>

        <div style="border:1px solid #d5eeec;background:#eef8f7;border-radius:12px;padding:16px 18px;margin-bottom:20px;text-align:center;">
          <p style="margin:0 0 12px 0;font-size:14px;color:#115e59;line-height:1.6;">
            Email verification helps us keep your account secure.
          </p>
          <a href="${verificationUrl}" style="display:inline-block;background-color:${brandColor};color:#ffffff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;">
            Verify email
          </a>
        </div>

        <p style="margin:0 0 12px 0;font-size:12px;color:#777;line-height:1.6;word-break:break-all;">
          Or copy this link:<br/>
          <a href="${verificationUrl}" style="color:${brandColor};">${verificationUrl}</a>
        </p>

        <p style="margin:0 0 24px 0;font-size:12px;color:#777;line-height:1.6;">
          If you didn’t create this account, you can safely ignore this email.
        </p>

        <p style="margin:0 0 8px 0;font-size:13px;color:#555;">
          With respect,<br/>
          <strong>${safeName} Team</strong>
        </p>
      </div>

      <div style="border-top:1px solid #eee;padding:16px 24px 20px 24px;font-size:12px;color:#666;line-height:1.6;">
        <div style="margin-bottom:8px;">
          Website:
          <a href="${companyWebsite}" style="color:${brandColor};text-decoration:none;">${companyWebsite}</a>
        </div>
        <div style="margin-bottom:8px;">
          Email:
          <a href="mailto:${companyEmail}" style="color:${brandColor};text-decoration:none;">${companyEmail}</a>
        </div>
        <div style="margin-bottom:8px;">Phone: ${companyPhone}</div>
        <div>
          <p style="margin:0 0 8px 0;font-size:12px;color:#666;">Follow us:</p>
          <a href="${companyTwitter}" style="display:inline-block;margin-right:12px;">
            <img src="https://img.icons8.com/color/48/twitterx--v1.png" width="28" height="28" alt="Twitter" style="display:block;" />
          </a>
          <a href="${companyInstagram}" style="display:inline-block;margin-right:12px;">
            <img src="https://img.icons8.com/color/48/instagram-new.png" width="28" height="28" alt="Instagram" style="display:block;" />
          </a>
          <a href="${companyLinkedIn}" style="display:inline-block;margin-right:12px;">
            <img src="https://img.icons8.com/color/48/linkedin.png" width="28" height="28" alt="LinkedIn" style="display:block;" />
          </a>
          <a href="${companyFacebook}" style="display:inline-block;">
            <img src="https://img.icons8.com/color/48/facebook.png" width="28" height="28" alt="Facebook" style="display:block;" />
          </a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`.trim();
}

module.exports = { buildVerificationEmailHtml };
