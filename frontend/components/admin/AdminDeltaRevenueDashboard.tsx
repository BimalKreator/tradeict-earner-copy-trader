"use client";

import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { adminFetch, buildAdminApiUrl, formatAdminFetchError, formatFetchErrors } from "@/lib/adminAuth";
import { resolveApiBase } from "@/lib/apiBase";
import { fmtUsd } from "@/lib/currency";
import {
  formatIstCalendarDate,
  formatIstMonthYear,
  formatIstSnapshotDay,
  currentIstYearMonth,
} from "@/lib/istDates";
import { ConfirmDestructiveModal } from "@/components/admin/ConfirmDestructiveModal";
import { runSafeRecompute } from "@/components/admin/AdminUserStructureBillingPanel";

const UNMATCHED_AMBER_THRESHOLD = 3;

type OverviewUser = {
  userId: string;
  email: string;
  name: string | null;
  structuresClosed: number;
  realizedPnl: number;
  hwmBefore: number;
  hwmAfter: number;
  billableProfit: number;
  profitSharePct: number;
  commissionAmount: number;
  invoiceStatus: string;
};

type HealthUser = {
  userId: string;
  email: string | null;
  ledgerRowCount: number;
  lastLedgerOccurredAt: string | null;
  lastLedgerSyncAt: string | null;
  structuresMatched: number;
  unmatchedTxnCount: number;
  zeroMatchStructureCount: number;
  overlapCount: number;
};

type DetailInvoice = {
  id: string;
  periodYear: number;
  periodMonth: number;
  realizedPnl: number;
  cumulativeRealizedPnl?: number | null;
  hwmBefore: number;
  hwmAfter: number;
  billableProfit: number;
  profitSharePct: number;
  commissionAmount: number;
  creditNoteAmount?: number | null;
  creditNoteReason?: string | null;
  status: string;
  overlapTxnCount?: number | null;
  suspectStructuresCount?: number | null;
  suspectLossesCountedCount?: number | null;
  suspectLossesCountedAmount?: number | null;
  voidReason?: string | null;
};

type UserDetail = {
  user: { id: string; email: string; name: string | null };
  profitShareOverride: number | null;
  strategyProfitShare: number | null;
  strategyTitle: string | null;
  snapshots: Array<{
    snapshotDate: string;
    cumulativeRealized: number;
    highWaterMark: number;
    realizedDelta: number;
    commissionCumulative: number;
  }>;
  structures: Array<{
    id: string;
    botStructureId: number;
    status: string;
    openedAt: string;
    closedAt: string | null;
    realizedPnl: number | null;
    matchedTxnCount: number;
    grossCashflow?: number;
    commissionTotal?: number;
    fundingTotal?: number;
    settlementTotal?: number;
    liquidationFeeTotal?: number;
    legs: Array<{
      legRole: string;
      symbol: string | null;
      productId: number;
      realizedPnl: number | null;
      matchedTxnCount: number;
      grossCashflow?: number;
      commissionTotal?: number;
      fundingTotal?: number | null;
      settlementTotal?: number | null;
      liquidationFeeTotal?: number | null;
    }>;
  }>;
  invoices: DetailInvoice[];
};

type StructureLedgerPayload = {
  nearbyPadHours: number;
  legs: Array<{
    botLegId: number;
    legRole: string;
    symbol: string | null;
    productId: number;
    matched: Array<{
      deltaUuid: string;
      transactionType: string;
      amount: number;
      occurredAt: string;
      productId: number | null;
      productSymbol: string | null;
    }>;
  }>;
  nearbyUnmatched: Array<{
    deltaUuid: string;
    transactionType: string;
    amount: number;
    occurredAt: string;
    productId: number | null;
    productSymbol: string | null;
  }>;
};

function pnlClass(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-300";
  return "text-white/70";
}

function defaultPeriod(): { year: number; month: number } {
  return currentIstYearMonth();
}

function canVoidInvoice(status: string): boolean {
  return status === "ACCRUED" || status === "INVOICED";
}

function canCreditNote(status: string): boolean {
  return status === "INVOICED" || status === "PAID";
}

const DEFAULT_OPS_PATHS = {
  snapshot: "/admin/revenue/snapshot",
  invoice: "/admin/revenue/invoice",
  structurePnlRecompute: "/admin/structure-pnl/recompute",
  issueConfirmation: "ISSUE INVOICE",
} as const;

const OPS_TIMEOUT_MS = 120_000;

type OpsPaths = {
  snapshot: string;
  invoice: string;
  structurePnlRecompute: string;
  issueConfirmation: string;
};

type OpsBusy =
  | null
  | "snapshot"
  | "invoice"
  | "structure"
  | `row-invoice:${string}`;

function summarizeOpsResults(
  label: string,
  results: Record<string, unknown> | undefined,
  verb: string,
): string {
  const n = results ? Object.keys(results).length : 0;
  const userWord = n === 1 ? "user" : "users";
  return `${label}: ${n} ${userWord} ${verb}`;
}

async function postAdminOps(
  path: string,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; results: Record<string, unknown>; issued?: number }
  | { ok: false; error: string }
> {
  const res = await adminFetch(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    OPS_TIMEOUT_MS,
  );
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    expectedHint?: string;
    results?: Record<string, unknown>;
    issued?: number;
  };
  if (!res.ok) {
    return {
      ok: false,
      error:
        (payload.error ??
          formatAdminFetchError("ops", res, buildAdminApiUrl(path))) +
        (payload.expectedHint ? ` ${payload.expectedHint}` : ""),
    };
  }
  return {
    ok: true,
    results: payload.results ?? {},
    ...(typeof payload.issued === "number" ? { issued: payload.issued } : {}),
  };
}

