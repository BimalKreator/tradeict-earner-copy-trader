/**
 * Run on the VPS after `npm run build` (from `backend/`):
 *   node scripts/diagnose-bot.js
 * Expect: deltaEthUsdtToCcxt=ETH/USD:USD and fetchDeltaTicker last is a number.
 */
import {
  DELTA_INDIA_CCXT_SAMPLE_SYMBOL,
  fetchDeltaTicker,
} from "../dist/services/exchangeService.js";

console.log("DELTA_INDIA_CCXT_SAMPLE_SYMBOL (ETHUSDT→)", DELTA_INDIA_CCXT_SAMPLE_SYMBOL);
if (DELTA_INDIA_CCXT_SAMPLE_SYMBOL !== "ETH/USD:USD") {
  console.error(
    "FAIL: Wrong symbol map. Rebuild: cd backend && rm -rf dist && npm run build",
  );
  process.exit(1);
}

for (const sym of ["ETHUSDT", "AVAXUSDT"]) {
  const t = await fetchDeltaTicker(sym);
  console.log(`fetchDeltaTicker(${sym})`, t);
  if (t.last == null || !Number.isFinite(t.last)) {
    console.error(`FAIL: ticker for ${sym}`);
    process.exit(1);
  }
}
console.log("OK");
