"use client";

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState, Fragment } from "react";
import { ConfirmDestructiveModal } from "@/components/admin/ConfirmDestructiveModal";
import { adminFetch, buildAdminApiUrl, formatAdminFetchError } from "@/lib/adminAuth";
import { resolveApiBase } from "@/lib/apiBase";
import { fmtUsd } from "@/lib/currency";
import { formatIstCalendarDate, formatIstDateTime } from "@/lib/istDates";

type StructureSummary = {
  id: string;
  botStructureId: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  realizedPnl: number | null;
  matchedTxnCount: number;
};

type LedgerEntryRow = {
  deltaUuid: string;
  transactionType: string;
  amount: number;
  occurredAt: string;
  productId: number | null;
  productSymbol: string | null;
};

type StructureLedgerPayload = {
  structurePnlId: string;
  botStructureId: number;
  nearbyPadHours: number;
  legs: Array<{
    botLegId: number;
    legRole: string;
    symbol: string | null;
    productId: number;
    matched: LedgerEntryRow[];
  }>;
  nearbyUnmatched: LedgerEntryRow[];
};

type Props = {
  userId: string;
  /** Customer email required for backend typed confirmation. */
  userEmail: string;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
};

async function runSafeRecompute(userId: string): Promise<string> {
  const steps: Array<{ label: string; path: string }> = [
    { label: "delta-ledger/sync", path: "/admin/delta-ledger/sync" },
    { label: "structure-pnl/recompute", path: "/admin/structure-pnl/recompute" },
    { label: "revenue/recompute-chain", path: "/admin/revenue/recompute-chain" },
  ];
  const notes: string[] = [];
  for (const step of steps) {
    const res = await adminFetch(step.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(
        body.error ??
          formatAdminFetchError(step.label, res, buildAdminApiUrl(step.path)),
      );
    }
    notes.push(step.label);
  }
  return `Safe recompute done: ${notes.join(" → ")} (no positions closed).`;
}

