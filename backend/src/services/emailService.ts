/**
 * Branded transactional email entry point.
 * SMTP transport lives in `utils/emailService.ts`; HTML templates in `emailTemplates.ts`.
 */
import {
  createMailTransport,
  getFromAddress,
  sendWelcomeToTeamMemberEmail,
  teamMemberRoleLabel,
  type TeamMemberRoleLabel,
} from "../utils/emailService.js";
import {
  renderEmailTemplate,
  type EmailTemplateDataMap,
  type EmailTemplateName,
} from "./emailTemplates.js";

export {
  sendWelcomeToTeamMemberEmail,
  teamMemberRoleLabel,
  type TeamMemberRoleLabel,
};

export type { EmailTemplateName, EmailTemplateDataMap } from "./emailTemplates.js";

function displayName(name: string | null | undefined, email: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const local = email.split("@")[0]?.trim();
  return local || "Member";
}

/** Resolve a friendly display name from profile fields. */
export function resolveEmailRecipientName(
  name: string | null | undefined,
  email: string,
): string {
  return displayName(name, email);
}

/**
 * Send a branded HTML template email. Returns true on success, false on failure.
 * Failures are logged; callers may fire-and-forget with `void sendTemplateEmail(...)`.
 */
export async function sendTemplateEmail<T extends EmailTemplateName>(
  to: string,
  templateName: T,
  data: EmailTemplateDataMap[T],
): Promise<boolean> {
  const recipient = to.trim();
  if (!recipient) {
    console.error(
      `[emailService] sendTemplateEmail skipped — empty recipient template=${templateName}`,
    );
    return false;
  }

  try {
    const { subject, html, text } = renderEmailTemplate(templateName, data);
    const transport = createMailTransport();
    const info = await transport.sendMail({
      from: getFromAddress(),
      to: recipient,
      subject,
      html,
      text,
    });

    const messageId =
      info && typeof info === "object" && "messageId" in info
        ? String((info as { messageId?: string }).messageId ?? "")
        : "";

    console.log(
      `[emailService] Sent template=${templateName} to=${recipient}` +
        (messageId ? ` messageId=${messageId}` : ""),
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[emailService] Failed template=${templateName} to=${recipient}: ${message}`,
    );
    return false;
  }
}

/** Fire-and-forget helper for controllers — never throws. */
export function sendTemplateEmailAsync<T extends EmailTemplateName>(
  to: string,
  templateName: T,
  data: EmailTemplateDataMap[T],
): void {
  void sendTemplateEmail(to, templateName, data);
}
