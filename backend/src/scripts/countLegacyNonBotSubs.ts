import "dotenv/config";
import pg from "pg";

async function main(): Promise<void> {
  const connectionString =
    process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const r = await client.query(`
      SELECT COUNT(*)::int AS n
      FROM "UserStrategySubscription" uss
      JOIN "Strategy" s ON s.id = uss."strategyId"
      WHERE uss.status = 'ACTIVE'
        AND (s."botStrategyType" IS NULL OR s."botStrategyType" = '')
    `);
    console.log(
      JSON.stringify({ liveNonBotActiveSubscriptions: r.rows[0].n }, null, 2),
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
