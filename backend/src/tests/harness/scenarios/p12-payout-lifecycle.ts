import {
  CommissionLedgerStatus,
  PayoutRequestStatus,
  Prisma,
  Role,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import {
  PAYOUT_STATUS_CONFLICT_MSG,
  approvePartnerPayout,
  completePartnerPayout,
  rejectPartnerPayout,
} from "../../../services/affiliatePayoutService.js";
import {
  claimPartnerPayoutDirect,
  TEST_ID_PREFIX,
} from "../fixtures.js";
import type { HarnessScenario, ScenarioContext } from "../types.js";

/**
 * approve+reject from PENDING can both succeed (APPROVED→REJECTED is a valid
 * admin path). The money-safety race is complete vs reject on APPROVED —
 * those UPDATE predicates are mutually exclusive.
 */
export const p12PayoutLifecycleScenario: HarnessScenario = {
  name: "p12-payout-lifecycle",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;
    const prefix = TEST_ID_PREFIX;

    const partner = await fixtures.createTestUser(prefix, Role.EXECUTIVE);
    const source = await fixtures.createTestUser(prefix, Role.USER);
    const admin = await fixtures.createTestUser(prefix, Role.ADMIN);

    const invoice = await fixtures.createTestMonthlyRevenueInvoice({
      marker: `${prefix}${partner.marker}`,
      userId: source.id,
      sourceUserId: source.id,
    });

    const commission = await fixtures.createCommissionRow({
      marker: `${prefix}${partner.marker}`,
      sourceUserId: source.id,
      beneficiaryUserId: partner.id,
      amount: 5,
      status: CommissionLedgerStatus.WITHDRAWABLE,
      monthlyRevenueInvoiceId: invoice.id,
    });

    const claim = await claimPartnerPayoutDirect(prisma, partner.id);
    assert.assert(claim.ok === true, "payout claim succeeds");
    if (!claim.ok) {
      throw new Error("claim failed unexpectedly");
    }
    fixtures.trackPayoutFromClaim(claim.payoutRequestId);

    const secondClaim = await claimPartnerPayoutDirect(prisma, partner.id);
    assert.assert(
      secondClaim.ok === false,
      "second claim refused while first payout is outstanding",
    );

    let duplicatePendingCreated = false;
    try {
      const duplicate = await prisma.payoutRequest.create({
        data: {
          userId: partner.id,
          amount: new Prisma.Decimal(1),
          status: PayoutRequestStatus.PENDING,
        },
        select: { id: true },
      });
      duplicatePendingCreated = true;
      fixtures.trackPayoutFromClaim(duplicate.id);
    } catch (err) {
      assert.assert(
        err instanceof PrismaClientKnownRequestError && err.code === "P2002",
        "second PENDING payout refused (partial unique index / P2002)",
      );
    }
    assert.assert(
      duplicatePendingCreated === false,
      "second PENDING payout for the same user is refused",
    );

    const approved = await approvePartnerPayout(
      prisma,
      claim.payoutRequestId,
      admin.id,
    );
    assert.assert(approved.ok === true, "sequential approve succeeds");

    const [completeResult, rejectResult] = await Promise.all([
      completePartnerPayout(
        prisma,
        claim.payoutRequestId,
        admin.id,
        `${prefix}UTR-RACE`,
      ),
      rejectPartnerPayout(
        prisma,
        claim.payoutRequestId,
        admin.id,
        "harness concurrent reject",
      ),
    ]);

    const successes = [completeResult, rejectResult].filter((row) => row.ok);
    const loser = completeResult.ok ? rejectResult : completeResult;
    assert.equal(
      successes.length,
      1,
      "exactly one of complete/reject succeeds",
    );
    assert.assert(loser.ok === false, "exactly one of complete/reject fails");
    if (!loser.ok) {
      assert.equal(loser.status, 409, "losing transition returns 409");
      assert.equal(
        loser.message,
        PAYOUT_STATUS_CONFLICT_MSG,
        "losing transition uses status-conflict message",
      );
    }

    const payout = await prisma.payoutRequest.findUniqueOrThrow({
      where: { id: claim.payoutRequestId },
      select: { status: true },
    });
    const ledger = await prisma.commissionLedger.findUniqueOrThrow({
      where: { id: commission.id },
      select: {
        status: true,
        payoutRequestId: true,
        payoutClaimToken: true,
      },
    });

    if (completeResult.ok) {
      assert.equal(
        payout.status,
        PayoutRequestStatus.COMPLETED,
        "complete-win final payout status",
      );
      assert.equal(
        ledger.status,
        CommissionLedgerStatus.WITHDRAWN,
        "complete-win ledger remains WITHDRAWN",
      );
      assert.equal(
        ledger.payoutRequestId,
        claim.payoutRequestId,
        "complete-win ledger stays linked",
      );
    } else {
      assert.equal(
        payout.status,
        PayoutRequestStatus.REJECTED,
        "reject-win final payout status",
      );
      assert.equal(
        ledger.status,
        CommissionLedgerStatus.WITHDRAWABLE,
        "reject-win ledger released to WITHDRAWABLE",
      );
      assert.equal(
        ledger.payoutRequestId,
        null,
        "reject-win ledger unlinked from payout",
      );
      assert.equal(
        ledger.payoutClaimToken,
        null,
        "reject-win claim token cleared",
      );
    }

    let completeTargetId = claim.payoutRequestId;
    if (payout.status === PayoutRequestStatus.REJECTED) {
      const reclaim = await claimPartnerPayoutDirect(prisma, partner.id);
      assert.assert(reclaim.ok === true, "reclaim after reject succeeds");
      if (!reclaim.ok) {
        throw new Error("reclaim failed unexpectedly");
      }
      fixtures.trackPayoutFromClaim(reclaim.payoutRequestId);
      const reapproved = await approvePartnerPayout(
        prisma,
        reclaim.payoutRequestId,
        admin.id,
      );
      assert.assert(reapproved.ok === true, "sequential approve after reclaim");
      const paid = await completePartnerPayout(
        prisma,
        reclaim.payoutRequestId,
        admin.id,
        `${prefix}UTR-AFTER-REJECT`,
      );
      assert.assert(paid.ok === true, "complete after reclaim succeeds");
      completeTargetId = reclaim.payoutRequestId;
    }

    const again = await completePartnerPayout(
      prisma,
      completeTargetId,
      admin.id,
      `${prefix}UTR-AGAIN`,
    );
    assert.assert(
      again.ok === false,
      "completed payout cannot be re-completed",
    );
    if (!again.ok) {
      assert.equal(again.status, 409, "re-complete returns 409");
    }
  },
};
