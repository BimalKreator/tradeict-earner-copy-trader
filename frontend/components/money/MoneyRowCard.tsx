"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Desktop table + mobile card list wrapper. */
export function ResponsiveMoneyTable({
  table,
  cards,
  className = "",
}: {
  table: ReactNode;
  cards: ReactNode;
  className?: string;
}) {
  return (
    <>
      <div className={`hidden md:block ${className}`}>
        <div className="scroll-table overflow-x-auto">{table}</div>
      </div>
      <div className={`md:hidden divide-y divide-white/5 ${className}`}>{cards}</div>
    </>
  );
}

export type MoneyRowCardProps = {
  primary: ReactNode;
  secondary?: ReactNode;
  /** Amount + sign — must stay visible on narrow screens. */
  amount: ReactNode;
  status?: ReactNode;
  details: ReactNode;
  defaultExpanded?: boolean;
};

/** Single disclosure card — front always shows label, amount, status; details on tap. */
export function MoneyRowCard({
  primary,
  secondary,
  amount,
  status,
  details,
  defaultExpanded = false,
}: MoneyRowCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="border-b border-white/5 last:border-0">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-white/[0.02]"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-white/45" aria-hidden />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-white/45" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-white">{primary}</div>
              {secondary ? (
                <div className="mt-0.5 text-xs text-white/45">{secondary}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              {amount}
              {status}
            </div>
          </div>
          <p className="mt-1 text-[10px] text-white/35">
            {expanded ? "Tap to hide details" : "Tap for details"}
          </p>
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-white/10 bg-white/[0.02] px-4 py-3 pl-10">
          {details}
        </div>
      ) : null}
    </div>
  );
}

export function DetailRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-white/60">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
