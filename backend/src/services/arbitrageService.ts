/**
 * DEX arbitrage spread data. Base prices from CoinGecko (when available);
 * per-DEX quotes are deterministic simulated spreads until a premium aggregator API is wired.
 */

export const ARBITRAGE_DEXES = [
  "Uniswap",
  "PancakeSwap",
  "Curve Finance",
  "dYdX",
  "Balancer",
  "Raydium",
  "SushiSwap",
  "Hyperliquid",
  "Trader Joe",
  "Orca",
] as const;

export type ArbitrageDex = (typeof ARBITRAGE_DEXES)[number];

export type DexArbitrageRow = {
  token: string;
  tokenName: string;
  basePrice: number;
  lowestPrice: number;
  lowestDex: ArbitrageDex;
  highestPrice: number;
  highestDex: ArbitrageDex;
  spreadUsd: number;
  spreadPercentage: number;
  estimatedFeePercent: number;
  netSpreadPercent: number;
};

export type DexArbitragePayload = {
  updatedAt: string;
  cacheTtlSeconds: number;
  source: "coingecko+simulated" | "simulated";
  rows: DexArbitrageRow[];
};

/** Top 100 tokens (symbol → CoinGecko id). */
const TOKEN_CATALOG: { symbol: string; name: string; coingeckoId: string }[] = [
  { symbol: "BTC", name: "Bitcoin", coingeckoId: "bitcoin" },
  { symbol: "ETH", name: "Ethereum", coingeckoId: "ethereum" },
  { symbol: "USDT", name: "Tether", coingeckoId: "tether" },
  { symbol: "BNB", name: "BNB", coingeckoId: "binancecoin" },
  { symbol: "SOL", name: "Solana", coingeckoId: "solana" },
  { symbol: "USDC", name: "USD Coin", coingeckoId: "usd-coin" },
  { symbol: "TRX", name: "TRON", coingeckoId: "tron" },
  { symbol: "DOGE", name: "Dogecoin", coingeckoId: "dogecoin" },
  { symbol: "TON", name: "Toncoin", coingeckoId: "the-open-network" },
  { symbol: "ADA", name: "Cardano", coingeckoId: "cardano" },
  { symbol: "AVAX", name: "Avalanche", coingeckoId: "avalanche-2" },
  { symbol: "LINK", name: "Chainlink", coingeckoId: "chainlink" },
  { symbol: "SHIB", name: "Shiba Inu", coingeckoId: "shiba-inu" },
  { symbol: "SUI", name: "Sui", coingeckoId: "sui" },
  { symbol: "DOT", name: "Polkadot", coingeckoId: "polkadot" },
  { symbol: "LTC", name: "Litecoin", coingeckoId: "litecoin" },
  { symbol: "HLP", name: "Hyperliquid", coingeckoId: "hyperliquid" },
  { symbol: "BCH", name: "Bitcoin Cash", coingeckoId: "bitcoin-cash" },
  { symbol: "NEAR", name: "NEAR", coingeckoId: "near" },
  { symbol: "PEPE", name: "Pepe", coingeckoId: "pepe" },
  { symbol: "KAS", name: "Kaspa", coingeckoId: "kaspa" },
  { symbol: "VET", name: "VeChain", coingeckoId: "vechain" },
  { symbol: "HBAR", name: "Hedera", coingeckoId: "hedera-hashgraph" },
  { symbol: "APT", name: "Aptos", coingeckoId: "aptos" },
  { symbol: "ARB", name: "Arbitrum", coingeckoId: "arbitrum" },
  { symbol: "OP", name: "Optimism", coingeckoId: "optimism" },
  { symbol: "RNDR", name: "Render", coingeckoId: "render-token" },
  { symbol: "INJ", name: "Injective", coingeckoId: "injective-protocol" },
  { symbol: "FIL", name: "Filecoin", coingeckoId: "filecoin" },
  { symbol: "TIA", name: "Celestia", coingeckoId: "celestia" },
  { symbol: "STX", name: "Stacks", coingeckoId: "blockstack" },
  { symbol: "IMX", name: "Immutable", coingeckoId: "immutable-x" },
  { symbol: "CRO", name: "Cronos", coingeckoId: "crypto-com-chain" },
  { symbol: "ATOM", name: "Cosmos", coingeckoId: "cosmos" },
  { symbol: "MNT", name: "Mantle", coingeckoId: "mantle" },
  { symbol: "SEI", name: "Sei", coingeckoId: "sei-network" },
  { symbol: "ENA", name: "Ethena", coingeckoId: "ethena" },
  { symbol: "BONK", name: "Bonk", coingeckoId: "bonk" },
  { symbol: "FTM", name: "Fantom", coingeckoId: "fantom" },
  { symbol: "TAO", name: "Bittensor", coingeckoId: "bittensor" },
  { symbol: "ALGO", name: "Algorand", coingeckoId: "algorand" },
  { symbol: "ICP", name: "Internet Computer", coingeckoId: "internet-computer" },
  { symbol: "MKR", name: "Maker", coingeckoId: "maker" },
  { symbol: "AAVE", name: "Aave", coingeckoId: "aave" },
  { symbol: "UNI", name: "Uniswap", coingeckoId: "uniswap" },
  { symbol: "LDO", name: "Lido DAO", coingeckoId: "lido-dao" },
  { symbol: "RPL", name: "Rocket Pool", coingeckoId: "rocket-pool" },
  { symbol: "GRT", name: "The Graph", coingeckoId: "the-graph" },
  { symbol: "PYTH", name: "Pyth Network", coingeckoId: "pyth-network" },
  { symbol: "JUP", name: "Jupiter", coingeckoId: "jupiter-exchange-solana" },
  { symbol: "RUNE", name: "THORChain", coingeckoId: "thorchain" },
  { symbol: "WLD", name: "Worldcoin", coingeckoId: "worldcoin-wld" },
  { symbol: "ONDO", name: "Ondo", coingeckoId: "ondo-finance" },
  { symbol: "FLR", name: "Flare", coingeckoId: "flare-networks" },
  { symbol: "EOS", name: "EOS", coingeckoId: "eos" },
  { symbol: "XTZ", name: "Tezos", coingeckoId: "tezos" },
  { symbol: "SAND", name: "The Sandbox", coingeckoId: "the-sandbox" },
  { symbol: "MANA", name: "Decentraland", coingeckoId: "decentraland" },
  { symbol: "AXS", name: "Axie Infinity", coingeckoId: "axie-infinity" },
  { symbol: "GALA", name: "Gala", coingeckoId: "gala" },
  { symbol: "FLOW", name: "Flow", coingeckoId: "flow" },
  { symbol: "KAVA", name: "Kava", coingeckoId: "kava" },
  { symbol: "SNX", name: "Synthetix", coingeckoId: "havven" },
  { symbol: "CRV", name: "Curve DAO", coingeckoId: "curve-dao-token" },
  { symbol: "FRAX", name: "Frax", coingeckoId: "frax" },
  { symbol: "PENDLE", name: "Pendle", coingeckoId: "pendle" },
  { symbol: "AERO", name: "Aerodrome", coingeckoId: "aerodrome-finance" },
  { symbol: "MOVE", name: "Movement", coingeckoId: "movement" },
  { symbol: "BERA", name: "Berachain", coingeckoId: "berachain-bera" },
  { symbol: "MATIC", name: "Polygon", coingeckoId: "matic-network" },
  { symbol: "AR", name: "Arweave", coingeckoId: "arweave" },
  { symbol: "ZEC", name: "Zcash", coingeckoId: "zcash" },
  { symbol: "XMR", name: "Monero", coingeckoId: "monero" },
  { symbol: "NEO", name: "NEO", coingeckoId: "neo" },
  { symbol: "KCS", name: "KuCoin", coingeckoId: "kucoin-shares" },
  { symbol: "BTT", name: "BitTorrent", coingeckoId: "bittorrent" },
  { symbol: "TUSD", name: "TrueUSD", coingeckoId: "true-usd" },
  { symbol: "HNT", name: "Helium", coingeckoId: "helium" },
  { symbol: "RON", name: "Ronin", coingeckoId: "ronin" },
  { symbol: "BEAM", name: "Beam", coingeckoId: "beam-2" },
  { symbol: "W", name: "Wormhole", coingeckoId: "wormhole" },
  { symbol: "EIGEN", name: "EigenLayer", coingeckoId: "eigenlayer" },
  { symbol: "STRK", name: "Starknet", coingeckoId: "starknet" },
  { symbol: "NOT", name: "Notcoin", coingeckoId: "notcoin" },
  { symbol: "CORE", name: "Core", coingeckoId: "coredaoorg" },
  { symbol: "XEC", name: "eCash", coingeckoId: "ecash" },
  { symbol: "EGLD", name: "MultiversX", coingeckoId: "multiversx" },
  { symbol: "CHZ", name: "Chiliz", coingeckoId: "chiliz" },
  { symbol: "BLUR", name: "Blur", coingeckoId: "blur" },
  { symbol: "MOG", name: "Mog Coin", coingeckoId: "mog-coin" },
  { symbol: "TURBO", name: "Turbo", coingeckoId: "turbo" },
  { symbol: "SAFE", name: "Safe", coingeckoId: "safe" },
  { symbol: "AKT", name: "Akash", coingeckoId: "akash-network" },
  { symbol: "NEXO", name: "Nexo", coingeckoId: "nexo" },
  { symbol: "IOTX", name: "IoTeX", coingeckoId: "iotex" },
  { symbol: "QTUM", name: "Qtum", coingeckoId: "qtum" },
  { symbol: "1INCH", name: "1inch", coingeckoId: "1inch" },
  { symbol: "GMX", name: "GMX", coingeckoId: "gmx" },
  { symbol: "CAKE", name: "PancakeSwap", coingeckoId: "pancakeswap-token" },
];

