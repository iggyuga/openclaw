import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  coinbase: {
    apiKey: required("COINBASE_API_KEY"),
    apiSecret: required("COINBASE_API_SECRET"),
  },
  cryptopanic: {
    apiKey: optional("CRYPTOPANIC_API_KEY", ""),
  },
  discord: {
    webhookUrl: optional("DISCORD_WEBHOOK_URL", ""),
  },
  bot: {
    dryRun: optional("DRY_RUN", "true") === "true",
    symbols: optional("SYMBOLS", "ETH/USD,BTC/USD")
      .split(",")
      .map((s) => s.trim()),
    uiPort: parseInt(optional("UI_PORT", "3420"), 10),
    logLevel: optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
    // Minimum 24h quote volume in USD — filters out illiquid / meme pairs
    minLiquidityUsd: parseInt(optional("MIN_LIQUIDITY_USD", "1000000"), 10),
  },
  arbitrage: {
    enabled: optional("ARB_ENABLED", "true") === "true",
    // Minimum profit % after fees to execute (0.2% default)
    minProfitPct: parseFloat(optional("ARB_MIN_PROFIT_PCT", "0.002")),
    // USD capital to deploy per arb opportunity
    capitalUsd: parseFloat(optional("ARB_CAPITAL_USD", "500")),
    // How often to scan in ms (10s default)
    intervalMs: parseInt(optional("ARB_INTERVAL_MS", "10000"), 10),
  },
  strategy: {
    // EMA periods
    emaFast: 9,
    emaSlow: 21,
    emaLong: 200,
    // RSI
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    // How much of portfolio to risk per trade (0.02 = 2%)
    riskPerTrade: 0.02,
    // Stop loss: exit if trade drops this far from entry (0.03 = 3%)
    stopLossPct: 0.03,
    // Take profit: exit when trade gains this much (0.06 = 6%)
    takeProfitPct: 0.06,
    // Coinbase Advanced Trade fees
    makerFeePct: 0.004, // 0.40% — limit orders (adds liquidity)
    takerFeePct: 0.006, // 0.60% — market orders (removes liquidity)
    // Use limit orders for entries (better price, lower fee)
    useLimitOrders: true,
    // Limit order: how far below ask to place buy (0.001 = 0.1%)
    limitOffsetPct: 0.001,
    // Candle timeframe for signals (15m, 1h, 4h, 1d)
    timeframe: optional("TIMEFRAME", "1h") as "15m" | "1h" | "4h" | "1d",
    // How many candles to fetch for indicator warmup
    candleLimit: 250,
  },
};

export type Config = typeof config;
