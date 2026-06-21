import Big from "big.js";

/** Financial round half-up to 2 decimal places (USD cents). */
export function roundPnlUsdHalfUp(value: Big | number | string): number {
  const b = value instanceof Big ? value : new Big(value);
  return Number(b.round(2, Big.roundHalfUp).toString());
}

/**
 * Terminal UPNL: `(exit - entry) * lots * contract_value` for BUY,
 * `(entry - exit) * lots * contract_value` for SELL — half-up to 2dp.
 */
export function computeTerminalPnlUsd(args: {
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  positionLots: number;
  contractValue: number;
}): number {
  const lots = new Big(Math.abs(args.positionLots));
  const cv = new Big(args.contractValue);
  const entry = new Big(args.entryPrice);
  const exit = new Big(args.exitPrice);
  const diff = args.side === "BUY" ? exit.minus(entry) : entry.minus(exit);
  return roundPnlUsdHalfUp(diff.times(lots).times(cv));
}