const CACHE_TTL_MS = 4 * 60 * 1000;

let cache: DexArbitragePayload | null = null;
let cacheExpiresAt = 0;
let refreshInFlight: Promise<DexArbitragePayload> | null = null;

function seededUnit(seed: string, salt: string): number {
  let h = 2166136261;
  const s = `${seed}::${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function fallbackBasePrice(symbol: string, rank: number): number {
  const u = seededUnit(symbol, "base");
  if (symbol === "USDT" || symbol === "USDC" || symbol === "TUSD") return 1;
  if (rank < 3) return 20_000 + u * 80_000;
  if (rank < 15) return 50 + u * 450;
  if (rank < 50) return 0.5 + u * 25;
  return 0.01 + u * 2;
}

async function fetchCoinGeckoUsdPrices(
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const chunkSize = 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(chunk.join(","))}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status}`);
    }
    const data = (await res.json()) as Record<string, { usd?: number }>;
    for (const [id, row] of Object.entries(data)) {
      const p = row?.usd;
      if (typeof p === "number" && Number.isFinite(p) && p > 0) {
        out.set(id, p);
      }
    }
  }
  return out;
}

function simulateDexQuotes(
  symbol: string,
  basePrice: number,
): { dex: ArbitrageDex; price: number }[] {
  return ARBITRAGE_DEXES.map((dex, idx) => {
    const u = seededUnit(symbol, dex);
    const bias = (u - 0.5) * 0.06;
    const dexSkew = (idx - 4.5) * 0.0015;
    const price = basePrice * (1 + bias + dexSkew);
    return { dex, price: Math.max(price, basePrice * 0.0001) };
  });
}

