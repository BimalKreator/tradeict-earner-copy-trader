/** IST calendar date formatting — snapshotDate is UTC instant of IST midnight. */
export const IST_TIMEZONE = "Asia/Kolkata";

const istDateFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIMEZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
});

const istMonthFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: IST_TIMEZONE,
  year: "numeric",
  month: "long",
});

/** Render a stored UTC instant as its IST calendar date (not UTC date). */
export function formatIstCalendarDate(isoOrDate: string | Date): string {
  try {
    const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
    if (Number.isNaN(d.getTime())) return "—";
    return istDateFmt.format(d);
  } catch {
    return "—";
  }
}

/** Chart axis label from DailyPnlSnapshot.snapshotDate. */
export function formatIstSnapshotDay(snapshotDateIso: string): string {
  return formatIstCalendarDate(snapshotDateIso);
}

export function formatIstMonthYear(month: number, year: number): string {
  try {
    return istMonthFmt.format(new Date(Date.UTC(year, month - 1, 15, 12, 0, 0)));
  } catch {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
}

/** Current IST calendar year and month (1-indexed). */
export function currentIstYearMonth(ref = new Date()): {
  year: number;
  month: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIMEZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(ref);
  const year = parseInt(parts.find((p) => p.type === "year")?.value ?? "0", 10);
  const month = parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10);
  return { year, month };
}

/** True when a UTC instant falls in the given IST calendar month. */
export function isUtcInstantInIstMonth(
  isoOrDate: string | Date,
  year: number,
  month: number,
): boolean {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return false;
  const parts = currentIstYearMonth(d);
  return parts.year === year && parts.month === month;
}

const istDateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIMEZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Full IST timestamp with zone suffix, e.g. "26 Aug 2026, 3:42 PM IST". */
export function formatIstDateTime(isoOrDate: string | Date | null | undefined): string {
  if (isoOrDate == null) return "—";
  try {
    const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
    if (Number.isNaN(d.getTime())) return "—";
    return `${istDateTimeFmt.format(d)} IST`;
  } catch {
    return "—";
  }
}

function istStartOfDayMs(ref: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(ref);
  const y = parseInt(parts.find((p) => p.type === "year")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10);
  const d = parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10);
  return Date.UTC(y, m - 1, d, 0, 0, 0) - (5 * 60 + 30) * 60 * 1000;
}

function relativeIstDayLabel(target: Date, ref = new Date()): string | undefined {
  const diffDays = Math.round(
    (istStartOfDayMs(target) - istStartOfDayMs(ref)) / (24 * 60 * 60 * 1000),
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays > 1) return `In ${diffDays} days`;
  if (diffDays < -1) return `${Math.abs(diffDays)} days ago`;
  return undefined;
}

/** Absolute IST date/time with optional relative secondary line (for due dates). */
export function dueDateLabel(
  dueDate: string | null | undefined,
  status?: string,
): { primary: string; secondary?: string } {
  if (!dueDate) return { primary: "—" };
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return { primary: "—" };
  const primary = formatIstDateTime(d);
  const normalized = status?.toUpperCase();
  if (normalized === "PAID" || normalized === "SETTLED") {
    return { primary };
  }
  const secondary = relativeIstDayLabel(d);
  return secondary ? { primary, secondary } : { primary };
}
