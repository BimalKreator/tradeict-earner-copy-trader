/**
 * Terminal log filter — show trade lifecycle + errors only (suppress exchange noise).
 * Import this module once at process boot before other services load.
 */

const TRADE_LOG_MARKERS = [
  "[copy]",
  "[FORCE-SYNC]",
  "[MASTER-REST-SYNC]",
  "[MASTER-WS]",
  "[RETRY_LOOP]",
  "[RECONCILE]",
  "[EXECUTION]",
  "[trade-settlement]",
  "[tradePosition]",
  "[copy-deficit]",
  "[copy-exec]",
  "[admin-qty-adjust]",
  "[admin-master-qty-adjust]",
  "[late-join]",
  "[manual-sync]",
  "[granular-sync]",
  "[live-trades]",
  "[SYNC-MONITOR]",
  "[COPY-SYNC]",
  "[BOOT]",
  "[tradeEngine]",
  "[affiliateCommission]",
];

const SUPPRESS_PATTERNS: RegExp[] = [
  /\[DEBUG_AUTH\]/i,
  /\[exchangeService\] option UPL@Offer/i,
  /\[exchangeService\] realtime position overlay/i,
  /\[exchangeService\] fetchDeltaOpenPositions: market fallback/i,
  /\[exchangeService\] option hydrate/i,
  /\[exchangeService\] option product .* not found in CCXT/i,
  /\[PNL_TRACKER\]/i,
  /\[tradeEngine WS\] type=/i,
  /\[tradeEngine WS\] tracked /i,
  /\[tradeEngine WS\] positions snapshot processed/i,
  /Initializing CCXT for API Key/i,
];

const ERROR_MARKERS = [
  /FATAL/i,
  /\bfailed\b/i,
  /\berror\b/i,
  /Hard error/i,
  /Confirm window exhausted/i,
  /unhandled rejection/i,
  /heartbeat missed/i,
];

function messageText(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function isTradeRelated(msg: string): boolean {
  if (ERROR_MARKERS.some((re) => re.test(msg))) return true;
  if (SUPPRESS_PATTERNS.some((re) => re.test(msg))) return false;
  return TRADE_LOG_MARKERS.some((m) => msg.includes(m));
}

function wrapConsole(
  level: "log" | "warn" | "error",
  original: (...args: unknown[]) => void,
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const msg = messageText(args);
    if (level === "error") {
      original(...args);
      return;
    }
    if (level === "warn") {
      if (isTradeRelated(msg) || ERROR_MARKERS.some((re) => re.test(msg))) {
        original(...args);
      }
      return;
    }
    if (isTradeRelated(msg)) {
      original(...args);
    }
  };
}

export function installTradeLogFilter(): void {
  if (process.env.TRADE_LOG_FILTER === "0") return;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = wrapConsole("log", origLog) as typeof console.log;
  console.warn = wrapConsole("warn", origWarn) as typeof console.warn;
  console.error = origError;
}
