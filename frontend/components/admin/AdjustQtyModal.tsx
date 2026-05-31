"use client";

import { Loader2, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type AdjustQtyTarget = {
  strategyId: string;
  userId: string;
  userLabel: string;
  symbol: string;
  currentSide: string;
  currentLots: number;
};

type AdjustQtyModalProps = {
  open: boolean;
  target: AdjustQtyTarget | null;
  onClose: () => void;
  apiBase: string;
  authToken: string;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function AdjustQtyModal({
  open,
  target,
  onClose,
  apiBase,
  authToken,
  onSuccess,
  onError,
}: AdjustQtyModalProps) {
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
  }, [open, target?.symbol, target?.currentSide]);

  const handleSubmit = useCallback(async () => {
    if (!target || submitLockRef.current || submitting) return;

    const adjustmentLots = Math.trunc(Number(adjustmentInput));
    if (!Number.isFinite(adjustmentLots) || adjustmentLots === 0) {
      onError("Enter a non-zero integer (positive to add, negative to reduce).");
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);

    const payload = {
      userId: target.userId,
      strategyId: target.strategyId,
      symbol: target.symbol,
      currentSide: target.currentSide.toUpperCase(),
      adjustmentLots,
    };

    try {
      const res = await fetch(`${apiBase}/admin/live-trades/adjust-follower-qty`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(payload),
      });
      const responseBody: unknown = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          typeof responseBody === "object" && responseBody !== null
            ? typeof (responseBody as { error?: unknown }).error === "string"
              ? (responseBody as { error: string }).error
              : `Adjust qty failed (${res.status})`
            : `Adjust qty failed (${res.status})`;
        throw new Error(msg);
      }

      const newQty =
        typeof responseBody === "object" &&
        responseBody !== null &&
        typeof (responseBody as { newQuantity?: unknown }).newQuantity === "number"
          ? (responseBody as { newQuantity: number }).newQuantity
          : null;

      onSuccess(
        newQty != null
          ? `Adjusted ${target.symbol} for ${target.userLabel}: ${adjustmentLots > 0 ? "+" : ""}${adjustmentLots} lot(s). New bot qty: ${newQty}.`
          : `Adjusted ${target.symbol} for ${target.userLabel} by ${adjustmentLots > 0 ? "+" : ""}${adjustmentLots} lot(s).`,
      );
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Adjust qty failed");
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
      aria-labelledby="adjust-qty-title"
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#0d0d12] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2
              id="adjust-qty-title"
              className="flex items-center gap-2 text-lg font-semibold text-white"
            >
              <SlidersHorizontal className="h-5 w-5 text-amber-300" aria-hidden />
              Adjust Quantity
            </h2>
            <p className="mt-1 text-sm text-white/50">
              {target.userLabel} ·{" "}
              <span className="font-mono text-white/80">{target.symbol}</span>{" "}
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                  target.currentSide.toUpperCase() === "BUY"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-red-500/15 text-red-300"
                }`}
              >
                {target.currentSide.toUpperCase()}
              </span>
            </p>
            <p className="mt-1 text-xs text-white/40">
              Current lots: {target.currentLots}
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
            Lots to adjust
            <input
              type="number"
              step={1}
              value={adjustmentInput}
              disabled={submitting}
              onChange={(e) => setAdjustmentInput(e.target.value)}
              placeholder="e.g. 1 or -1"
              className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm tabular-nums text-white outline-none ring-amber-500/40 placeholder:text-white/30 focus:border-amber-500/50 focus:ring-2 disabled:opacity-50"
            />
          </label>
          <p className="text-xs leading-relaxed text-white/45">
            Use positive numbers to add lots (e.g.{" "}
            <span className="font-mono text-white/60">1</span>) and negative
            numbers to reduce (e.g.{" "}
            <span className="font-mono text-white/60">-1</span>). A reduction
            that reaches zero closes the bot-managed position row.
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
            className="inline-flex items-center gap-2 rounded-lg border border-amber-500/45 bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Executing…
              </>
            ) : (
              "Apply Adjustment"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
