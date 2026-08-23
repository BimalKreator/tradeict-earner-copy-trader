/**
 * Terminal log filter — suppress known noisy lines; print everything else.
 * Import this module once at process boot before other services load.
 */

const SUPPRESS_PATTERNS: RegExp[] = [
  /\[DEBUG_AUTH\]/i,
  /\[exchangeService\] option UPL@Offer/i,
  /\[exchangeService\] realtime position overlay/i,
  /\[exchangeService\] fetchDeltaOpenPositions: market fallback/i,
  /\[exchangeService\] option hydrate/i,
  /\[exchangeService\] option product .* not found in CCXT/i,
  /\[exchangeService\] .*(hydrate|overlay|fallback)/i,
  /\[PNL_TRACKER\]/i,
  /\[tradeEngine WS\] type=/i,
  /\[tradeEngine WS\] tracked /i,
  /\[tradeEngine WS\] positions snapshot processed/i,
  /Initializing CCXT for API Key/i,
];

function buildSuppressPatterns(): RegExp[] {
  const extra = process.env.LOG_SUPPRESS_EXTRA?.trim();
  if (!extra) return SUPPRESS_PATTERNS;
  const substrings = extra
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (substrings.length === 0) return SUPPRESS_PATTERNS;
  const escaped = substrings.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return [
    ...SUPPRESS_PATTERNS,
    ...escaped.map((s) => new RegExp(s, "i")),
  ];
}

let activeSuppressPatterns = SUPPRESS_PATTERNS;

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

function isSuppressed(msg: string): boolean {
  return activeSuppressPatterns.some((re) => re.test(msg));
}

function wrapConsole(
  level: "log" | "warn",
  original: (...args: unknown[]) => void,
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (level === "warn") {
      original(...args);
      return;
    }
    const msg = messageText(args);
    if (!isSuppressed(msg)) {
      original(...args);
    }
  };
}

export function installTradeLogFilter(): void {
  if (process.env.TRADE_LOG_FILTER === "0") return;

  activeSuppressPatterns = buildSuppressPatterns();

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = wrapConsole("log", origLog) as typeof console.log;
  console.warn = wrapConsole("warn", origWarn) as typeof console.warn;
  console.error = origError;
}
