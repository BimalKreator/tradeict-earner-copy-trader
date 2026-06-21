import type { PrismaClient } from "@prisma/client";

export type ManualEmailLogKind = "template_resend" | "custom";

export type LogManualEmailArgs = {
  recipientUserId: string;
  recipientEmail: string;
  adminUserId: string;
  adminEmail?: string | null;
  kind: ManualEmailLogKind;
  templateName?: string | null;
  subject: string;
  success: boolean;
  errorMessage?: string | null;
};

/** Persist manual email audit + console log (DB write is best-effort if table not migrated). */
export async function logManualEmail(
  prisma: PrismaClient,
  args: LogManualEmailArgs,
): Promise<void> {
  const summary =
    `[emailLog] manual kind=${args.kind} template=${args.templateName ?? "—"} ` +
    `admin=${args.adminUserId} recipient=${args.recipientUserId} ` +
    `to=${args.recipientEmail} success=${args.success}` +
    (args.errorMessage ? ` error=${args.errorMessage}` : "");

  if (args.success) {
    console.log(summary);
  } else {
    console.error(summary);
  }

  try {
    await prisma.emailLog.create({
      data: {
        recipientUserId: args.recipientUserId,
        recipientEmail: args.recipientEmail,
        adminUserId: args.adminUserId,
        adminEmail: args.adminEmail?.trim() || null,
        kind: args.kind,
        templateName: args.templateName?.trim() || null,
        subject: args.subject,
        success: args.success,
        errorMessage: args.errorMessage?.trim() || null,
      },
    });
  } catch (err) {
    console.warn(
      "[emailLog] DB persist failed (run prisma migrate if EmailLog table is missing):",
      err instanceof Error ? err.message : err,
    );
  }
}
