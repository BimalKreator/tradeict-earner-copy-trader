import type { PrismaClient } from "@prisma/client";

const SETTINGS_ID = "global";
const DEFAULT_PG_FEE_PERCENT = 2.36;

export async function getPgFeePercent(prisma: PrismaClient): Promise<number> {
  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, pgFeePercent: DEFAULT_PG_FEE_PERCENT },
    update: {},
  });
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
    create: { id: SETTINGS_ID, pgFeePercent },
    update: { pgFeePercent },
  });
  return row.pgFeePercent;
}
