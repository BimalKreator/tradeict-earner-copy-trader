import type { Prisma } from "@prisma/client";

/** When false (default), exclude simulated test rows from billing and customer views. */
export function simulatedScopeFilter(
  includeSimulated: boolean,
): Pick<Prisma.DeltaLedgerEntryWhereInput, "isSimulated"> | Record<string, never> {
  if (includeSimulated) return {};
  return { isSimulated: false };
}

/** Generic isSimulated filter for any table with that column. */
export function excludeSimulatedFilter(
  includeSimulated: boolean,
): { isSimulated?: false } | Record<string, never> {
  if (includeSimulated) return {};
  return { isSimulated: false };
}

/** Exclude dummy legacy trades and simulated PnL from money-moving paths. */
export function excludeTestPnlFilter(
  includeSimulated: boolean,
): Prisma.PnLRecordWhereInput {
  if (includeSimulated) return {};
  return { isSimulated: false, isDummy: false };
}

/** Scope queries to exactly real or simulated rows (never mix). */
export function scopedSimulatedFilter(isSimulated: boolean): { isSimulated: boolean } {
  return { isSimulated };
}

export function parseIncludeSimulated(raw: unknown): boolean {
  if (raw === true || raw === "true" || raw === "1") return true;
  return false;
}

export const SIM_PRODUCT_ID_BASE = 990_000_000;
export const SIM_BOT_STRUCTURE_ID_BASE = 990_000_000;
export const SIM_SYMBOL_PREFIX = "SIM-";