export function AdminDeltaRevenueDashboard({
  opsPaths = DEFAULT_OPS_PATHS,
}: {
  opsPaths?: OpsPaths;
} = {}) {
  const [period, setPeriod] = useState(defaultPeriod);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<OverviewUser[]>([]);
  const [totals, setTotals] = useState({
    structuresClosed: 0,
    realizedPnl: 0,
    billableProfit: 0,
    commissionAmount: 0,
  });
  const [health, setHealth] = useState<HealthUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [overrideInput, setOverrideInput] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);
  const [expandedWhyId, setExpandedWhyId] = useState<string | null>(null);
  const [invoiceSidePanel, setInvoiceSidePanel] = useState<{
    invoiceId: string;
    kind: "commissions" | "history";
    loading: boolean;
    error: string | null;
    data: unknown;
  } | null>(null);
  const [voidModal, setVoidModal] = useState<{
    invoice: DetailInvoice;
    reason: string;
  } | null>(null);
  const [creditModal, setCreditModal] = useState<{
    invoice: DetailInvoice;
    amount: string;
    reason: string;
  } | null>(null);
  const [invoiceActionBusy, setInvoiceActionBusy] = useState(false);
  const [invoiceActionError, setInvoiceActionError] = useState<string | null>(null);
  const [invoiceActionResult, setInvoiceActionResult] = useState<string | null>(null);
  const [safeRecomputeUserId, setSafeRecomputeUserId] = useState<string | null>(null);
  const [structureFocus, setStructureFocus] = useState<"unmatched" | "overlap" | null>(
    null,
  );
  const [expandedStructureLedgerId, setExpandedStructureLedgerId] = useState<
    string | null
  >(null);
  const [structureLedgers, setStructureLedgers] = useState<
    Record<string, StructureLedgerPayload>
  >({});
  const [structureLedgerLoading, setStructureLedgerLoading] = useState<string | null>(
    null,
  );
  const [opsBusy, setOpsBusy] = useState<OpsBusy>(null);
  const [opsMessage, setOpsMessage] = useState<string | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsSnapshotUserId, setOpsSnapshotUserId] = useState("");
  const [opsSnapshotDate, setOpsSnapshotDate] = useState("");
  const [opsInvoiceUserId, setOpsInvoiceUserId] = useState("");
  const [opsInvoiceYear, setOpsInvoiceYear] = useState(period.year);
  const [opsInvoiceMonth, setOpsInvoiceMonth] = useState(period.month);
  const [opsIssueAlso, setOpsIssueAlso] = useState(false);
  const [issueConfirmOpen, setIssueConfirmOpen] = useState(false);
  const [issueConfirmError, setIssueConfirmError] = useState<string | null>(null);
  const [opsStructureUserId, setOpsStructureUserId] = useState("");

  useEffect(() => {
    setOpsInvoiceYear(period.year);
    setOpsInvoiceMonth(period.month);
  }, [period.year, period.month]);

  const loadOverview = useCallback(async () => {
    if (!resolveApiBase()) return;
    setLoading(true);
    setError(null);
    try {
      const overviewPath = `/admin/revenue/overview?year=${period.year}&month=${period.month}`;
      const healthPath = "/admin/revenue/health";
      const [ovRes, hRes] = await Promise.all([
        adminFetch(overviewPath),
        adminFetch(healthPath),
      ]);
      const failures: Array<{ label: string; res: Response; url: string }> = [];
      if (!ovRes.ok) {
        failures.push({
          label: "overview",
          res: ovRes,
          url: buildAdminApiUrl(overviewPath),
        });
      }
      if (!hRes.ok) {
        failures.push({
          label: "health",
          res: hRes,
          url: buildAdminApiUrl(healthPath),
        });
      }
      if (failures.length > 0) {
        throw new Error(formatFetchErrors(failures));
      }
      const ov = (await ovRes.json()) as {
        users: OverviewUser[];
        totals: typeof totals;
      };
      const h = (await hRes.json()) as { users: HealthUser[] };
      setUsers(ov.users ?? []);
      setTotals(ov.totals ?? totals);
      setHealth(h.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [period.month, period.year]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadDetail = useCallback(async (userId: string) => {
    if (!resolveApiBase()) return;
    setDetailLoading(true);
    try {
      const detailPath = `/admin/revenue/user/${userId}`;
      const res = await adminFetch(detailPath);
      if (!res.ok) {
        throw new Error(formatAdminFetchError("user detail", res, buildAdminApiUrl(detailPath)));
      }
      const data = (await res.json()) as UserDetail;
      setDetail(data);
      setOverrideInput(
        data.profitShareOverride != null ? String(data.profitShareOverride) : "",
      );
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedUserId) void loadDetail(selectedUserId);
    else setDetail(null);
  }, [selectedUserId, loadDetail]);

  const healthByUser = useMemo(
    () => new Map(health.map((h) => [h.userId, h])),
    [health],
  );

  const userOptions = useMemo(() => {
    const byId = new Map<string, { userId: string; label: string }>();
    for (const u of users) {
      byId.set(u.userId, {
        userId: u.userId,
        label: u.email || u.name || u.userId.slice(0, 8),
      });
    }
    for (const h of health) {
      if (byId.has(h.userId)) continue;
      byId.set(h.userId, {
        userId: h.userId,
        label: h.email ?? h.userId.slice(0, 8),
      });
    }
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [users, health]);

  const chartData = useMemo(
    () =>
      (detail?.snapshots ?? []).map((s) => ({
        day: formatIstSnapshotDay(s.snapshotDate),
        cumulativeRealized: s.cumulativeRealized,
        highWaterMark: s.highWaterMark,
        hwmGap: Math.max(0, s.highWaterMark - s.cumulativeRealized),
      })),
    [detail],
  );

  async function saveOverride() {
    if (!selectedUserId || !resolveApiBase()) return;
    setSavingOverride(true);
    try {
      const val = overrideInput.trim();
      const body =
        val === ""
          ? { profitShareOverride: null }
          : { profitShareOverride: parseFloat(val) };
      const overridePath = `/admin/revenue/user/${selectedUserId}/profit-share`;
      const res = await adminFetch(overridePath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(formatAdminFetchError("profit share", res, buildAdminApiUrl(overridePath)));
      }
      await loadDetail(selectedUserId);
      await loadOverview();
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleSafeRecompute(userId: string) {
    setSafeRecomputeUserId(userId);
    try {
      await runSafeRecompute(userId);
      await loadOverview();
      if (selectedUserId === userId) await loadDetail(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Safe recompute failed");
    } finally {
      setSafeRecomputeUserId(null);
    }
  }

  async function runSnapshot() {
    const userId = opsSnapshotUserId.trim();
    if (!userId) {
      const ok = window.confirm("Run snapshot for all users?");
      if (!ok) return;
    }
    setOpsBusy("snapshot");
    setOpsMessage(null);
    setOpsError(null);
    try {
      const body: Record<string, unknown> = {};
      if (userId) body.userId = userId;
      if (opsSnapshotDate.trim()) body.date = opsSnapshotDate.trim();
      const result = await postAdminOps(opsPaths.snapshot, body);
      if (!result.ok) {
        setOpsError(result.error);
        return;
      }
      setOpsMessage(
        summarizeOpsResults("Snapshot", result.results, "processed"),
      );
      await loadOverview();
    } catch (err) {
      setOpsError(err instanceof Error ? err.message : "Snapshot failed");
    } finally {
      setOpsBusy(null);
    }
  }

  async function runComputeInvoice(opts?: {
    userId?: string;
    year?: number;
    month?: number;
    busyKey?: OpsBusy;
    /** When set, forces issue flag (row actions = compute only). */
    issue?: boolean;
    confirmation?: string;
  }) {
    const userId = (opts?.userId ?? opsInvoiceUserId).trim();
    const year = opts?.year ?? opsInvoiceYear;
    const month = opts?.month ?? opsInvoiceMonth;
    const wantIssue = opts?.issue ?? opsIssueAlso;

    if (wantIssue && !opts?.confirmation) {
      setIssueConfirmError(null);
      setIssueConfirmOpen(true);
      return;
    }

    if (!userId && !opts?.userId && !wantIssue) {
      const ok = window.confirm(
        `Compute monthly invoice for all users (${formatIstMonthYear(month, year)})?`,
      );
      if (!ok) return;
    }

    setOpsBusy(opts?.busyKey ?? "invoice");
    setOpsMessage(null);
    setOpsError(null);
    setIssueConfirmError(null);
    try {
      const body: Record<string, unknown> = {
        year,
        month,
        issue: wantIssue,
      };
      if (userId) body.userId = userId;
      if (wantIssue && opts?.confirmation) {
        body.confirmation = opts.confirmation;
      }
      const result = await postAdminOps(opsPaths.invoice, body);
      if (!result.ok) {
        if (issueConfirmOpen) {
          setIssueConfirmError(result.error);
        } else {
          setOpsError(result.error);
        }
        return;
      }
      const processed = summarizeOpsResults(
        "Invoice",
        result.results,
        "processed",
      );
      const issuedMsg =
        typeof result.issued === "number"
          ? ` · ${result.issued} invoice${result.issued === 1 ? "" : "s"} issued (ACCRUED → INVOICED)`
          : wantIssue
            ? " · issue requested"
            : "";
      setOpsMessage(`${processed}${issuedMsg}`);
      setIssueConfirmOpen(false);
      await loadOverview();
      if (userId && selectedUserId === userId) await loadDetail(userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invoice compute failed";
      if (issueConfirmOpen) setIssueConfirmError(msg);
      else setOpsError(msg);
    } finally {
      setOpsBusy(null);
    }
  }

  async function runStructureRecompute() {
    const userId = opsStructureUserId.trim();
    if (!userId) {
      const ok = window.confirm("Recompute structure P&L for all users?");
      if (!ok) return;
    }
    setOpsBusy("structure");
    setOpsMessage(null);
    setOpsError(null);
    try {
      const body: Record<string, unknown> = {};
      if (userId) body.userId = userId;
      const result = await postAdminOps(opsPaths.structurePnlRecompute, body);
      if (!result.ok) {
        setOpsError(result.error);
        return;
      }
      setOpsMessage(
        summarizeOpsResults("Structure P&L", result.results, "recomputed"),
      );
      await loadOverview();
      if (userId && selectedUserId === userId) await loadDetail(userId);
    } catch (err) {
      setOpsError(
        err instanceof Error ? err.message : "Structure P&L recompute failed",
      );
    } finally {
      setOpsBusy(null);
    }
  }

  async function loadInvoiceSide(
    invoiceId: string,
    kind: "commissions" | "history",
  ) {
    setInvoiceSidePanel({ invoiceId, kind, loading: true, error: null, data: null });
    try {
      const path =
        kind === "commissions"
          ? `/admin/revenue/invoice/${invoiceId}/commissions`
          : `/admin/revenue/invoice/${invoiceId}/ledger`;
      const res = await adminFetch(path);
      if (!res.ok) {
        throw new Error(formatAdminFetchError(kind, res, buildAdminApiUrl(path)));
      }
      const data: unknown = await res.json();
      setInvoiceSidePanel({ invoiceId, kind, loading: false, error: null, data });
    } catch (err) {
      setInvoiceSidePanel({
        invoiceId,
        kind,
        loading: false,
        error: err instanceof Error ? err.message : "Load failed",
        data: null,
      });
    }
  }

  async function toggleStructureLedger(structurePnlId: string) {
    if (expandedStructureLedgerId === structurePnlId) {
      setExpandedStructureLedgerId(null);
      return;
    }
    setExpandedStructureLedgerId(structurePnlId);
    if (structureLedgers[structurePnlId]) return;
    setStructureLedgerLoading(structurePnlId);
    try {
      const path = `/admin/revenue/structure/${structurePnlId}/ledger`;
      const res = await adminFetch(path);
      if (!res.ok) {
        throw new Error(formatAdminFetchError("structure ledger", res, buildAdminApiUrl(path)));
      }
      const data = (await res.json()) as StructureLedgerPayload;
      setStructureLedgers((prev) => ({ ...prev, [structurePnlId]: data }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ledger");
      setExpandedStructureLedgerId(null);
    } finally {
      setStructureLedgerLoading(null);
    }
  }

  async function confirmVoid(confirmation: string) {
    if (!voidModal || !selectedUserId) return;
    setInvoiceActionBusy(true);
    setInvoiceActionError(null);
    setInvoiceActionResult(null);
    try {
      const path = `/admin/revenue/invoice/${voidModal.invoice.id}/status`;
      const res = await adminFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "VOID",
          reason: voidModal.reason.trim(),
          confirmation,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        expectedHint?: string;
      };
      if (!res.ok) {
        throw new Error(
          (body.error ?? formatAdminFetchError("void", res, buildAdminApiUrl(path))) +
            (body.expectedHint ? ` ${body.expectedHint}` : ""),
        );
      }
      setInvoiceActionResult("Invoice voided.");
      await loadDetail(selectedUserId);
      await loadOverview();
    } catch (err) {
      setInvoiceActionError(err instanceof Error ? err.message : "Void failed");
    } finally {
      setInvoiceActionBusy(false);
    }
  }

  async function confirmCreditNote(confirmation: string) {
    if (!creditModal || !selectedUserId) return;
    setInvoiceActionBusy(true);
    setInvoiceActionError(null);
    setInvoiceActionResult(null);
    try {
      const path = `/admin/revenue/invoice/${creditModal.invoice.id}/credit-note`;
      const res = await adminFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(creditModal.amount),
          reason: creditModal.reason.trim(),
          confirmation,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        expectedHint?: string;
      };
      if (!res.ok) {
        throw new Error(
          (body.error ?? formatAdminFetchError("credit note", res, buildAdminApiUrl(path))) +
            (body.expectedHint ? ` ${body.expectedHint}` : ""),
        );
      }
      setInvoiceActionResult("Credit note applied.");
      await loadDetail(selectedUserId);
      await loadOverview();
    } catch (err) {
      setInvoiceActionError(err instanceof Error ? err.message : "Credit note failed");
    } finally {
      setInvoiceActionBusy(false);
    }
  }

  function openUserFromHealth(
    userId: string,
    focus: "unmatched" | "overlap" | null,
  ) {
    setStructureFocus(focus);
    setSelectedUserId(userId);
  }

  if (selectedUserId && detail) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <button
          type="button"
          onClick={() => {
            setSelectedUserId(null);
            setStructureFocus(null);
          }}
          className="inline-flex items-center gap-1 text-sm text-white/60 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" /> Back to overview
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-white">{detail.user.email}</h1>
          <p className="text-sm text-white/50">
            Strategy: {detail.strategyTitle ?? "—"} · default share{" "}
            {detail.strategyProfitShare ?? 0}%
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="text-sm font-medium text-white">Profit share override</p>
          <p className="mt-1 text-xs text-white/45">
            Per-user override (null = use strategy default). Applied on next invoice
            recompute.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              type="number"
              step="0.1"
              min="0"
              placeholder="Strategy default"
              value={overrideInput}
              onChange={(e) => setOverrideInput(e.target.value)}
              className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
            />
            <button
              type="button"
              disabled={savingOverride}
              onClick={() => void saveOverride()}
              className="rounded-lg bg-[#0A84FF] px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {savingOverride ? "Saving…" : "Save override"}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 p-4">
          <h2 className="mb-3 text-lg font-medium text-white">Daily cumulative (IST)</h2>
          {detailLoading ? (
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-white/30" />
          ) : chartData.length === 0 ? (
            <p className="text-sm text-white/45">No snapshots yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis dataKey="day" tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }} />
                <Tooltip />
                <Area dataKey="cumulativeRealized" stackId="h" fill="transparent" stroke="none" />
                <Area dataKey="hwmGap" stackId="h" fill="rgba(251,191,36,0.12)" stroke="none" />
                <Line dataKey="cumulativeRealized" stroke="#34d399" dot={false} />
                <Line type="stepAfter" dataKey="highWaterMark" stroke="#0A84FF" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-medium text-white">Invoices</h2>
          {detail.invoices.length === 0 ? (
            <p className="text-sm text-white/45">No invoices yet.</p>
          ) : (
            <div className="space-y-3">
              {detail.invoices.map((inv) => {
                const whyOpen = expandedWhyId === inv.id;
                const freePortion = Math.max(0, inv.realizedPnl - inv.billableProfit);
                return (
                  <div
                    key={inv.id}
                    className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-white">
                          {formatIstMonthYear(inv.periodMonth, inv.periodYear)} ·{" "}
                          {inv.status}
                        </p>
                        <p className="mt-0.5 text-xs text-white/45">
                          Billable {fmtUsd(inv.billableProfit)} · Share{" "}
                          {inv.profitSharePct.toFixed(1)}% · Commission{" "}
                          {fmtUsd(inv.commissionAmount)}
                          {(inv.overlapTxnCount ?? 0) > 0
                            ? ` · Overlaps ${inv.overlapTxnCount}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedWhyId(whyOpen ? null : inv.id)
                          }
                          className="rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/5"
                        >
                          Why this amount?
                        </button>
                        <button
                          type="button"
                          onClick={() => void loadInvoiceSide(inv.id, "commissions")}
                          className="rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/5"
                        >
                          Commissions
                        </button>
                        <button
                          type="button"
                          onClick={() => void loadInvoiceSide(inv.id, "history")}
                          className="rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/5"
                        >
                          History
                        </button>
                        {canCreditNote(inv.status) ? (
                          <button
                            type="button"
                            onClick={() => {
                              setInvoiceActionError(null);
                              setInvoiceActionResult(null);
                              setCreditModal({
                                invoice: inv,
                                amount: "",
                                reason: "",
                              });
                            }}
                            className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-100"
                          >
                            Credit note
                          </button>
                        ) : null}
                        {canVoidInvoice(inv.status) ? (
                          <button
                            type="button"
                            onClick={() => {
                              setInvoiceActionError(null);
                              setInvoiceActionResult(null);
                              setVoidModal({ invoice: inv, reason: "" });
                            }}
                            className="rounded border border-red-500/40 bg-red-500/15 px-2 py-1 text-[11px] text-red-100"
                          >
                            Void
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {whyOpen ? (
                      <div className="mt-3 space-y-1 rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/70">
                        <div className="flex justify-between gap-4">
                          <span>Realized P&amp;L (realizedPnl)</span>
                          <span className="tabular-nums">{fmtUsd(inv.realizedPnl)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>HWM before (hwmBefore)</span>
                          <span className="tabular-nums">{fmtUsd(inv.hwmBefore)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>HWM after (hwmAfter)</span>
                          <span className="tabular-nums">{fmtUsd(inv.hwmAfter)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Billable (billableProfit)</span>
                          <span className="tabular-nums">{fmtUsd(inv.billableProfit)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Free portion (above HWM not billed)</span>
                          <span className="tabular-nums">{fmtUsd(freePortion)}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Share % (profitSharePct)</span>
                          <span className="tabular-nums">
                            {inv.profitSharePct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Commission (commissionAmount)</span>
                          <span className="tabular-nums">
                            {fmtUsd(inv.commissionAmount)}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Credit note</span>
                          <span className="tabular-nums">
                            {inv.creditNoteAmount != null
                              ? `${fmtUsd(inv.creditNoteAmount)}${
                                  inv.creditNoteReason
                                    ? ` — ${inv.creditNoteReason}`
                                    : ""
                                }`
                              : "—"}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Suspect structures / losses counted</span>
                          <span className="tabular-nums">
                            {inv.suspectStructuresCount ?? 0} /{" "}
                            {inv.suspectLossesCountedCount ?? 0}
                            {inv.suspectLossesCountedAmount != null
                              ? ` (${fmtUsd(inv.suspectLossesCountedAmount)})`
                              : ""}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>Overlap txn count</span>
                          <span
                            className={`tabular-nums ${
                              (inv.overlapTxnCount ?? 0) > 0 ? "text-red-300" : ""
                            }`}
                          >
                            {inv.overlapTxnCount ?? 0}
                          </span>
                        </div>
                        {inv.voidReason ? (
                          <div className="flex justify-between gap-4 text-red-200/90">
                            <span>Void reason</span>
                            <span>{inv.voidReason}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {invoiceSidePanel?.invoiceId === inv.id ? (
                      <div className="mt-3 rounded border border-white/10 bg-black/40 p-3 text-xs">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="font-medium text-white/80">
                            {invoiceSidePanel.kind === "commissions"
                              ? "Commissions"
                              : "Invoice history"}
                          </p>
                          <button
                            type="button"
                            className="text-white/40 hover:text-white"
                            onClick={() => setInvoiceSidePanel(null)}
                          >
                            Close
                          </button>
                        </div>
                        {invoiceSidePanel.loading ? (
                          <Loader2 className="h-4 w-4 animate-spin text-white/30" />
                        ) : invoiceSidePanel.error ? (
                          <p className="text-amber-200">{invoiceSidePanel.error}</p>
                        ) : (
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-white/65">
                            {JSON.stringify(invoiceSidePanel.data, null, 2)}
                          </pre>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-2" id="admin-revenue-structures">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium text-white">Structures</h2>
            {structureFocus ? (
              <p className="text-xs text-amber-200">
                Focus: {structureFocus === "unmatched" ? "unmatched txns" : "overlap legs"} —
                open ledger rows on structures below.
              </p>
            ) : null}
          </div>
          {detail.structures.map((s) => {
            const highlightZero =
              structureFocus === "unmatched" && s.matchedTxnCount === 0;
            const highlightOverlap =
              structureFocus === "overlap" && s.matchedTxnCount > 0;
            const ledgerOpen = expandedStructureLedgerId === s.id;
            const ledger = structureLedgers[s.id];
            return (
            <div
              key={s.id}
              className={`rounded-lg border px-4 py-3 text-sm ${
                highlightZero || highlightOverlap
                  ? "border-amber-500/40 bg-amber-500/[0.06]"
                  : "border-white/10"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex justify-between gap-4 flex-1">
                  <span>
                    #{s.botStructureId} · {s.status} · {formatIstCalendarDate(s.openedAt)}
                    {s.closedAt ? ` → ${formatIstCalendarDate(s.closedAt)}` : ""}
                  </span>
                  <span className={pnlClass(s.realizedPnl ?? 0)}>
                    {s.realizedPnl != null ? fmtUsd(s.realizedPnl) : "—"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void toggleStructureLedger(s.id)}
                  className="inline-flex items-center gap-1 rounded border border-sky-500/35 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-100"
                >
                  {structureLedgerLoading === s.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : ledgerOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Show ledger rows
                </button>
              </div>
              <p className="mt-1 text-xs text-white/40">
                {s.legs.length} legs · {s.matchedTxnCount} matched txns
                {" · "}
                cash {fmtUsd(s.grossCashflow ?? 0)}
                {" · "}
                fee {fmtUsd(s.commissionTotal ?? 0)}
                {" · "}
                funding {fmtUsd(s.fundingTotal ?? 0)}
                {" · "}
                settlement {fmtUsd(s.settlementTotal ?? 0)}
                {" · "}
                liq {fmtUsd(s.liquidationFeeTotal ?? 0)}
              </p>
              {ledgerOpen && ledger ? (
                <div className="mt-2 space-y-2 rounded border border-white/10 bg-black/30 p-2 text-[11px]">
                  {ledger.legs.map((leg) => (
                    <div key={leg.botLegId}>
                      <p className="text-white/60">
                        {leg.legRole}
                        {leg.symbol ? ` · ${leg.symbol}` : ""} · {leg.matched.length}{" "}
                        matched
                      </p>
                      <ul className="mt-1 space-y-0.5 text-white/50">
                        {leg.matched.slice(0, 20).map((r) => (
                          <li key={r.deltaUuid} className="font-mono">
                            {r.transactionType} {fmtUsd(r.amount)} ·{" "}
                            {r.deltaUuid.slice(0, 10)}…
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <p className="text-amber-200/80">
                    Nearby unmatched ({ledger.nearbyUnmatched.length}) ±
                    {ledger.nearbyPadHours}h
                  </p>
                  <ul className="space-y-0.5 text-white/50">
                    {ledger.nearbyUnmatched.slice(0, 30).map((r) => (
                      <li key={r.deltaUuid} className="font-mono">
                        {r.transactionType} {fmtUsd(r.amount)} · product{" "}
                        {r.productId ?? "—"} · {r.deltaUuid.slice(0, 10)}…
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {s.legs.length > 0 ? (
                <div className="mt-2 overflow-x-auto rounded border border-white/5">
                  <table className="w-full min-w-[640px] text-left text-xs text-white/70">
                    <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wide text-white/35">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Leg</th>
                        <th className="px-2 py-1.5 font-medium">Cashflow</th>
                        <th className="px-2 py-1.5 font-medium">Commission</th>
                        <th className="px-2 py-1.5 font-medium">Funding</th>
                        <th className="px-2 py-1.5 font-medium">Settlement</th>
                        <th className="px-2 py-1.5 font-medium">Liq fee</th>
                        <th className="px-2 py-1.5 font-medium">Realized</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {s.legs.map((leg, idx) => (
                        <tr key={`${s.botStructureId}-${leg.productId}-${idx}`}>
                          <td className="px-2 py-1.5">
                            {leg.legRole}
                            {leg.symbol ? ` · ${leg.symbol}` : ""}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.grossCashflow ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.commissionTotal ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.fundingTotal ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.settlementTotal ?? 0)}
                          </td>
                          <td className="px-2 py-1.5 tabular-nums">
                            {fmtUsd(leg.liquidationFeeTotal ?? 0)}
                          </td>
                          <td
                            className={`px-2 py-1.5 tabular-nums ${pnlClass(leg.realizedPnl ?? 0)}`}
                          >
                            {leg.realizedPnl != null
                              ? fmtUsd(leg.realizedPnl)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          );
          })}
        </div>

        <ConfirmDestructiveModal
          open={voidModal != null}
          title="Void invoice"
          description={`Void ${
            voidModal
              ? formatIstMonthYear(
                  voidModal.invoice.periodMonth,
                  voidModal.invoice.periodYear,
                )
              : ""
          } invoice (${voidModal?.invoice.status ?? ""}). Commissions reverse per lifecycle rules. Type the customer email to confirm.`}
          expectedConfirmation={detail.user.email}
          customerEmail={detail.user.email}
          confirmButtonText="Void invoice"
          busy={invoiceActionBusy}
          error={invoiceActionError}
          result={invoiceActionResult}
          onClose={() => {
            if (!invoiceActionBusy) setVoidModal(null);
          }}
          onConfirm={(confirmation) => {
            if (!voidModal?.reason.trim()) {
              setInvoiceActionError("Reason is required");
              return;
            }
            void confirmVoid(confirmation);
          }}
        />
        {voidModal ? (
          <div className="fixed bottom-4 left-1/2 z-[60] w-full max-w-md -translate-x-1/2 rounded-lg border border-white/15 bg-zinc-900 p-3 shadow-xl">
            <label className="block text-xs text-white/60">
              Void reason
              <input
                value={voidModal.reason}
                onChange={(e) =>
                  setVoidModal({ ...voidModal, reason: e.target.value })
                }
                className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-1.5 text-sm text-white"
              />
            </label>
          </div>
        ) : null}

        <ConfirmDestructiveModal
          open={creditModal != null}
          title="Apply credit note"
          description={`Credit note on ${
            creditModal
              ? formatIstMonthYear(
                  creditModal.invoice.periodMonth,
                  creditModal.invoice.periodYear,
                )
              : ""
          } reduces collectible amount (max ${fmtUsd(
            creditModal?.invoice.commissionAmount ?? 0,
          )}). Type the customer email to confirm.`}
          expectedConfirmation={detail.user.email}
          customerEmail={detail.user.email}
          confirmButtonText="Apply credit note"
          busy={invoiceActionBusy}
          error={invoiceActionError}
          result={invoiceActionResult}
          onClose={() => {
            if (!invoiceActionBusy) setCreditModal(null);
          }}
          onConfirm={(confirmation) => {
            if (!creditModal?.reason.trim()) {
              setInvoiceActionError("Reason is required");
              return;
            }
            const amt = Number(creditModal?.amount);
            if (!Number.isFinite(amt) || amt <= 0) {
              setInvoiceActionError("Amount must be a positive number");
              return;
            }
            void confirmCreditNote(confirmation);
          }}
        />
        {creditModal ? (
          <div className="fixed bottom-4 left-1/2 z-[60] w-full max-w-md -translate-x-1/2 space-y-2 rounded-lg border border-white/15 bg-zinc-900 p-3 shadow-xl">
            <label className="block text-xs text-white/60">
              Credit amount (USD)
              <input
                type="number"
                step="0.01"
                min="0"
                value={creditModal.amount}
                onChange={(e) =>
                  setCreditModal({ ...creditModal, amount: e.target.value })
                }
                className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-1.5 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-white/60">
              Reason
              <input
                value={creditModal.reason}
                onChange={(e) =>
                  setCreditModal({ ...creditModal, reason: e.target.value })
                }
                className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-1.5 text-sm text-white"
              />
            </label>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[#0A84FF]">
            <ShieldCheck className="h-5 w-5" />
            <span className="text-sm uppercase tracking-wide">Admin</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-white">Revenue (Delta)</h1>
          <p className="mt-1 text-sm text-white/50">
            From customer Delta ledger → structure P&L → monthly invoices. Not bot MTM.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={period.month}
            onChange={(e) =>
              setPeriod((p) => ({ ...p, month: parseInt(e.target.value, 10) }))
            }
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {formatIstMonthYear(m, period.year)}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={period.year}
            onChange={(e) =>
              setPeriod((p) => ({ ...p, year: parseInt(e.target.value, 10) || p.year }))
            }
            className="w-24 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white"
          />
          <button
            type="button"
            onClick={() => void loadOverview()}
            className="rounded-lg border border-white/15 p-2 text-white/70 hover:bg-white/5"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <p className="text-xs text-white/40">
        Legacy bot-reported view:{" "}
        <Link href="/admin/revenue" className="text-[#0A84FF] underline">
          Revenue Analytics (legacy)
        </Link>
      </p>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4">
        <div>
          <h2 className="text-sm font-medium text-white">Operations</h2>
          <p className="mt-1 text-xs text-white/45">
            Manually run daily snapshot, monthly invoice compute, or structure P&amp;L
            recompute when cron has not caught up.
          </p>
        </div>

        {opsMessage ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
            {opsMessage}
          </div>
        ) : null}
        {opsError ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {opsError}
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-2 rounded-lg border border-white/10 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-white/50">
              Run daily snapshot
            </p>
            <label className="block text-xs text-white/45">
              User (optional)
              <select
                value={opsSnapshotUserId}
                onChange={(e) => setOpsSnapshotUserId(e.target.value)}
                disabled={opsBusy != null}
                className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-sm text-white"
              >
                <option value="">All eligible users</option>
                {userOptions.map((u) => (
                  <option key={u.userId} value={u.userId}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-white/45">
              Date (optional, blank = previous IST day)
              <input
                type="date"
                value={opsSnapshotDate}
                onChange={(e) => setOpsSnapshotDate(e.target.value)}
                disabled={opsBusy != null}
                className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-sm text-white"
              />
            </label>
            <button
              type="button"
              disabled={opsBusy != null}
              onClick={() => void runSnapshot()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#0A84FF] px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {opsBusy === "snapshot" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Run snapshot
            </button>
          </div>

          <div className="space-y-2 rounded-lg border border-white/10 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-white/50">
              Compute monthly invoice
            </p>
            <div className="flex gap-2">
              <label className="block flex-1 text-xs text-white/45">
                Year
                <input
                  type="number"
                  value={opsInvoiceYear}
                  onChange={(e) =>
                    setOpsInvoiceYear(parseInt(e.target.value, 10) || period.year)
                  }
                  disabled={opsBusy != null}
                  className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-sm text-white"
                />
              </label>
              <label className="block flex-1 text-xs text-white/45">
                Month
                <select
                  value={opsInvoiceMonth}
                  onChange={(e) =>
                    setOpsInvoiceMonth(parseInt(e.target.value, 10))
                  }
                  disabled={opsBusy != null}
                  className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-sm text-white"
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-xs text-white/45">
              User (optional)
              <select
                value={opsInvoiceUserId}
                onChange={(e) => setOpsInvoiceUserId(e.target.value)}
                disabled={opsBusy != null}
                className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-sm text-white"
              >
                <option value="">All eligible users</option>
                {userOptions.map((u) => (
                  <option key={u.userId} value={u.userId}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-start gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={opsIssueAlso}
                onChange={(e) => setOpsIssueAlso(e.target.checked)}
                disabled={opsBusy != null}
                className="mt-0.5 rounded border-white/30"
              />
              <span>
                Also issue (ACCRUED → INVOICED)
                <span className="mt-0.5 block text-[11px] text-white/40">
                  Freezes INR amount and USD/INR rate; creates partner commissions.
                </span>
              </span>
            </label>
            <button
              type="button"
              disabled={opsBusy != null}
              onClick={() => void runComputeInvoice()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#0A84FF] px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {opsBusy === "invoice" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {opsIssueAlso ? "Compute & issue invoice" : "Compute invoice"}
            </button>
          </div>

          <div className="space-y-2 rounded-lg border border-white/10 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-white/50">
              Recompute structure P&amp;L
            </p>
            <label className="block text-xs text-white/45">
              User (optional)
              <select
                value={opsStructureUserId}
                onChange={(e) => setOpsStructureUserId(e.target.value)}
                disabled={opsBusy != null}
                className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-sm text-white"
              >
                <option value="">All eligible users</option>
                {userOptions.map((u) => (
                  <option key={u.userId} value={u.userId}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={opsBusy != null}
              onClick={() => void runStructureRecompute()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#0A84FF] px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {opsBusy === "structure" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Recompute structures
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-white/10 overflow-hidden">
        <h2 className="border-b border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-white">
          Pipeline health
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] text-left text-sm">
            <thead className="text-xs uppercase text-white/40">
              <tr>
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Ledger rows</th>
                <th className="px-4 py-2">Last txn (IST)</th>
                <th className="px-4 py-2">Last sync</th>
                <th className="px-4 py-2">Unmatched</th>
                <th className="px-4 py-2">Zero-match</th>
                <th className="px-4 py-2">Overlap</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {health.map((h) => {
                const unmatchedWarn = h.unmatchedTxnCount >= UNMATCHED_AMBER_THRESHOLD;
                const zeroMatchBad = h.zeroMatchStructureCount > 0;
                const overlapBad = h.overlapCount > 0;
                const hasIssue = unmatchedWarn || zeroMatchBad || overlapBad;
                return (
                  <tr key={h.userId} className="text-white/80">
                    <td className="px-4 py-2">{h.email ?? h.userId.slice(0, 8)}</td>
                    <td className="px-4 py-2 tabular-nums">{h.ledgerRowCount}</td>
                    <td className="px-4 py-2 text-xs">
                      {h.lastLedgerOccurredAt
                        ? formatIstCalendarDate(h.lastLedgerOccurredAt)
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {h.lastLedgerSyncAt
                        ? formatIstCalendarDate(h.lastLedgerSyncAt)
                        : "—"}
                    </td>
                    <td
                      className={`px-4 py-2 tabular-nums ${unmatchedWarn ? "text-amber-300" : ""}`}
                    >
                      {h.unmatchedTxnCount}
                    </td>
                    <td
                      className={`px-4 py-2 tabular-nums ${zeroMatchBad ? "text-red-300 font-medium" : ""}`}
                    >
                      {h.zeroMatchStructureCount}
                    </td>
                    <td
                      className={`px-4 py-2 tabular-nums ${overlapBad ? "text-red-300 font-medium" : ""}`}
                    >
                      {h.overlapCount}
                    </td>
                    <td className="px-4 py-2">
                      {hasIssue ? (
                        <div className="flex flex-wrap gap-1">
                          {zeroMatchBad ? (
                            <button
                              type="button"
                              disabled={safeRecomputeUserId === h.userId}
                              onClick={() => void handleSafeRecompute(h.userId)}
                              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-100 disabled:opacity-50"
                            >
                              {safeRecomputeUserId === h.userId
                                ? "…"
                                : "Recompute (safe)"}
                            </button>
                          ) : null}
                          {unmatchedWarn ? (
                            <button
                              type="button"
                              onClick={() => openUserFromHealth(h.userId, "unmatched")}
                              className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-100"
                            >
                              Show ledger rows
                            </button>
                          ) : null}
                          {overlapBad ? (
                            <button
                              type="button"
                              onClick={() => openUserFromHealth(h.userId, "overlap")}
                              className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-100"
                            >
                              Open overlap legs
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-white/30">OK</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-white/10 overflow-hidden">
        <h2 className="border-b border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-white">
          {formatIstMonthYear(period.month, period.year)} — all users
        </h2>
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-white/30" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead className="text-xs uppercase text-white/40">
                <tr>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Closed</th>
                  <th className="px-4 py-2">Realized</th>
                  <th className="px-4 py-2">HWM before</th>
                  <th className="px-4 py-2">HWM after</th>
                  <th className="px-4 py-2">Billable</th>
                  <th className="px-4 py-2">Share</th>
                  <th className="px-4 py-2">Commission</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {users.map((u) => (
                  <tr
                    key={u.userId}
                    className="cursor-pointer text-white/85 hover:bg-white/[0.03]"
                    onClick={() => setSelectedUserId(u.userId)}
                  >
                    <td className="px-4 py-2">{u.email}</td>
                    <td className="px-4 py-2 tabular-nums">{u.structuresClosed}</td>
                    <td className={`px-4 py-2 tabular-nums ${pnlClass(u.realizedPnl)}`}>
                      {fmtUsd(u.realizedPnl)}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.hwmBefore)}</td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.hwmAfter)}</td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.billableProfit)}</td>
                    <td className="px-4 py-2 tabular-nums">{u.profitSharePct.toFixed(1)}%</td>
                    <td className="px-4 py-2 tabular-nums">{fmtUsd(u.commissionAmount)}</td>
                    <td className="px-4 py-2">{u.invoiceStatus}</td>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        disabled={opsBusy != null}
                        onClick={(e) => {
                          e.stopPropagation();
                          void runComputeInvoice({
                            userId: u.userId,
                            year: period.year,
                            month: period.month,
                            busyKey: `row-invoice:${u.userId}`,
                            issue: false,
                          });
                        }}
                        className="rounded border border-[#0A84FF]/40 bg-[#0A84FF]/15 px-2 py-1 text-[10px] text-sky-100 disabled:opacity-50"
                      >
                        {opsBusy === `row-invoice:${u.userId}` ? (
                          <Loader2 className="inline h-3 w-3 animate-spin" />
                        ) : (
                          "Recompute"
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className="bg-white/[0.04] font-medium text-white">
                  <td className="px-4 py-2">Totals</td>
                  <td className="px-4 py-2 tabular-nums">{totals.structuresClosed}</td>
                  <td className={`px-4 py-2 tabular-nums ${pnlClass(totals.realizedPnl)}`}>
                    {fmtUsd(totals.realizedPnl)}
                  </td>
                  <td className="px-4 py-2" colSpan={2} />
                  <td className="px-4 py-2 tabular-nums">{fmtUsd(totals.billableProfit)}</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 tabular-nums">{fmtUsd(totals.commissionAmount)}</td>
                  <td className="px-4 py-2" colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {users.length === 0 && !loading ? (
        <p className="flex items-center gap-2 text-sm text-white/45">
          <AlertTriangle className="h-4 w-4" />
          No eligible bot-strategy users or no invoices for this period yet.
        </p>
      ) : null}

      <ConfirmDestructiveModal
        open={issueConfirmOpen}
        title="Issue monthly invoice"
        description={
          "Issuing freezes the INR amount and the USD/INR rate, and creates partner commissions. " +
          "This cannot be undone except by voiding the invoice. " +
          `Period: ${formatIstMonthYear(opsInvoiceMonth, opsInvoiceYear)}` +
          (opsInvoiceUserId.trim()
            ? ` · user ${userOptions.find((u) => u.userId === opsInvoiceUserId)?.label ?? opsInvoiceUserId}`
            : " · all eligible users") +
          `. Type ${opsPaths.issueConfirmation} to confirm.`
        }
        expectedConfirmation={opsPaths.issueConfirmation}
        confirmationLabel={`Type exactly: ${opsPaths.issueConfirmation}`}
        confirmButtonText="Issue invoice"
        busy={opsBusy === "invoice"}
        error={issueConfirmError}
        onClose={() => {
          if (opsBusy !== "invoice") {
            setIssueConfirmOpen(false);
            setIssueConfirmError(null);
          }
        }}
        onConfirm={(confirmation) => {
          void runComputeInvoice({
            issue: true,
            confirmation,
          });
        }}
      />
    </div>
  );
}
