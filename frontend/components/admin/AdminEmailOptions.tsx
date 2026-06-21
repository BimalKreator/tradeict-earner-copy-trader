"use client";

import { ChevronDown, Loader2, Mail, MessageSquare, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CustomEmailModal,
  type CustomEmailRecipient,
} from "./CustomEmailModal";

export type AdminEmailRecipient = CustomEmailRecipient;

type AdminEmailOptionsProps = {
  apiBase: string;
  authHeaders: () => HeadersInit;
  recipient: AdminEmailRecipient;
  onToast?: (toast: { type: "ok" | "err"; text: string }) => void;
  /** Shown before email controls (e.g. Change upline). */
  children?: React.ReactNode;
  className?: string;
};

export function AdminEmailOptions({
  apiBase,
  authHeaders,
  recipient,
  onToast,
  children,
  className = "",
}: AdminEmailOptionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const [resending, setResending] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuWidth = 220;
    let left = rect.right - menuWidth;
    left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
    setMenuStyle({
      top: rect.bottom + 6,
      left,
    });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
    function onScroll() {
      updateMenuPosition();
    }
    function onResize() {
      updateMenuPosition();
    }
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (
        menuRef.current?.contains(t) ||
        triggerRef.current?.contains(t)
      ) {
        return;
      }
      setMenuOpen(false);
    }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("mousedown", onDocClick);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDocClick);
    };
  }, [menuOpen, updateMenuPosition]);

  async function handleResendWelcome() {
    setMenuOpen(false);
    setResending(true);
    try {
      const res = await fetch(`${apiBase}/admin/resend-registration-email`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          userId: recipient.id,
          templateName: "welcome",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to send welcome email");
      }
      onToast?.({
        type: "ok",
        text: `Welcome email sent to ${recipient.email}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Email send failed";
      onToast?.({ type: "err", text: msg });
    } finally {
      setResending(false);
    }
  }

  function openCustomModal() {
    setMenuOpen(false);
    setCustomOpen(true);
  }

  return (
    <>
      <div className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
        {children}
        <button
          ref={triggerRef}
          type="button"
          disabled={resending}
          onClick={() => {
            if (!menuOpen) updateMenuPosition();
            setMenuOpen((v) => !v);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-50"
          title="Email options"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          {resending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Mail className="h-3.5 w-3.5" aria-hidden />
          )}
          Email options
          <ChevronDown
            className={`h-3 w-3 opacity-70 transition ${menuOpen ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
      </div>

      {menuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[90] min-w-[220px] overflow-hidden rounded-lg border border-glassBorder bg-[#0f172a] py-1 shadow-2xl ring-1 ring-white/10"
          style={{ top: menuStyle.top, left: menuStyle.left }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={resending}
            onClick={() => void handleResendWelcome()}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-white/90 hover:bg-white/10 disabled:opacity-50"
          >
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden />
            Resend Welcome Email
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={openCustomModal}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-white/90 hover:bg-white/10"
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden />
            Send Custom Message
          </button>
        </div>
      ) : null}

      <CustomEmailModal
        open={customOpen}
        recipient={recipient}
        apiBase={apiBase}
        authHeaders={authHeaders}
        onClose={() => setCustomOpen(false)}
        onSuccess={(msg) => onToast?.({ type: "ok", text: msg })}
        onError={(msg) => onToast?.({ type: "err", text: msg })}
      />
    </>
  );
}
