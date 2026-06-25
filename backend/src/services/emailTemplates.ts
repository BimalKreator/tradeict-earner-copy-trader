/** Branded HTML email templates — mobile-responsive, inline CSS. */

export type EmailTemplateName =
  | "welcome"
  | "member_registration"
  | "approval_notification"
  | "nomination_request"
  | "withdrawal_request_submitted";

export type WelcomeTemplateData = {
  userName: string;
  dashboardUrl?: string;
};

export type MemberRegistrationTemplateData = {
  userName: string;
  strategyName?: string;
  dashboardUrl?: string;
};

export type ApprovalNotificationTemplateData = {
  userName: string;
  /** What was approved — account access or copy-trading subscription. */
  approvalType?: "account" | "subscription";
  strategyName?: string;
  dashboardUrl?: string;
};

export type NominationRequestTemplateData = {
  userName: string;
  phase: "received" | "approved";
  requestedRole?: string;
  nominatedBy?: string;
  dashboardUrl?: string;
};

export type WithdrawalRequestSubmittedTemplateData = {
  userName: string;
  amount: number;
  message: string;
  dashboardUrl?: string;
};

export type EmailTemplateDataMap = {
  welcome: WelcomeTemplateData;
  member_registration: MemberRegistrationTemplateData;
  approval_notification: ApprovalNotificationTemplateData;
  nomination_request: NominationRequestTemplateData;
  withdrawal_request_submitted: WithdrawalRequestSubmittedTemplateData;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function defaultDashboardUrl(): string {
  const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  return `${base}/dashboard`;
}

function emailShell(args: {
  preheader: string;
  headline: string;
  subheadline?: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footerNote?: string;
}): string {
  const safeHeadline = escapeHtml(args.headline);
  const safeSub = args.subheadline ? escapeHtml(args.subheadline) : "";
  const safePre = escapeHtml(args.preheader);
  const ctaBlock =
    args.ctaLabel && args.ctaUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto 0 auto;">
  <tr>
    <td align="center" style="border-radius:10px;background:linear-gradient(180deg,#0a84ff 0%,#0066cc 100%);box-shadow:0 8px 24px rgba(10,132,255,0.35);">
      <a href="${escapeHtml(args.ctaUrl)}" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(args.ctaLabel)}</a>
    </td>
  </tr>
</table>`
      : "";

  const footer = args.footerNote
    ? `<p style="margin:20px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.6;color:#64748b;text-align:center;">${escapeHtml(args.footerNote)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${safeHeadline}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0f172a;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${safePre}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0f172a;background-image:radial-gradient(ellipse 120% 80% at 50% -20%, rgba(10,132,255,0.12), transparent 55%);padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">
          <tr>
            <td style="padding-bottom:28px;text-align:center;">
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#38bdf8;">TradeICT</div>
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#f8fafc;margin-top:6px;">TradeICT Earner</div>
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#94a3b8;margin-top:6px;">Smart copy trading · Your keys · Your funds</div>
            </td>
          </tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(155deg, rgba(30,41,59,0.95) 0%, rgba(15,23,42,0.98) 100%);border-radius:16px;border:1px solid rgba(56,189,248,0.22);box-shadow:0 24px 48px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06);overflow:hidden;">
                <tr>
                  <td style="padding:36px 28px 32px 28px;">
                    <h1 style="margin:0 0 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:24px;font-weight:700;line-height:1.25;color:#f8fafc;">${safeHeadline}</h1>
                    ${safeSub ? `<p style="margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#38bdf8;">${safeSub}</p>` : ""}
                    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.7;color:#cbd5e1;">
                      ${args.bodyHtml}
                    </div>
                    ${ctaBlock}
                    ${footer}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:28px;text-align:center;">
              <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:11px;color:#475569;letter-spacing:0.04em;">© TradeICT Earner · Tradeict AI Private Limited</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;">${text}</p>`;
}