function LedgerRowsTable({ rows }: { rows: LedgerEntryRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-white/40">No rows.</p>;
  }
  return (
    <div className="max-h-48 overflow-auto rounded border border-white/10">
      <table className="w-full min-w-[640px] text-left text-[11px]">
        <thead className="sticky top-0 bg-black/70 text-white/40 uppercase">
          <tr>
            <th className="px-2 py-1">UUID</th>
            <th className="px-2 py-1">Type</th>
            <th className="px-2 py-1">Amount</th>
            <th className="px-2 py-1">Occurred</th>
            <th className="px-2 py-1">Product</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5 text-white/75">
          {rows.map((r) => (
            <tr key={r.deltaUuid}>
              <td className="px-2 py-1 font-mono text-[10px]">{r.deltaUuid.slice(0, 12)}…</td>
              <td className="px-2 py-1">{r.transactionType}</td>
              <td className="px-2 py-1 tabular-nums">{fmtUsd(r.amount)}</td>
              <td className="px-2 py-1">{formatIstDateTime(r.occurredAt)}</td>
              <td className="px-2 py-1">
                {r.productSymbol ?? r.productId ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminUserStructureBillingPanel({
  userId,
  userEmail,
  onNotice,
  onError,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [structures, setStructures] = useState<StructureSummary[]>([]);
  const [finalising, setFinalising] = useState(false);
  const [safeRecomputing, setSafeRecomputing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalResult, setModalResult] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedLedgerId, setExpandedLedgerId] = useState<string | null>(null);
  const [ledgerByStructure, setLedgerByStructure] = useState<
    Record<string, StructureLedgerPayload>
  >({});
  const [ledgerLoadingId, setLedgerLoadingId] = useState<string | null>(null);

  const loadStructures = useCallback(async () => {
    if (!resolveApiBase() || !userId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const path = `/admin/revenue/user/${userId}`;
      const res = await adminFetch(path);
      if (!res.ok) {
        throw new Error(formatAdminFetchError("structures", res, buildAdminApiUrl(path)));
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

  async function handleSafeRecompute() {
    setSafeRecomputing(true);
    try {
      const msg = await runSafeRecompute(userId);
      onNotice?.(msg);
      await loadStructures();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Safe recompute failed";
      onError?.(message);
    } finally {
      setSafeRecomputing(false);
    }
  }

  async function toggleLedger(structurePnlId: string) {
    if (expandedLedgerId === structurePnlId) {
      setExpandedLedgerId(null);
      return;
    }
    setExpandedLedgerId(structurePnlId);
    if (ledgerByStructure[structurePnlId]) return;
    setLedgerLoadingId(structurePnlId);
    try {
      const path = `/admin/revenue/structure/${structurePnlId}/ledger`;
      const res = await adminFetch(path);
      if (!res.ok) {
        throw new Error(formatAdminFetchError("structure ledger", res, buildAdminApiUrl(path)));
      }
      const data = (await res.json()) as StructureLedgerPayload;
      setLedgerByStructure((prev) => ({ ...prev, [structurePnlId]: data }));
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to load ledger rows");
      setExpandedLedgerId(null);
    } finally {
      setLedgerLoadingId(null);
    }
  }

  async function runFinalise(confirmation: string) {
    setFinalising(true);
    setModalError(null);
    setModalResult(null);
    try {
      const path = `/admin/users/${userId}/close-structure-and-finalise-billing`;
      const res = await adminFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        expectedHint?: string;
        failedBaskets?: number[];
        invoice?: { commissionAmount?: number; billableProfit?: number; isFinal?: boolean };
      };
      if (!res.ok) {
        const extra =
          body.failedBaskets && body.failedBaskets.length > 0
            ? ` Failed baskets: ${body.failedBaskets.join(", ")}.`
            : "";
        const hint = body.expectedHint ? ` ${body.expectedHint}` : "";
        throw new Error(
          (body.error ?? formatAdminFetchError("finalise billing", res, buildAdminApiUrl(path))) +
            hint +
            extra,
        );
      }
      const msg = `Structure closed and final invoice issued (commission ${fmtUsd(body.invoice?.commissionAmount ?? 0)}).`;
      setModalResult(msg);
      onNotice?.(msg);
      await loadStructures();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Finalise billing failed";
      setModalError(message);
      onError?.(message);
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
            <h2 className="text-lg font-semibold text-white">Billing workbench</h2>
          </div>
          <p className="mt-1 text-sm text-white/55">
            Fix wrong numbers with a safe recompute and ledger forensic view — without
            touching live positions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={safeRecomputing || loading || !userId}
            onClick={() => void handleSafeRecompute()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-60"
          >
            {safeRecomputing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {safeRecomputing ? "Recomputing…" : "Recompute (safe)"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-red-500/35 bg-red-500/[0.07] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            <div>
              <p className="text-sm font-medium text-red-100">
                Close structure &amp; finalise (destructive)
              </p>
              <p className="mt-1 text-xs text-red-200/80">
                Closes this customer&apos;s <strong className="text-red-100">LIVE</strong>{" "}
                Delta positions, syncs the ledger, recomputes P&amp;L, and issues a final
                invoice. Use only when cancellation is stuck — not to fix a wrong number.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={finalising || loading || !userEmail}
            onClick={() => {
              setModalError(null);
              setModalResult(null);
              setModalOpen(true);
            }}
            className="rounded-lg border border-red-500/50 bg-red-600/30 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-600/45 disabled:opacity-60"
          >
            {finalising ? "Finalising…" : "Close structure & finalise"}
          </button>
        </div>
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
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-black/60 text-white/40 uppercase">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Opened (IST)</th>
                  <th className="px-3 py-2">Realized</th>
                  <th className="px-3 py-2">Txns</th>
                  <th className="px-3 py-2">Forensic</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-white/80">
                {structures.map((s) => {
                  const expanded = expandedLedgerId === s.id;
                  const ledger = ledgerByStructure[s.id];
                  return (
                    <Fragment key={s.id}>
                      <tr>
                        <td className="px-3 py-2 tabular-nums">{s.botStructureId}</td>
                        <td className="px-3 py-2">{s.status}</td>
                        <td className="px-3 py-2">{formatIstCalendarDate(s.openedAt)}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {s.realizedPnl != null ? fmtUsd(s.realizedPnl) : "—"}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{s.matchedTxnCount}</td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => void toggleLedger(s.id)}
                            className="inline-flex items-center gap-1 rounded border border-sky-500/35 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-100 hover:bg-sky-500/20"
                          >
                            {ledgerLoadingId === s.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : expanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            Show ledger rows
                          </button>
                        </td>
                      </tr>
                      {expanded ? (
                        <tr>
                          <td colSpan={6} className="bg-black/40 px-3 py-3">
                            {ledgerLoadingId === s.id && !ledger ? (
                              <Loader2 className="h-5 w-5 animate-spin text-white/30" />
                            ) : ledger ? (
                              <div className="space-y-3">
                                <p className="text-[11px] text-white/45">
                                  Matched rows per leg · nearby unmatched within ±
                                  {ledger.nearbyPadHours}h (read-only forensic view)
                                </p>
                                {ledger.legs.map((leg) => (
                                  <div key={leg.botLegId} className="space-y-1">
                                    <p className="text-xs text-white/70">
                                      Leg {leg.botLegId} · {leg.legRole}
                                      {leg.symbol ? ` · ${leg.symbol}` : ""} · product{" "}
                                      {leg.productId} · {leg.matched.length} matched
                                    </p>
                                    <LedgerRowsTable rows={leg.matched} />
                                  </div>
                                ))}
                                <div className="space-y-1">
                                  <p className="text-xs font-medium text-amber-200/90">
                                    Nearby unmatched ({ledger.nearbyUnmatched.length})
                                  </p>
                                  <LedgerRowsTable rows={ledger.nearbyUnmatched} />
                                </div>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConfirmDestructiveModal
        open={modalOpen}
        title="Close structure and finalise billing"
        description={`This closes LIVE Delta positions for this customer (${openCount} open structure(s)), syncs the ledger, recomputes P&L, and issues a final invoice for the current IST month. This cannot be undone. Do not use this to fix a wrong invoice number — use Recompute (safe) instead.`}
        expectedConfirmation={userEmail}
        customerEmail={userEmail}
        confirmButtonText="Close structure & finalise"
        busy={finalising}
        error={modalError}
        result={modalResult}
        onClose={() => {
          if (!finalising) setModalOpen(false);
        }}
        onConfirm={(confirmation) => void runFinalise(confirmation)}
      />
    </div>
  );
}

export { runSafeRecompute };
