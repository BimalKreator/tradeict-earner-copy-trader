/**
 * Compare legacy float commission vs Decimal ROUND_HALF_EVEN.
 * Run: npx tsx src/scripts/compareCommissionRounding.ts
 */
import { Prisma } from "@prisma/client";
import { computeCommissionAmount } from "../services/structureRevenueService.js";
import { roundInr, usdToInr } from "../services/paymentFeeService.js";

function legacyCommission(billableProfit: number, profitSharePct: number): number {
  return billableProfit * (profitSharePct / 100);
}

function legacyInvoiceBaseInr(amountDueUsd: number, usdInrRate: number): number {
  return Math.ceil(amountDueUsd * usdInrRate);
}

function legacyTotalInrCeil(total: number): number {
  return Math.ceil(total);
}

const cases: Array<{ billable: string; pct: string }> = [
  { billable: "100.00", pct: "20" },
  { billable: "123.4567890123", pct: "20" },
  { billable: "0.015", pct: "20" },
  { billable: "999.9999999999", pct: "17.5" },
  { billable: "1.005", pct: "20" },
  { billable: "10.125", pct: "33.333" },
];

console.log("=== Commission: legacy float vs Decimal ROUND_HALF_EVEN ===");
console.log(
  "billable".padEnd(18),
  "pct".padEnd(8),
  "legacy".padEnd(16),
  "new".padEnd(16),
  "delta(new-legacy)",
);

let commissionFavorCustomer = 0;
let commissionAgainstCustomer = 0;

for (const c of cases) {
  const billable = new Prisma.Decimal(c.billable);
  const pct = new Prisma.Decimal(c.pct);
  const legacy = legacyCommission(billable.toNumber(), pct.toNumber());
  const next = computeCommissionAmount(billable, pct);
  const delta = next.sub(new Prisma.Decimal(legacy));
  if (delta.lessThan(0)) commissionFavorCustomer += 1;
  if (delta.greaterThan(0)) commissionAgainstCustomer += 1;
  console.log(
    c.billable.padEnd(18),
    c.pct.padEnd(8),
    legacy.toFixed(10).padEnd(16),
    next.toFixed(10).padEnd(16),
    delta.toFixed(10),
  );
}

console.log(
  `\nCommission deltas: customer-favourable (new lower)=${commissionFavorCustomer}, ` +
    `new higher=${commissionAgainstCustomer}`,
);

console.log("\n=== INR invoice conversion: double Math.ceil vs ROUND_HALF_EVEN ===");
const inrCases: Array<{ usd: number; rate: number; feePct: number }> = [
  { usd: 10.01, rate: 83.47, feePct: 2 },
  { usd: 25.555, rate: 83.12, feePct: 2 },
  { usd: 100.001, rate: 84, feePct: 2.5 },
  { usd: 7.33, rate: 83.5, feePct: 2 },
];

for (const row of inrCases) {
  const legacyBase = legacyInvoiceBaseInr(row.usd, row.rate);
  const legacyFee = Math.round((legacyBase * row.feePct) / 100 * 100) / 100;
  const legacyTotal = legacyTotalInrCeil(legacyBase + legacyFee);

  const newBase = roundInr(usdToInr(row.usd, row.rate));
  const newFee = roundInr((newBase * row.feePct) / 100);
  const newTotal = roundInr(newBase + newFee);
  const saved = legacyTotal - newTotal;

  console.log(
    `usd=${row.usd} rate=${row.rate}: legacyTotal=${legacyTotal.toFixed(2)} ` +
      `newTotal=${newTotal.toFixed(2)} customerSaves=${saved.toFixed(2)}`,
  );
}

console.log("\nPASS: comparison printed (no assertion failures)");
