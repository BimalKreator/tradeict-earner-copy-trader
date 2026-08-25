/**
 * Seed (or refresh) the Google Play Store reviewer demo account.
 *
 * Usage (from backend/):
 *   REVIEWER_EMAIL=... REVIEWER_PASSWORD=... npx tsx src/scripts/seedReviewerAccount.ts
 *   npx tsx src/scripts/seedReviewerAccount.ts --email=... --password=...
 *
 * No credentials are hardcoded — refuse to run if email/password are missing.
 * Does NOT create ExchangeAccount, wallet balance, trades, or simulated revenue.
 */

import "dotenv/config";
import bcrypt from "bcrypt";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  Prisma,
  PrismaClient,
  Role,
  SubscriptionStatus,
} from "@prisma/client";
import {
  getAllowedEmailDomains,
  isEmailDomainAllowed,
  parseAllowedEmailDomains,
} from "../services/settingsService.js";
import { resolvePrimaryStrategy } from "../services/futureHedgeService.js";
import { invalidateCopySubscriberCache } from "../services/strategySubscriptionService.js";
import { resolveStrategyBaseCapital } from "../utils/subscriptionCapital.js";
import {
  MAX_SUBSCRIPTION_MULTIPLIER,
  MIN_SUBSCRIPTION_MULTIPLIER,
} from "../constants/subscription.js";

/** Same rounds as authController (do not import from there — keep this script self-contained). */
const BCRYPT_ROUNDS = 12;

/** Same shape as publicController email checks. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROTECTED_EMAIL = "tradeictdevelopers@gmail.com";
const PROTECTED_USER_ID = "695f8b44-0af1-4d87-908b-38d9c942745a";

/** Small deployed capital so My Strategies renders without looking like live volume. */
const REVIEWER_DEPLOYED_CAPITAL_USD = 10;

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function readArgFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function resolveCredentials(): { email: string; password: string } {
  const email =
    process.env.REVIEWER_EMAIL?.trim() ||
    readArgFlag("email")?.trim() ||
    "";
  const password =
    process.env.REVIEWER_PASSWORD ||
    readArgFlag("password") ||
    "";
  return { email, password };
}

function abort(message: string): never {
  console.error(`[seedReviewerAccount] ABORT: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { email: emailRaw, password } = resolveCredentials();

  if (!emailRaw || !password) {
    abort(
      "REVIEWER_EMAIL and REVIEWER_PASSWORD are required (env or --email= / --password=). " +
        "No default credentials are provided.",
    );
  }

  if (password.length < 8) {
    abort("password must be at least 8 characters (same rule as signup).");
  }

  const email = normalizeEmail(emailRaw);

  if (email === PROTECTED_EMAIL) {
    abort(
      `Refusing to seed ${PROTECTED_EMAIL} — that is live EXECUTIVE user ${PROTECTED_USER_ID}. ` +
        `Use a distinct address (e.g. with a +tag), never this account.`,
    );
  }

  if (!EMAIL_RE.test(email)) {
    abort(
      `Email failed app validation (EMAIL_RE /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/): "${emailRaw}". ` +
        `If "+" was rejected, the validator needs a separate fix before Play review.`,
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    abort("DATABASE_URL is not set");
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const allowedRaw = await getAllowedEmailDomains(prisma);
    const allowedDomains = parseAllowedEmailDomains(allowedRaw);
    const domainAllowed = await isEmailDomainAllowed(prisma, email);
    if (!domainAllowed) {
      abort(
        `Domain not on allowlist for "${email}". Allowed domains: ${allowedDomains.join(", ") || "(none)"}`,
      );
    }

    const existingByEmail = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingByEmail?.id === PROTECTED_USER_ID) {
      abort(
        `Email "${email}" resolves to protected user ${PROTECTED_USER_ID} — refuse to modify.`,
      );
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        password: passwordHash,
        name: "Play Store Reviewer",
        mobile: "0000000000",
        role: Role.USER,
        isOtpBypassed: true,
        otpCode: null,
        otpExpiry: null,
        allowSimulation: false,
        cryptoArbitrageEnabled: false,
        cryptoBalance: 0,
        deltaBalanceDisplayOffset: 0,
        copyTradingPaused: true,
      },
      update: {
        password: passwordHash,
        name: "Play Store Reviewer",
        role: Role.USER,
        isOtpBypassed: true,
        otpCode: null,
        otpExpiry: null,
        allowSimulation: false,
        cryptoArbitrageEnabled: false,
        // Do not invent wallet/balance/trades — leave money fields alone on update
        // except simulation flags which must stay off for this demo account.
      },
    });

    if (user.id === PROTECTED_USER_ID) {
      abort(
        `Upsert unexpectedly returned protected user ${PROTECTED_USER_ID} — refusing to continue.`,
      );
    }

    // Never attach exchange credentials to the reviewer account.
    const exchangeCount = await prisma.exchangeAccount.count({
      where: { userId: user.id },
    });
    if (exchangeCount > 0) {
      abort(
        `User ${user.id} already has ${exchangeCount} ExchangeAccount row(s). ` +
          `Reviewer seed will not attach or leave API keys on this account — clean up manually.`,
      );
    }

    const strategy = await resolvePrimaryStrategy(prisma);
    const baseCapital = resolveStrategyBaseCapital(strategy);
    let multiplier =
      Math.round((REVIEWER_DEPLOYED_CAPITAL_USD / baseCapital) * 1e6) / 1e6;
    if (multiplier < MIN_SUBSCRIPTION_MULTIPLIER) {
      multiplier = MIN_SUBSCRIPTION_MULTIPLIER;
    }
    if (multiplier > MAX_SUBSCRIPTION_MULTIPLIER) {
      multiplier = MAX_SUBSCRIPTION_MULTIPLIER;
    }

    const profitSharePctSnapshot = new Prisma.Decimal(strategy.profitShare ?? 20);

    const existingSub = await prisma.userStrategySubscription.findUnique({
      where: {
        userId_strategyId: { userId: user.id, strategyId: strategy.id },
      },
    });

    const subscription = existingSub
      ? await prisma.userStrategySubscription.update({
          where: { id: existingSub.id },
          data: {
            status: SubscriptionStatus.ACTIVE,
            isActive: true,
            isStrategyFeePaid: true,
            multiplier,
            profitSharePctSnapshot,
            exchangeAccountId: null,
            botSlaveId: null,
          },
        })
      : await prisma.userStrategySubscription.create({
          data: {
            userId: user.id,
            strategyId: strategy.id,
            status: SubscriptionStatus.ACTIVE,
            isActive: true,
            isStrategyFeePaid: true,
            multiplier,
            profitSharePctSnapshot,
            exchangeAccountId: null,
            botSlaveId: null,
          },
        });

    invalidateCopySubscriberCache();

    console.log(`[seedReviewerAccount] user id=${user.id}`);
    console.log(`[seedReviewerAccount] email=${user.email}`);
    console.log(`[seedReviewerAccount] subscription id=${subscription.id}`);
    console.log(
      `[seedReviewerAccount] strategy="${strategy.title}" (${strategy.id}) multiplier=${multiplier} (~$${REVIEWER_DEPLOYED_CAPITAL_USD} deployed)`,
    );
    console.log(
      "isOtpBypassed=true — skips OTP AFTER a correct password.",
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
