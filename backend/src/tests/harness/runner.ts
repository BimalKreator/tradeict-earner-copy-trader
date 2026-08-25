import "dotenv/config";
import "./emailGag.js";
import { AssertionContext } from "./assert.js";
import {
  createHarnessPrisma,
  TestFixtureFactory,
  TestRegistry,
  verifyNoTestRowLeaks,
} from "./fixtures.js";
import { p12PayoutLifecycleScenario } from "./scenarios/p12-payout-lifecycle.js";
import { p12ReversalScenario } from "./scenarios/p12-reversal.js";
import { p12WalletRaceScenario } from "./scenarios/p12-wallet-race.js";
import { schemaDriftScenario } from "./scenarios/schema-drift.js";
import type { HarnessScenario, ScenarioResult } from "./types.js";
import {
  getSmtpSendAttempts,
  waitForInflightMail,
} from "../../utils/emailService.js";

const ALL_SCENARIOS: HarnessScenario[] = [
  schemaDriftScenario,
  p12ReversalScenario,
  p12WalletRaceScenario,
  p12PayoutLifecycleScenario,
];

function parseOnlyArg(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith("--only=")) {
      return arg.slice("--only=".length).trim();
    }
  }
  return null;
}

function formatDuration(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

function printResultsTable(results: ScenarioResult[]): void {
  const nameWidth = Math.max(
    "scenario".length,
    ...results.map((r) => r.name.length),
  );
  console.log("");
  console.log(
    `${"scenario".padEnd(nameWidth)}  ${"assertions".padStart(10)}  ${"duration".padStart(10)}  result`,
  );
  console.log(`${"-".repeat(nameWidth)}  ${"-".repeat(10)}  ${"-".repeat(10)}  ${"-".repeat(6)}`);
  for (const row of results) {
    const status = row.passed ? "PASS" : "FAIL";
    console.log(
      `${row.name.padEnd(nameWidth)}  ${String(row.assertionCount).padStart(10)}  ${formatDuration(row.durationMs).padStart(10)}  ${status}${row.error ? ` — ${row.error}` : ""}`,
    );
  }
  console.log("");
}

async function runScenario(
  scenario: HarnessScenario,
  prisma: ReturnType<typeof createHarnessPrisma>,
): Promise<ScenarioResult> {
  const started = Date.now();
  const assert = new AssertionContext();
  const registry = new TestRegistry();
  const fixtures = new TestFixtureFactory(prisma, registry);

  try {
    await scenario.run({ prisma, assert, fixtures });
    return {
      name: scenario.name,
      passed: true,
      assertionCount: assert.assertionCount,
      durationMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      name: scenario.name,
      passed: false,
      assertionCount: assert.assertionCount,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await registry.cleanup(prisma);
    } catch (cleanupErr) {
      const msg =
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      throw new Error(`Cleanup failed for scenario ${scenario.name}: ${msg}`);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.EMAIL_TRANSPORT !== "noop") {
    console.error(
      "Harness refused to start: EMAIL_TRANSPORT must be noop so tests cannot send mail",
    );
    process.exit(1);
  }

  const only = parseOnlyArg(process.argv.slice(2));
  const selected = only
    ? ALL_SCENARIOS.filter((s) => s.name === only)
    : ALL_SCENARIOS;

  if (selected.length === 0) {
    console.error(
      only
        ? `No scenario named "${only}". Registered: ${ALL_SCENARIOS.map((s) => s.name).join(", ")}`
        : "No scenarios registered",
    );
    process.exit(1);
  }

  console.log(`Harness: ${selected.length} scenario(s)`);
  console.log(`Registered: ${ALL_SCENARIOS.map((s) => s.name).join(", ")}`);
  console.log("EMAIL_TRANSPORT=noop");

  const prisma = createHarnessPrisma();
  const results: ScenarioResult[] = [];

  try {
    for (const scenario of selected) {
      results.push(await runScenario(scenario, prisma));
    }
  } finally {
    await prisma.$disconnect();
  }

  await waitForInflightMail();

  const smtpAttempts = getSmtpSendAttempts();
  if (smtpAttempts > 0) {
    console.error(
      `EMAIL LEAK: ${smtpAttempts} SMTP send(s) while EMAIL_TRANSPORT=noop`,
    );
    process.exit(1);
  }

  printResultsTable(results);

  const leaks = await (async () => {
    const leakPrisma = createHarnessPrisma();
    try {
      return await verifyNoTestRowLeaks(leakPrisma);
    } finally {
      await leakPrisma.$disconnect();
    }
  })();

  await waitForInflightMail();

  if (leaks.length > 0) {
    console.error(`LEAK: ${leaks.length} TEST-P row(s) remain after cleanup:`);
    for (const leak of leaks) {
      console.error(`  - ${leak}`);
    }
    process.exit(1);
  }

  const failed = results.some((r) => !r.passed);
  if (failed) {
    process.exit(1);
  }

  console.log("All scenarios passed. No TEST-P leaks detected. No SMTP sends.");
}

main().catch(async (err) => {
  await waitForInflightMail();
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
