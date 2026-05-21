import type { DiscountCoupon, Prisma, PrismaClient } from "@prisma/client";

type CouponDb = PrismaClient | Prisma.TransactionClient;

export type CouponValidationResult =
  | {
      ok: true;
      coupon: DiscountCoupon;
      originalFeeInr: number;
      discountAmountInr: number;
      finalFeeInr: number;
      discountPercentage: number;
    }
  | { ok: false; error: string };

export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function computeDiscountedFeeInr(
  originalFeeInr: number,
  discountPercentage: number,
): { discountAmountInr: number; finalFeeInr: number } {
  const pct = Math.min(100, Math.max(0, Math.floor(discountPercentage)));
  const discountAmountInr = (originalFeeInr * pct) / 100;
  const finalFeeInr = Math.max(0, originalFeeInr - discountAmountInr);
  return { discountAmountInr, finalFeeInr };
}

export async function validateCouponForFee(
  prisma: PrismaClient,
  code: string,
  originalFeeInr: number,
): Promise<CouponValidationResult> {
  const normalized = normalizeCouponCode(code);
  if (!normalized) {
    return { ok: false, error: "Coupon code is required" };
  }

  const coupon = await prisma.discountCoupon.findUnique({
    where: { code: normalized },
  });

  if (!coupon) {
    return { ok: false, error: "Invalid coupon code" };
  }
  if (!coupon.isActive) {
    return { ok: false, error: "This coupon is no longer active" };
  }
  if (coupon.usedCount >= coupon.maxUses) {
    return { ok: false, error: "This coupon has reached its usage limit" };
  }

  const { discountAmountInr, finalFeeInr } = computeDiscountedFeeInr(
    originalFeeInr,
    coupon.discountPercentage,
  );

  return {
    ok: true,
    coupon,
    originalFeeInr,
    discountAmountInr,
    finalFeeInr,
    discountPercentage: coupon.discountPercentage,
  };
}

/** Increment coupon usage after successful payment (transactional). */
export async function consumeCouponUse(
  db: CouponDb,
  couponId: string,
): Promise<void> {
  const coupon = await db.discountCoupon.findUnique({
    where: { id: couponId },
  });
  if (!coupon) throw new Error("Coupon not found");
  if (!coupon.isActive) throw new Error("Coupon is no longer active");
  if (coupon.usedCount >= coupon.maxUses) {
    throw new Error("Coupon has reached its usage limit");
  }
  await db.discountCoupon.update({
    where: { id: couponId },
    data: { usedCount: { increment: 1 } },
  });
}
