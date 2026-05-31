"use client";

import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type GranularSyncMasterLeg = {
  symbol: string;
  side: string;
  masterQty: number;
};

type LegDraft = GranularSyncMasterLeg & { addLots: number };

type GranularSyncModalProps = {
  open: boolean;
  onClose: () => void;
  strategyId: string;
  userId: string;
  userLabel: string;
  masterLegs: GranularSyncMasterLeg[];
  apiBase: string;
  authToken: string;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
};

export function GranularSyncModal({
  open,
  onClose,
  strategyId,
  userId,
  userLabel,
  masterLegs,
  apiBase,
  authToken,
  onSuccess,
  onError,
}: GranularSyncModalProps) {
  const [drafts, setDrafts] = useState<LegDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  const legKey = useCallback(
    (leg: GranularSyncMasterLeg) => `${leg.symbol}:${leg.side}`,
    [],
  );

  useEffect(() => {
    if (!open) {
      submitLockRef.current = false;
      setSubmitting(false);
      return;
    }
    setDrafts(
      masterLegs.map((leg) => ({
        ...leg,
        addLots: 0,
      })),
    );
  }, [open, masterLegs]);

  const handleExecute = useCallback(async () => {
    if (submitLockRef.current || submitting) return;

    const legs = drafts
      .filter((d) => d.addLots > 0)
      .map((d) => ({
        symbol: d.symbol,
        side: d.side,
        addLots: Math.floor(d.addLots),
      }));

    if (legs.length === 0) {
      onError("Enter lots to add for at least one leg.");
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);

    const payload = { userId, strategyId, legs };
    console.log("[granular-sync] payload", JSON.stringify(payload));

    try {
      const res = await fetch(`${apiBase}/admin/live-trades/granular-sync`, {
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
              : typeof (responseBody as { syncError?: unknown }).syncError ===
                  "string"
                ? (responseBody as { syncError: string }).syncError
                : `Granular sync failed (${res.status})`
            : `Granular sync failed (${res.status})`;
        throw new Error(msg);
      }

      const succeeded =
        typeof responseBody === "object" &&
        responseBody !== null &&
        typeof (responseBody as { legsSucceeded?: unknown }).legsSucceeded ===
          "number"
          ? (responseBody as { legsSucceeded: number }).legsSucceeded
          : legs.length;

      onSuccess(
        `Granular sync complete — ${succeeded} leg${succeeded === 1 ? "" : "s"} executed for ${userLabel}.`,
      );
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Granular sync failed");
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }, [
    apiBase,
    authToken,
    drafts,
    onClose,
    onError,
    onSuccess,
    strategyId,
    submitting,
    userId,
    userLabel,
  ]);

  const pendingCount = useMemo(
    () => drafts.filter((d) => d.addLots > 0).length,
    [drafts],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="granular-sync-title"
    >
      <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#0d0d12] shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2
              id="granular-sync-title"
              className="text-lg font-semibold text-white"
            >
              Granular Force Sync
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Add exact lots per master leg for{" "}
              <span className="font-medium text-white/80">{userLabel}</span>.
              Multiplier is not applied — use the precise lot count you want on
              the follower account.
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

        {masterLegs.length === 0 ? (
          <p className="px-5 py-8 text-sm text-white/45">
            No active master legs to sync.
          </p>
        ) : (
          <div className="max-h-[50vh] overflow-auto px-5 py-4">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-white/45">
                  <th className="pb-2 pr-3 font-medium">Symbol</th>
                  <th className="pb-2 pr-3 font-medium">Side</th>
                  <th className="pb-2 pr-3 font-medium tabular-nums">Master Qty</th>
                  <th className="pb-2 font-medium">Lots to Add</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((leg) => (
                  <tr
                    key={legKey(leg)}
                    className="border-b border-white/[0.06] last:border-0"
                  >
                    <td className="py-2.5 pr-3 font-mono text-white/90">
                      {leg.symbol}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                          leg.side.toUpperCase() === "BUY"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-red-500/15 text-red-300"
                        }`}
                      >
                        {leg.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums text-white/70">
                      {leg.masterQty}
                    </td>
                    <td className="py-2.5">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={leg.addLots}
                        disabled={submitting}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const parsed =
                            raw === "" ? 0 : Math.max(0, Math.floor(Number(raw)));
                          setDrafts((prev) =>
                            prev.map((row) =>
                              legKey(row) === legKey(leg)
                                ? { ...row, addLots: Number.isFinite(parsed) ? parsed : 0 }
                                : row,
                            ),
                          );
                        }}
                        className="w-24 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-sm tabular-nums text-white outline-none ring-violet-500/40 focus:border-violet-500/50 focus:ring-2 disabled:opacity-50"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
            disabled={submitting || masterLegs.length === 0 || pendingCount === 0}
            onClick={() => void handleExecute()}
            aria-busy={submitting}
            className="inline-flex items-center gap-2 rounded-lg border border-violet-500/45 bg-violet-500/20 px-4 py-2 text-sm font-medium text-violet-100 transition hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Executing…
              </>
            ) : (
              <>Execute Sync{pendingCount > 0 ? ` (${pendingCount})` : ""}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
