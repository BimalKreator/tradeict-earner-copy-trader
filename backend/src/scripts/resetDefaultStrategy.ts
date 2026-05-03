/**
 * Removes all strategies and related subscription/trade data, then creates the default
 * Intraday strategy. Run: `npm run build && node dist/scripts/resetDefaultStrategy.js`
 * from the backend directory (with DATABASE_URL / DIRECT_URL in .env).
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

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
    await prisma.invoice.deleteMany({});
    await prisma.trade.deleteMany({});
    await prisma.pnLRecord.deleteMany({});
    await prisma.userSubscription.deleteMany({});
    await prisma.strategy.deleteMany({});

    await prisma.strategy.create({
      data: {
        title: "Intraday Cryptotrading Algo - For Delta Ex India",
        description:
          "Automated intraday crypto strategy mirrored from a linked Cosmic Trade account to Delta Exchange (India). Configure Cosmic API credentials on this strategy and set COSMIC_POSITIONS_HTTP_URL in the API environment.",
        cosmicApiKey: "",
        cosmicApiSecret: "",
        performanceMetrics: {},
        slippage: 0.5,
        monthlyFee: 0,
        profitShare: 20,
        minCapital: 0,
      },
    });

    console.log("All prior strategies removed. Default strategy created.");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
