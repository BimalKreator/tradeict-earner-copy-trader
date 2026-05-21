"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Headphones,
  Loader2,
  MessageSquarePlus,
  Plus,
  X,
} from "lucide-react";
import {
  formatTicketDate,
  statusBadgeClass,
  type TicketDetailResponse,
  type TicketSummary,
} from "@/lib/tickets";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

export default function SupportTicketsPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/tickets`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to load tickets (${res.status})`);
      const data = (await res.json()) as { tickets?: TicketSummary[] };
      setTickets(data.tickets ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tickets");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createTicket(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/tickets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ subject, message }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<TicketDetailResponse>;
      if (!res.ok) throw new Error(body.error ?? "Failed to create ticket");
      setModalOpen(false);
      setSubject("");
      setMessage("");
      if (body.ticket?.id) {
        router.push(`/dashboard/support/${body.ticket.id}`);
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create ticket");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-glassBorder bg-white/[0.04] p-3">
            <Headphones className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white">Support</h1>
            <p className="mt-1 text-sm text-white/55">
              Open a ticket and chat with our team.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Create new ticket
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="glass-card overflow-hidden border border-glassBorder">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-white/55">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            Loading tickets…
          </div>
        ) : tickets.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <MessageSquarePlus
              className="mx-auto h-10 w-10 text-white/25"
              aria-hidden
            />
            <p className="mt-4 text-sm text-white/55">No tickets yet.</p>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="mt-4 text-sm font-medium text-primary hover:underline"
            >
              Create your first ticket
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {tickets.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/dashboard/support/${t.id}`}
                  className="flex flex-col gap-2 px-5 py-4 transition hover:bg-white/[0.03] sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusBadgeClass(t.status)}`}
                      >
                        {t.status}
                      </span>
                      {t.unread && (
                        <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                          New reply
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-medium text-white">
                      {t.subject}
                    </p>
                    {t.lastMessagePreview && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-white/50">
                        {t.lastMessagePreview}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 text-xs text-white/40">
                    {formatTicketDate(t.updatedAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div
            className="glass-card w-full max-w-lg border border-glassBorder p-6 shadow-2xl"
            role="dialog"
            aria-labelledby="new-ticket-title"
          >
            <div className="flex items-start justify-between gap-4">
              <h2
                id="new-ticket-title"
                className="text-lg font-semibold text-white"
              >
                New support ticket
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1 text-white/60 hover:bg-white/10 hover:text-white"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={(e) => void createTicket(e)} className="mt-5 space-y-4">
              <label className="block">
                <span className="text-xs text-white/55">Subject</span>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  required
                  maxLength={200}
                  className="mt-1 w-full rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
                  placeholder="Brief summary of your issue"
                />
              </label>
              <label className="block">
                <span className="text-xs text-white/55">Message</span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                  rows={5}
                  maxLength={8000}
                  className="mt-1 w-full resize-y rounded-lg border border-glassBorder bg-black/40 px-3 py-2 text-sm text-white"
                  placeholder="Describe your issue in detail…"
                />
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/80"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  Submit ticket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
