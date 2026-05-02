import type { PrismaClient } from "@prisma/client";

export async function logUserActivity(
  prisma: PrismaClient,
  args: {
    userId: string;
    kind: string;
    message: string;
  },
): Promise<void> {
  try {
    await prisma.userActivity.create({
      data: {
        userId: args.userId,
        kind: args.kind,
        message: args.message.slice(0, 500),
      },
    });
  } catch (err) {
    console.warn("[userActivity] log failed:", err);
  }
}
