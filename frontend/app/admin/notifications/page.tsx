"use client";

import { Bell, CheckCircle2, Loader2, Search, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

type AudienceMode = "ALL" | "ACTIVE" | "SPECIFIC";

type UserOption = {
  id: string;
  email: string;
};

export default function AdminNotificationsPage() {
  const [audience, setAudience] = useState<AudienceMode>("ALL");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const loadUsers = useCallback(async () => {
    if (!token) return;
    setLoadingUsers(true);
    try {
      const res = await fetch(`${API_BASE}/admin/users/list`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as UserOption[];
      if (Array.isArray(data)) setUsers(data);
    } catch {
      /* optional */
    } finally {
      setLoadingUsers(false);
    }
  }, [token]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.email.toLowerCase().includes(q));
  }, [users, userSearch]);

  function toggleUser(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!token) {
      setError("You must be logged in as admin.");
      return;
    }
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!message.trim()) {
      setError("Message is required.");
      return;
    }
    if (audience === "SPECIFIC" && selectedIds.length === 0) {
      setError("Select at least one user.");
      return;
    }

    const body: Record<string, unknown> = {
      title: title.trim(),
      message: message.trim(),
    };
    if (audience === "SPECIFIC") {
      body.audience = "SPECIFIC";
      body.userIds = selectedIds;
    } else {
      body.audience = audience;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/admin/notifications/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        recipientCount?: number;
        notificationsCreated?: number;
        emailsSent?: number;
        emailsFailed?: number;
      };
      if (!res.ok) throw new Error(data.error ?? `Broadcast failed (${res.status})`);

      const count = data.recipientCount ?? 0;
      const emailNote =
        typeof data.emailsFailed === "number" && data.emailsFailed > 0
          ? ` (${data.emailsSent ?? 0} emails sent, ${data.emailsFailed} failed)`
          : ` (${data.emailsSent ?? 0} emails sent)`;
      setSuccess(
        `Broadcast delivered to ${count} user${count === 1 ? "" : "s"}${emailNote}.`,
      );
      setTitle("");
      setMessage("");
      setSelectedIds([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="flex items-start gap-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
          <Bell className="h-6 w-6 text-cyan-400" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Broadcast notifications
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Send an in-app alert and HTML email to selected users.
          </p>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{success}</span>
        </div>
      )}

      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl"
      >
        <div>
          <label
            htmlFor="audience"
            className="block text-sm font-medium text-slate-300"
          >
            Send to
          </label>
          <select
            id="audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value as AudienceMode)}
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500/40"
          >
            <option value="ALL">All users</option>
            <option value="ACTIVE">Active users only</option>
            <option value="SPECIFIC">Specific users</option>
          </select>
        </div>

        {audience === "SPECIFIC" && (
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/80 p-4">
            <p className="text-sm font-medium text-slate-300">Select users</p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="search"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search by email…"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500/40"
              />
            </div>
            {selectedIds.length > 0 && (
              <p className="text-xs text-cyan-400/90">
                {selectedIds.length} selected
              </p>
            )}
            <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-800">
              {loadingUsers ? (
                <p className="px-3 py-4 text-sm text-slate-500">Loading users…</p>
              ) : filteredUsers.length === 0 ? (
                <p className="px-3 py-4 text-sm text-slate-500">No users match.</p>
              ) : (
                filteredUsers.map((u) => {
                  const checked = selectedIds.includes(u.id);
                  return (
                    <label
                      key={u.id}
                      className={`flex cursor-pointer items-center gap-3 border-b border-slate-800/80 px-3 py-2 text-sm last:border-0 hover:bg-slate-800/50 ${
                        checked ? "bg-cyan-500/10" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleUser(u.id)}
                        className="h-4 w-4 rounded border-slate-600 text-cyan-500 focus:ring-cyan-500/40"
                      />
                      <span className="truncate text-slate-200">{u.email}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div>
          <label htmlFor="title" className="block text-sm font-medium text-slate-300">
            Title
          </label>
          <input
            id="title"
            type="text"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Scheduled maintenance tonight"
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
          <p className="mt-1 text-xs text-slate-500">{title.length}/200</p>
        </div>

        <div>
          <label
            htmlFor="message"
            className="block text-sm font-medium text-slate-300"
          >
            Message
          </label>
          <textarea
            id="message"
            rows={8}
            maxLength={5000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Write the full message users will see in-app and in email…"
            className="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm leading-relaxed text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
          <p className="mt-1 text-xs text-slate-500">
            {message.length}/5000 — line breaks are preserved in email.
          </p>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Sending…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden />
              Send broadcast
            </>
          )}
        </button>
      </form>
    </div>
  );
}
