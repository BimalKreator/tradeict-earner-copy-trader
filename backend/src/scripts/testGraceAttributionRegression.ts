/**
 * Regression: shared hedge product across two structures ~12 min apart.
 * Run: npx tsx src/scripts/testGraceAttributionRegression.ts
 */
import {
  findMatchingLegWindows,
  LEG_CLOSE_GRACE_MS,
  type LegWindowSpec,
} from "../services/structurePnlService.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function ms(iso: string): Date {
  return new Date(iso);
}

/** Live case: product 143235 reused by structure 2 then structure 4 (~12 min gap). */
function testSharedHedgeProductAcrossStructures(): void {
  const productId = 143235;
  const legStructure2: LegWindowSpec = {
    botStructureId: 2,
    botLegId: 1,
    productId,
    openedAt: ms("2026-08-23T10:11:10.221Z"),
    attributionFrom: null,
    closedAt: ms("2026-08-23T10:16:35.593Z"),
  };
  const legStructure4: LegWindowSpec = {
    botStructureId: 4,
    botLegId: 1,
    productId,
    openedAt: ms("2026-08-23T10:28:34.543Z"),
    attributionFrom: null,
    closedAt: ms("2026-08-23T10:35:26.936Z"),
  };
  const legs = [legStructure2, legStructure4];

  // Commission / exit credit shortly after structure 4 close — must match structure 4 only.
  const postCloseCommission = ms("2026-08-23T10:35:27.500Z");
  const postCloseMatches = findMatchingLegWindows(
    { productId, occurredAt: postCloseCommission },
    legs,
  );
  assert(
    postCloseMatches.length === 1 &&
      postCloseMatches[0]!.botStructureId === 4,
    "post-close commission must match structure 4 only (grace applies; structure 2 is closed)",
  );

  // Still within grace, no other leg open at txn time.
  const graceCommission = ms("2026-08-23T10:35:50.000Z");
  const graceMatches = findMatchingLegWindows(
    { productId, occurredAt: graceCommission },
    legs,
  );
  assert(
    graceMatches.length === 1 && graceMatches[0]!.botStructureId === 4,
    "grace-period commission must still match structure 4",
  );

  // Structure 2 in-window txn must still match structure 2 only.
  const s2Txn = ms("2026-08-23T10:15:00.000Z");
  const s2Matches = findMatchingLegWindows(
    { productId, occurredAt: s2Txn },
    legs,
  );
  assert(
    s2Matches.length === 1 && s2Matches[0]!.botStructureId === 2,
    "structure 2 mid-life txn must match structure 2 only",
  );

  // After structure 2 grace ends and before structure 4 opens — unmatched.
  const gapTxn = ms("2026-08-23T10:20:00.000Z");
  assert(
    findMatchingLegWindows({ productId, occurredAt: gapTxn }, legs).length === 0,
    "gap between structures must not match either leg",
  );
}

/** Overlap: two legs on same product with concurrent windows → 2+ matches. */
function testTrueOverlapStillSuspect(): void {
  const productId = 999;
  const legA: LegWindowSpec = {
    botStructureId: 1,
    botLegId: 1,
    productId,
    openedAt: ms("2026-08-23T10:00:00.000Z"),
    attributionFrom: null,
    closedAt: ms("2026-08-23T10:05:00.000Z"),
  };
  const legB: LegWindowSpec = {
    botStructureId: 2,
    botLegId: 1,
    productId,
    openedAt: ms("2026-08-23T10:04:00.000Z"),
    attributionFrom: null,
    closedAt: ms("2026-08-23T10:10:00.000Z"),
  };
  const legs = [legA, legB];
  const overlapTxn = ms("2026-08-23T10:04:30.000Z");
  assert(
    findMatchingLegWindows({ productId, occurredAt: overlapTxn }, legs).length === 2,
    "concurrent legs must both match (overlap — caller must not guess)",
  );
}

/** Grace suppressed only when another leg is actually open at txn time. */
function testGraceSuppressedWhenOtherLegOpenAtTxn(): void {
  const productId = 888;
  const legA: LegWindowSpec = {
    botStructureId: 1,
    botLegId: 1,
    productId,
    openedAt: ms("2026-08-23T10:00:00.000Z"),
    attributionFrom: null,
    closedAt: ms("2026-08-23T10:05:00.000Z"),
  };
  const legB: LegWindowSpec = {
    botStructureId: 2,
    botLegId: 1,
    productId,
    openedAt: ms("2026-08-23T10:05:01.000Z"),
    attributionFrom: null,
    closedAt: ms("2026-08-23T10:10:00.000Z"),
  };
  const legs = [legA, legB];

  // After A close, before B opens — A still gets grace (B not open yet).
  const txnBeforeB = ms("2026-08-23T10:05:30.000Z");
  assert(
    findMatchingLegWindows({ productId, occurredAt: txnBeforeB }, legs).length ===
      1 &&
      findMatchingLegWindows({ productId, occurredAt: txnBeforeB }, legs)[0]!
        .botStructureId === 2,
    "txn after A close with B open must match B only",
  );

  // After A close, B not yet open — A grace applies.
  const txnInAGraceBeforeB = ms("2026-08-23T10:05:00.500Z");
  const matches = findMatchingLegWindows(
    { productId, occurredAt: txnInAGraceBeforeB },
    legs,
  );
  assert(
    matches.length === 1 && matches[0]!.botStructureId === 1,
    "txn in A grace before B opens must match A only",
  );

  void LEG_CLOSE_GRACE_MS;
}

testSharedHedgeProductAcrossStructures();
testTrueOverlapStillSuspect();
testGraceSuppressedWhenOtherLegOpenAtTxn();

console.log("PASS: grace attribution regression tests");
