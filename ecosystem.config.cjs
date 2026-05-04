/**
 * PM2: always run the compiled API from ./backend (not another clone or stale cwd).
 * From repo root:  npm run build --prefix backend && pm2 startOrReload ecosystem.config.cjs
 */
const path = require("path");

const backendDir = path.join(__dirname, "backend");
const runner = path.join(backendDir, "run-production.mjs");

module.exports = {
  apps: [
    {
      name: "tradeict-bot",
      cwd: backendDir,
      /** Fails fast if `dist/` is stale; loads `dist/server.js` after checks. */
      script: runner,
      interpreter: "node",
      instances: 1,
      autorestart: true,
    },
  ],
};
