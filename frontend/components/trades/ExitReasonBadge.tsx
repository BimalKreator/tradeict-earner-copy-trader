"use client";

function badgeClass(reason: string | null | undefined): string {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("target hit")) {
    return "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30";
  }
  if (r.includes("stop loss")) {
    return "bg-red-500/15 text-red-300 ring-red-500/30";
  }
  if (r.includes("admin panel")) {
    return "bg-slate-500/15 text-slate-300 ring-slate-500/30";
  }
  if (r.includes("externally") || r.includes("delta exchange")) {
    return "bg-violet-500/15 text-violet-200 ring-violet-500/35";
  }
  if (r.includes("insufficient margin")) {
    return "bg-orange-500/15 text-orange-300 ring-orange-500/30";
  }
  if (r.includes("master closed")) {
    return "bg-cyan-500/15 text-cyan-200 ring-cyan-500/30";
  }
  if (r.includes("failed") || r.includes("slippage") || r.includes("execution")) {
    return "bg-amber-500/10 text-amber-200/90 ring-amber-500/25";
  }
  return "bg-white/5 text-white/50 ring-white/10";
}

function shortLabel(reason: string | null | undefined): string {
  if (!reason?.trim()) return "—";
  const r = reason.toLowerCase();
  if (r.includes("auto-exit target")) return "Target Hit";
  if (r.includes("auto-exit stop")) return "Stop Loss Hit";
  if (r.includes("admin panel")) return "Admin Panel";
  if (r.includes("externally")) return "External";
  if (r.includes("insufficient margin")) return "Margin Failed";
  if (r.includes("master closed")) return "Master Closed";
  if (r.includes("slippage")) return "Slippage";
  if (r.includes("no api")) return "No API";
  if (r.includes("execution failed")) return "Exec Failed";
  return reason.length > 28 ? `${reason.slice(0, 26)}…` : reason;
}

export function ExitReasonBadge({
  reason,
  title,
}: {
  reason: string | null | undefined;
  title?: string;
}) {
  if (!reason?.trim()) {
    return <span className="text-white/35">—</span>;
  }

  return (
    <span
      title={title ?? reason}
      className={`inline-flex max-w-[160px] truncate rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${badgeClass(reason)}`}
    >
      {shortLabel(reason)}
    </span>
  );
}
