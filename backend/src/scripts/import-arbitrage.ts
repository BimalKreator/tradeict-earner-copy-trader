/**
 * Import arbitrage trades and withdrawals from Excel for a single user.
 *
 * Expected sheet columns:
 * Token, Qty, Buy, Sell, Fees Charged, Fee %, Net Profit, Time
 *
 * Buy/Sell cells: "$price\\nExchangeName"
 * Withdrawal rows: Token = "WITHDRAWAL", amount in Net Profit (negative), date in Time
 *
 * Run from backend/:
 *   npm run db:import-arbitrage
 *   npm run db:import-arbitrage -- --file="C:/path/to/file.xlsx"
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const TARGET_EMAIL = "bimal.vishwakarma@gmail.com";
const SHEET_NAME = "Arbitrage Data";
const BATCH_SIZE = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../..");

function resolveExcelPath(): string {
  const arg = process.argv.find((a) => a.startsWith("--file="));
  if (arg) {
    const custom = arg.slice("--file=".length).trim();
    if (!custom) throw new Error("--file= requires a path");
    return path.resolve(custom);
  }

  const candidates = [
    path.join(backendRoot, "Arbitrage_Trades_Analysis_2026.xlsx"),
    path.join(
      process.env.USERPROFILE ?? "",
      "Downloads",
      "Arbitrage_Trades_Analysis_2026.xlsx",
    ),
  ].filter((p) => p && !p.includes("undefined"));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    `Excel file not found. Place Arbitrage_Trades_Analysis_2026.xlsx in ${backendRoot} ` +
      `or pass --file="C:/full/path.xlsx"`,
  );
}

function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "result" in v) {
    return (v as { result?: unknown }).result ?? "";
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

function parsePriceDex(cell: unknown, label: string): { price: number; dex: string } {
  const raw = String(cell ?? "").trim();
  if (!raw) {
    throw new Error(`${label} is empty`);
  }
  const parts = raw.split(/\r?\n/).map((s) => s.trim());
  const priceLine = parts[0] ?? "";
  const dex = parts[1]?.trim() || "Unknown";
  const price = Number.parseFloat(priceLine.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(price)) {
    throw new Error(`${label} invalid price: ${JSON.stringify(cell)}`);
  }
  return { price, dex };
}

function parseExcelTime(cell: unknown): Date {
  const raw = String(cell ?? "").trim();
  if (!raw) throw new Error("Time is empty");
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid Time: ${raw}`);
  }
  return d;
}

function num(cell: unknown, label: string): number {
  const n = typeof cell === "number" ? cell : Number.parseFloat(String(cell ?? ""));
  if (!Number.isFinite(n)) {
    throw new Error(`${label} is not a number: ${JSON.stringify(cell)}`);
  }
  return n;
}

function rowValues(row: ExcelJS.Row): unknown[] {
  const out: unknown[] = [];
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    out[colNumber - 1] = cellValue(cell);
  });
  return out;
}

function isWithdrawalRow(row: unknown[]): boolean {
  return String(row[0] ?? "").trim().toUpperCase() === "WITHDRAWAL";
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const excelPath = resolveExcelPath();
  console.log(`[import-arbitrage] Reading ${excelPath}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet =
    workbook.getWorksheet(SHEET_NAME) ?? workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`Sheet "${SHEET_NAME}" not found`);
  }

  const dataRows: unknown[][] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    dataRows.push(rowValues(row));
  });

  if (dataRows.length === 0) {
    throw new Error("Excel sheet has no data rows");
  }

  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.findUnique({
      where: { email: TARGET_EMAIL.toLowerCase() },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      throw new Error(`User not found: ${TARGET_EMAIL}`);
    }
    console.log(`[import-arbitrage] User ${user.email} (${user.id})`);

    const deletedTrades = await prisma.arbitrageTrade.deleteMany({
      where: { userId: user.id },
    });
    const deletedWithdrawals = await prisma.arbitrageWithdrawal.deleteMany({
      where: { userId: user.id },
    });
    console.log(
      `[import-arbitrage] Cleared ${deletedTrades.count} trade(s), ${deletedWithdrawals.count} withdrawal(s)`,
    );

    const trades: Array<{
      userId: string;
      token: string;
      qty: number;
      buyPrice: number;
      sellPrice: number;
      buyDex: string;
      sellDex: string;
      feePercent: number;
      feeAmount: number;
      netProfit: number;
      createdAt: Date;
    }> = [];

    const withdrawals: Array<{
      userId: string;
      amount: number;
      date: Date;
    }> = [];

    let skipped = 0;

    for (let i = 0; i < dataRows.length; i += 1) {
      const row = dataRows[i];
      if (!row || row.every((c) => String(c ?? "").trim() === "")) {
        skipped += 1;
        continue;
      }

      try {
        if (isWithdrawalRow(row)) {
          const netProfit = num(row[6], "Net Profit");
          const amount = Math.abs(netProfit);
          if (amount <= 0) {
            throw new Error("withdrawal amount must be positive");
          }
          withdrawals.push({
            userId: user.id,
            amount,
            date: parseExcelTime(row[7]),
          });
          continue;
        }

        const token = String(row[0] ?? "").trim();
        if (!token) {
          skipped += 1;
          continue;
        }

        const buy = parsePriceDex(row[2], "Buy");
        const sell = parsePriceDex(row[3], "Sell");

        trades.push({
          userId: user.id,
          token,
          qty: num(row[1], "Qty"),
          buyPrice: buy.price,
          sellPrice: sell.price,
          buyDex: buy.dex,
          sellDex: sell.dex,
          feeAmount: num(row[4], "Fees Charged"),
          feePercent: num(row[5], "Fee %"),
          netProfit: num(row[6], "Net Profit"),
          createdAt: parseExcelTime(row[7]),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Row ${i + 2}: ${msg}`);
      }
    }

    console.log(
      `[import-arbitrage] Parsed ${trades.length} trade(s), ${withdrawals.length} withdrawal(s), skipped ${skipped} empty row(s)`,
    );

    for (let i = 0; i < trades.length; i += BATCH_SIZE) {
      const batch = trades.slice(i, i + BATCH_SIZE);
      await prisma.arbitrageTrade.createMany({ data: batch });
      console.log(
        `[import-arbitrage] Inserted trades ${Math.min(i + batch.length, trades.length)}/${trades.length}`,
      );
    }

    if (withdrawals.length > 0) {
      await prisma.arbitrageWithdrawal.createMany({ data: withdrawals });
      console.log(`[import-arbitrage] Inserted ${withdrawals.length} withdrawal(s)`);
    }

    const gross = trades.reduce((s, t) => s + t.netProfit, 0);
    const withdrawn = withdrawals.reduce((s, w) => s + w.amount, 0);
    console.log(
      `[import-arbitrage] Done. Gross net profit: ${gross.toFixed(2)} USDT, ` +
        `withdrawn: ${withdrawn.toFixed(2)} USDT, net: ${(gross - withdrawn).toFixed(2)} USDT`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[import-arbitrage] Failed:", err);
  process.exit(1);
});
