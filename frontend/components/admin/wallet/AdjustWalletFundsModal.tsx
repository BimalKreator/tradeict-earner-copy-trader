"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fmtUsd } from "@/lib/currency";

export type WalletUserRow = {
  id: string;
  name: string | null;
  email: string;
  balance: number;
  lockedBalance: number;
};

type AdjustType = "ADD" | "REMOVE";

type AdjustWalletFundsModalProps = {
  open: boolean;
  user: WalletUserRow | null;
  apiBase: string;
  token: string | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function AdjustWalletFundsModal({
  open,
  user,
  apiBase,
  token,
  onClose,
  onSuccess,
  onError,
}: AdjustWalletFundsModalProps) {
  const [mounted, setMounted] = useState(false);
  const [adjustType, setAdjustType] = useState<AdjustType>("ADD");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setAdjustType("ADD");
    setAmount("");
    setReason("");
    setFormError(null);
  }, [open, user?.id]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !user || !mounted) return null;

  const parsedAmount = Number(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const maxRemove = Math.max(0, user.balance);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !user) return;

    setFormError(null);
    if (!amountValid) {
      setFormError("Enter a positive amount.");
      return;
    }
    if (!reason.trim()) {
      setFormError("Reason is required.");
      return;
    }
    if (adjustType === "REMOVE" && parsedAmount > maxRemove + 1e-9) {
      setFormError(`Cannot remove more than available balance (${fmtUsd(maxRemove)}).`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `${apiBase}/admin/wallet/users/${encodeURIComponent(user.id)}/adjust`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: parsedAmount,
            type: adjustType,
            reason: reason.trim(),
          }),
        },
      );
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Adjustment failed (${res.status})`;
        throw new Error(msg);
      }
      onSuccess(
        `${adjustType === "ADD" ? "Added" : "Removed"} ${fmtUsd(parsedAmount)} for ${user.email}.`,
      );
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Wallet adjustment failed";
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const userLabel = user.name?.trim() || user.email;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="adjust-wallet-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-glassBorder bg-background/95 p-6 shadow-2xl backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="adjust-wallet-title" className="text-lg font-semibold text-white">
              Adjust wallet funds
            </h2>
            <p className="mt-1 text-sm text-white/55">{userLabel}</p>
            <p className="mt-1 text-xs text-white/45">
              Balance {fmtUsd(user.balance)}
              {user.lockedBalance > 0
                ? ` · Locked ${fmtUsd(user.lockedBalance)}`
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="sr-only">Adjustment type</legend>
            {(["ADD", "REMOVE"] as const).map((type) => (
              <label
                key={type}
                className={`flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                  adjustType === type
                    ? type === "ADD"
                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-100"
                      : "border-red-500/40 bg-red-500/15 text-red-100"
                    : "border-glassBorder text-white/65 hover:bg-white/[0.04]"
                }`}
              >
                <input
                  type="radio"
                  name="adjustType"
                  value={type}
                  checked={adjustType === type}
                  onChange={() => setAdjustType(type)}
                  disabled={submitting}
                  className="sr-only"
                />
                {type === "ADD" ? "Add" : "Remove"}
              </label>
            ))}
          </fieldset>

          <div>
            <label
              htmlFor="adjust-amount"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Amount (USD)
            </label>
            <input
              id="adjust-amount"
              type="number"
              min={0.01}
              step="0.01"
              max={adjustType === "REMOVE" ? maxRemove : undefined}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={submitting}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white tabular-nums placeholder:text-white/30 focus:border-primary/50 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="adjust-reason"
              className="block text-xs font-medium uppercase tracking-wider text-white/45"
            >
              Reason
            </label>
            <textarea
              id="adjust-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder="Internal note for this adjustment"
              className="mt-2 w-full resize-none rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-primary/50 focus:outline-none"
            />
          </div>

          {formError ? (
            <p className="text-sm text-red-300" role="alert">
              {formError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-lg border border-glassBorder px-4 py-2 text-sm font-medium text-white/75 hover:bg-white/[0.06] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : (
                "Apply adjustment"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
