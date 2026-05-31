"use client";

import { Loader2, Shield, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type MasterAdjustQtyTarget = {
  strategyId: string;
  symbol: string;
  currentSide: string;
  currentLots: number;
};

type MasterAdjustQtyModalProps = {
  open: boolean;
  target: MasterAdjustQtyTarget | null;
  onClose: () => void;
  apiBase: string;
  authToken: string;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function MasterAdjustQtyModal({
  open,
  target,
  onClose,
  apiBase,
  authToken,
  onSuccess,
  onError,
}: MasterAdjustQtyModalProps) {
  const [adjustmentInput, setAdjustmentInput] = useState("1");
  const [submitting, setSubmitting] = useState<"copy" | "solo" | null>(null);
  const submitLockRef = useRef(false);

  useEffect(() => {
    if (!open) {
      submitLockRef.current = false;
      setSubmitting(null);
      return;
    }
    setAdjustmentInput("1");
  }, [open, target?.symbol, target?.currentSide]);

  const handleSubmit = useCallback(
    async (copyToUsers: boolean) => {
      if (!target || submitLockRef.current || submitting) return;

      const adjustmentLots = Math.trunc(Number(adjustmentInput));
      if (!Number.isFinite(adjustmentLots) || adjustmentLots === 0) {
        onError("Enter a non-zero integer (positive to add, negative to reduce).");
        return;
      }

      submitLockRef.current = true;
      setSubmitting(copyToUsers ? "copy" : "solo");

      try {
        const res = await fetch(`${apiBase}/admin/live-trades/adjust-master`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            strategyId: target.strategyId,
            symbol: target.symbol,
            currentSide: target.currentSide.toUpperCase(),
            adjustmentLots,
            copyToUsers,
          }),
        });
        const responseBody: unknown = await res.json().catch(() => ({}));

        if (!res.ok) {
          const msg =
            typeof responseBody === "object" && responseBody !== null
              ? typeof (responseBody as { error?: unknown }).error === "string"
                ? (responseBody as { error: string }).error
                : `Master adjust failed (${res.status})`
              : `Master adjust failed (${res.status})`;
          throw new Error(msg);
        }

        onSuccess(
          copyToUsers
            ? `Master ${target.symbol} adjusted ${adjustmentLots > 0 ? "+" : ""}${adjustmentLots} lot(s) and copied to subscribers.`
            : `Master ${target.symbol} adjusted ${adjustmentLots > 0 ? "+" : ""}${adjustmentLots} lot(s) only (no follower copy).`,
        );
        onClose();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Master adjust failed");
      } finally {
        submitLockRef.current = false;
        setSubmitting(null);
      }
    },
    [
      adjustmentInput,
      apiBase,
      authToken,
      onClose,
      onError,
      onSuccess,
      submitting,
      target,
    ],
  );

  if (!open || !target) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="master-adjust-qty-title"
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#0d0d12] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2
              id="master-adjust-qty-title"
              className="flex items-center gap-2 text-lg font-semibold text-white"
            >
              <Shield className="h-5 w-5 text-primary" aria-hidden />
              Adjust Master Quantity
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Master Delta ·{" "}
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
            disabled={submitting != null}
            className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <label className="block text-sm text-white/70">
            Lots to adjust on Master
            <input
              type="number"
              step={1}
              value={adjustmentInput}
              disabled={submitting != null}
              onChange={(e) => setAdjustmentInput(e.target.value)}
              placeholder="e.g. 1 or -1"
              className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm tabular-nums text-white outline-none ring-primary/40 placeholder:text-white/30 focus:border-primary/50 focus:ring-2 disabled:opacity-50"
            />
          </label>
          <p className="text-xs leading-relaxed text-white/45">
            Positive adds lots; negative reduces. Choose whether subscribers
            should mirror this change or keep master-only reconciliation.
          </p>
        </div>

        <div className="flex flex-col gap-2 border-t border-white/10 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting != null}
            className="rounded-lg px-4 py-2 text-sm text-white/65 transition hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting != null}
            onClick={() => void handleSubmit(false)}
            aria-busy={submitting === "solo"}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-500/45 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting === "solo" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Executing…
              </>
            ) : (
              <>
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                Adjust Master ONLY
              </>
            )}
          </button>
          <button
            type="button"
            disabled={submitting != null}
            onClick={() => void handleSubmit(true)}
            aria-busy={submitting === "copy"}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary/45 bg-primary/20 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting === "copy" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Executing…
              </>
            ) : (
              "Adjust & Copy to Users"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
