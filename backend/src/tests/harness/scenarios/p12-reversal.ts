import { CommissionLedgerStatus, Role } from "@prisma/client";
import { reverseMonthlyRevenueInvoiceCommissionsOnVoid } from "../../../services/affiliateCommissionService.js";
import { getPartnerCommissionWalletBreakdown } from "../../../services/commissionBalanceService.js";
import {
  PAYOUT_LAST_DAY_ONLY_MSG,
  requestPartnerPayout,
} from "../../../services/affiliatePayoutService.js";
import {
  claimPartnerPayoutDirect,
  rollbackTestPayoutClaim,
  TEST_ID_PREFIX,
} from "../fixtures.js";
import type { HarnessScenario, ScenarioContext } from "../types.js";

export const p12ReversalScenario: HarnessScenario = {
  name: "p12-reversal",
  async run(ctx) {
    const { prisma, assert, fixtures } = ctx;
    const prefix = TEST_ID_PREFIX;

    const partner = await fixtures.createTestUser(prefix, Role.EXECUTIVE);
    const source = await fixtures.createTestUser(prefix, Role.USER);

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

    const balanceAfterInsert = await getPartnerCommissionWalletBreakdown(
      prisma,
      partner.id,
    );
    assert.near(
      balanceAfterInsert.netBalance,
      5,
      "partner net balance after WITHDRAWABLE insert",
    );
    assert.near(
      balanceAfterInsert.mature,
      5,
      "partner mature WITHDRAWABLE bucket after insert",
    );

    const gated = await requestPartnerPayout(prisma, partner.id);
    assert.assert(
      gated.ok === false && gated.message === PAYOUT_LAST_DAY_ONLY_MSG,
      "requestPartnerPayout is IST-gated (testability defect: claim fused with last-day gate)",
    );

    const claim = await claimPartnerPayoutDirect(prisma, partner.id);
    assert.assert(claim.ok === true, "payout claim succeeds before reversal");
    if (!claim.ok) {
      throw new Error("claim failed unexpectedly");
    }
    assert.near(claim.amount, 5, "claimed payout amount");
    fixtures.trackPayoutFromClaim(claim.payoutRequestId);

    await rollbackTestPayoutClaim(prisma, {
      beneficiaryUserId: partner.id,
      payoutRequestId: claim.payoutRequestId,
      claimToken: claim.claimToken,
    });
    fixtures.untrackPayoutRequest(claim.payoutRequestId);

    await prisma.$transaction(async (tx) => {
      const result = await reverseMonthlyRevenueInvoiceCommissionsOnVoid(tx, {
        id: invoice.id,
        userId: source.id,
        invoicedAt: new Date(),
      });
      assert.equal(result.reversed, 1, "reversal rows created");
    });

    const balanceAfterReversal = await getPartnerCommissionWalletBreakdown(
      prisma,
      partner.id,
    );
    assert.near(
      balanceAfterReversal.netBalance,
      0,
      "partner net balance after reversal",
    );

    const original = await prisma.commissionLedger.findUnique({
      where: { id: commission.id },
      select: { status: true },
    });
    assert.equal(
      original?.status,
      CommissionLedgerStatus.REVERSED,
      "original accrual moved to REVERSED",
    );

    const refused = await claimPartnerPayoutDirect(prisma, partner.id);
    assert.assert(
      refused.ok === false,
      "payout claim refused after reversal",
    );

    assert.assert(
      commission.idempotencyKey.startsWith(prefix),
      "commission row uses TEST-P marker",
    );
  },
};
