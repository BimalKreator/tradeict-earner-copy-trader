"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type AuditLogDetailsModalProps = {
  open: boolean;
  title: string;
  details: unknown;
  onClose: () => void;
};

export function AuditLogDetailsModal({
  open,
  title,
  details,
  onClose,
}: AuditLogDetailsModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !mounted) return null;

  const formatted =
    details === null || details === undefined
      ? "No additional details recorded."
      : JSON.stringify(details, null, 2);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audit-details-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-glassBorder bg-background/95 shadow-2xl backdrop-blur">
        <div className="flex items-start justify-between gap-3 border-b border-glassBorder px-5 py-4">
          <h2 id="audit-details-title" className="text-lg font-semibold text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="overflow-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-white/[0.08] bg-black/40 p-4 font-mono text-xs leading-relaxed text-emerald-100/90">
            {formatted}
          </pre>
        </div>
      </div>
    </div>,
    document.body,
  );
}
