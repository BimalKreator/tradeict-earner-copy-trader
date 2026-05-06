/**
 * PM2: runs the compiled API from ./backend AND the Next.js production server
 * from ./frontend. Both apps live in the same ecosystem so a single
 * `pm2 startOrReload ecosystem.config.cjs` restarts the whole stack.
 *
 * Deploy: from repo root, run `bash deploy.sh` (handles git pull, install,
 * Prisma, builds, restart, and pm2 save).
 */
const path = require("path");

const backendDir = path.join(__dirname, "backend");
const frontendDir = path.join(__dirname, "frontend");
const backendRunner = path.join(backendDir, "run-production.mjs");

module.exports = {
  apps: [
    {
      name: "tradeict-bot",
      cwd: backendDir,
      /** Fails fast if `dist/` is stale; loads `dist/server.js` after checks. */
      script: backendRunner,
      interpreter: "node",
      instances: 1,
      autorestart: true,
    },
    {
      name: "tradeict-frontend",
      cwd: frontendDir,
      /** `next start` serves the production build from ./frontend/.next. */
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3000",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
    },
  ],
};
