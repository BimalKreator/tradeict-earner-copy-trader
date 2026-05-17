import type { PrismaClient } from "@prisma/client";

const SETTINGS_ID = "global";
const DEFAULT_PG_FEE_PERCENT = 2.36;
const DEFAULT_ALLOWED_EMAIL_DOMAINS =
  "gmail.com,yahoo.com,hotmail.com,outlook.com";

export const EMAIL_DOMAIN_BLOCKED_MESSAGE =
  "Registration from this email domain is not permitted. Please use an allowed provider.";

export function parseAllowedEmailDomains(raw: string): string[] {
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

async function ensureSystemSettings(prisma: PrismaClient) {
  return prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent: DEFAULT_PG_FEE_PERCENT,
      allowedEmailDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
    },
    update: {},
  });
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
    },
    update: { pgFeePercent },
  });
  return row.pgFeePercent;
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
    },
    update: { allowedEmailDomains: domains.join(",") },
  });
  return row.allowedEmailDomains;
}

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
