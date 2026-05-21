import { Role, UserStatus, type PrismaClient } from "@prisma/client";
import { sendBroadcastNotificationEmail } from "../utils/emailService.js";

const CREATE_BATCH_SIZE = 200;
const EMAIL_CONCURRENCY = 8;

export type BroadcastAudience =
  | "ALL"
  | "ACTIVE"
  | { userIds: string[] };

export type BroadcastRecipient = {
  id: string;
  email: string;
  name: string | null;
};

export type BroadcastResult = {
  recipientCount: number;
  notificationsCreated: number;
  emailsSent: number;
  emailsFailed: number;
};

export function parseBroadcastAudience(body: {
  audience?: unknown;
  userIds?: unknown;
}): BroadcastAudience | null {
  if (body.audience === "ALL") return "ALL";
  if (body.audience === "ACTIVE") return "ACTIVE";

  if (Array.isArray(body.audience)) {
    const ids = body.audience
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.length > 0 ? { userIds: ids } : null;
  }

  if (body.audience === "SPECIFIC" && Array.isArray(body.userIds)) {
    const ids = body.userIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.length > 0 ? { userIds: ids } : null;
  }

  return null;
}

export async function resolveBroadcastRecipients(
  prisma: PrismaClient,
  audience: BroadcastAudience,
): Promise<BroadcastRecipient[]> {
  const baseWhere = { role: Role.USER };

  if (audience === "ALL") {
    return prisma.user.findMany({
      where: baseWhere,
      select: { id: true, email: true, name: true },
      orderBy: { email: "asc" },
    });
  }

  if (audience === "ACTIVE") {
    return prisma.user.findMany({
      where: { ...baseWhere, status: UserStatus.ACTIVE },
      select: { id: true, email: true, name: true },
      orderBy: { email: "asc" },
    });
  }

  const uniqueIds = [...new Set(audience.userIds)];
  const users = await prisma.user.findMany({
    where: { id: { in: uniqueIds }, ...baseWhere },
    select: { id: true, email: true, name: true },
    orderBy: { email: "asc" },
  });
  return users;
}

async function bulkCreateNotifications(
  prisma: PrismaClient,
  recipients: BroadcastRecipient[],
  title: string,
  message: string,
): Promise<number> {
  let created = 0;
  for (let i = 0; i < recipients.length; i += CREATE_BATCH_SIZE) {
    const chunk = recipients.slice(i, i + CREATE_BATCH_SIZE);
    const result = await prisma.notification.createMany({
      data: chunk.map((u) => ({
        userId: u.id,
        title,
        message,
        isRead: false,
      })),
    });
    created += result.count;
  }
  return created;
}

async function sendBroadcastEmails(
  recipients: BroadcastRecipient[],
  title: string,
  message: string,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += EMAIL_CONCURRENCY) {
    const chunk = recipients.slice(i, i + EMAIL_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((u) =>
        sendBroadcastNotificationEmail(
          { email: u.email, name: u.name },
          title,
          message,
        ),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") sent += 1;
      else failed += 1;
    }
  }

  return { sent, failed };
}

export async function broadcastNotifications(
  prisma: PrismaClient,
  args: { title: string; message: string; audience: BroadcastAudience },
): Promise<BroadcastResult> {
  const title = args.title.trim();
  const message = args.message.trim();
  const recipients = await resolveBroadcastRecipients(prisma, args.audience);

  if (recipients.length === 0) {
    return {
      recipientCount: 0,
      notificationsCreated: 0,
      emailsSent: 0,
      emailsFailed: 0,
    };
  }

  const notificationsCreated = await bulkCreateNotifications(
    prisma,
    recipients,
    title,
    message,
  );

  const { sent, failed } = await sendBroadcastEmails(
    recipients,
    title,
    message,
  );

  return {
    recipientCount: recipients.length,
    notificationsCreated,
    emailsSent: sent,
    emailsFailed: failed,
  };
}
