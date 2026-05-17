import type { NextFunction, Request, Response } from "express";
import { sendExpertTraderApplicationEmail } from "../utils/emailService.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v.trim() : "";
}

function readCapital(body: Record<string, unknown>): string {
  const raw = body.requiredCapital;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string") return raw.trim();
  return "";
}

function readRevenueShare(body: Record<string, unknown>): number | null {
  const raw = body.expectedRevenueShare;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number.parseFloat(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function createPublicController() {
  async function applyExpert(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown>;
      const name = readString(body, "name");
      const email = readString(body, "email").toLowerCase();
      const mobile = readString(body, "mobile");
      const strategyIdea = readString(body, "strategyIdea");
      const exchange = readString(body, "exchange");
      const requiredCapital = readCapital(body);
      const share = readRevenueShare(body);

      if (
        !name ||
        !email ||
        !mobile ||
        !strategyIdea ||
        !exchange ||
        !requiredCapital ||
        share === null
      ) {
        res.status(400).json({
          error:
            "name, email, mobile, strategyIdea, exchange, requiredCapital, and expectedRevenueShare are required",
        });
        return;
      }

      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: "Invalid email address" });
        return;
      }

      if (share < 0 || share > 100) {
        res.status(400).json({
          error: "expectedRevenueShare must be between 0 and 100",
        });
        return;
      }

      await sendExpertTraderApplicationEmail({
        name,
        email,
        mobile,
        strategyIdea,
        exchange,
        requiredCapital,
        expectedRevenueShare: String(share),
      });

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }

  return { applyExpert };
}
