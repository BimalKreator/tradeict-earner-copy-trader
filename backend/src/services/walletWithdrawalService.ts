import {
  Prisma,
  type PrismaClient,
  TransactionStatus,
  TransactionType,
  WalletWithdrawalStatus,
} from "@prisma/client";
import {
  createMailTransport,
  getFromAddress,
} from "../utils/emailService.js";
import {
  sendTemplateEmailAsync,
  resolveEmailRecipientName,
} from "./emailService.js";

const WITHDRAWAL_CREDIT_MESSAGE =
  "Your withdrawal request has been submitted successfully and will be credited to your saved bank account within 24 to 48 hours.";

export type WalletWithdrawalServiceError = {
  ok: false;
  status: number;
  message: string;
};

function parsePositiveAmount(raw: unknown): number | null {
  const amount =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function hasCompleteBankDetails(user: {
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
}): boolean {
  return Boolean(
    user.bankName?.trim() &&
      user.bankAccountNumber?.trim() &&
      user.bankIfsc?.trim(),
  );
}

/** Notify user and admin that a wallet withdrawal was requested. */
export function notifyWithdrawalRequestSubmitted(args: {
  userEmail: string;
  userName: string | null;
  amount: number;
}): void {
  const name = resolveEmailRecipientName(args.userName, args.userEmail);
  sendTemplateEmailAsync(args.userEmail, "withdrawal_request_submitted", {
    userName: name,
    amount: args.amount,
    message: WITHDRAWAL_CREDIT_MESSAGE,
  });

  void sendAdminWithdrawalNotification({
    userEmail: args.userEmail,
    userName: name,
    amount: args.amount,
  });
}

async function sendAdminWithdrawalNotification(args: {
  userEmail: string;
  userName: string;
  amount: number;
}): Promise<void> {
  const adminTo =
    process.env.PAYMENT_ADMIN_EMAIL?.trim() || "support@tradeictai.com";
  const text = [
    "New wallet withdrawal request",
    "",
    `User: ${args.userName} <${args.userEmail}>`,
    `Amount: $${args.amount.toFixed(2)} USDT`,
    "",
    WITHDRAWAL_CREDIT_MESSAGE,
  ].join("\n");

  try {
    const transport = createMailTransport();
    await transport.sendMail({
      from: getFromAddress(),
      to: adminTo,
      subject: `Wallet withdrawal requested — ${args.userEmail}`,
      text,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:20px;">
<h2>New wallet withdrawal request</h2>
<p><strong>User:</strong> ${args.userName} (${args.userEmail})</p>
<p><strong>Amount:</strong> $${args.amount.toFixed(2)} USDT</p>
<p>${WITHDRAWAL_CREDIT_MESSAGE}</p>
</body></html>`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[walletWithdrawalService] Admin withdrawal notification failed: ${message}`,
    );
  }
}

export type RequestWalletWithdrawalResult =
  | { ok: true; withdrawalId: string; amount: number }
  | WalletWithdrawalServiceError;

export async function requestWalletWithdrawal(
  prisma: PrismaClient,
  userId: string,
  amountRaw: unknown,
): Promise<RequestWalletWithdrawalResult> {
  const amount = parsePositiveAmount(amountRaw);
  if (amount === null) {
    return { ok: false, status: 400, message: "amount must be a positive number" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      bankName: true,
      bankAccountNumber: true,
      bankIfsc: true,
    },
  });

  if (!user) {
    return { ok: false, status: 404, message: "User not found" };
  }

  if (!hasCompleteBankDetails(user)) {
    return {
      ok: false,
      status: 400,
      message:
        "Bank details are required before withdrawing. Please add bank name, account number, and IFSC in your profile.",
    };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        return {
          ok: false as const,
          status: 400,
          message: "Wallet not found. Complete a deposit before withdrawing.",
        };
      }

      if (wallet.balance < amount) {
        return {
          ok: false as const,
          status: 400,
          message: "Insufficient wallet balance for this withdrawal",
        };
      }

      const ledgerTransaction = await tx.transaction.create({
        data: {
          userId,
          amount,
          type: TransactionType.WITHDRAWAL_REQUEST,
          status: TransactionStatus.PENDING,
        },
      });

      const withdrawal = await tx.walletWithdrawalRequest.create({
        data: {
          walletId: wallet.id,
          userId,
          amount,
          status: WalletWithdrawalStatus.PENDING,
          bankName: user.bankName!.trim(),
          bankAccountNumber: user.bankAccountNumber!.trim(),
          bankIfsc: user.bankIfsc!.trim(),
          ledgerTransactionId: ledgerTransaction.id,
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: { decrement: amount },
          lockedBalance: { increment: amount },
        },
      });

      return { ok: true as const, withdrawal, user };
    });

    if (!result.ok) {
      return result;
    }

    notifyWithdrawalRequestSubmitted({
      userEmail: result.user.email,
      userName: result.user.name,
      amount,
    });

    return {
      ok: true,
      withdrawalId: result.withdrawal.id,
      amount,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return { ok: false, status: 400, message: err.message };
    }
    throw err;
  }
}

