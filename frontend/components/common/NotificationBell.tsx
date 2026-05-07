"use client";

import { Bell } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL;

type NotificationRow = {
  id: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const token = useMemo(
    () => (typeof window !== "undefined" ? localStorage.getItem("token") : null),
    [],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { notifications?: NotificationRow[] };
      setItems(Array.isArray(body.notifications) ? body.notifications.slice(0, 20) : []);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const unread = items.filter((n) => !n.isRead).length;

  async function markRead(id: string) {
    if (!token) return;
    await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-lg border border-glassBorder bg-white/[0.04] p-2 text-white/90 transition hover:bg-white/10"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-glassBorder bg-[#0f1117] shadow-2xl">
          <div className="border-b border-glassBorder px-3 py-2 text-xs font-medium uppercase tracking-wider text-white/50">
            Notifications
          </div>
          <div className="max-h-80 overflow-auto">
            {loading ? (
              <p className="px-3 py-4 text-sm text-white/55">Loading...</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-4 text-sm text-white/55">No notifications.</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => void markRead(n.id)}
                  className={`block w-full border-b border-white/[0.06] px-3 py-2 text-left transition hover:bg-white/[0.03] ${
                    n.isRead ? "opacity-75" : ""
                  }`}
                >
                  <p className="text-sm font-medium text-white">{n.title}</p>
                  <p className="mt-0.5 text-xs text-white/65">{n.message}</p>
                  <p className="mt-1 text-[11px] text-white/40">
                    {new Date(n.createdAt).toLocaleString()}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

