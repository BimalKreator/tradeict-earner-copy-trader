/**
 * PM2 / production entry: refuses to start if `dist/` was never rebuilt after
 * Delta India symbol fixes (avoids silent ticker failures from stale compiled JS).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exchangeSvc = path.join(__dirname, "dist", "services", "exchangeService.js");
const serverJs = path.join(__dirname, "dist", "server.js");

function fatal(msg) {
  console.error(msg);
  process.exit(1);
}

for (const p of [exchangeSvc, serverJs]) {
  if (!fs.existsSync(p)) {
    fatal(
      `FATAL: Missing ${path.relative(__dirname, p)}. Run:\n` +
        `  cd ${__dirname} && npm ci && npm run build\n` +
        `Then restart PM2 (see repo root ecosystem.config.cjs).`,
    );
  }
}

const exBody = fs.readFileSync(exchangeSvc, "utf8");
if (
  !exBody.includes("market.option === true || isDeltaOptionProductId") ||
  exBody.includes("resolveDeltaPositionUpnl")
) {
  fatal(
    "FATAL: dist/services/exchangeService.js is stale (wrong Live PnL logic).\n" +
      "Rebuild required:\n" +
      `  cd ${__dirname}\n` +
      "  rm -rf dist && npm ci && npm run build\n" +
      "  cd .. && pm2 delete tradeict-bot 2>/dev/null; pm2 start ecosystem.config.cjs && pm2 save\n",
  );
}

await import(pathToFileURL(serverJs).href);
