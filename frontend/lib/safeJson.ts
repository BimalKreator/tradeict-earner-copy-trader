/** Shape-safe JSON helpers — return null instead of throwing on invalid data. */

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function parseJsonArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function readFiniteNumber(
  obj: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function readOptionalFiniteNumber(
  obj: Record<string, unknown>,
  key: string,
): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readStringArray(obj: Record<string, unknown>, key: string): string[] {
  const raw = parseJsonArray(obj[key]);
  if (!raw) return [];
  return raw.filter((item): item is string => typeof item === "string");
}
