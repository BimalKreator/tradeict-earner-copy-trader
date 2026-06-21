import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  renderEmailTemplate,
  type EmailTemplateName,
} from "../services/emailTemplates.js";
import {
  resolveEmailRecipientName,
  sendCustomEmail,
  sendTemplateEmail,
} from "../services/emailService.js";
import { logManualEmail } from "../services/emailLogService.js";

const RESENDABLE_TEMPLATES = new Set<string>([
  "welcome",
  "member_registration",
  "approval_notification",
  "nomination_request",
]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plainTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
}

function wrapCustomEmailHtml(subject: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#0f172a;color:#e2e8f0;">
  <div style="max-width:560px;margin:0 auto;padding:28px 24px;border-radius:16px;border:1px solid rgba(56,189,248,0.22);background:linear-gradient(155deg,rgba(30,41,59,0.95),rgba(15,23,42,0.98));">
    <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:#38bdf8;">TradeICT Earner</p>
    <div style="font-size:15px;line-height:1.7;color:#cbd5e1;">${bodyHtml}</div>
    <p style="margin:24px 0 0;font-size:11px;color:#64748b;">Tradeict AI Private Limited</p>
  </div>
</body>
</html>`;
}

async function buildResendTemplateData(
  prisma: PrismaClient,
  userId: string,
  templateName: EmailTemplateName,
  userName: string,
): Promise<Record<string, unknown>> {
  switch (templateName) {
    case "welcome":
      return { userName };
    case "member_registration": {
      const sub = await prisma.userStrategySubscription.findFirst({
        where: { userId },
        orderBy: { joinedDate: "desc" },
        select: { strategy: { select: { title: true } } },
      });
      const strategyName = sub?.strategy.title?.trim();
      return strategyName ? { userName, strategyName } : { userName };
    }
    case "approval_notification":
      return { userName, approvalType: "account" as const };
    case "nomination_request":
      return {
        userName,
        phase: "received" as const,
        requestedRole: "Team Member",
      };
    default:
      return { userName };
  }
}

export function createAdminEmailController(prisma: PrismaClient) {
  async function resendRegistrationEmail(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const adminUserId = req.userId;
      if (!adminUserId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as { userId?: unknown; templateName?: unknown };
      const userId =
        typeof body.userId === "string" ? body.userId.trim() : "";
      const templateRaw =
        typeof body.templateName === "string"
          ? body.templateName.trim().toLowerCase()
          : "welcome";

      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }
      if (!RESENDABLE_TEMPLATES.has(templateRaw)) {
        res.status(400).json({
          error: `templateName must be one of: ${[...RESENDABLE_TEMPLATES].join(", ")}`,
        });
        return;
      }

      const templateName = templateRaw as EmailTemplateName;

      const [recipient, admin] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, name: true },
        }),
        prisma.user.findUnique({
          where: { id: adminUserId },
          select: { email: true },
        }),
      ]);

      if (!recipient?.email) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const userName = resolveEmailRecipientName(recipient.name, recipient.email);
      const templateData = await buildResendTemplateData(
        prisma,
        userId,
        templateName,
        userName,
      );

      const rendered = renderEmailTemplate(
        templateName,
        templateData as Parameters<typeof renderEmailTemplate>[1],
      );

      const success = await sendTemplateEmail(
        recipient.email,
        templateName,
        templateData as Parameters<typeof sendTemplateEmail>[2],
      );

      await logManualEmail(prisma, {
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        adminUserId,
        adminEmail: admin?.email ?? null,
        kind: "template_resend",
        templateName,
        subject: rendered.subject,
        success,
        errorMessage: success ? null : "SMTP send failed",
      });

      if (!success) {
        res.status(502).json({ error: "Failed to send email. Check SMTP configuration." });
        return;
      }

      res.json({
        ok: true,
        templateName,
        recipientEmail: recipient.email,
        subject: rendered.subject,
      });
    } catch (err) {
      next(err);
    }
  }

  async function sendCustomEmailToUser(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const adminUserId = req.userId;
      if (!adminUserId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const body = req.body as {
        userId?: unknown;
        subject?: unknown;
        htmlContent?: unknown;
        body?: unknown;
      };

      const userId =
        typeof body.userId === "string" ? body.userId.trim() : "";
      const subject =
        typeof body.subject === "string" ? body.subject.trim() : "";
      const htmlRaw =
        typeof body.htmlContent === "string"
          ? body.htmlContent.trim()
          : typeof body.body === "string"
            ? body.body.trim()
            : "";

      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }
      if (!subject) {
        res.status(400).json({ error: "subject is required" });
        return;
      }
      if (subject.length > 200) {
        res.status(400).json({ error: "subject must be at most 200 characters" });
        return;
      }
      if (!htmlRaw) {
        res.status(400).json({ error: "htmlContent or body is required" });
        return;
      }
      if (htmlRaw.length > 50_000) {
        res.status(400).json({ error: "message body is too long" });
        return;
      }

      const [recipient, admin] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, name: true },
        }),
        prisma.user.findUnique({
          where: { id: adminUserId },
          select: { email: true },
        }),
      ]);

      if (!recipient?.email) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const looksLikeHtml = /<[a-z][\s\S]*>/i.test(htmlRaw);
      const htmlContent = looksLikeHtml
        ? htmlRaw
        : wrapCustomEmailHtml(subject, plainTextToHtml(htmlRaw));
      const textContent = looksLikeHtml ? subject : htmlRaw;

      const success = await sendCustomEmail({
        to: recipient.email,
        subject,
        htmlContent,
        textContent,
      });

      await logManualEmail(prisma, {
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        adminUserId,
        adminEmail: admin?.email ?? null,
        kind: "custom",
        templateName: null,
        subject,
        success,
        errorMessage: success ? null : "SMTP send failed",
      });

      if (!success) {
        res.status(502).json({ error: "Failed to send email. Check SMTP configuration." });
        return;
      }

      res.json({
        ok: true,
        recipientEmail: recipient.email,
        subject,
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    resendRegistrationEmail,
    sendCustomEmailToUser,
  };
}
