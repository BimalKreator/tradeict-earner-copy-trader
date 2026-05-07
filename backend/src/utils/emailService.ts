import nodemailer from "nodemailer";

export type OtpEmailPurpose = "Sign Up" | "Login";

/**
 * Brevo (formerly Sendinblue) SMTP — configure via environment (same keys work with Brevo’s SMTP relay):
 * - SMTP_HOST — e.g. smtp-relay.brevo.com
 * - SMTP_PORT — typically 587 (STARTTLS) or 465 (implicit TLS)
 * - SMTP_USER — your Brevo SMTP login
 * - SMTP_PASS — your Brevo SMTP key
 * - SMTP_SECURE — optional; set "true" for port 465
 * - EMAIL_FROM — optional From display (defaults to SMTP_USER)
 */
export function createMailTransport(): nodemailer.Transporter {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS must be set in environment");
  }

  const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const secure =
    process.env.SMTP_SECURE === "true" ||
    process.env.SMTP_SECURE === "1" ||
    port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

function getFromAddress(): string {
  const from = process.env.EMAIL_FROM?.trim();
  if (from) return from;
  const user = process.env.SMTP_USER?.trim();
  if (user) return user;
  return '"TradeICT Earner" <noreply@localhost>';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildOtpHtml(otp: string, purpose: OtpEmailPurpose): string {
  const safeOtp = escapeHtml(otp);
  const safePurpose = escapeHtml(purpose);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>TradeICT Earner — Verification</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0f172a;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0f172a;background-image:radial-gradient(ellipse 120% 80% at 50% -20%, rgba(10,132,255,0.12), transparent 55%);padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;margin:0 auto;">
          <tr>
            <td style="padding-bottom:28px;text-align:center;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#38bdf8;">TradeICT</div>
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#f8fafc;margin-top:6px;">TradeICT Earner</div>
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#94a3b8;margin-top:6px;">Copy trading · Your keys · Your funds</div>
            </td>
          </tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(155deg, rgba(30,41,59,0.95) 0%, rgba(15,23,42,0.98) 100%);border-radius:16px;border:1px solid rgba(56,189,248,0.22);box-shadow:0 24px 48px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06);overflow:hidden;">
                <tr>
                  <td style="padding:36px 32px 28px 32px;text-align:center;">
                    <p style="margin:0 0 20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#cbd5e1;">
                      Here is your verification code for <strong style="color:#f1f5f9;">${safePurpose}</strong>. This code is valid for 10 minutes.
                    </p>
                    <div style="display:inline-block;margin:8px 0 24px 0;padding:20px 36px;border-radius:12px;background:linear-gradient(180deg, rgba(10,132,255,0.18) 0%, rgba(15,23,42,0.9) 100%);border:1px solid rgba(10,132,255,0.35);box-shadow:0 0 0 1px rgba(255,255,255,0.04) inset;">
                      <span style="font-family:'SF Mono',Monaco,'Cascadia Code','Roboto Mono',Consolas,monospace;font-size:36px;font-weight:700;letter-spacing:0.35em;color:#38bdf8;text-shadow:0 0 24px rgba(56,189,248,0.35);">${safeOtp}</span>
                    </div>
                    <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:12px;line-height:1.55;color:#64748b;">
                      If you did not request this code, please ignore this email. Do not share this code with anyone.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;text-align:center;">
              <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#475569;letter-spacing:0.04em;">
                © TradeICT Earner · Automated execution software
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildOtpText(otp: string, purpose: OtpEmailPurpose): string {
  return [
    "TradeICT Earner",
    "",
    `Here is your verification code for ${purpose}. This code is valid for 10 minutes.`,
    "",
    `Your code: ${otp}`,
    "",
    "If you did not request this code, please ignore this email. Do not share this code with anyone.",
  ].join("\n");
}

function subjectForPurpose(purpose: OtpEmailPurpose): string {
  if (purpose === "Sign Up") {
    return "Verify your email — TradeICT Earner";
  }
  return "Your login code — TradeICT Earner";
}

/**
 * Sends a branded OTP email via Brevo-compatible SMTP (nodemailer).
 */
export async function sendOtpEmail(
  to: string,
  otp: string,
  purpose: OtpEmailPurpose,
): Promise<void> {
  const transport = createMailTransport();
  await transport.sendMail({
    from: getFromAddress(),
    to,
    subject: subjectForPurpose(purpose),
    text: buildOtpText(otp, purpose),
    html: buildOtpHtml(otp, purpose),
  });
}

export async function sendPasswordResetLinkEmail(
  to: string,
  resetLink: string,
): Promise<void> {
  const transport = createMailTransport();
  await transport.sendMail({
    from: getFromAddress(),
    to,
    subject: "Reset your password — TradeICT Earner",
    text: [
      "TradeICT Earner",
      "",
      "A password reset was requested for your account.",
      `Reset link: ${resetLink}`,
      "",
      "If you did not request this, you can safely ignore this email.",
    ].join("\n"),
    html: `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0">
  <h2 style="margin-top:0;color:#f8fafc">TradeICT Earner</h2>
  <p>A password reset was requested for your account.</p>
  <p>
    <a href="${escapeHtml(resetLink)}" style="color:#38bdf8">Reset your password</a>
  </p>
  <p style="font-size:12px;color:#94a3b8">If you did not request this, you can safely ignore this email.</p>
</body>
</html>`,
  });
}
