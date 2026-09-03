/**
 * Wings / iron-condor helpers for structure attribution.
 * Run: npx tsx src/scripts/testStructureWings.ts
 */
import { Prisma } from "@prisma/client";
import {
  STRUCTURE_LEG_ROLE,
  WING_ENTRY_MAX_SKEW_MS,
  computeBasketNetCredit,
  countBasketLegs,
  discoverWingLegsFromLedger,
  expectedBasketCommissionRows,
  expiryKeyFromSymbol,
  healOpenWingLegsOnClosedStructure,
  normalizeStructureForWings,
  optionKindFromSymbol,
} from "../services/structureWings.js";
import { evaluateLegStructuralCompleteness } from "../services/structurePnlService.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

function d(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

function baseStructure() {
  const openedAt = new Date("2026-09-03T10:00:00.000Z");
  const closedAt = new Date("2026-09-03T12:00:00.000Z");
  return {
    botStructureId: 42,
    status: "closed",
    openedAt,
    closedAt,
    legs: [
      {
        botLegId: 1,
        legRole: STRUCTURE_LEG_ROLE.BASKET_CALL,
        basketSeq: 1,
        adjSeq: 0,
        productId: 100,
        symbol: "C-BTC-85000-040926",
        strike: 85000,
        side: "SELL",
        quantity: 4,
        openedAt,
        attributionFrom: null,
        closedAt,
      },
      {
        botLegId: 2,
        legRole: STRUCTURE_LEG_ROLE.BASKET_PUT,
        basketSeq: 1,
        adjSeq: 0,
        productId: 101,
        symbol: "P-BTC-82000-040926",
        strike: 82000,
        side: "SELL",
        quantity: 4,
        openedAt: new Date(openedAt.getTime() + 1000),
        attributionFrom: null,
        closedAt,
      },
    ],
  };
}

function testSymbolParsers(): void {
  assert(optionKindFromSymbol("C-BTC-85000-040926") === "call", "C- prefix call");
  assert(optionKindFromSymbol("P-BTC-82000-040926") === "put", "P- prefix put");
  assert(expiryKeyFromSymbol("C-BTC-85000-040926") === "040926", "expiry token");
}

function testHealOpenWings(): void {
  const s = baseStructure();
  const withOpenWing = {
    ...s,
    legs: [
      ...s.legs,
      {
        botLegId: 3,
        legRole: STRUCTURE_LEG_ROLE.BASKET_WING_CALL,
        basketSeq: 1,
        adjSeq: 0,
        productId: 200,
        symbol: "C-BTC-90000-040926",
        strike: 90000,
        side: "BUY",
        quantity: 4,
        openedAt: s.openedAt,
        attributionFrom: null,
        closedAt: null as Date | null,
      },
    ],
  };
  const healed = healOpenWingLegsOnClosedStructure(withOpenWing);
  const wing = healed.legs.find(
    (l) => l.legRole === STRUCTURE_LEG_ROLE.BASKET_WING_CALL,
  );
  assert(wing?.closedAt?.getTime() === s.closedAt!.getTime(), "open wing healed");
}

function testDiscoverWings(): void {
  const s = baseStructure();
  const t0 = s.openedAt.getTime();
  const ledger = [
    {
      productId: 200,
      productSymbol: "C-BTC-90000-040926",
      transactionType: "cashflow",
      amount: d(-0.1721),
      occurredAt: new Date(t0 + 5_000),
    },
    {
      productId: 201,
      productSymbol: "P-BTC-78000-040926",
      transactionType: "cashflow",
      amount: d(-0.07),
      occurredAt: new Date(t0 + 6_000),
    },
    // Outside 60s window — must ignore
    {
      productId: 299,
      productSymbol: "C-BTC-91000-040926",
      transactionType: "cashflow",
      amount: d(-0.5),
      occurredAt: new Date(t0 + WING_ENTRY_MAX_SKEW_MS + 5_000),
    },
  ];
  const found = discoverWingLegsFromLedger(s, ledger);
  const roles = found.legs.map((l) => l.legRole);
  assert(
    roles.includes(STRUCTURE_LEG_ROLE.BASKET_WING_CALL) &&
      roles.includes(STRUCTURE_LEG_ROLE.BASKET_WING_PUT),
    "discovers wing call+put within 60s",
  );
  assert(
    !found.legs.some((l) => l.productId === 299),
    "ignores wing cashflow outside 60s",
  );
  const counts = countBasketLegs(found.legs);
  assert(counts.totalBasket === 4 && counts.wings === 2, "4 basket legs");
  assert(expectedBasketCommissionRows(4) === 8, "4-leg expects 8 commissions");
  assert(expectedBasketCommissionRows(2) === 4, "2-leg expects 4 commissions");
}

function testNetCredit(): void {
  const map = new Map<string, Prisma.Decimal>([
    ["0", d(0.337)], // short call
    ["1", d(0.12)], // short put
    ["2", d(-0.1721)], // wing call
    ["3", d(-0.07)], // wing put
  ]);
  const net = computeBasketNetCredit({
    legs: [
      { legRole: STRUCTURE_LEG_ROLE.BASKET_CALL, side: "SELL" },
      { legRole: STRUCTURE_LEG_ROLE.BASKET_PUT, side: "SELL" },
      { legRole: STRUCTURE_LEG_ROLE.BASKET_WING_CALL, side: "BUY" },
      { legRole: STRUCTURE_LEG_ROLE.BASKET_WING_PUT, side: "BUY" },
    ],
    firstCashflowByLegKey: map,
    legKey: (i) => String(i),
  });
  const expected = 0.337 + 0.12 - 0.1721 - 0.07;
  assert(
    Math.abs(net.toNumber() - expected) < 1e-9,
    `net credit shorts−wings = ${expected}`,
  );
}

function testCompletenessFourLeg(): void {
  // Each of 4 legs: 2 cashflows + 2 commissions → structure-level 8 commissions
  const oneLeg = evaluateLegStructuralCompleteness({
    cashflowCount: 2,
    commissionCount: 2,
    cashflowHasPositive: true,
    cashflowHasNegative: true,
    hasSettlement: false,
    matchedTxnCount: 4,
  });
  assert(oneLeg.ok, "wing/short leg with paired commissions is complete");
}

function testNormalizeIdempotentWhenWingsPresent(): void {
  const s = baseStructure();
  const withWings = {
    ...s,
    legs: [
      ...s.legs,
      {
        botLegId: 3,
        legRole: STRUCTURE_LEG_ROLE.BASKET_WING_CALL,
        basketSeq: 1,
        adjSeq: 0,
        productId: 200,
        symbol: "C-BTC-90000-040926",
        strike: 90000,
        side: "BUY",
        quantity: 4,
        openedAt: s.openedAt,
        attributionFrom: null,
        closedAt: s.closedAt,
      },
      {
        botLegId: 4,
        legRole: STRUCTURE_LEG_ROLE.BASKET_WING_PUT,
        basketSeq: 1,
        adjSeq: 0,
        productId: 201,
        symbol: "P-BTC-78000-040926",
        strike: 78000,
        side: "BUY",
        quantity: 4,
        openedAt: s.openedAt,
        attributionFrom: null,
        closedAt: s.closedAt,
      },
    ],
  };
  const ledger = [
    {
      productId: 300,
      productSymbol: "C-BTC-92000-040926",
      transactionType: "cashflow",
      amount: d(-0.01),
      occurredAt: new Date(s.openedAt.getTime() + 1000),
    },
  ];
  const out = normalizeStructureForWings(withWings, ledger);
  assert(out.legs.length === 4, "does not double-add wings when already present");
}

testSymbolParsers();
testHealOpenWings();
testDiscoverWings();
testNetCredit();
testCompletenessFourLeg();
testNormalizeIdempotentWhenWingsPresent();
console.log("All structure wings tests passed.");
