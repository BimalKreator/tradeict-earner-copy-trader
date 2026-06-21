"use client";

import { ChevronDown, Loader2, Mail, MessageSquare, Pencil } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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

const MENU_WIDTH = 224;
const MENU_GAP = 6;

function computeMenuPosition(button: HTMLButtonElement): { top: number; left: number } {
  const rect = button.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // Right-align menu to trigger; clamp within viewport (document coords).
  let left = rect.right + scrollX - MENU_WIDTH;
  const minLeft = scrollX + 8;
  const maxLeft = scrollX + window.innerWidth - MENU_WIDTH - 8;
  left = Math.max(minLeft, Math.min(left, maxLeft));

  return {
    top: rect.bottom + scrollY + MENU_GAP,
    left,
  };
}

/**
 * Controlled email-options dropdown for admin user/member tables.
 * Menu renders in a portal so table overflow cannot clip it.
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const syncMenuPosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const next = computeMenuPosition(el);
    setCoords(next);
    return next;
  }, []);

  /** Position before paint so the portal never flashes at (0, 0). */
  useLayoutEffect(() => {
    if (!isOpen) {
      setCoords(null);
      return;
    }
    syncMenuPosition();
  }, [isOpen, syncMenuPosition]);

  /** Close on scroll/resize so the menu does not drift from the trigger. */
  useEffect(() => {
    if (!isOpen) return;
    function closeMenu() {
      onOpenDropdown(null);
    }
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [isOpen, onOpenDropdown]);

  /** Defer outside-click so the opening click does not instantly close the menu. */
  useEffect(() => {
    if (!isOpen) return;
    let removeListener: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      function onDocumentClick(e: MouseEvent) {
        const target = e.target as Node;
        if (triggerRef.current?.contains(target)) return;
        if (menuRef.current?.contains(target)) return;
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
    if (isOpen) {
      onOpenDropdown(null);
      return;
    }
    syncMenuPosition();
    onOpenDropdown(rowId);
  }

  const menu =
    isOpen && mounted && coords
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Email options"
            className="absolute z-[9999] min-w-[224px] overflow-hidden rounded-lg border border-white/15 bg-[#0f172a] py-1 shadow-2xl ring-1 ring-sky-500/20"
            style={{
              position: "absolute",
              top: coords.top,
              left: coords.left,
              zIndex: 9999,
            }}
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
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="relative inline-block">
        <button
          ref={triggerRef}
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
      </div>
      {menu}
    </>
  );
}
