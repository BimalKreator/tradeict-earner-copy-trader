"use client";

import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { authFetch, buildApiUrl, formatFetchError } from "@/lib/authFetch";
import { resolveApiBase } from "@/lib/apiBase";
import { fmtUsd } from "@/lib/currency";
import { formatIstCalendarDate } from "@/lib/istDates";

type StructureSummary = {
  botStructureId: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  realizedPnl: number | null;
  matchedTxnCount: number;
};

type Props = {
  userId: string;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
};

export function AdminUserStructureBillingPanel({
  userId,
  onNotice,
  onError,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [structures, setStructures] = useState<StructureSummary[]>([]);
  const [finalising, setFinalising] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadStructures = useCallback(async () => {
    if (!resolveApiBase() || !userId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const path = `/admin/revenue/user/${userId}`;
      const res = await authFetch(path);
      if (!res.ok) {
        throw new Error(formatFetchError("structures", res, buildApiUrl(path)));
      }
      const data = (await res.json()) as { structures: StructureSummary[] };
      setStructures(data.structures ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load structures");
      setStructures([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadStructures();
  }, [loadStructures]);

  const openCount = structures.filter((s) => s.status !== "closed").length;
  const closedCount = structures.filter((s) => s.status === "closed").length;

  async function finaliseBilling() {
    const ok = window.confirm(
      "Close this user's open bot structure on Delta, sync ledger, recompute P&L, " +
        "and issue a final invoice for the current IST month? This cannot be undone.",
    );
    if (!ok) return;

    setFinalising(true);
    try {
      const path = `/admin/users/${userId}/close-structure-and-finalise-billing`;
      const res = await authFetch(path, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        failedBaskets?: number[];
        invoice?: { commissionAmount?: number; billableProfit?: number; isFinal?: boolean };
      };
      if (!res.ok) {
        const extra =
          body.failedBaskets && body.failedBaskets.length > 0
            ? ` Failed baskets: ${body.failedBaskets.join(", ")}.`
            : "";
        throw new Error(
          (body.error ?? formatFetchError("finalise billing", res, buildApiUrl(path))) + extra,
        );
      }
      onNotice?.(
        `Structure closed and final invoice issued (commission ${fmtUsd(body.invoice?.commissionAmount ?? 0)}).`,
      );
      await loadStructures();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Finalise billing failed");
    } finally {
      setFinalising(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-sky-500/25 bg-sky-500/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sky-300">
            <ShieldCheck className="h-4 w-4" />
            <h2 className="text-lg font-semibold text-white">Bot structure &amp; billing</h2>
          </div>
          <p className="mt-1 text-sm text-white/55">
            Delta-derived structures for this user. Use finalise when cancellation was blocked or
            stuck.
          </p>
        </div>
        <button
          type="button"
          disabled={finalising || loading}
          onClick={() => void finaliseBilling()}
          className="rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-2 text-xs font-medium text-sky-100 hover:bg-sky-500/25 disabled:opacity-60"
        >
          {finalising ? "Finalising…" : "Close structure and finalise billing"}
        </button>
      </div>

      {loadError ? (
        <p className="flex items-center gap-2 text-sm text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {loadError}
        </p>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-white/30" />
        </div>
      ) : structures.length === 0 ? (
        <p className="text-sm text-white/45">No bot structures recorded for this user.</p>
      ) : (
        <>
          <p className="text-sm text-white/70">
            <span className="font-medium text-white">{structures.length}</span> structures ·{" "}
            <span className={openCount > 0 ? "text-amber-300" : "text-emerald-300"}>
              {openCount} open
            </span>{" "}
            · {closedCount} closed
          </p>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-white/10">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-black/60 text-white/40 uppercase">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Opened (IST)</th>
                  <th className="px-3 py-2">Realized</th>
                  <th className="px-3 py-2">Txns</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-white/80">
                {structures.slice(0, 20).map((s) => (
                  <tr key={s.botStructureId}>
                    <td className="px-3 py-2 tabular-nums">{s.botStructureId}</td>
                    <td className="px-3 py-2">{s.status}</td>
                    <td className="px-3 py-2">{formatIstCalendarDate(s.openedAt)}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {s.realizedPnl != null ? fmtUsd(s.realizedPnl) : "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{s.matchedTxnCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
