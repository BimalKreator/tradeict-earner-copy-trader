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
