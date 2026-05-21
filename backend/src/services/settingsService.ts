import type { PrismaClient } from "@prisma/client";

const SETTINGS_ID = "global";
const DEFAULT_PG_FEE_PERCENT = 2.36;
const DEFAULT_ALLOWED_EMAIL_DOMAINS =
  "gmail.com,yahoo.com,hotmail.com,outlook.com";
export const DEFAULT_USD_INR_RATE = 83;
export const DEFAULT_MAINTENANCE_MESSAGE =
  "The platform is temporarily under maintenance. Please check back shortly.";

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

async function ensureSystemSettings(prisma: PrismaClient) {
  return prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent: DEFAULT_PG_FEE_PERCENT,
      allowedEmailDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
      usdInrRate: DEFAULT_USD_INR_RATE,
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
      usdInrRate: DEFAULT_USD_INR_RATE,
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
      usdInrRate: DEFAULT_USD_INR_RATE,
    },
    update: { pgFeePercent },
  });
  return row.pgFeePercent;
}

export async function getUsdInrRate(prisma: PrismaClient): Promise<number> {
  const row = await ensureSystemSettings(prisma);
  const n = row.usdInrRate;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_INR_RATE;
}

export async function setUsdInrRate(
  prisma: PrismaClient,
  usdInrRate: number,
): Promise<number> {
  if (!Number.isFinite(usdInrRate) || usdInrRate <= 0 || usdInrRate > 500) {
    throw new Error("usdInrRate must be a positive number (max 500)");
  }
  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      pgFeePercent: DEFAULT_PG_FEE_PERCENT,
      allowedEmailDomains: DEFAULT_ALLOWED_EMAIL_DOMAINS,
      usdInrRate,
    },
    update: { usdInrRate },
  });
  return row.usdInrRate;
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
      usdInrRate: DEFAULT_USD_INR_RATE,
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
