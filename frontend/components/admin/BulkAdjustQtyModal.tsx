"use client";

import { Layers, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type BulkAdjustQtyTarget = {
  strategyId: string;
  userId: string;
  userLabel: string;
  legCount: number;
};

type BulkAdjustQtyModalProps = {
  open: boolean;
  target: BulkAdjustQtyTarget | null;
  onClose: () => void;
  apiBase: string;
  authToken: string;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function BulkAdjustQtyModal({
  open,
  target,
  onClose,
  apiBase,
  authToken,
  onSuccess,
  onError,
}: BulkAdjustQtyModalProps) {
  const [adjustmentInput, setAdjustmentInput] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  useEffect(() => {
    if (!open) {
      submitLockRef.current = false;
      setSubmitting(false);
      return;
    }
    setAdjustmentInput("1");
  }, [open, target?.userId]);

  const handleSubmit = useCallback(async () => {
    if (!target || submitLockRef.current || submitting) return;

    const adjustmentLots = Math.trunc(Number(adjustmentInput));
    if (!Number.isFinite(adjustmentLots) || adjustmentLots === 0) {
      onError("Enter a non-zero integer (positive to add, negative to reduce).");
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);

    try {
      const res = await fetch(`${apiBase}/admin/live-trades/bulk-adjust-follower`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          userId: target.userId,
          strategyId: target.strategyId,
          adjustmentLots,
        }),
      });
      const responseBody: unknown = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          typeof responseBody === "object" && responseBody !== null
            ? typeof (responseBody as { error?: unknown }).error === "string"
              ? (responseBody as { error: string }).error
              : `Bulk adjust failed (${res.status})`
            : `Bulk adjust failed (${res.status})`;
        throw new Error(msg);
      }

      const succeeded =
        typeof responseBody === "object" &&
        responseBody !== null &&
        typeof (responseBody as { legsSucceeded?: unknown }).legsSucceeded ===
          "number"
          ? (responseBody as { legsSucceeded: number }).legsSucceeded
          : target.legCount;

      onSuccess(
        `Bulk adjust complete for ${target.userLabel}: ${adjustmentLots > 0 ? "+" : ""}${adjustmentLots} lot(s) on ${succeeded} leg${succeeded === 1 ? "" : "s"}.`,
      );
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk adjust failed");
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }, [
    adjustmentInput,
    apiBase,
    authToken,
    onClose,
    onError,
    onSuccess,
    submitting,
    target,
  ]);

  if (!open || !target) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-adjust-qty-title"
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#0d0d12] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2
              id="bulk-adjust-qty-title"
              className="flex items-center gap-2 text-lg font-semibold text-white"
            >
              <Layers className="h-5 w-5 text-sky-300" aria-hidden />
              Bulk Adjust Quantity
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Apply the same lot delta to all{" "}
              <span className="font-semibold text-white/80">
                {target.legCount}
              </span>{" "}
              open leg{target.legCount === 1 ? "" : "s"} for{" "}
              <span className="font-medium text-white/80">{target.userLabel}</span>.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <label className="block text-sm text-white/70">
            Lots to adjust (all legs)
            <input
              type="number"
              step={1}
              value={adjustmentInput}
              disabled={submitting}
              onChange={(e) => setAdjustmentInput(e.target.value)}
              placeholder="e.g. 1 or -1"
              className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm tabular-nums text-white outline-none ring-sky-500/40 placeholder:text-white/30 focus:border-sky-500/50 focus:ring-2 disabled:opacity-50"
            />
          </label>
          <p className="text-xs leading-relaxed text-white/45">
            Positive adds lots on each leg; negative reduces each leg by that
            amount (legs reaching zero are closed in the DB).
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg px-4 py-2 text-sm text-white/65 transition hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleSubmit()}
            aria-busy={submitting}
            className="inline-flex items-center gap-2 rounded-lg border border-sky-500/45 bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Executing…
              </>
            ) : (
              "Apply to All Legs"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
