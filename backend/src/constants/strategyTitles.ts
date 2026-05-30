/** Sole primary copy / hedge strategy for the platform. */
export const FUTURE_HEDGE_STRATEGY_TITLE = "Future Hedge Strategy";

/**
 * Legacy strategy titles removed in favor of {@link FUTURE_HEDGE_STRATEGY_TITLE}.
 * Includes historical naming variants stored in production databases.
 */
export const LEGACY_CRYPTO_OPTIONS_STRATEGY_TITLES = [
  "Crypto Options Trading - For Delta Ex India",
  "Intraday Cryptotrading Algo - For Delta Ex India",
] as const;

/** Substring match for any renamed "Crypto Options …" row not in the exact list above. */
export const LEGACY_CRYPTO_OPTIONS_TITLE_FRAGMENT = "Crypto Options";

export function isLegacyCryptoOptionsStrategyTitle(title: string): boolean {
  const normalized = title.trim();
  if (!normalized) return false;
  if (normalized === FUTURE_HEDGE_STRATEGY_TITLE) return false;
  if (
    (LEGACY_CRYPTO_OPTIONS_STRATEGY_TITLES as readonly string[]).includes(
      normalized,
    )
  ) {
    return true;
  }
  return normalized
    .toLowerCase()
    .includes(LEGACY_CRYPTO_OPTIONS_TITLE_FRAGMENT.toLowerCase());
}
