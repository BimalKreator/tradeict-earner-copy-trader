module.exports = {
  apps: [
    {
      name: "tradeict-earner",
      script: "/home/tradeict-earner/backend/run-production.mjs",
      cwd: "/home/tradeict-earner/backend",
      interpreter: "node",
      exec_mode: "cluster",
      instances: 1,
      autorestart: true,
      max_memory_restart: "800M",
    },
  ],
};
