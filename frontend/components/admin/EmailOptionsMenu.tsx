"use client";

import { ChevronDown, Loader2, Mail, MessageSquare, Pencil } from "lucide-react";
import { useEffect, useRef } from "react";

export type EmailOptionsRecipient = {
  id: string;
  email: string;
  name: string | null;
};

type EmailOptionsMenuProps = {
  rowId: string;
  openDropdownId: string | null;
  onOpenDropdown: (id: string | null) => void;
  onResendWelcome: () => void;
  onSendCustomMessage: () => void;
  resending?: boolean;
};

/**
 * Controlled email-options dropdown for admin user/member tables.
 * Menu is rendered inline (no portal) below the trigger button.
 */
export function EmailOptionsMenu({
  rowId,
  openDropdownId,
  onOpenDropdown,
  onResendWelcome,
  onSendCustomMessage,
  resending = false,
}: EmailOptionsMenuProps) {
  const isOpen = openDropdownId === rowId;
  const wrapperRef = useRef<HTMLDivElement>(null);

  /** Defer outside-click so the opening click does not instantly close the menu. */
  useEffect(() => {
    if (!isOpen) return;
    let removeListener: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      function onDocumentClick(e: MouseEvent) {
        const target = e.target as Node;
        if (wrapperRef.current?.contains(target)) return;
        onOpenDropdown(null);
      }
      document.addEventListener("click", onDocumentClick, true);
      removeListener = () =>
        document.removeEventListener("click", onDocumentClick, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListener?.();
    };
  }, [isOpen, onOpenDropdown]);

  function toggleMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onOpenDropdown(isOpen ? null : rowId);
  }

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        disabled={resending}
        onClick={toggleMenu}
        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-100 transition hover:bg-sky-500/20 disabled:opacity-50"
        title="Email options"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        {resending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Mail className="h-3.5 w-3.5" aria-hidden />
        )}
        Email options
        <ChevronDown
          className={`h-3 w-3 opacity-70 transition ${isOpen ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {isOpen ? (
        <div
          role="menu"
          aria-label="Email options"
          className="absolute right-0 top-full z-[9999] mt-2 w-48 overflow-hidden rounded-md border border-gray-700 bg-[#1a1d2d] py-1 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={resending}
            onClick={(e) => {
              e.stopPropagation();
              onResendWelcome();
            }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-white/90 hover:bg-white/10 disabled:opacity-50"
          >
            {resending ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
            ) : (
              <MessageSquare
                className="h-3.5 w-3.5 shrink-0 text-emerald-300"
                aria-hidden
              />
            )}
            Resend Welcome Email
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onSendCustomMessage();
            }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-white/90 hover:bg-white/10"
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden />
            Send Custom Message
          </button>
        </div>
      ) : null}
    </div>
  );
}