export async function getAdminWalletSummary(prisma: PrismaClient) {
  const [walletAgg, pendingAgg] = await Promise.all([
    prisma.wallet.aggregate({
      _sum: { balance: true, lockedBalance: true },
    }),
    prisma.walletWithdrawalRequest.aggregate({
      where: { status: WalletWithdrawalStatus.PENDING },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    totalWalletBalance: walletAgg._sum.balance ?? 0,
    totalLockedBalance: walletAgg._sum.lockedBalance ?? 0,
    totalPendingWithdrawals: pendingAgg._sum.amount ?? 0,
    pendingWithdrawalCount: pendingAgg._count._all ?? 0,
  };
}

export async function listAdminWalletUsers(prisma: PrismaClient) {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      wallet: { select: { balance: true, lockedBalance: true } },
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });

  return {
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      balance: u.wallet?.balance ?? 0,
      lockedBalance: u.wallet?.lockedBalance ?? 0,
    })),
  };
}

export async function listWalletWithdrawalRequests(
  prisma: PrismaClient,
  statusFilter?: string,
) {
  const status =
    statusFilter?.trim().toUpperCase() as WalletWithdrawalStatus | undefined;
  const validStatuses = Object.values(WalletWithdrawalStatus);
  const hasStatusFilter =
    status !== undefined && validStatuses.includes(status);

  const items = await prisma.walletWithdrawalRequest.findMany({
    ...(hasStatusFilter ? { where: { status } } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      user: {
        select: { id: true, email: true, name: true },
      },
    },
  });

  return { items };
}

export type ProcessWalletWithdrawalResult =
  | { ok: true; withdrawal: { id: string; status: WalletWithdrawalStatus } }
  | WalletWithdrawalServiceError;

