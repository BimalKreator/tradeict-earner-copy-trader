"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { adminFetch } from "@/lib/adminAuth";
import { fmtUsd, formatINR, RATE_MISSING_MESSAGE } from "@/lib/currency";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";

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
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function ProcessWithdrawalModal({
  open,
  request,
  onClose,
  onSuccess,
  onError,
}: ProcessWithdrawalModalProps) {
  const { rate: usdInrRate } = useUsdInrRate();
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
    if (!request) return;

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
      const res = await adminFetch(
        `/admin/wallet/withdrawals/${encodeURIComponent(request.id)}/process`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: decision,
            transactionId:
              decision === "COMPLETED" ? transactionId.trim() : undefined,
            remarks:
              decision === "REJECTED"
                ? remarks.trim()
                : remarks.trim() || undefined,
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
          ? "Withdrawal marked completed."
          : "Withdrawal rejected.",
      );
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to process withdrawal";
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-glassBorder bg-[#12141c] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">
              Process withdrawal
            </h2>
            <p className="mt-1 text-sm text-white/55">
              {request.user.name ?? request.user.email} · {fmtUsd(request.amount)}
              {" · "}
              {formatINR(request.amount, usdInrRate)}
              {usdInrRate == null ? (
                <span className="ml-1 text-amber-200/80">
                  · {RATE_MISSING_MESSAGE}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="space-y-4 px-5 py-4"
        >
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="sr-only">Decision</legend>
            {(["COMPLETED", "REJECTED"] as const).map((d) => (
              <label
                key={d}
                className={`flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium ${
                  decision === d
                    ? d === "COMPLETED"
                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-100"
                      : "border-red-500/50 bg-red-600/20 text-red-100"
                    : "border-glassBorder text-white/65"
                }`}
              >
                <input
                  type="radio"
                  name="decision"
                  value={d}
                  checked={decision === d}
                  onChange={() => setDecision(d)}
                  disabled={submitting}
                  className="sr-only"
                />
                {d === "COMPLETED" ? "Approve" : "Reject"}
              </label>
            ))}
          </fieldset>

          {decision === "COMPLETED" ? (
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/45">
                UTR / reference
              </label>
              <input
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
                disabled={submitting}
                className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white"
              />
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/45">
                Rejection remarks
              </label>
              <textarea
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                disabled={submitting}
                rows={3}
                className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2.5 text-sm text-white"
              />
            </div>
          )}

          {formError ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {formError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm text-white/70 hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Submit
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
