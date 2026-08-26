import type { PrismaClient } from "@prisma/client";

const SETTINGS_ID = "global";
const DEFAULT_PG_FEE_PERCENT = 2.36;
/**
 * Signup-only allowlist default. Narrowing this list MUST NEVER lock out an
 * existing account — login, verify-otp, and password reset do not consult it.
 */
const DEFAULT_ALLOWED_EMAIL_DOMAINS =
  "gmail.com,googlemail.com,yahoo.com,yahoo.co.in,yahoo.co.uk,hotmail.com,hotmail.co.uk,outlook.com,outlook.in,live.com,msn.com,icloud.com,me.com,mac.com,proton.me,protonmail.com,aol.com,zoho.com,yandex.com,gmx.com,mail.com,rediffmail.com";
export const DEFAULT_MAINTENANCE_MESSAGE =
  "The platform is temporarily under maintenance. Please check back shortly.";

/** Max age of an admin-set USD/INR rate before getUsdInrRate refuses it. */
export function usdInrRateMaxAgeHours(): number {
  const raw = process.env.USD_INR_RATE_MAX_AGE_HOURS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 48;
}

export class MissingUsdInrRateError extends Error {
  readonly code = "MISSING_USD_INR_RATE" as const;
  readonly reason: "absent" | "invalid" | "stale";

  constructor(reason: "absent" | "invalid" | "stale", detail: string) {
    super(`USD/INR rate unusable (${reason}): ${detail}`);
    this.name = "MissingUsdInrRateError";
    this.reason = reason;
  }
}

export type PublicPlatformConfig = {
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
};

export const EMAIL_DOMAIN_BLOCKED_MESSAGE =
  "Registration from this email domain is not permitted. Please use an allowed provider.";

export function parseAllowedEmailDomains(raw: string): string[] {
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** Create global settings if missing — never invent a USD/INR rate. */
async function ensureSystemSettings(prisma: PrismaClient) {
  return prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent: DEFAULT_PG_FEE_PERCENT,
      allowedEmailDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
      usdInrRate: null,
      usdInrRateUpdatedAt: null,
      maintenanceMode: false,
      maintenanceMessage: null,
    },
    update: {},
  });
}

export async function getPublicPlatformConfig(
  prisma: PrismaClient,
): Promise<PublicPlatformConfig> {
  const row = await ensureSystemSettings(prisma);
  return {
    maintenanceMode: row.maintenanceMode === true,
    maintenanceMessage: row.maintenanceMessage?.trim() || null,
  };
}

export async function setMaintenanceSettings(
  prisma: PrismaClient,
  args: { maintenanceMode: boolean; maintenanceMessage: string | null },
): Promise<PublicPlatformConfig> {
  const message =
    args.maintenanceMessage?.trim() ||
    (args.maintenanceMode ? DEFAULT_MAINTENANCE_MESSAGE : null);

  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent: DEFAULT_PG_FEE_PERCENT,
      allowedEmailDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
      usdInrRate: null,
      usdInrRateUpdatedAt: null,
      maintenanceMode: args.maintenanceMode,
      maintenanceMessage: message,
    },
    update: {
      maintenanceMode: args.maintenanceMode,
      maintenanceMessage: message,
    },
  });

  return {
    maintenanceMode: row.maintenanceMode === true,
    maintenanceMessage: row.maintenanceMessage?.trim() || null,
  };
}

export async function getPgFeePercent(prisma: PrismaClient): Promise<number> {
  const row = await ensureSystemSettings(prisma);
  return row.pgFeePercent;
}

export async function setPgFeePercent(
  prisma: PrismaClient,
  pgFeePercent: number,
): Promise<number> {
  if (!Number.isFinite(pgFeePercent) || pgFeePercent < 0 || pgFeePercent > 100) {
    throw new Error("pgFeePercent must be between 0 and 100");
  }
  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent,
      allowedEmailDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
      usdInrRate: null,
      usdInrRateUpdatedAt: null,
    },
    update: { pgFeePercent },
  });
  return row.pgFeePercent;
}

