import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { decryptDeltaSecretOrPlain } from "../utils/encryption.js";
import { registerUserWithBot } from "../services/botBridgeService.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const userId = "5dc0105f-938a-4853-aa5e-a9372d134e60";
  const strategyId = "bd8e7d98-32b1-4062-ace3-1681a4569b51";
  const subscriptionId = "512b4ef1-80bf-40df-a2c6-c651d2799bf5";

  // Get exchange account
  const ea = await prisma.exchangeAccount.findFirst({
    where: { userId },
  });
  if (!ea) throw new Error("No exchange account found");

  const apiKey = decryptDeltaSecretOrPlain(ea.apiKey);
  const apiSecret = decryptDeltaSecretOrPlain(ea.apiSecret);
  console.log("API Key prefix:", apiKey.substring(0, 15));

  // Register on bot
  const result = await registerUserWithBot({
    apiKey,
    apiSecret,
    userId,
    strategyId,
    subscriptionId,
    userAllocatedCapitalUsd: 300,
  });
  console.log("Bot registration result:", JSON.stringify(result));

  if (result.success && result.botSlaveId) {
    // Save botSlaveId
    await prisma.$executeRaw`
      UPDATE "UserSubscription"
      SET "botSlaveId" = ${String(result.botSlaveId)}, "isActive" = true
      WHERE id = ${subscriptionId}
    `;
    console.log("botSlaveId saved:", result.botSlaveId);
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
