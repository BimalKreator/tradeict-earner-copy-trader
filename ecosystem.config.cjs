/**
 * PM2: always run the compiled API from ./backend (not another clone or stale cwd).
 * From repo root:  npm run build --prefix backend && pm2 startOrReload ecosystem.config.cjs
 */
const path = require("path");

const backendDir = path.join(__dirname, "backend");
const serverJs = path.join(backendDir, "dist", "server.js");

module.exports = {
  apps: [
    {
      name: "tradeict-bot",
      cwd: backendDir,
      script: serverJs,
      interpreter: "node",
      instances: 1,
      autorestart: true,
    },
  ],
};
