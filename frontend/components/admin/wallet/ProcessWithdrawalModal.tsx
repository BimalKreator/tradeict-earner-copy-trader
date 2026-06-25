"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fmtUsd, formatINR } from "@/lib/currency";

export type WithdrawalRequestRow = {
  id: string;
  amount: number;
  status: string;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null };
};

type ProcessDecision = "COMPLETED" | "REJECTED";

type ProcessWithdrawalModalProps = {
  open: boolean;
  request: WithdrawalRequestRow | null;
  apiBase: string;
  token: string | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function ProcessWithdrawalModal({
  open,
  request,
  apiBase,
  token,
  onClose,
  onSuccess,
  onError,
}: ProcessWithdrawalModalProps) {
  const [mounted, setMounted] = useState(false);
  const [decision, setDecision] = useState<ProcessDecision>("COMPLETED");
  const [transactionId, setTransactionId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setDecision("COMPLETED");
    setTransactionId("");
    setRemarks("");
    setFormError(null);
  }, [open, request?.id]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !request || !mounted) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !request) return;

    setFormError(null);
    if (decision === "COMPLETED" && !transactionId.trim()) {
      setFormError("UTR / reference number is required when approving.");
      return;
    }
    if (decision === "REJECTED" && !remarks.trim()) {
      setFormError("Remarks are required when rejecting.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `${apiBase}/admin/wallet/withdrawals/${encodeURIComponent(request.id)}/process`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: decision,
            transactionId: decision === "COMPLETED" ? transactionId.trim() : undefined,
            remarks: decision === "REJECTED" ? remarks.trim() : remarks.trim() || undefined,
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
            : `Could not process withdrawal (${res.status})`;
        throw new Error(msg);
      }
      onSuccess(
        decision === "COMPLETED"
          ? "Withdrawal approved and marked as completed."
          : "Withdrawal rejected and funds returned to user wallet.",
      );
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to process withdrawal";
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const userLabel = request.user.name?.trim() || request.user.email;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="process-withdrawal-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />
      <div className="relative z-10 w-full max-w-lg rounded-xl border border-glassBorder bg-background/95 p-6 shadow-2xl backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="process-withdrawal-title" className="text-lg font-semibold text-white">
              Process withdrawal
            </h2>
            <p className="mt-1 text-sm text-white/55">
              {userLabel} · {fmtUsd(request.amount)} ({formatINR(request.amount)})
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

        <div className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 text-xs text-white/60">
          <p>
            <span className="text-white/40">Bank:</span> {request.bankName ?? "—"}
          </p>
          <p className="mt-1">
            <span className="text-white/40">A/C:</span>{" "}
            {request.bankAccountNumber ?? "—"}
          </p>
          <p className="mt-1">
            <span className="text-white/40">IFSC:</span> {request.bankIfsc ?? "—"}
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wider text-white/45">
              Decision
            </legend>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-glassBorder px-3 py-2.5 text-sm text-white/85 has-[:checked]:border-emerald-500/40 has-[:checked]:bg-emerald-500/10">
              <input
                type="radio"
                name="decision"
                value="COMPLETED"
                checked={decision === "COMPLETED"}
                onChange={() => setDecision("COMPLETED")}
                disabled={submitting}
                className="accent-emerald-500"
              />
              Approve (mark completed)
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-glassBorder px-3 py-2.5 text-sm text-white/85 has-[:checked]:border-red-500/40 has-[:checked]:bg-red-500/10">
              <input
                type="radio"
                name="decision"
                value="REJECTED"
                checked={decision === "REJECTED"}
                onChange={() => setDecision("REJECTED")}
                disabled={submitting}
                className="accent-red-500"
              />
              Reject (return funds to wallet)
            </label>
          </fieldset>

          {decision === "COMPLETED" ? (
            <div>
              <label
                htmlFor="withdrawal-txn-id"
                className="block text-xs font-medium uppercase tracking-wider text-white/45"
              >
                UTR / reference number
              </label>
              <input
                id="withdrawal-txn-id"
                type="text"
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
                disabled={submitting}
                placeholder="Bank transfer reference"
                className="mt-2 w-full rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-primary/50 focus:outline-none"
              />
            </div>
          ) : (
            <div>
              <label
                htmlFor="withdrawal-remarks"
                className="block text-xs font-medium uppercase tracking-wider text-white/45"
              >
                Rejection remarks
              </label>
              <textarea
                id="withdrawal-remarks"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                disabled={submitting}
                rows={3}
                placeholder="Reason shown internally for this rejection"
                className="mt-2 w-full resize-none rounded-lg border border-glassBorder bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-primary/50 focus:outline-none"
              />
            </div>
          )}

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
                "Save"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
