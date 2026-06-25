"use client";

import { AlertTriangle, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtUsd } from "@/lib/currency";

export type BankDetails = {
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
};

type WithdrawFundsModalProps = {
  open: boolean;
  apiBase: string;
  token: string | null;
  availableBalance: number;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

function hasBankDetails(bank: BankDetails): boolean {
  return Boolean(
    bank.bankName?.trim() &&
      bank.bankAccountNumber?.trim() &&
      bank.bankIfsc?.trim(),
  );
}

function maskAccountNumber(account: string): string {
  const trimmed = account.trim();
  if (trimmed.length <= 4) return trimmed;
  return `•••• ${trimmed.slice(-4)}`;
}

export function WithdrawFundsModal({
  open,
  apiBase,
  token,
  availableBalance,
  onClose,
  onSuccess,
  onError,
}: WithdrawFundsModalProps) {
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState<BankDetails | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const maxAvailable = Math.max(0, availableBalance);

  useEffect(() => {
    if (!open) return;

    setAmount("");
    setFormError(null);
    setBank(null);
    setLoadingProfile(true);

    if (!token) {
      setFormError("Not signed in");
      setLoadingProfile(false);
      return;
    }

    void (async () => {
      try {
        const res = await fetch(`${apiBase}/user/profile`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`Could not load profile (${res.status})`);
        }
        const data = (await res.json()) as {
          profile?: BankDetails;
        };
        const profile = data.profile ?? null;
        setBank({
          bankName: profile?.bankName ?? null,
          bankAccountNumber: profile?.bankAccountNumber ?? null,
          bankIfsc: profile?.bankIfsc ?? null,
        });
      } catch (e) {
        setFormError(
          e instanceof Error ? e.message : "Failed to load bank details",
        );
      } finally {
        setLoadingProfile(false);
      }
    })();
  }, [apiBase, open, token]);

  if (!open) return null;

  const parsedAmount = Number(amount);
  const bankReady = bank !== null && hasBankDetails(bank);
  const amountValid =
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount <= maxAvailable + 1e-9;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!token) {
      setFormError("Not signed in");
      return;
    }
    if (!bankReady) {
      setFormError("Add bank details in your profile before withdrawing.");
      return;
    }
    if (!amountValid) {
      setFormError(
        maxAvailable <= 0
          ? "No available balance to withdraw."
          : `Enter an amount between $0.01 and ${fmtUsd(maxAvailable)}.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/user/wallet/withdraw`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: parsedAmount }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Withdrawal failed (${res.status})`;
        throw new Error(msg);
      }
      onSuccess(
        "Withdrawal Request Submitted Successfully. The amount will be credited to your account within 24-48 hours.",
      );
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Withdrawal request failed";
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-funds-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close withdraw dialog"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-glassBorder bg-background/95 p-6 shadow-2xl backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="withdraw-funds-title"
              className="text-lg font-semibold text-white"
            >
              Withdraw funds
            </h2>
            <p className="mt-1 text-sm text-white/55">
              Max available:{" "}
              <span className="font-medium tabular-nums text-white">
                {fmtUsd(maxAvailable)}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {loadingProfile ? (
          <div className="mt-8 flex justify-center py-10">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-5">
            <div>
              <label
                htmlFor="withdraw-amount"
                className="block text-xs font-medium uppercase tracking-wider text-white/50"
              >
                Amount to withdraw (USD)
              </label>
              <input
                id="withdraw-amount"
                type="number"
                inputMode="decimal"
                min={0.01}
                max={maxAvailable}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={submitting || maxAvailable <= 0}
                placeholder="0.00"
                className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-white tabular-nums placeholder:text-white/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
              />
            </div>

            <div className="rounded-lg border border-glassBorder bg-white/[0.03] p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-white/45">
                Payout bank account
              </p>
              {bank && bankReady ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/50">Bank</dt>
                    <dd className="text-right text-white/90">{bank.bankName}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/50">A/C number</dt>
                    <dd className="text-right font-mono text-white/90">
                      {maskAccountNumber(bank.bankAccountNumber!)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/50">IFSC</dt>
                    <dd className="text-right font-mono text-white/90">
                      {bank.bankIfsc}
                    </dd>
                  </div>
                </dl>
              ) : (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <p>
                    Bank details are missing.{" "}
                    <Link
                      href="/dashboard/profile"
                      className="font-medium text-amber-200 underline hover:text-white"
                      onClick={onClose}
                    >
                      Update Bank Details in Profile
                    </Link>
                  </p>
                </div>
              )}
            </div>

            {formError ? (
              <p className="text-sm text-red-300" role="alert">
                {formError}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={submitting || !bankReady || maxAvailable <= 0}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Submitting…
                </>
              ) : (
                "Submit Withdrawal Request"
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
