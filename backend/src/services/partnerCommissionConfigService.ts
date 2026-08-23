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

export type PartnerCommissionChainPreview = {
  label: string;
  totalPct: number;
  withinCap: boolean;
  slices: Array<{ role: string; pct: number; amountUsd: number }>;
};

export type PartnerCommissionPreview = {
  platformRevenueUsd: number;
  maxTotalPct: number;
  chains: PartnerCommissionChainPreview[];
};

function clampRate(n: number, label: string): number {
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`${label} must be between 0 and 100`);
  }
  return Math.round(n * 1e4) / 1e4;
}

function clampMaxTotalPct(n: number): number {
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    throw new Error("maxTotalPct must be greater than 0 and at most 100");
  }
  return Math.round(n * 1e4) / 1e4;
}

export function executiveChainTotalPct(rates: PartnerCommissionRates): number {
  return (
    rates.executiveDirectPct +
    rates.managerUnderExecutivePct +
    rates.directorUnderExecutivePct
  );
}

export function managerChainTotalPct(rates: PartnerCommissionRates): number {
  return rates.managerDirectPct + rates.directorUnderManagerPct;
}

export function directorChainTotalPct(rates: PartnerCommissionRates): number {
  return rates.directorDirectPct;
}

export function validatePartnerCommissionRateTotals(
  rates: PartnerCommissionRates,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(rates.maxTotalPct) || rates.maxTotalPct <= 0) {
    return {
      ok: false,
      error: `maxTotalPct must be greater than 0 (got ${rates.maxTotalPct})`,
    };
  }

  const executiveTotal = executiveChainTotalPct(rates);
  if (executiveTotal > rates.maxTotalPct) {
    return {
      ok: false,
      error:
        `Executive chain total ${executiveTotal}% exceeds maxTotalPct cap ${rates.maxTotalPct}% ` +
        `(executiveDirectPct=${rates.executiveDirectPct} + managerUnderExecutivePct=${rates.managerUnderExecutivePct} + directorUnderExecutivePct=${rates.directorUnderExecutivePct})`,
    };
  }

  const managerTotal = managerChainTotalPct(rates);
  if (managerTotal > rates.maxTotalPct) {
    return {
      ok: false,
      error:
        `Manager chain total ${managerTotal}% exceeds maxTotalPct cap ${rates.maxTotalPct}% ` +
        `(managerDirectPct=${rates.managerDirectPct} + directorUnderManagerPct=${rates.directorUnderManagerPct})`,
    };
  }

  const directorTotal = directorChainTotalPct(rates);
  if (directorTotal > rates.maxTotalPct) {
    return {
      ok: false,
      error:
        `Senior Manager chain total ${directorTotal}% exceeds maxTotalPct cap ${rates.maxTotalPct}% ` +
        `(directorDirectPct=${rates.directorDirectPct})`,
    };
  }

  return { ok: true };
}

export function buildPartnerCommissionPreview(
  rates: PartnerCommissionRates,
  platformRevenueUsd = 100,
): PartnerCommissionPreview {
  const amount = (pct: number) =>
    Math.round(((platformRevenueUsd * pct) / 100) * 100) / 100;

  const executiveTotal = executiveChainTotalPct(rates);
  const managerTotal = managerChainTotalPct(rates);
  const directorTotal = directorChainTotalPct(rates);

  return {
    platformRevenueUsd,
    maxTotalPct: rates.maxTotalPct,
    chains: [
      {
        label: "Executive acquired the trader",
        totalPct: executiveTotal,
        withinCap: executiveTotal <= rates.maxTotalPct,
        slices: [
          {
            role: "Executive",
            pct: rates.executiveDirectPct,
            amountUsd: amount(rates.executiveDirectPct),
          },
          {
            role: "Manager (upline)",
            pct: rates.managerUnderExecutivePct,
            amountUsd: amount(rates.managerUnderExecutivePct),
          },
          {
            role: "Senior Manager (upline)",
            pct: rates.directorUnderExecutivePct,
            amountUsd: amount(rates.directorUnderExecutivePct),
          },
        ],
      },
      {
        label: "Manager acquired the trader",
        totalPct: managerTotal,
        withinCap: managerTotal <= rates.maxTotalPct,
        slices: [
          {
            role: "Manager",
            pct: rates.managerDirectPct,
            amountUsd: amount(rates.managerDirectPct),
          },
          {
            role: "Senior Manager (upline)",
            pct: rates.directorUnderManagerPct,
            amountUsd: amount(rates.directorUnderManagerPct),
          },
        ],
      },
      {
        label: "Senior Manager acquired the trader",
        totalPct: directorTotal,
        withinCap: directorTotal <= rates.maxTotalPct,
        slices: [
          {
            role: "Senior Manager",
            pct: rates.directorDirectPct,
            amountUsd: amount(rates.directorDirectPct),
          },
        ],
      },
    ],
  };
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
    data.partnerMaxCommissionPct = clampMaxTotalPct(input.maxTotalPct);
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

  const current = await getPartnerCommissionRates(prisma);
  const merged: PartnerCommissionRates = {
    maxTotalPct:
      data.partnerMaxCommissionPct ?? current.maxTotalPct,
    executiveDirectPct:
      data.partnerExecutiveDirectPct ?? current.executiveDirectPct,
    managerUnderExecutivePct:
      data.partnerManagerUnderExecPct ?? current.managerUnderExecutivePct,
    directorUnderExecutivePct:
      data.partnerDirectorUnderExecPct ?? current.directorUnderExecutivePct,
    managerDirectPct:
      data.partnerManagerDirectPct ?? current.managerDirectPct,
    directorUnderManagerPct:
      data.partnerDirectorUnderMgrPct ?? current.directorUnderManagerPct,
    directorDirectPct:
      data.partnerDirectorDirectPct ?? current.directorDirectPct,
  };

  const validation = validatePartnerCommissionRateTotals(merged);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const row = await prisma.systemSettings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      partnerMaxCommissionPct: merged.maxTotalPct,
      partnerExecutiveDirectPct: merged.executiveDirectPct,
      partnerManagerUnderExecPct: merged.managerUnderExecutivePct,
      partnerDirectorUnderExecPct: merged.directorUnderExecutivePct,
      partnerManagerDirectPct: merged.managerDirectPct,
      partnerDirectorUnderMgrPct: merged.directorUnderManagerPct,
      partnerDirectorDirectPct: merged.directorDirectPct,
    },
    update: data,
  });

  return rowToRates(row);
}
