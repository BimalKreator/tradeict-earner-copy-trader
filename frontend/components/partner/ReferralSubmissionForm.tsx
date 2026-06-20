"use client";

import {
  Check,
  Clock,
  Loader2,
  Mail,
  Send,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ReferralStatus = "PENDING" | "APPROVED" | "REJECTED";

type ReferralHistoryRow = {
  id: string;
  referredEmail: string;
  status: ReferralStatus;
  createdAt: string;
  updatedAt: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statusBadge(status: ReferralStatus): string {
  if (status === "APPROVED") {
    return "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30";
  }
  if (status === "REJECTED") {
    return "bg-red-500/15 text-red-200 ring-red-500/30";
  }
  return "bg-amber-500/15 text-amber-200 ring-amber-500/30";
}

type ReferralSubmissionFormProps = {
  apiBase: string;
  token: string | null;
  /** Bump to reload history from parent */
  refreshKey?: number;
  onSubmitted?: () => void;
};

export function ReferralSubmissionForm({
  apiBase,
  token,
  refreshKey = 0,
  onSubmitted,
}: ReferralSubmissionFormProps) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [history, setHistory] = useState<ReferralHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`${apiBase}/user/partner/referral-requests`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to load referral history (${res.status})`);
    }
    const data = (await res.json()) as { requests: ReferralHistoryRow[] };
    setHistory(data.requests ?? []);
  }, [apiBase, token]);

  useEffect(() => {
    void (async () => {
      setHistoryLoading(true);
      try {
        await loadHistory();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load history");
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, [loadHistory, refreshKey]);

  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => setSuccess(null), 4000);
    return () => window.clearTimeout(t);
  }, [success]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || submitting) return;

    const trimmed = email.trim();
    if (!trimmed) {
      setError("Please enter an email address");
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`${apiBase}/user/partner/referral-request`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ referredEmail: trimmed }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Submit failed (${res.status})`;
        throw new Error(msg);
      }

      setEmail("");
      setSuccess("Referral submitted! An admin will review it shortly.");
      await loadHistory();
      onSubmitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="glass-card rounded-2xl border border-glassBorder p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-2.5">
            <Send className="h-5 w-5 text-sky-300" aria-hidden />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Submit a referral</h2>
            <p className="mt-1 text-sm text-white/50">
              Nominate a trader by email. Once approved, they&apos;ll link to your
              downline and count toward your next tier.
            </p>
          </div>
        </div>

        {success ? (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
            <Check className="h-4 w-4 shrink-0" aria-hidden />
            {success}
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden />
            {error}
          </div>
        ) : null}

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 flex flex-col gap-3 sm:flex-row">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Referred email</span>
            <Mail
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
              aria-hidden
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="trader@example.com"
              autoComplete="email"
              disabled={submitting}
              className="w-full rounded-xl border border-glassBorder bg-black/40 py-3 pl-10 pr-4 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
            />
          </label>
          <button
            type="submit"
            disabled={submitting || !email.trim()}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            Submit Referral
          </button>
        </form>
      </div>

      <div className="glass-card overflow-hidden rounded-2xl border border-glassBorder">
        <div className="border-b border-glassBorder bg-white/[0.03] px-5 py-4">
          <h3 className="text-sm font-semibold text-white">Your referral submissions</h3>
          <p className="mt-0.5 text-xs text-white/45">Recent requests and their review status</p>
        </div>

        {historyLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
          </div>
        ) : history.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-white/45">
            No referrals submitted yet. Enter an email above to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-xs uppercase tracking-wider text-white/40">
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium">Email</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02]"
                  >
                    <td className="whitespace-nowrap px-5 py-3 text-white/55">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-white/30" aria-hidden />
                        {fmtDate(row.createdAt)}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-medium text-white/85">
                      {row.referredEmail}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${statusBadge(row.status)}`}
                      >
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
