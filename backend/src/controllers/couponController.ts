import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { normalizeCouponCode } from "../services/couponService.js";

function parsePositiveInt(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number.parseInt(v, 10)
        : NaN;
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return null;
  return n;
}

function parseDiscountPct(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number.parseInt(v, 10)
        : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 100 || !Number.isInteger(n)) return null;
  return n;
}

export function createCouponController(prisma: PrismaClient) {
  async function list(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const coupons = await prisma.discountCoupon.findMany({
        orderBy: { createdAt: "desc" },
      });
      res.json({ coupons });
    } catch (err) {
      next(err);
    }
  }

  async function create(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown>;
      const code =
        typeof body.code === "string" ? normalizeCouponCode(body.code) : "";
      const discountPercentage = parseDiscountPct(body.discountPercentage);
      const maxUses = parsePositiveInt(body.maxUses);

      if (!code) {
        res.status(400).json({ error: "code is required" });
        return;
      }
      if (discountPercentage == null) {
        res.status(400).json({
          error: "discountPercentage must be an integer between 1 and 100",
        });
        return;
      }
      if (maxUses == null) {
        res.status(400).json({ error: "maxUses must be a positive integer" });
        return;
      }

      const coupon = await prisma.discountCoupon.create({
        data: { code, discountPercentage, maxUses },
      });
      res.status(201).json({ coupon });
    } catch (err) {
      next(err);
    }
  }

  async function createBulk(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown>;
      const discountPercentage = parseDiscountPct(body.discountPercentage);
      const maxUses = parsePositiveInt(body.maxUses);
      const count = parsePositiveInt(body.count) ?? 1;
      const prefix =
        typeof body.prefix === "string" && body.prefix.trim()
          ? normalizeCouponCode(body.prefix).replace(/[^A-Z0-9]/g, "")
          : "TICT";

      if (discountPercentage == null || maxUses == null) {
        res.status(400).json({
          error: "discountPercentage (1–100) and maxUses are required",
        });
        return;
      }
      if (count > 500) {
        res.status(400).json({ error: "count cannot exceed 500" });
        return;
      }

      const created = [];
      for (let i = 0; i < count; i++) {
        const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
        const code = `${prefix}-${Date.now().toString(36).toUpperCase()}-${suffix}`;
        const coupon = await prisma.discountCoupon.create({
          data: { code, discountPercentage, maxUses },
        });
        created.push(coupon);
      }
      res.status(201).json({ count: created.length, coupons: created });
    } catch (err) {
      next(err);
    }
  }

  async function toggleActive(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (typeof id !== "string" || !id.trim()) {
        res.status(400).json({ error: "id is required" });
        return;
      }

      const existing = await prisma.discountCoupon.findUnique({
        where: { id: id.trim() },
      });
      if (!existing) {
        res.status(404).json({ error: "Coupon not found" });
        return;
      }

      const coupon = await prisma.discountCoupon.update({
        where: { id: id.trim() },
        data: { isActive: !existing.isActive },
      });
      res.json({ coupon });
    } catch (err) {
      next(err);
    }
  }

  return { list, create, createBulk, toggleActive };
}
