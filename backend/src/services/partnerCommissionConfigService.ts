import type { PrismaClient } from "@prisma/client";

const SETTINGS_ID = "global";

export type PartnerCommissionRates = {
  maxTotalPct: number;
  executiveDirectPct: number;
  managerUnderExecutivePct: number;
  directorUnderExecutivePct: number;
  managerDirectPct: number;
  directorUnderManagerPct: number;
  directorDirectPct: number;
};

export const DEFAULT_PARTNER_COMMISSION_RATES: PartnerCommissionRates = {
  maxTotalPct: 8,
  executiveDirectPct: 5,
  managerUnderExecutivePct: 2,
  directorUnderExecutivePct: 1,
  managerDirectPct: 6,
  directorUnderManagerPct: 2,
  directorDirectPct: 8,
};

function clampRate(n: number, label: string): number {
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`${label} must be between 0 and 100`);
  }
  return Math.round(n * 1e4) / 1e4;
}

function rowToRates(row: {
  partnerMaxCommissionPct: number;
  partnerExecutiveDirectPct: number;
  partnerManagerUnderExecPct: number;
  partnerDirectorUnderExecPct: number;
  partnerManagerDirectPct: number;
  partnerDirectorUnderMgrPct: number;
  partnerDirectorDirectPct: number;
}): PartnerCommissionRates {
  return {
    maxTotalPct: row.partnerMaxCommissionPct,
    executiveDirectPct: row.partnerExecutiveDirectPct,
    managerUnderExecutivePct: row.partnerManagerUnderExecPct,
    directorUnderExecutivePct: row.partnerDirectorUnderExecPct,
    managerDirectPct: row.partnerManagerDirectPct,
    directorUnderManagerPct: row.partnerDirectorUnderMgrPct,
    directorDirectPct: row.partnerDirectorDirectPct,
  };
}

async function ensureSystemSettings(prisma: PrismaClient) {
  return prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      ...{
        partnerMaxCommissionPct: DEFAULT_PARTNER_COMMISSION_RATES.maxTotalPct,
        partnerExecutiveDirectPct:
          DEFAULT_PARTNER_COMMISSION_RATES.executiveDirectPct,
        partnerManagerUnderExecPct:
          DEFAULT_PARTNER_COMMISSION_RATES.managerUnderExecutivePct,
        partnerDirectorUnderExecPct:
          DEFAULT_PARTNER_COMMISSION_RATES.directorUnderExecutivePct,
        partnerManagerDirectPct:
          DEFAULT_PARTNER_COMMISSION_RATES.managerDirectPct,
        partnerDirectorUnderMgrPct:
          DEFAULT_PARTNER_COMMISSION_RATES.directorUnderManagerPct,
        partnerDirectorDirectPct:
          DEFAULT_PARTNER_COMMISSION_RATES.directorDirectPct,
      },
    },
    update: {},
  });
}

export async function getPartnerCommissionRates(
  prisma: PrismaClient,
): Promise<PartnerCommissionRates> {
  const row = await ensureSystemSettings(prisma);
  return rowToRates(row);
}

export type UpdatePartnerCommissionRatesInput = Partial<PartnerCommissionRates>;

export async function setPartnerCommissionRates(
  prisma: PrismaClient,
  input: UpdatePartnerCommissionRatesInput,
): Promise<PartnerCommissionRates> {
  const data: Record<string, number> = {};

  if (input.maxTotalPct !== undefined) {
    data.partnerMaxCommissionPct = clampRate(
      input.maxTotalPct,
      "maxTotalPct",
    );
  }
  if (input.executiveDirectPct !== undefined) {
    data.partnerExecutiveDirectPct = clampRate(
      input.executiveDirectPct,
      "executiveDirectPct",
    );
  }
  if (input.managerUnderExecutivePct !== undefined) {
    data.partnerManagerUnderExecPct = clampRate(
      input.managerUnderExecutivePct,
      "managerUnderExecutivePct",
    );
  }
  if (input.directorUnderExecutivePct !== undefined) {
    data.partnerDirectorUnderExecPct = clampRate(
      input.directorUnderExecutivePct,
      "directorUnderExecutivePct",
    );
  }
  if (input.managerDirectPct !== undefined) {
    data.partnerManagerDirectPct = clampRate(
      input.managerDirectPct,
      "managerDirectPct",
    );
  }
  if (input.directorUnderManagerPct !== undefined) {
    data.partnerDirectorUnderMgrPct = clampRate(
      input.directorUnderManagerPct,
      "directorUnderManagerPct",
    );
  }
  if (input.directorDirectPct !== undefined) {
    data.partnerDirectorDirectPct = clampRate(
      input.directorDirectPct,
      "directorDirectPct",
    );
  }

  if (Object.keys(data).length === 0) {
    throw new Error("Provide at least one partner commission rate to update");
  }

  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      partnerMaxCommissionPct:
        data.partnerMaxCommissionPct ??
        DEFAULT_PARTNER_COMMISSION_RATES.maxTotalPct,
      partnerExecutiveDirectPct:
        data.partnerExecutiveDirectPct ??
        DEFAULT_PARTNER_COMMISSION_RATES.executiveDirectPct,
      partnerManagerUnderExecPct:
        data.partnerManagerUnderExecPct ??
        DEFAULT_PARTNER_COMMISSION_RATES.managerUnderExecutivePct,
      partnerDirectorUnderExecPct:
        data.partnerDirectorUnderExecPct ??
        DEFAULT_PARTNER_COMMISSION_RATES.directorUnderExecutivePct,
      partnerManagerDirectPct:
        data.partnerManagerDirectPct ??
        DEFAULT_PARTNER_COMMISSION_RATES.managerDirectPct,
      partnerDirectorUnderMgrPct:
        data.partnerDirectorUnderMgrPct ??
        DEFAULT_PARTNER_COMMISSION_RATES.directorUnderManagerPct,
      partnerDirectorDirectPct:
        data.partnerDirectorDirectPct ??
        DEFAULT_PARTNER_COMMISSION_RATES.directorDirectPct,
    },
    update: data,
  });

  return rowToRates(row);
}