function buildRow(
  entry: (typeof TOKEN_CATALOG)[number],
  rank: number,
  oracleUsd: Map<string, number>,
  usedOracle: { value: boolean },
): DexArbitrageRow {
  const fromOracle = oracleUsd.get(entry.coingeckoId);
  const basePrice =
    typeof fromOracle === "number" && fromOracle > 0
      ? fromOracle
      : fallbackBasePrice(entry.symbol, rank);

  if (fromOracle != null) usedOracle.value = true;

  const quotes = simulateDexQuotes(entry.symbol, basePrice);
  let lowest = quotes[0]!;
  let highest = quotes[0]!;
  for (const q of quotes) {
    if (q.price < lowest.price) lowest = q;
    if (q.price > highest.price) highest = q;
  }

  const spreadUsd = highest.price - lowest.price;
  const spreadPercentage =
    lowest.price > 0 ? (spreadUsd / lowest.price) * 100 : 0;

  const estimatedFeePercent =
    Math.round((7 + seededUnit(entry.symbol, "est-fee") * 2) * 100) / 100;
  const netSpreadPercent = spreadPercentage - estimatedFeePercent;

  return {
    token: entry.symbol,
    tokenName: entry.name,
    basePrice,
    lowestPrice: lowest.price,
    lowestDex: lowest.dex,
    highestPrice: highest.price,
    highestDex: highest.dex,
    spreadUsd,
    spreadPercentage,
    estimatedFeePercent,
    netSpreadPercent,
  };
}

async function refreshDexArbitrageData(): Promise<DexArbitragePayload> {
  const ids = [...new Set(TOKEN_CATALOG.map((t) => t.coingeckoId))];
  let oracleUsd = new Map<string, number>();
  const usedOracle = { value: false };

  try {
    oracleUsd = await fetchCoinGeckoUsdPrices(ids);
  } catch (err) {
    console.warn("[arbitrage] CoinGecko fetch failed, using simulated bases:", err);
  }

  const rows = TOKEN_CATALOG.map((entry, idx) =>
    buildRow(entry, idx, oracleUsd, usedOracle),
  ).sort((a, b) => b.spreadPercentage - a.spreadPercentage);

  return {
    updatedAt: new Date().toISOString(),
    cacheTtlSeconds: Math.floor(CACHE_TTL_MS / 1000),
    source: usedOracle.value ? "coingecko+simulated" : "simulated",
    rows,
  };
}

export async function getDexArbitrageData(
  forceRefresh = false,
): Promise<{ data: DexArbitragePayload; fromCache: boolean }> {
  const now = Date.now();
  if (!forceRefresh && cache && now < cacheExpiresAt) {
    return { data: cache, fromCache: true };
  }

  if (!forceRefresh && refreshInFlight) {
    const data = await refreshInFlight;
    return { data, fromCache: true };
  }

  refreshInFlight = refreshDexArbitrageData();
  try {
    const data = await refreshInFlight;
    cache = data;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return { data, fromCache: false };
  } finally {
    refreshInFlight = null;
  }
}
