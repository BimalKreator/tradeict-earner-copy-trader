"use client";

import { AlertTriangle, FlaskConical, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { adminFetch, buildAdminApiUrl, formatAdminFetchError } from "@/lib/adminAuth";
import { resolveApiBase } from "@/lib/apiBase";
import { fmtUsd } from "@/lib/currency";
import { formatIstCalendarDate } from "@/lib/istDates";

type Scenario = "PROFIT" | "LOSS" | "PROFIT_THEN_LOSS_THEN_PROFIT";

type ChainState = {
  ledgerRowCount: number;
  ledgerSample: Array<{
    productSymbol: string | null;
    transactionType: string;
    amount: number;
    occurredAt: string;
  }>;
  structures: Array<{
    botStructureId: number;
    status: string;
    realizedPnl: number | null;
    closedAt: string | null;
    legs: number;
  }>;
  snapshots: Array<{
    snapshotDate: string;
    realizedDelta: number;
    cumulativeRealized: number;
    highWaterMark: number;
    commissionAccrued: number;
  }>;
  invoices: Array<{
    periodYear: number;
    periodMonth: number;
    billableProfit: number;
    commissionAmount: number;
    status: string;
  }>;
  affiliateCommissions: Array<{
    beneficiaryUserId: string;
    amount: number;
    status: string;
  }>;
};

type Props = {
  userId: string;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
};

export function AdminUserSimulationPanel({ userId, onNotice, onError }: Props) {
  const [loading, setLoading] = useState(true);
  const [allowSimulation, setAllowSimulation] = useState(false);
  const [togglingAllow, setTogglingAllow] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("PROFIT");
  const [realizedPnl, setRealizedPnl] = useState("100");
  const [closedAtIst, setClosedAtIst] = useState("");
  const [running, setRunning] = useState(false);
  const [purging, setPurging] = useState(false);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadChain = useCallback(async () => {
    if (!resolveApiBase() || !userId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const path = `/admin/simulate/chain/${userId}`;
      const res = await adminFetch(path);
      if (!res.ok) {
        throw new Error(formatAdminFetchError("simulation chain", res, buildAdminApiUrl(path)));
      }
      const data = (await res.json()) as {
        user: { allowSimulation: boolean };
        chain: ChainState;
      };
      setAllowSimulation(data.user.allowSimulation);
      setChain(data.chain);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load simulation state");
      setChain(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadChain();
  }, [loadChain]);

  async function toggleAllowSimulation() {
    setTogglingAllow(true);
    try {
      const path = `/admin/users/${userId}/allow-simulation`;
      const res = await adminFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowSimulation: !allowSimulation }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        user?: { allowSimulation: boolean };
      };
      if (!res.ok) throw new Error(body.error ?? "Failed to update allowSimulation");
      setAllowSimulation(body.user?.allowSimulation ?? !allowSimulation);
      onNotice?.(
        body.user?.allowSimulation
          ? "Simulation enabled for this user."
          : "Simulation disabled for this user.",
      );
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to toggle simulation");
    } finally {
      setTogglingAllow(false);
    }
  }

  async function runSimulation() {
    if (!allowSimulation) {
      onError?.("Enable allowSimulation before running scenarios.");
      return;
    }

    const ok = window.confirm(
      `Run ${scenario} simulation? All rows will be marked isSimulated and excluded from billing/payouts until purged.`,
    );
    if (!ok) return;

    setRunning(true);
    try {
      const path = "/admin/simulate/structure";
      const body: Record<string, unknown> = { userId, scenario };
      if (realizedPnl.trim()) {
        body.realizedPnl = parseFloat(realizedPnl);
      }
      if (closedAtIst.trim()) {
        body.closedAtIst = closedAtIst.trim();
      }

      const res = await adminFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Simulation failed");

      onNotice?.(`Simulation ${scenario} completed — see chain below.`);
      await loadChain();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setRunning(false);
    }
  }

  async function purgeSimulation() {
    const ok = window.confirm(
      "Purge ALL simulated rows for this user and recompute real snapshots/invoices?",
    );
    if (!ok) return;

    setPurging(true);
    try {
      const path = "/admin/simulate/purge";
      const res = await adminFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        deleted?: Record<string, number>;
      };
      if (!res.ok) throw new Error(payload.error ?? "Purge failed");

      const counts = payload.deleted
        ? Object.entries(payload.deleted)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        : "";
      onNotice?.(`Simulated data purged. ${counts}`);
      await loadChain();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Purge failed");
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-amber-100">
            <FlaskConical className="h-5 w-5" aria-hidden />
            Delta Revenue Simulation
          </h2>
          <p className="mt-1 text-sm text-white/55">
            Isolated test pipeline — rows are tagged{" "}
            <span className="font-medium text-amber-200">SIMULATED</span> and excluded
            from invoices, payouts, and customer views until purged.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toggleAllowSimulation()}
          disabled={togglingAllow}
          className={`rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-60 ${
            allowSimulation
              ? "border-amber-400/50 bg-amber-500/20 text-amber-100"
              : "border-glassBorder bg-black/30 text-white/70"
          }`}
        >
          {togglingAllow
            ? "Saving..."
            : allowSimulation
              ? "allowSimulation: ON"
              : "allowSimulation: OFF"}
        </button>
      </div>

      {!allowSimulation ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-black/30 px-3 py-2 text-sm text-amber-100/90">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Enable allowSimulation manually before running — prevents accidental use on
          paying customers.
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-sm text-white/70">
          Scenario
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value as Scenario)}
            className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
          >
            <option value="PROFIT">PROFIT</option>
            <option value="LOSS">LOSS</option>
            <option value="PROFIT_THEN_LOSS_THEN_PROFIT">
              PROFIT_THEN_LOSS_THEN_PROFIT
            </option>
          </select>
        </label>
        <label className="text-sm text-white/70">
          realizedPnl override
          <input
            value={realizedPnl}
            onChange={(e) => setRealizedPnl(e.target.value)}
            placeholder="100"
            className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
          />
        </label>
        <label className="text-sm text-white/70">
          closedAtIst (YYYY-MM-DD)
          <input
            value={closedAtIst}
            onChange={(e) => setClosedAtIst(e.target.value)}
            placeholder="empty = today IST"
            className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void runSimulation()}
          disabled={running || !allowSimulation}
          className="inline-flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/20 px-3 py-2 text-xs font-medium text-amber-50 hover:bg-amber-500/30 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Run scenario
        </button>
        <button
          type="button"
          onClick={() => void purgeSimulation()}
          disabled={purging}
          className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-500/25 disabled:opacity-50"
        >
          {purging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Purge simulated data
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading simulation chain…
        </div>
      ) : loadError ? (
        <p className="text-sm text-red-300">{loadError}</p>
      ) : chain ? (
        <div className="space-y-3 text-sm">
          <p className="text-white/60">
            Simulated ledger rows:{" "}
            <span className="font-medium text-white">{chain.ledgerRowCount}</span>
          </p>

          {chain.ledgerSample.length > 0 ? (
            <ChainSection title="Ledger (sample)">
              {chain.ledgerSample.map((row, idx) => (
                <div key={idx} className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className="text-amber-200/90">SIMULATED</span>
                  <span>{row.productSymbol ?? "—"}</span>
                  <span>{row.transactionType}</span>
                  <span className="tabular-nums">{fmtUsd(row.amount)}</span>
                </div>
              ))}
            </ChainSection>
          ) : null}

          {chain.structures.length > 0 ? (
            <ChainSection title="Structure P&L">
              {chain.structures.map((s) => (
                <div key={s.botStructureId} className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className="text-amber-200/90">SIMULATED #{s.botStructureId}</span>
                  <span>{s.status}</span>
                  <span className="tabular-nums">{fmtUsd(s.realizedPnl ?? 0)}</span>
                  <span>{s.legs} legs</span>
                </div>
              ))}
            </ChainSection>
          ) : null}

          {chain.snapshots.length > 0 ? (
            <ChainSection title="Daily snapshots">
              {chain.snapshots.map((s) => (
                <div key={s.snapshotDate} className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className="text-amber-200/90">SIMULATED</span>
                  <span>{formatIstCalendarDate(s.snapshotDate)}</span>
                  <span className="tabular-nums">HWM {fmtUsd(s.highWaterMark)}</span>
                  <span className="tabular-nums">comm {fmtUsd(s.commissionAccrued)}</span>
                </div>
              ))}
            </ChainSection>
          ) : null}

          {chain.invoices.length > 0 ? (
            <ChainSection title="Monthly invoices">
              {chain.invoices.map((inv) => (
                <div
                  key={`${inv.periodYear}-${inv.periodMonth}`}
                  className="flex flex-wrap justify-between gap-2 text-xs"
                >
                  <span className="text-amber-200/90">SIMULATED</span>
                  <span>
                    {inv.periodYear}-{String(inv.periodMonth).padStart(2, "0")}
                  </span>
                  <span className="tabular-nums">{fmtUsd(inv.commissionAmount)}</span>
                  <span>{inv.status}</span>
                </div>
              ))}
            </ChainSection>
          ) : null}

          {chain.affiliateCommissions.length > 0 ? (
            <ChainSection title="Affiliate commissions">
              {chain.affiliateCommissions.map((c, idx) => (
                <div key={idx} className="flex flex-wrap justify-between gap-2 text-xs">
                  <span className="text-amber-200/90">SIMULATED</span>
                  <span className="truncate">{c.beneficiaryUserId.slice(0, 8)}…</span>
                  <span className="tabular-nums">{fmtUsd(c.amount)}</span>
                  <span>{c.status}</span>
                </div>
              ))}
            </ChainSection>
          ) : null}

          {chain.ledgerRowCount === 0 ? (
            <p className="text-white/45">No simulated rows for this user.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChainSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-glassBorder bg-black/25 px-3 py-2">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/45">
        {title}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
