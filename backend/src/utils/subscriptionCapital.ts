import {
  MAX_SUBSCRIPTION_MULTIPLIER,
  MIN_SUBSCRIPTION_MULTIPLIER,
} from "../constants/subscription.js";

export function resolveStrategyBaseCapital(strategy: {
  baseCapital?: number | null;
  minCapital?: number | null;
}): number {
  const base = strategy.baseCapital;
  if (typeof base === "number" && Number.isFinite(base) && base > 0) {
    return base;
  }
  const min = strategy.minCapital;
  if (typeof min === "number" && Number.isFinite(min) && min > 0) {
    return min;
  }
  return 10;
}

export function parseDeployedCapital(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

export function multiplierFromDeployedCapital(
  deployedCapital: number,
  baseCapital: number,
): number | null {
  const base = resolveStrategyBaseCapital({ baseCapital, minCapital: baseCapital });
  const mult = deployedCapital / base;
  if (!Number.isFinite(mult) || mult < MIN_SUBSCRIPTION_MULTIPLIER) return null;
  if (mult > MAX_SUBSCRIPTION_MULTIPLIER) return null;
  return Math.round(mult * 10) / 10;
}

export function deployedCapitalFromMultiplier(
  multiplier: number,
  baseCapital: number,
): number {
  const base = resolveStrategyBaseCapital({ baseCapital, minCapital: baseCapital });
  if (!Number.isFinite(multiplier)) return base;
  return Math.round(multiplier * base * 100) / 100;
}

export function parseMultiplierFromBody(
  body: { deployedCapital?: unknown; multiplier?: unknown },
  baseCapital: number,
): number | null {
  const deployed = parseDeployedCapital(body.deployedCapital);
  if (deployed != null) {
    return multiplierFromDeployedCapital(deployed, baseCapital);
  }

  const raw = body.multiplier;
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < MIN_SUBSCRIPTION_MULTIPLIER) return null;
  if (n > MAX_SUBSCRIPTION_MULTIPLIER) return null;
  return Math.round(n * 10) / 10;
}

export function deployedCapitalRangeError(baseCapital: number): string {
  const base = resolveStrategyBaseCapital({ baseCapital, minCapital: baseCapital });
  const minUsd = Math.round(MIN_SUBSCRIPTION_MULTIPLIER * base * 100) / 100;
  const maxUsd = Math.round(MAX_SUBSCRIPTION_MULTIPLIER * base * 100) / 100;
  return `deployedCapital must be between $${minUsd} and $${maxUsd} (base capital $${base})`;
}
