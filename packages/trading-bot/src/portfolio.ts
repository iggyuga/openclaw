import { fetchBalances, fetchTicker } from "./exchange.js";
import { log } from "./logger.js";

export interface Holding {
  currency: string;
  qty: number;
  free: number;
  valueUsd: number;
  priceUsd: number;
}

export interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryTime: number;
  currentPrice: number;
}

// In-memory position tracker (extend with SQLite persistence later)
const positions = new Map<string, Position>();
const closedTrades: Array<Position & { exitPrice: number; exitTime: number; pnlPct: number }> = [];

export function openPosition(symbol: string, qty: number, entryPrice: number) {
  positions.set(symbol, {
    symbol,
    qty,
    entryPrice,
    entryTime: Date.now(),
    currentPrice: entryPrice,
  });
  log.info(`Position opened: ${symbol} ${qty} @ $${entryPrice}`);
}

export function closePosition(symbol: string, exitPrice: number) {
  const pos = positions.get(symbol);
  if (!pos) return;

  const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  closedTrades.push({ ...pos, exitPrice, exitTime: Date.now(), pnlPct });
  positions.delete(symbol);

  const emoji = pnlPct >= 0 ? "✓" : "✗";
  log.trade(
    `${emoji} Closed ${symbol}: ${pnlPct.toFixed(2)}% PnL (entry $${pos.entryPrice} → exit $${exitPrice})`,
  );
}

export function updatePrices(priceMap: Record<string, number>) {
  for (const [symbol, pos] of positions) {
    const price = priceMap[symbol];
    if (price) pos.currentPrice = price;
  }
}

export function hasPosition(symbol: string): boolean {
  return positions.has(symbol);
}

export function getPosition(symbol: string): Position | undefined {
  return positions.get(symbol);
}

export function getAllPositions(): Position[] {
  return Array.from(positions.values());
}

export function getClosedTrades() {
  return closedTrades;
}

export async function getPortfolioSummary() {
  try {
    const balances = await fetchBalances();
    const usdBalance = balances.find((b) => b.currency === "USD");
    const usdcBalance = balances.find((b) => b.currency === "USDC");

    // Stablecoins count as cash — combine with USD
    const stablecoins = ["USDC", "USDT", "DAI", "BUSD"];
    const totalCashUsd = (usdBalance?.free ?? 0) + (usdcBalance?.total ?? 0);

    // Fetch USD value for each non-USD, non-stablecoin holding
    const cryptoBalances = balances.filter(
      (b) => !stablecoins.includes(b.currency) && b.currency !== "USD" && b.total > 0,
    );
    const holdings: Holding[] = await Promise.all(
      cryptoBalances.map(async (b) => {
        try {
          const ticker = await fetchTicker(`${b.currency}/USD`);
          return {
            currency: b.currency,
            qty: b.total,
            free: b.free,
            priceUsd: ticker.price,
            valueUsd: b.total * ticker.price,
          };
        } catch {
          return { currency: b.currency, qty: b.total, free: b.free, priceUsd: 0, valueUsd: 0 };
        }
      }),
    );

    const holdingsValueUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
    const totalValueUsd = totalCashUsd + holdingsValueUsd;

    const openPnl = Array.from(positions.values()).reduce((acc, p) => {
      return acc + (p.currentPrice - p.entryPrice) * p.qty;
    }, 0);
    const totalRealizedPnl = closedTrades.reduce((acc, t) => {
      return acc + (t.exitPrice - t.entryPrice) * t.qty;
    }, 0);

    return {
      usdFree: totalCashUsd,
      usdActual: usdBalance?.free ?? 0,
      usdcBalance: usdcBalance?.total ?? 0,
      totalValueUsd,
      holdings,
      openPositions: getAllPositions(),
      openUnrealizedPnl: openPnl,
      realizedPnl: totalRealizedPnl,
      tradeCount: closedTrades.length,
    };
  } catch (err) {
    log.error("Failed to fetch portfolio summary", err);
    return null;
  }
}
