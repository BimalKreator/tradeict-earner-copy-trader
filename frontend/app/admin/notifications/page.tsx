"use client";

import { Bell, CheckCircle2, Loader2, Search, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/$/, "") ?? "";

const SEARCH_DEBOUNCE_MS = 350;
const MIN_SEARCH_LENGTH = 3;

type AudienceMode = "ALL" | "ACTIVE" | "SPECIFIC";

type SearchUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  label: string;
};

export default function AdminNotificationsPage() {
  const [audience, setAudience] = useState<AudienceMode>("ALL");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const selectedIds = selectedUsers.map((u) => u.id);

  const runSearch = useCallback(
    async (query: string) => {
      if (!token || query.length < MIN_SEARCH_LENGTH) {
        setSearchResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      setSearchError(null);
      try {
        const params = new URLSearchParams({ q: query });
        const res = await fetch(
          `${API_BASE}/admin/users/search?${params.toString()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          },
        );
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        const data = (await res.json()) as { users?: SearchUser[] };
        setSearchResults(Array.isArray(data.users) ? data.users : []);
        setDropdownOpen(true);
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : "Search failed");
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [token],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = userSearch.trim();
    if (q.length < MIN_SEARCH_LENGTH) {
      setSearchResults([]);
      setSearching(false);
      setSearchError(null);
      setDropdownOpen(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [userSearch, runSearch]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!searchRef.current?.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function addUser(u: SearchUser) {
    setSelectedUsers((prev) =>
      prev.some((x) => x.id === u.id) ? prev : [...prev, u],
    );
    setUserSearch("");
    setSearchResults([]);
    setDropdownOpen(false);
  }

  function removeUser(id: string) {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== id));
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
      setSelectedUsers([]);
      setUserSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setSubmitting(false);
    }
  }

  const showDropdown =
    dropdownOpen &&
    userSearch.trim().length >= MIN_SEARCH_LENGTH &&
    (searching || searchResults.length > 0 || !!searchError);

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
            <p className="text-xs text-slate-500">
              Type at least {MIN_SEARCH_LENGTH} characters to search by name,
              email, or phone.
            </p>

            {selectedUsers.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedUsers.map((u) => (
                  <span
                    key={u.id}
                    className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-100"
                  >
                    <span className="max-w-[200px] truncate">{u.label}</span>
                    <button
                      type="button"
                      onClick={() => removeUser(u.id)}
                      className="rounded-full p-0.5 hover:bg-cyan-500/20"
                      aria-label={`Remove ${u.label}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div ref={searchRef} className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="search"
                value={userSearch}
                onChange={(e) => {
                  setUserSearch(e.target.value);
                  if (e.target.value.trim().length >= MIN_SEARCH_LENGTH) {
                    setDropdownOpen(true);
                  }
                }}
                onFocus={() => {
                  if (userSearch.trim().length >= MIN_SEARCH_LENGTH) {
                    setDropdownOpen(true);
                  }
                }}
                placeholder="Search name, email, or phone…"
                autoComplete="off"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500/40"
              />

              {showDropdown && (
                <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl">
                  {searching ? (
                    <li className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Searching…
                    </li>
                  ) : searchError ? (
                    <li className="px-3 py-3 text-sm text-red-300">{searchError}</li>
                  ) : searchResults.length === 0 ? (
                    <li className="px-3 py-3 text-sm text-slate-500">
                      No users found.
                    </li>
                  ) : (
                    searchResults.map((u) => {
                      const picked = selectedIds.includes(u.id);
                      return (
                        <li key={u.id}>
                          <button
                            type="button"
                            disabled={picked}
                            onClick={() => addUser(u)}
                            className="block w-full px-3 py-2.5 text-left text-sm transition hover:bg-slate-800 disabled:cursor-default disabled:opacity-50"
                          >
                            <span className="font-medium text-slate-100">
                              {u.label}
                            </span>
                            <span className="mt-0.5 block text-xs text-slate-500">
                              {u.email}
                              {u.phone ? ` · ${u.phone}` : ""}
                            </span>
                            {picked && (
                              <span className="mt-1 text-[10px] text-cyan-400">
                                Already selected
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              )}
            </div>

            <p className="text-xs text-cyan-400/90">
              {selectedUsers.length} user{selectedUsers.length === 1 ? "" : "s"}{" "}
              selected
            </p>
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
