"use client";

import { resolveApiBase } from "@/lib/apiBase";
import { adminAuthHeaders, adminRequestInit } from "@/lib/adminAuth";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDestructiveModal } from "@/components/admin/ConfirmDestructiveModal";
import { Loader2, TestTube2, Trash2 } from "lucide-react";

function authHeaders(): HeadersInit {
  return adminAuthHeaders({ "Content-Type": "application/json" });
}

type MinimalUser = { id: string; email: string };

type ClearDummyTradesResponse = {
  ok: boolean;
  tradesDeleted: number;
  pnlRecordsDeleted: number;
  commissionLedgersDeleted: number;
};

type InjectTradeResponse = {
  ok: boolean;
  tradeId: string;
  pnlRecordId: string;
  strategyId: string;
  grossPnl: number;
  appRevenue: number;
  profitSharePct: number;
  isDummy: boolean;
  symbol: string;
  commissionsCreated: number;
  commissionsSkipped: number;
  commissionLedger: Array<{
    id: string;
    beneficiaryUserId: string;
    amount: number;
    commissionRate: number;
    status: string;
  }>;
  bookedAfter: {
    grossPnl: number;
    appRevenue: number;
    netEarnedPnl: number;
  };
};

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export default function AdminInjectTradePage() {
  const apiBase = useMemo(() => resolveApiBase(), []);
  const [users, setUsers] = useState<MinimalUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [userId, setUserId] = useState("");
  const [grossPnl, setGrossPnl] = useState("3.42");
  const [symbol, setSymbol] = useState("");
  const [strategyId, setStrategyId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [injectModalOpen, setInjectModalOpen] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalResult, setModalResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [result, setResult] = useState<InjectTradeResponse | null>(null);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch(`${apiBase}/admin/users/list`, { ...adminRequestInit(), headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid users response");
      setUsers(
        (data as Record<string, unknown>[]).map((row) => ({
          id: String(row.id ?? ""),
          email: String(row.email ?? ""),
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoadingUsers(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => setSuccess(null), 6000);
    return () => window.clearTimeout(t);
  }, [success]);

  function openClearModal() {
    setModalError(null);
    setModalResult(null);
    setClearModalOpen(true);
  }

  async function runClearDummyTrades(confirmation: string) {
    setClearing(true);
    setModalError(null);
    setModalResult(null);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`${apiBase}/admin/debug/clear-dummy-trades`, {
        method: "DELETE",
        headers: authHeaders(),
        body: JSON.stringify({ confirmation }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Clear failed (${res.status})`;
        const hint =
          typeof data === "object" &&
          data !== null &&
          "expectedHint" in data &&
          typeof (data as { expectedHint: unknown }).expectedHint === "string"
            ? ` ${(data as { expectedHint: string }).expectedHint}`
            : "";
        throw new Error(msg + hint);
      }
      const cleared = data as ClearDummyTradesResponse;
      setResult(null);
      const msg = `Cleaned up ${cleared.tradesDeleted} trade(s), ${cleared.pnlRecordsDeleted} PnL record(s), and ${cleared.commissionLedgersDeleted} commission row(s).`;
      setModalResult(msg);
      setSuccess(msg);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Failed to clear dummy trades";
      setModalError(message);
      setError(message);
    } finally {
      setClearing(false);
    }
  }

  function openInjectModal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setResult(null);
    setModalError(null);
    setModalResult(null);
    if (!userId.trim()) {
      setError("Select or enter a user ID");
      return;
    }
    const pnl = Number.parseFloat(grossPnl);
    if (!Number.isFinite(pnl)) {
      setError("Enter a valid gross PnL number");
      return;
    }
    setInjectModalOpen(true);
  }

  async function runInjectTrade(confirmation: string) {
    setSubmitting(true);
    setModalError(null);
    setModalResult(null);
    setError(null);
    setSuccess(null);
    setResult(null);
    try {
      const pnl = Number.parseFloat(grossPnl);
      const body: Record<string, string | number> = {
        userId: userId.trim(),
        grossPnl: pnl,
        confirmation,
      };
      if (symbol.trim()) body.symbol = symbol.trim();
      if (strategyId.trim()) body.strategyId = strategyId.trim();

      const res = await fetch(`${apiBase}/admin/debug/inject-trade`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Request failed (${res.status})`;
        const hint =
          typeof data === "object" &&
          data !== null &&
          "expectedHint" in data &&
          typeof (data as { expectedHint: unknown }).expectedHint === "string"
            ? ` ${(data as { expectedHint: string }).expectedHint}`
            : "";
        throw new Error(msg + hint);
      }
      setResult(data as InjectTradeResponse);
      setModalResult("Test trade injected.");
      setSuccess("Test trade injected.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Inject trade failed";
      setModalError(message);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }


  return (
    <div className="space-y-8">
      <header className="flex items-start gap-3">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-300">
          <TestTube2 className="h-6 w-6" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Inject Trade
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-white/55">
            Simulate a closed trade without hitting the exchange. Runs app
            revenue calculation, partner commission distribution, and writes
            flagged dummy rows to Trade and PnLRecord.
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {success}
        </div>
      ) : null}

      <div className="glass-card max-w-xl border border-glassBorder p-6 md:p-8">
        <form onSubmit={openInjectModal} className="space-y-5">
          <label className="block text-sm text-white/70">
            User
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={loadingUsers || submitting}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">Select a user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} ({u.id.slice(0, 8)}…)
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm text-white/70">
            Or paste User ID
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={submitting}
              placeholder="uuid"
              className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 font-mono text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>

          <label className="block text-sm text-white/70">
            Gross PnL (USD)
            <input
              type="number"
              step="any"
              required
              value={grossPnl}
              onChange={(e) => setGrossPnl(e.target.value)}
              disabled={submitting}
              className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>

          <label className="block text-sm text-white/70">
            Symbol <span className="text-white/40">(optional)</span>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              disabled={submitting}
              placeholder="DUMMY-INJECT"
              className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>

          <label className="block text-sm text-white/70">
            Strategy ID <span className="text-white/40">(optional)</span>
            <input
              type="text"
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value)}
              disabled={submitting}
              placeholder="Uses active subscription if empty"
              className="mt-2 w-full rounded-lg border border-glassBorder bg-black/40 px-4 py-3 font-mono text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <TestTube2 className="h-4 w-4" aria-hidden />
            )}
            {submitting ? "Injecting…" : "Submit Dummy Trade"}
          </button>
        </form>

        <div className="mt-8 border-t border-glassBorder pt-6">
          <h2 className="text-sm font-semibold text-red-300">Danger zone</h2>
          <p className="mt-1 text-xs text-white/45">
            Removes every trade flagged as dummy (or with exit reason &quot;Admin
            Dummy Trade&quot;), plus linked PnL and commission ledger rows.
          </p>
          <button
            type="button"
            onClick={() => openClearModal()}
            disabled={submitting || clearing}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/50 bg-red-600/90 px-5 py-3 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {clearing ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden />
            )}
            {clearing ? "Clearing…" : "Clear All Dummy Trades"}
          </button>
        </div>
      </div>

      {result ? (
        <section className="glass-card border border-emerald-500/30 bg-emerald-500/5 p-6">
          <h2 className="text-lg font-semibold text-emerald-200">
            Trade injected successfully
          </h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-white/45">Trade ID</dt>
              <dd className="font-mono text-white/90">{result.tradeId}</dd>
            </div>
            <div>
              <dt className="text-white/45">Strategy</dt>
              <dd className="font-mono text-white/90">{result.strategyId}</dd>
            </div>
            <div>
              <dt className="text-white/45">Gross PnL</dt>
              <dd className="tabular-nums text-white">
                {usdFmt.format(result.grossPnl)}
              </dd>
            </div>
            <div>
              <dt className="text-white/45">App revenue ({result.profitSharePct}%)</dt>
              <dd className="tabular-nums text-amber-200">
                {usdFmt.format(result.appRevenue)}
              </dd>
            </div>
            <div>
              <dt className="text-white/45">Partner commissions</dt>
              <dd className="text-white">
                {result.commissionsCreated} created
                {result.commissionsSkipped > 0
                  ? ` · ${result.commissionsSkipped} skipped`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="text-white/45">Booked after (net)</dt>
              <dd className="tabular-nums text-white">
                {usdFmt.format(result.bookedAfter.netEarnedPnl)}
              </dd>
            </div>
          </dl>
          {result.commissionLedger.length > 0 ? (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="border-b border-white/10 text-white/45">
                  <tr>
                    <th className="py-2 pr-3">Partner</th>
                    <th className="py-2 pr-3">Rate</th>
                    <th className="py-2 pr-3">Amount</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.commissionLedger.map((row) => (
                    <tr key={row.id} className="border-b border-white/5">
                      <td className="py-2 pr-3 font-mono text-white/80">
                        {row.beneficiaryUserId.slice(0, 8)}…
                      </td>
                      <td className="py-2 pr-3 text-white/70">
                        {row.commissionRate}%
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-emerald-300">
                        {usdFmt.format(row.amount)}
                      </td>
                      <td className="py-2 text-white/60">{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      <ConfirmDestructiveModal
        open={injectModalOpen}
        title="Inject test trade"
        description="Creates a dummy trade with PnL and partner commission rows for testing. No exchange orders are placed. Type INJECT TEST TRADE to continue."
        expectedConfirmation="INJECT TEST TRADE"
        confirmButtonText="Inject test trade"
        busy={submitting}
        error={injectModalOpen ? modalError : null}
        result={injectModalOpen ? modalResult : null}
        onClose={() => {
          if (!submitting) setInjectModalOpen(false);
        }}
        onConfirm={(confirmation) => void runInjectTrade(confirmation)}
      />
      <ConfirmDestructiveModal
        open={clearModalOpen}
        title="Clear dummy trades"
        description="Deletes ALL injected dummy trades, their PnL records, and partner commission ledger rows. Real trades are not affected. This cannot be undone."
        expectedConfirmation="CLEAR DUMMY TRADES"
        confirmButtonText="Clear dummy trades"
        busy={clearing}
        error={clearModalOpen ? modalError : null}
        result={clearModalOpen ? modalResult : null}
        onClose={() => {
          if (!clearing) setClearModalOpen(false);
        }}
        onConfirm={(confirmation) => void runClearDummyTrades(confirmation)}
      />
    </div>
  );
}