function evaluateUsdInrRate(row: {
  usdInrRate: number | null;
  usdInrRateUpdatedAt: Date | null;
}):
  | { ok: true; rate: number }
  | { ok: false; reason: "absent" | "invalid" | "stale"; detail: string } {
  const n = row.usdInrRate;
  if (n == null) {
    return {
      ok: false,
      reason: "absent",
      detail: "SystemSettings.usdInrRate is null — an admin must set the rate",
    };
  }
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      reason: "invalid",
      detail: `stored rate is ${String(n)} (must be a finite number > 0)`,
    };
  }
  const updatedAt = row.usdInrRateUpdatedAt;
  if (updatedAt == null) {
    return {
      ok: false,
      reason: "stale",
      detail: "usdInrRateUpdatedAt is null — rate must be re-set by an admin",
    };
  }
  const maxAgeMs = usdInrRateMaxAgeHours() * 3_600_000;
  const ageMs = Date.now() - updatedAt.getTime();
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      reason: "stale",
      detail: `rate last set at ${updatedAt.toISOString()} exceeds USD_INR_RATE_MAX_AGE_HOURS=${usdInrRateMaxAgeHours()}`,
    };
  }
  return { ok: true, rate: n };
}

/**
 * Required for money paths (invoicing, payments). Throws when the rate is
 * absent, invalid, or older than USD_INR_RATE_MAX_AGE_HOURS.
 */
export async function getUsdInrRate(prisma: PrismaClient): Promise<number> {
  const row = await ensureSystemSettings(prisma);
  const result = evaluateUsdInrRate(row);
  if (!result.ok) {
    throw new MissingUsdInrRateError(result.reason, result.detail);
  }
  return result.rate;
}

/** Display / soft paths — never throws; returns null when rate is unusable. */
export async function getUsdInrRateOrNull(
  prisma: PrismaClient,
): Promise<number | null> {
  const row = await ensureSystemSettings(prisma);
  const result = evaluateUsdInrRate(row);
  return result.ok ? result.rate : null;
}

export async function getUsdInrRateMeta(prisma: PrismaClient): Promise<{
  usdInrRate: number | null;
  usdInrRateUpdatedAt: string | null;
  usable: boolean;
}> {
  const row = await ensureSystemSettings(prisma);
  const result = evaluateUsdInrRate(row);
  return {
    usdInrRate: row.usdInrRate,
    usdInrRateUpdatedAt: row.usdInrRateUpdatedAt?.toISOString() ?? null,
    usable: result.ok,
  };
}

export async function setUsdInrRate(
  prisma: PrismaClient,
  usdInrRate: number,
): Promise<number> {
  if (!Number.isFinite(usdInrRate) || usdInrRate <= 0 || usdInrRate > 500) {
    throw new Error("usdInrRate must be a positive number (max 500)");
  }
  const now = new Date();
  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent: DEFAULT_PG_FEE_PERCENT,
      allowedEmailDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
      usdInrRate,
      usdInrRateUpdatedAt: now,
    },
    update: { usdInrRate, usdInrRateUpdatedAt: now },
  });
  return row.usdInrRate!;
}

export async function getAllowedEmailDomains(
  prisma: PrismaClient,
): Promise<string> {
  const row = await ensureSystemSettings(prisma);
  return row.allowedEmailDomains;
}

export async function setAllowedEmailDomains(
  prisma: PrismaClient,
  allowedEmailDomains: string,
): Promise<string> {
  const normalized = allowedEmailDomains.trim();
  const domains = parseAllowedEmailDomains(normalized);
  if (domains.length === 0) {
    throw new Error("At least one allowed email domain is required");
  }
  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent: DEFAULT_PG_FEE_PERCENT,
      allowedEmailDomains: domains.join(","),
      usdInrRate: null,
      usdInrRateUpdatedAt: null,
    },
    update: { allowedEmailDomains: domains.join(",") },
  });
  return row.allowedEmailDomains;
}

/** Signup gate only. Never use this to refuse login or password reset. */
export async function isEmailDomainAllowed(
  prisma: PrismaClient,
  email: string,
): Promise<boolean> {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2 || !parts[1]?.trim()) {
    return false;
  }
  const domain = parts[1]!.trim();
  const allowed = parseAllowedEmailDomains(await getAllowedEmailDomains(prisma));
  return allowed.includes(domain);
}
