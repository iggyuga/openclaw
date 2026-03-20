import ccxt, { coinbaseadvanced } from "ccxt";
import { config } from "./config.js";
import { log } from "./logger.js";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  change24h: number;
}

export interface Balance {
  currency: string;
  free: number;
  total: number;
}

let exchange: coinbaseadvanced;

export function getExchange(): coinbaseadvanced {
  if (!exchange) {
    exchange = new ccxt.coinbaseadvanced({
      apiKey: config.coinbase.apiKey,
      secret: config.coinbase.apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: "spot",
      },
    });
  }
  return exchange;
}

export async function fetchCandles(
  symbol: string,
  timeframe: string,
  limit: number,
): Promise<Candle[]> {
  const ex = getExchange();
  log.debug(`Fetching ${limit} ${timeframe} candles for ${symbol}`);

  const raw = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);
  return raw.map((candle) => ({
    timestamp: candle[0] as number,
    open: candle[1] as number,
    high: candle[2] as number,
    low: candle[3] as number,
    close: candle[4] as number,
    volume: candle[5] as number,
  }));
}

export async function fetchTicker(symbol: string): Promise<Ticker> {
  const ex = getExchange();
  const raw = await ex.fetchTicker(symbol);
  return {
    symbol,
    price: raw.last ?? 0,
    bid: raw.bid ?? 0,
    ask: raw.ask ?? 0,
    volume24h: raw.quoteVolume ?? 0,
    change24h: raw.percentage ?? 0,
  };
}

/**
 * Returns true if the symbol has sufficient 24h quote volume.
 * Guards against trading illiquid / meme pairs.
 */
export async function isLiquid(symbol: string, minUsd: number): Promise<boolean> {
  try {
    const ticker = await fetchTicker(symbol);
    if (ticker.volume24h < minUsd) {
      log.warn(
        `${symbol} rejected: 24h volume $${ticker.volume24h.toLocaleString()} < min $${minUsd.toLocaleString()}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`Liquidity check failed for ${symbol}`, err);
    return false;
  }
}

export async function fetchBalances(): Promise<Balance[]> {
  const ex = getExchange();
  const raw = await ex.fetchBalance();
  return Object.entries(raw.total)
    .filter(([, total]) => Number(total ?? 0) > 0)
    .map(([currency, total]) => ({
      currency,
      free: Number((raw.free as unknown as Record<string, unknown>)[currency] ?? 0),
      total: Number(total ?? 0),
    }));
}

export async function createMarketBuy(symbol: string, usdAmount: number): Promise<string> {
  const ex = getExchange();
  const ticker = await fetchTicker(symbol);
  const qty = usdAmount / ticker.price;

  log.trade(
    `MARKET BUY ${qty.toFixed(6)} ${symbol} @ ~$${ticker.price} (cost: $${usdAmount.toFixed(2)})`,
  );
  const order = await ex.createMarketBuyOrder(symbol, qty);
  return order.id;
}

// Limit buy: place order slightly below current ask for better fill + lower (maker) fee
export async function createLimitBuy(
  symbol: string,
  usdAmount: number,
  offsetPct: number,
): Promise<string> {
  const ex = getExchange();
  const ticker = await fetchTicker(symbol);
  const limitPrice = ticker.ask * (1 - offsetPct);
  const qty = usdAmount / limitPrice;

  log.trade(
    `LIMIT BUY ${qty.toFixed(6)} ${symbol} @ $${limitPrice.toFixed(2)} (ask: $${ticker.ask.toFixed(2)})`,
  );
  const order = await ex.createLimitBuyOrder(symbol, qty, limitPrice);
  return order.id;
}

export async function createMarketSell(symbol: string, qty: number): Promise<string> {
  const ex = getExchange();
  const ticker = await fetchTicker(symbol);

  log.trade(`MARKET SELL ${qty.toFixed(6)} ${symbol} @ ~$${ticker.price}`);
  const order = await ex.createMarketSellOrder(symbol, qty);
  return order.id;
}

// Limit sell: place order slightly above current bid
export async function createLimitSell(
  symbol: string,
  qty: number,
  offsetPct: number,
): Promise<string> {
  const ex = getExchange();
  const ticker = await fetchTicker(symbol);
  const limitPrice = ticker.bid * (1 + offsetPct);

  log.trade(
    `LIMIT SELL ${qty.toFixed(6)} ${symbol} @ $${limitPrice.toFixed(2)} (bid: $${ticker.bid.toFixed(2)})`,
  );
  const order = await ex.createLimitSellOrder(symbol, qty, limitPrice);
  return order.id;
}
