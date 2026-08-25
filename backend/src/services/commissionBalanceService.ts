import {
  CommissionLedgerStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

const DISPLAY_WALLET_STATUSES = [
  CommissionLedgerStatus.EARNED,
  CommissionLedgerStatus.PAYABLE,
  CommissionLedgerStatus.WITHDRAWABLE,
] as const;

function decimalSumToNumber(
  value: Prisma.Decimal | number | null | undefined,
): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return value.toNumber();
}

/** Signed sum of all non-simulated commission rows for a partner. */
export async function sumPartnerCommissionNet(
  db: DbClient,
  beneficiaryUserId: string,
): Promise<Prisma.Decimal> {
  const result = await db.commissionLedger.aggregate({
    where: { beneficiaryUserId, isSimulated: false },
    _sum: { amount: true },
  });
  return result._sum.amount ?? new Prisma.Decimal(0);
}

export type PartnerCommissionWalletBreakdown = {
  /** EARNED-status bucket — display only. */
  earned: number;
  /** PAYABLE-status bucket — display only. */
  payable: number;
  /** WITHDRAWABLE-status bucket — display only. */
  mature: number;
  /** Signed net over all non-simulated rows — gates payout; may be negative. */
  netBalance: number;
};

export async function getPartnerCommissionWalletBreakdown(
  db: DbClient,
  beneficiaryUserId: string,
): Promise<PartnerCommissionWalletBreakdown> {
  const [groups, net] = await Promise.all([
    db.commissionLedger.groupBy({
      by: ["status"],
      where: { beneficiaryUserId, isSimulated: false },
      _sum: { amount: true },
    }),
    sumPartnerCommissionNet(db, beneficiaryUserId),
  ]);

  const breakdown: PartnerCommissionWalletBreakdown = {
    earned: 0,
    payable: 0,
    mature: 0,
    netBalance: net.toNumber(),
  };

  for (const row of groups) {
    const amount = decimalSumToNumber(row._sum.amount);
    if (row.status === CommissionLedgerStatus.EARNED) {
      breakdown.earned = amount;
    } else if (row.status === CommissionLedgerStatus.PAYABLE) {
      breakdown.payable = amount;
    } else if (row.status === CommissionLedgerStatus.WITHDRAWABLE) {
      breakdown.mature = amount;
    }
  }

  return breakdown;
}

/** @deprecated Internal — display buckets only; never use to gate money. */
export const COMMISSION_DISPLAY_WALLET_STATUSES = DISPLAY_WALLET_STATUSES;