function renderWelcome(data: WelcomeTemplateData): RenderedEmail {
  const name = escapeHtml(data.userName.trim() || "Trader");
  const dashboardUrl = data.dashboardUrl ?? defaultDashboardUrl();
  const bodyHtml = [
    paragraph(`Hi <strong style="color:#f1f5f9;">${name}</strong>,`),
    paragraph(
      "Welcome to the future of smart trading. Your TradeICT Earner account is live — a platform built for disciplined growth, transparent execution, and copy trading on your terms.",
    ),
    paragraph(
      "Connect your exchange API keys, explore proven strategies, and let automation work while you focus on the bigger picture. Every step you take here compounds toward long-term results.",
    ),
    paragraph(
      "<strong style='color:#34d399;'>Your journey starts now.</strong> Sign in to complete your profile and discover strategies aligned with your goals.",
    ),
  ].join("");

  const text = [
    `Hi ${data.userName.trim() || "Trader"},`,
    "",
    "Welcome to the future of smart trading.",
    "",
    "Your TradeICT Earner account is live. Connect your exchange, explore strategies, and grow with algorithmic copy trading.",
    "",
    `Dashboard: ${dashboardUrl}`,
    "",
    "— TradeICT Earner Team",
  ].join("\n");

  return {
    subject: "Welcome to TradeICT Earner — Your smart trading journey begins",
    html: emailShell({
      preheader: "Welcome to the future of smart trading.",
      headline: "Welcome aboard",
      subheadline: "Welcome to the future of smart trading.",
      bodyHtml,
      ctaLabel: "Open your dashboard",
      ctaUrl: dashboardUrl,
    }),
    text,
  };
}

function renderMemberRegistration(data: MemberRegistrationTemplateData): RenderedEmail {
  const name = escapeHtml(data.userName.trim() || "Member");
  const strategy = data.strategyName?.trim();
  const dashboardUrl = data.dashboardUrl ?? defaultDashboardUrl();
  const strategyLine = strategy
    ? paragraph(
        `You have joined <strong style="color:#f8fafc;">${escapeHtml(strategy)}</strong>. Configure your exchange connection and deployment settings when you are ready to go live.`,
      )
    : paragraph(
        "Your membership is registered. Configure your exchange connection and strategy settings to prepare for deployment.",
      );

  const bodyHtml = [
    paragraph(`Hi <strong style="color:#f1f5f9;">${name}</strong>,`),
    paragraph(
      "You have taken the first step toward algorithmic success. By adding a strategy to your account, you are building a foundation for consistent, data-driven trading.",
    ),
    strategyLine,
    paragraph(
      "Great traders plan ahead — review risk settings, fund your wallet if required, and deploy when your setup is complete. We are here to support your growth every step of the way.",
    ),
  ].join("");

  const text = [
    `Hi ${data.userName.trim() || "Member"},`,
    "",
    "You have taken the first step toward algorithmic success.",
    "",
    strategy ? `Strategy: ${strategy}` : "",
    "",
    `Dashboard: ${dashboardUrl}`,
    "",
    "— TradeICT Earner Team",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject: strategy
      ? `Strategy enrolled — ${strategy}`
      : "Membership registered — TradeICT Earner",
    html: emailShell({
      preheader: "You have taken the first step toward algorithmic success.",
      headline: "You are on the path",
      subheadline: "You have taken the first step toward algorithmic success.",
      bodyHtml,
      ctaLabel: "View My Strategies",
      ctaUrl: dashboardUrl,
    }),
    text,
  };
}

function renderApprovalNotification(
  data: ApprovalNotificationTemplateData,
): RenderedEmail {
  const name = escapeHtml(data.userName.trim() || "Member");
  const dashboardUrl = data.dashboardUrl ?? defaultDashboardUrl();
  const isSubscription = data.approvalType === "subscription";
  const strategy = data.strategyName?.trim();

  const detail = isSubscription
    ? strategy
      ? `Your copy-trading subscription for <strong style="color:#f8fafc;">${escapeHtml(strategy)}</strong> is now active.`
      : "Your copy-trading subscription is now active."
    : "Your account access has been approved and restored.";

  const bodyHtml = [
    paragraph(`Hi <strong style="color:#f1f5f9;">${name}</strong>,`),
    paragraph("<strong style='color:#34d399;'>Account Approved! You are ready to start.</strong>"),
    paragraph(`${detail} You can sign in and continue building momentum with automated execution.`),
    paragraph(
      "Momentum favours the prepared — verify your exchange connection, review open positions, and let the platform work for you.",
    ),
  ].join("");

  const text = [
    `Hi ${data.userName.trim() || "Member"},`,
    "",
    "Account Approved! You are ready to start.",
    "",
    isSubscription
      ? `Your subscription${strategy ? ` for ${strategy}` : ""} is active.`
      : "Your account access has been approved.",
    "",
    `Dashboard: ${dashboardUrl}`,
    "",
    "— TradeICT Earner Team",
  ].join("\n");

  return {
    subject: "Account approved — you are ready to trade",
    html: emailShell({
      preheader: "Account Approved! You are ready to start.",
      headline: "You are cleared to go",
      subheadline: "Account Approved! You are ready to start.",
      bodyHtml,
      ctaLabel: "Go to dashboard",
      ctaUrl: dashboardUrl,
    }),
    text,
  };
}

