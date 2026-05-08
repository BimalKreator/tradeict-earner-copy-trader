import fs from "node:fs";
import path from "node:path";

const downloadsDir = path.resolve(process.cwd(), "public", "downloads");

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function rowsToCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: Array<{ key: keyof T; label: string }>,
): string {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => escapeCsvCell(row[c.key])).join(","),
  );
  return [header, ...body].join("\n");
}

export function buildTimestampTag(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function ensureDownloadsDir(): string {
  fs.mkdirSync(downloadsDir, { recursive: true });
  return downloadsDir;
}

export function writeCsvToDownloads(fileName: string, csv: string): {
  absolutePath: string;
  relativePath: string;
} {
  const baseDir = ensureDownloadsDir();
  const absolutePath = path.join(baseDir, fileName);
  fs.writeFileSync(absolutePath, `\uFEFF${csv}`, "utf8");
  return {
    absolutePath,
    relativePath: `/api/downloads/${fileName}`,
  };
}

