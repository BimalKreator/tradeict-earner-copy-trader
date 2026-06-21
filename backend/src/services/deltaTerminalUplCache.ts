type TradeSide = "BUY" | "SELL";

function legKey(symbolKey: string, side: TradeSide): string {
  return `${symbolKey.trim()}:${side.toUpperCase()}`;
}

/** Delta server-computed UPL from `positions` WS / REST (`upl` preferred). */
const terminalUplByLeg = new Map<string, number>();

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Parse Delta Terminal UPL from position payload.
 * Only `upl` — `unrealized_pnl` is mark-scaled and must not override bid/ask math.
 */
export function parseDeltaPositionTerminalUpl(
  row: Record<string, unknown>,
): number | null {
  if (row.upl === undefined || row.upl === null) return null;
  return num(row.upl);
}

export function cacheDeltaTerminalUpl(
  symbolKey: string,
  side: TradeSide,
  upl: number | null,
): void {
  const key = legKey(symbolKey, side);
  if (upl == null || !Number.isFinite(upl)) {
    terminalUplByLeg.delete(key);
    return;
  }
  terminalUplByLeg.set(key, upl);
}

export function getDeltaTerminalUpl(
  symbolKey: string,
  side: TradeSide,
): number | null {
  const v = terminalUplByLeg.get(legKey(symbolKey, side));
  return v != null && Number.isFinite(v) ? v : null;
}

/** Ingest one Delta `positions` WS / REST row — caches terminal UPL when present. */
export function ingestDeltaPositionTerminalUplRow(
  row: unknown,
  symbolKey: string,
  side: TradeSide,
): void {
  if (!row || typeof row !== "object") return;
  const upl = parseDeltaPositionTerminalUpl(row as Record<string, unknown>);
  if (upl !== null) cacheDeltaTerminalUpl(symbolKey, side, upl);
}
