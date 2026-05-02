"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Wallet,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const API_BASE = "http://localhost:5000/api/wallet";

type TxUser = { id: string; email: string };

type WalletTx = {
  id: string;
  userId: string;
  amount: number;
  utrNumber: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  user: TxUser;
};

export default function AdminFundsPage() {
  const [items, setItems] = useState<WalletTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowAction, setRowAction] = useState<Record<string, "approve" | "reject">>(
    {},
  );

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    setError(null);
    if (!token) {
      setUnauthorized(true);
      setForbidden(false);
      setLoading(false);
      setItems([]);
      return;
    }

    setLoading(true);
    setUnauthorized(false);
    setForbidden(false);

    try {
      const res = await fetch(`${API_BASE}/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) {
        setUnauthorized(true);
        setItems([]);
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        setItems([]);
        return;
      }

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Failed to load (${res.status})`;
        throw new Error(msg);
      }

      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid response");
      setItems(data as WalletTx[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load transactions");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleApproveAction(id: string, action: "APPROVED" | "REJECTED") {
    const t = token ?? localStorage.getItem("token");
    if (!t) {
      setUnauthorized(true);
      return;
    }

    const key = action === "APPROVED" ? "approve" : "reject";
    setRowAction((prev) => ({ ...prev, [id]: key }));

    try {
      const res = await fetch(`${API_BASE}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify({ transactionId: id, action }),
      });

      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Action failed (${res.status})`;
        throw new Error(msg);
      }

      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setRowAction((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  if (unauthorized) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-amber-500/35 bg-amber-500/10 px-6 py-10 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-300" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold text-white">Sign in required</h1>
        <p className="mt-2 text-sm text-white/60">
          Sign in with an <strong className="text-white">admin</strong> account to view
          deposit requests.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
        >
          Go to login
        </Link>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-red-500/35 bg-red-500/10 px-6 py-10 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-red-300" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold text-white">
          Admin access only
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Your account does not have the{" "}
          <strong className="text-white">ADMIN</strong> role. Wallet approvals are
          restricted to administrators.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex rounded-lg border border-glassBorder px-5 py-2.5 text-sm font-medium text-white hover:bg-white/10"
          >
            User dashboard
          </Link>
          <Link
            href="/login"
            className="inline-flex rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
          >
            Switch account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-primary/10 p-3">
            <Wallet className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              Funds &amp; deposits
            </h1>
            <p className="mt-1 text-sm text-white/55">
              Review UPI top-up requests. Only administrators can approve or reject.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-glassBorder bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh
        </button>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="glass-card border border-glassBorder overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-glassBorder bg-white/[0.03]">
              <tr>
                <th className="px-4 py-3 font-medium text-white/70">User email</th>
                <th className="px-4 py-3 font-medium text-white/70">Amount</th>
                <th className="px-4 py-3 font-medium text-white/70">UTR number</th>
                <th className="px-4 py-3 font-medium text-white/70">Date</th>
                <th className="px-4 py-3 font-medium text-white/70">Status</th>
                <th className="px-4 py-3 font-medium text-white/70">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-white/45">
                    <Loader2
                      className="mx-auto h-8 w-8 animate-spin text-primary"
                      aria-hidden
                    />
                    <p className="mt-3">Loading transactions…</p>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-14 text-center text-white/45">
                    No deposit requests yet.
                  </td>
                </tr>
              ) : (
                items.map((tx) => {
                  const busyApprove = rowAction[tx.id] === "approve";
                  const busyReject = rowAction[tx.id] === "reject";
                  const pending = tx.status === "PENDING";

                  return (
                    <tr
                      key={tx.id}
                      className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-3 font-medium text-white">
                        {tx.user?.email ?? "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-white/85">
                        ₹{tx.amount.toLocaleString("en-IN")}
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-3 font-mono text-xs text-white/75">
                        {tx.utrNumber ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-white/55 tabular-nums">
                        {new Date(tx.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                            tx.status === "APPROVED"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : tx.status === "REJECTED"
                                ? "bg-red-500/15 text-red-300"
                                : "bg-amber-500/15 text-amber-200"
                          }`}
                        >
                          {tx.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {pending ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busyApprove || busyReject}
                              onClick={() =>
                                void handleApproveAction(tx.id, "APPROVED")
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow hover:bg-emerald-500 disabled:opacity-50"
                            >
                              {busyApprove ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={busyApprove || busyReject}
                              onClick={() =>
                                void handleApproveAction(tx.id, "REJECTED")
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white shadow hover:bg-red-500 disabled:opacity-50"
                            >
                              {busyReject ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5" />
                              )}
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-white/35">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
