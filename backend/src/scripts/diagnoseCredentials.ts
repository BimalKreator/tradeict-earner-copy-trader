/**
 * Report which stored Delta credentials decrypt successfully (copy-trading health check).
 *
 * Run from backend/:
 *   npm run diagnose-credentials
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  decryptDeltaSecretOrPlain,
  isGcmSecret,
} from "../utils/encryption.js";

function formatKind(stored: string): string {
  const t = stored.trim();
  if (!t) return "empty";
  if (isGcmSecret(t)) return "gcm:v1";
  if (t.startsWith("U2Fsd")) return "legacy-aes";
  return "plaintext?";
}

function checkField(label: string, stored: string): boolean {
  const ok = Boolean(decryptDeltaSecretOrPlain(stored));
  console.log(
    `    ${label}: ${ok ? "OK" : "FAIL"} (${formatKind(stored)})`,
  );
  return ok;
}

async function main(): Promise<void> {
  const enc = process.env.ENCRYPTION_KEY?.trim();
  const legacy = process.env.PROCESS_ENCRYPTION_KEY?.trim();
  if (!enc && !legacy) {
    console.error("Set ENCRYPTION_KEY or PROCESS_ENCRYPTION_KEY in .env");
    process.exit(1);
  }
  console.log(
    `[diagnose-credentials] ENCRYPTION_KEY=${enc ? "set" : "missing"} ` +
      `PROCESS_ENCRYPTION_KEY=${legacy ? "set" : "missing"}`,
  );

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  let okRows = 0;
  let failRows = 0;

  try {
    const accounts = await prisma.exchangeAccount.findMany({
      select: {
        id: true,
        userId: true,
        nickname: true,
        exchange: true,
        apiKey: true,
        apiSecret: true,
        user: { select: { email: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    console.log(`\nExchangeAccount rows: ${accounts.length}`);
    for (const row of accounts) {
      console.log(
        `\n  user=${row.user.email} account=${row.id} (${row.nickname}, ${row.exchange})`,
      );
      const keyOk = checkField("apiKey", row.apiKey);
      const secretOk = checkField("apiSecret", row.apiSecret);
      if (keyOk && secretOk) okRows += 1;
      else failRows += 1;
    }

    const deltaKeys = await prisma.deltaApiKey.findMany({
      select: {
        id: true,
        userId: true,
        nickname: true,
        apiKey: true,
        apiSecret: true,
        user: { select: { email: true } },
      },
      orderBy: { id: "asc" },
    });

    console.log(`\nDeltaApiKey rows: ${deltaKeys.length}`);
    for (const row of deltaKeys) {
      console.log(`\n  user=${row.user.email} deltaApiKey=${row.id} (${row.nickname})`);
      const keyOk = checkField("apiKey", row.apiKey);
      const secretOk = checkField("apiSecret", row.apiSecret);
      if (keyOk && secretOk) okRows += 1;
      else failRows += 1;
    }

    const activeSubs = await prisma.userStrategySubscription.findMany({
      where: { isActive: true, status: "ACTIVE" },
      select: {
        userId: true,
        strategyId: true,
        exchangeAccountId: true,
        user: { select: { email: true } },
        exchangeAccount: {
          select: { id: true, apiKey: true, apiSecret: true },
        },
      },
    });

    console.log(`\nActive copy subscribers: ${activeSubs.length}`);
    for (const sub of activeSubs) {
      const ex = sub.exchangeAccount;
      if (!ex) {
        console.log(`  FAIL ${sub.user.email} — no exchange account linked`);
        continue;
      }
      const keyOk = Boolean(decryptDeltaSecretOrPlain(ex.apiKey));
      const secretOk = Boolean(decryptDeltaSecretOrPlain(ex.apiSecret));
      const status = keyOk && secretOk ? "OK" : "FAIL";
      console.log(
        `  ${status} ${sub.user.email} strategy=${sub.strategyId} exchangeAccount=${ex.id}`,
      );
    }

    console.log(
      `\n[diagnose-credentials] credential rows ok=${okRows} fail=${failRows}`,
    );
    if (failRows > 0) {
      console.log(
        "\nFix: set the correct ENCRYPTION_KEY / PROCESS_ENCRYPTION_KEY, redeploy, " +
          "or have affected users re-save Delta API keys in Settings.",
      );
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[diagnose-credentials] fatal:", err);
  process.exit(1);
});
