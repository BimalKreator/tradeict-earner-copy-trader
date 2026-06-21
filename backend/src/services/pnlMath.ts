import Big from "big.js";

/** Financial round half-up to 2 decimal places (USD cents). */
export function roundPnlUsdHalfUp(value: Big | number | string): number {
  const b = value instanceof Big ? value : new Big(value);
  return Number(b.round(2, Big.roundHalfUp).toString());
}

/** BTC option legs on Delta India — 0.001 BTC notional per lot. */
export const BTC_OPTION_CONTRACT_VALUE = 0.001;

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
  symbol?: string;
}): number {
  const lots = new Big(Math.abs(args.positionLots));
  const cv = new Big(args.contractValue);
  const entry = new Big(args.entryPrice);
  const exit = new Big(args.exitPrice);
  const diff = args.side === "BUY" ? exit.minus(entry) : entry.minus(exit);
  const calculatedPnl = roundPnlUsdHalfUp(diff.times(lots).times(cv));

  const sym = args.symbol?.trim() ?? "";
  const isOptionLike =
    sym.startsWith("C-") ||
    sym.startsWith("P-") ||
    args.contractValue > 0 && args.contractValue < 1;
  if (isOptionLike) {
    console.log("PnL Debug:", {
      symbol: sym || undefined,
      lots: Number(lots.toString()),
      contractValue: Number(cv.toString()),
      entry: Number(entry.toString()),
      exit: Number(exit.toString()),
      side: args.side,
      calculatedPnl,
    });
  }

  return calculatedPnl;
}
