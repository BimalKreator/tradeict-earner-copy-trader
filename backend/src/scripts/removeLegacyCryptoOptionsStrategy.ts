/**
 * One-time cleanup: delete legacy "Crypto Options …" strategies and related data.
 * Ensures "Future Hedge Strategy" exists as the sole primary strategy.
 *
 * Run from backend/: `npm run db:remove-legacy-strategies`
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { removeLegacyCryptoOptionsStrategies } from "../services/strategyCleanupService.js";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const result = await removeLegacyCryptoOptionsStrategies(prisma);

    if (result.removed.length === 0) {
      console.log(
        "No legacy Crypto Options strategies found — nothing to delete.",
      );
    } else {
      console.log(
        `Removed ${result.removed.length} legacy strateg(ies):`,
        result.removed.map((r) => `"${r.title}" (${r.strategyId})`).join(", "),
      );
    }

    console.log(
      `Primary strategy: "${result.primaryStrategyTitle}" (${result.primaryStrategyId})`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