export async function processWalletWithdrawalRequest(
  prisma: PrismaClient,
  withdrawalId: string,
  body: {
    action?: unknown;
    transactionId?: unknown;
    remarks?: unknown;
  },
): Promise<ProcessWalletWithdrawalResult> {
  const action =
    typeof body.action === "string" ? body.action.trim().toUpperCase() : "";
  if (action !== "COMPLETED" && action !== "REJECTED") {
    return {
      ok: false,
      status: 400,
      message: "action must be COMPLETED or REJECTED",
    };
  }

  const bankTransactionId =
    typeof body.transactionId === "string" ? body.transactionId.trim() : "";
  const adminRemarks =
    typeof body.remarks === "string" ? body.remarks.trim() : "";

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const request = await tx.walletWithdrawalRequest.findUnique({
        where: { id: withdrawalId },
      });

      if (!request) {
        return {
          ok: false as const,
          status: 404,
          message: "Withdrawal request not found",
        };
      }

      if (request.status !== WalletWithdrawalStatus.PENDING) {
        return {
          ok: false as const,
          status: 400,
          message: "Withdrawal request is not pending",
        };
      }

      const wallet = await tx.wallet.findUnique({
        where: { id: request.walletId },
      });

      if (!wallet) {
        return {
          ok: false as const,
          status: 404,
          message: "Wallet not found",
        };
      }

      if (wallet.lockedBalance < request.amount) {
        return {
          ok: false as const,
          status: 400,
          message: "Wallet locked balance is insufficient for this withdrawal",
        };
      }

      const nextStatus =
        action === "COMPLETED"
          ? WalletWithdrawalStatus.COMPLETED
          : WalletWithdrawalStatus.REJECTED;

      const nextLedgerStatus =
        action === "COMPLETED"
          ? TransactionStatus.COMPLETED
          : TransactionStatus.REJECTED;

      if (action === "COMPLETED") {
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { lockedBalance: { decrement: request.amount } },
        });
      } else {
        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            lockedBalance: { decrement: request.amount },
            balance: { increment: request.amount },
          },
        });
      }

      const withdrawal = await tx.walletWithdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: nextStatus,
          transactionId: bankTransactionId || null,
          adminRemarks: adminRemarks || null,
        },
      });

      if (request.ledgerTransactionId) {
        await tx.transaction.update({
          where: { id: request.ledgerTransactionId },
          data: { status: nextLedgerStatus },
        });
      }

      return { ok: true as const, withdrawal };
    });

    if (!outcome.ok) {
      return outcome;
    }

    return {
      ok: true,
      withdrawal: {
        id: outcome.withdrawal.id,
        status: outcome.withdrawal.status,
      },
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return { ok: false, status: 400, message: err.message };
    }
    throw err;
  }
}

export type AdjustUserWalletResult =
  | {
      ok: true;
      wallet: { balance: number; lockedBalance: number };
      transactionId: string;
    }
  | WalletWithdrawalServiceError;

export async function adjustUserWalletBalance(
  prisma: PrismaClient,
  userId: string,
  body: {
    amount?: unknown;
    type?: unknown;
    reason?: unknown;
  },
): Promise<AdjustUserWalletResult> {
  const amount = parsePositiveAmount(body.amount);
  if (amount === null) {
    return { ok: false, status: 400, message: "amount must be a positive number" };
  }

  const typeRaw =
    typeof body.type === "string" ? body.type.trim().toUpperCase() : "";
  if (typeRaw !== "ADD" && typeRaw !== "REMOVE") {
    return { ok: false, status: 400, message: "type must be ADD or REMOVE" };
  }

  const reason =
    typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return { ok: false, status: 400, message: "reason is required" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    return { ok: false, status: 404, message: "User not found" };
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.wallet.findUnique({ where: { userId } });

      if (typeRaw === "REMOVE") {
        if (!existing || existing.balance < amount) {
          return {
            ok: false as const,
            status: 400,
            message: "Insufficient wallet balance for this adjustment",
          };
        }
      }

      const wallet = await tx.wallet.upsert({
        where: { userId },
        create: {
          userId,
          balance: typeRaw === "ADD" ? amount : 0,
          lockedBalance: 0,
          pendingFees: 0,
          overdueDays: 0,
        },
        update:
          typeRaw === "ADD"
            ? { balance: { increment: amount } }
            : { balance: { decrement: amount } },
      });

      const ledgerTransaction = await tx.transaction.create({
        data: {
          userId,
          amount,
          type: TransactionType.ADMIN_ADJUSTMENT,
          status: TransactionStatus.APPROVED,
          note: `${typeRaw}: ${reason}`,
        },
      });

      const updatedWallet = await tx.wallet.findUniqueOrThrow({
        where: { id: wallet.id },
        select: { balance: true, lockedBalance: true },
      });

      return {
        ok: true as const,
        wallet: updatedWallet,
        transactionId: ledgerTransaction.id,
      };
    });

    if (!outcome.ok) {
      return outcome;
    }

    return outcome;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return { ok: false, status: 400, message: err.message };
    }
    throw err;
  }
}
