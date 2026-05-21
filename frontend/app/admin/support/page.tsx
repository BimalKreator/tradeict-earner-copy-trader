"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Headphones,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  formatTicketDate,
  statusBadgeClass,
  type TicketStatus,
  type TicketSummary,
} from "@/lib/tickets";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

export default function AdminSupportPage() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"ALL" | TicketStatus>("ALL");

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const q =
        statusFilter === "ALL" ? "" : `?status=${statusFilter}`;
      const res = await fetch(`${API_BASE}/admin/tickets${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403) {
        setError("Admin access required");
        return;
      }
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = (await res.json()) as { tickets?: TicketSummary[] };
      setTickets(data.tickets ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <Headphones className="h-6 w-6 text-cyan-400" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white">Support tickets</h1>
            <p className="mt-1 text-sm text-slate-400">
              Unread and open tickets appear first.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "ALL" | TicketStatus)
            }
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
          >
            <option value="ALL">All statuses</option>
            <option value="OPEN">Open only</option>
            <option value="CLOSED">Closed only</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/80 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Messages</th>
                <th className="px-4 py-3 font-medium">Updated</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                  </td>
                </tr>
              ) : tickets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                    No tickets found.
                  </td>
                </tr>
              ) : (
                tickets.map((t) => (
                  <tr
                    key={t.id}
                    className={`transition hover:bg-slate-800/40 ${
                      t.unread ? "bg-cyan-500/[0.06]" : ""
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span
                          className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadgeClass(t.status)}`}
                        >
                          {t.status}
                        </span>
                        {t.unread && (
                          <span className="text-[10px] font-semibold text-cyan-400">
                            Needs reply
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="max-w-[240px] px-4 py-3">
                      <p className="truncate font-medium text-slate-100">
                        {t.subject}
                      </p>
                      {t.lastMessagePreview && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">
                          {t.lastMessagePreview}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      <p className="truncate">{t.userEmail ?? "—"}</p>
                      {t.userName && (
                        <p className="text-xs text-slate-500">{t.userName}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{t.messageCount}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                      {formatTicketDate(t.updatedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/support/${t.id}`}
                        className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