function renderNominationRequest(data: NominationRequestTemplateData): RenderedEmail {
  const name = escapeHtml(data.userName.trim() || "Partner");
  const dashboardUrl = data.dashboardUrl ?? defaultDashboardUrl();
  const role = data.requestedRole?.trim();
  const nominator = data.nominatedBy?.trim();
  const isApproved = data.phase === "approved";

  const headline = isApproved ? "Nomination approved" : "Nomination received";
  const subheadline = isApproved
    ? "Nomination approved — your network is expanding."
    : "Nomination received — your network is expanding.";

  const intro = isApproved
    ? "Congratulations — your nomination has been approved by our admin team."
    : "We have received a nomination for you to join the TradeICT Earner partner network.";

  const roleLine = role
    ? paragraph(
        `Proposed role: <strong style="color:#38bdf8;">${escapeHtml(role)}</strong>`,
      )
    : "";
  const nominatorLine = nominator
    ? paragraph(`Nominated by: <strong style="color:#f1f5f9;">${escapeHtml(nominator)}</strong>`)
    : "";

  const closing = isApproved
    ? "Sign in to access your partner tools, track your network, and continue growing your influence."
    : "Our team will review this nomination shortly. We will notify you once a decision has been made.";

  const bodyHtml = [
    paragraph(`Hi <strong style="color:#f1f5f9;">${name}</strong>,`),
    paragraph(intro),
    roleLine,
    nominatorLine,
    paragraph(closing),
    paragraph(
      "<strong style='color:#34d399;'>Strong networks create lasting success.</strong> Thank you for being part of the TradeICT community.",
    ),
  ]
    .filter(Boolean)
    .join("");

  const text = [
    `Hi ${data.userName.trim() || "Partner"},`,
    "",
    subheadline,
    "",
    intro,
    role ? `Role: ${role}` : "",
    nominator ? `Nominated by: ${nominator}` : "",
    "",
    closing,
    "",
    `Dashboard: ${dashboardUrl}`,
    "",
    "— TradeICT Earner Team",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject: isApproved
      ? "Your partner nomination was approved"
      : "Partner nomination received — TradeICT Earner",
    html: emailShell({
      preheader: subheadline,
      headline,
      subheadline,
      bodyHtml,
      ctaLabel: "Open dashboard",
      ctaUrl: dashboardUrl,
    }),
    text,
  };
}

function renderWithdrawalRequestSubmitted(
  data: WithdrawalRequestSubmittedTemplateData,
): RenderedEmail {
  const name = escapeHtml(data.userName.trim() || "Member");
  const dashboardUrl = data.dashboardUrl ?? defaultDashboardUrl();
  const amountLabel = `$${data.amount.toFixed(2)} USDT`;
  const message = escapeHtml(data.message);

  const bodyHtml = [
    paragraph(`Hi <strong style="color:#f1f5f9;">${name}</strong>,`),
    paragraph(
      `We received your wallet withdrawal request for <strong style="color:#38bdf8;">${escapeHtml(amountLabel)}</strong>.`,
    ),
    paragraph(message),
    paragraph(
      "You can track the status from your wallet dashboard. We will notify you once the transfer is processed.",
    ),
  ].join("");

  const text = [
    `Hi ${data.userName.trim() || "Member"},`,
    "",
    `Withdrawal amount: ${amountLabel}`,
    "",
    data.message,
    "",
    `Dashboard: ${dashboardUrl}`,
    "",
    "— TradeICT Earner Team",
  ].join("\n");

  return {
    subject: "Withdrawal request received — TradeICT Earner",
    html: emailShell({
      preheader: data.message,
      headline: "Withdrawal request submitted",
      subheadline: amountLabel,
      bodyHtml,
      ctaLabel: "View wallet",
      ctaUrl: dashboardUrl,
    }),
    text,
  };
}

export function renderEmailTemplate<T extends EmailTemplateName>(
  templateName: T,
  data: EmailTemplateDataMap[T],
): RenderedEmail {
  switch (templateName) {
    case "welcome":
      return renderWelcome(data as WelcomeTemplateData);
    case "member_registration":
      return renderMemberRegistration(data as MemberRegistrationTemplateData);
    case "approval_notification":
      return renderApprovalNotification(data as ApprovalNotificationTemplateData);
    case "nomination_request":
      return renderNominationRequest(data as NominationRequestTemplateData);
    case "withdrawal_request_submitted":
      return renderWithdrawalRequestSubmitted(
        data as WithdrawalRequestSubmittedTemplateData,
      );
    default: {
      const _exhaustive: never = templateName;
      throw new Error(`Unknown email template: ${String(_exhaustive)}`);
    }
  }
}
