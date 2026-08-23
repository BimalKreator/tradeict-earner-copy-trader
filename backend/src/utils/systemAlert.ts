import { Prisma, type PrismaClient } from "@prisma/client";

export type SystemAlertSeverity = "WARN" | "CRITICAL";

export type RaiseAlertOptions = {
  key: string;
  severity: SystemAlertSeverity;
  source: string;
  message: string;
  detail?: unknown;
};

let alertPrisma: PrismaClient | null = null;

/** Bind the shared Prisma client once at process boot (after server creates it). */
export function bindSystemAlertPrisma(client: PrismaClient): void {
  alertPrisma = client;
}

function logAlertToConsole(opts: RaiseAlertOptions): void {
  const prefix = `[SystemAlert] ${opts.source}: ${opts.message}`;
  if (opts.severity === "CRITICAL") {
    if (opts.detail !== undefined) {
      console.error(prefix, opts.detail);
    } else {
      console.error(prefix);
    }
  } else if (opts.detail !== undefined) {
    console.warn(prefix, opts.detail);
  } else {
    console.warn(prefix);
  }
}

/**
 * Persist a deduplicated admin alert (active row per key while unresolved).
 * MUST NEVER THROW — failures are logged and swallowed.
 */
export async function raiseAlert(opts: RaiseAlertOptions): Promise<void> {
  logAlertToConsole(opts);

  const prisma = alertPrisma;
  if (!prisma) return;

  try {
    const now = new Date();
    const detailJson =
      opts.detail === undefined
        ? undefined
        : (opts.detail as Prisma.InputJsonValue);

    const existing = await prisma.systemAlert.findFirst({
      where: { key: opts.key, resolved: false },
      select: { id: true },
    });

    if (existing) {
      await prisma.systemAlert.update({
        where: { id: existing.id },
        data: {
          count: { increment: 1 },
          lastSeenAt: now,
          severity: opts.severity,
          source: opts.source,
          message: opts.message,
          ...(detailJson !== undefined ? { detail: detailJson } : {}),
        },
      });
      return;
    }

    await prisma.systemAlert.create({
      data: {
        key: opts.key,
        severity: opts.severity,
        source: opts.source,
        message: opts.message,
        detail: detailJson ?? Prisma.DbNull,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        resolved: false,
      },
    });
  } catch (err) {
    console.error("[SystemAlert] persist failed", err);
  }
}
