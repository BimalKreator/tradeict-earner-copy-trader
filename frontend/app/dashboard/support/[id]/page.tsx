"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Loader2,
  Lock,
  Send,
} from "lucide-react";
import {
  formatTicketDate,
  statusBadgeClass,
  type TicketDetailResponse,
  type TicketMessage,
} from "@/lib/tickets";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

function MessageBubble({ msg }: { msg: TicketMessage }) {
  const isUser = !msg.isAdmin;
  return (
    <div
      className={`flex ${isUser ? "justify-start" : "justify-end"}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm sm:max-w-[70%] ${
          isUser
            ? "rounded-bl-md border border-glassBorder bg-white/[0.06] text-white"
            : "rounded-br-md bg-primary/90 text-white"
        }`}
      >
        <p className="text-[11px] font-medium opacity-80">
          {isUser ? "You" : "Support"}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
          {msg.message}
        </p>
        <p className="mt-2 text-[10px] opacity-60">
          {formatTicketDate(msg.createdAt)}
        </p>
      </div>
    </div>
  );
}

export default function SupportTicketThreadPage() {
  const params = useParams();
  const ticketId = typeof params.id === "string" ? params.id : "";
  const [data, setData] = useState<TicketDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const load = useCallback(async () => {
    if (!token || !ticketId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/tickets/${ticketId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to load ticket (${res.status})`);
      const body = (await res.json()) as TicketDetailResponse;
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load ticket");
    } finally {
      setLoading(false);
    }
  }, [token, ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.messages.length]);

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !reply.trim() || data?.ticket.status === "CLOSED") return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/tickets/${ticketId}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: reply.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & TicketDetailResponse;
      if (!res.ok) throw new Error(body.error ?? "Reply failed");
      setData(body);
      setReply("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reply failed");
    } finally {
      setSending(false);
    }
  }

  async function closeTicket() {
    if (!token || !confirm("Close this ticket? You can still read the thread.")) {
      return;
    }
    setClosing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/tickets/${ticketId}/close`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & TicketDetailResponse;
      if (!res.ok) throw new Error(body.error ?? "Close failed");
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setClosing(false);
    }
  }

  const closed = data?.ticket.status === "CLOSED";

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/dashboard/support"
          className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          All tickets
        </Link>
        {data && !closed && (
          <button
            type="button"
            onClick={() => void closeTicket()}
            disabled={closing}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50"
          >
            {closing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            Close ticket
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-white/55">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading…
        </div>
      ) : !data ? (
        <p className="text-sm text-red-200">{error ?? "Ticket not found"}</p>
      ) : (
        <>
          <header className="glass-card mb-4 border border-glassBorder px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBadgeClass(data.ticket.status)}`}
              >
                {data.ticket.status}
              </span>
              {data.ticket.unread && (
                <span className="text-xs text-cyan-300">New reply from support</span>
              )}
            </div>
            <h1 className="mt-2 text-lg font-semibold text-white">
              {data.ticket.subject}
            </h1>
            <p className="mt-1 text-xs text-white/45">
              Opened {formatTicketDate(data.ticket.createdAt)}
            </p>
          </header>

          {error && (
            <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          <div
            ref={scrollRef}
            className="glass-card flex-1 space-y-4 overflow-y-auto border border-glassBorder p-4"
          >
            {data.messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
          </div>

          {closed ? (
            <p className="mt-4 text-center text-sm text-white/45">
              This ticket is closed. Open a new ticket if you need more help.
            </p>
          ) : (
            <form
              onSubmit={(e) => void sendReply(e)}
              className="mt-4 flex gap-2"
            >
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                placeholder="Type your reply…"
                className="min-h-[44px] flex-1 resize-none rounded-xl border border-glassBorder bg-black/40 px-4 py-3 text-sm text-white outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                type="submit"
                disabled={sending || !reply.trim()}
                className="inline-flex shrink-0 items-center justify-center rounded-xl bg-primary px-4 text-white disabled:opacity-50"
                aria-label="Send reply"
              >
                {sending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
