import { startArbitrage, stopArbitrage, arbStats } from "./arbitrage.js";
import { config } from "./config.js";
import { notifySignal, notifySentiment } from "./discord.js";
import { fetchCandles, fetchTicker, isLiquid } from "./exchange.js";
import { log } from "./logger.js";
import { updatePrices } from "./portfolio.js";
import { fetchSentiment } from "./sentiment.js";
import { computeIndicators, generateSignal } from "./strategy.js";
import { handleSignal, checkStopsAndTakeProfit } from "./trader.js";

// Shared state for the UI
export interface BotState {
  running: boolean;
  lastUpdate: number;
  symbols: string[];
  prices: Record<string, number>;
  signals: Record<string, ReturnType<typeof generateSignal>>;
  sentiment: Awaited<ReturnType<typeof fetchSentiment>> | null;
  errors: string[];
  arbitrage: typeof arbStats;
}

export const state: BotState = {
  running: false,
  lastUpdate: 0,
  symbols: config.bot.symbols,
  prices: {},
  signals: {},
  sentiment: null,
  errors: [],
  arbitrage: arbStats,
};

let sentimentInterval: NodeJS.Timeout | null = null;
let signalInterval: NodeJS.Timeout | null = null;

// Refresh sentiment every 30 minutes
const SENTIMENT_INTERVAL_MS = 30 * 60 * 1000;
// Check signals every 5 minutes (aligned with 1h candle updates)
const SIGNAL_INTERVAL_MS = 5 * 60 * 1000;

async function refreshSentiment() {
  try {
    state.sentiment = await fetchSentiment();
    await notifySentiment(state.sentiment);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Sentiment refresh failed", err);
    state.errors.push(`[sentiment] ${msg}`);
  }
}

async function checkSignals() {
  // Check stop-loss and take-profit on open positions first
  await checkStopsAndTakeProfit();

  const priceMap: Record<string, number> = {};

  await Promise.allSettled(
    config.bot.symbols.map(async (symbol) => {
      try {
        // Guard: skip illiquid / meme pairs
        const liquid = await isLiquid(symbol, config.bot.minLiquidityUsd);
        if (!liquid) {
          return;
        }

        const [candles, ticker] = await Promise.all([
          fetchCandles(symbol, config.strategy.timeframe, config.strategy.candleLimit),
          fetchTicker(symbol),
        ]);

        priceMap[symbol] = ticker.price;

        const indicators = computeIndicators(candles);
        if (!indicators) {
          log.warn(`Not enough candle data for ${symbol}`);
          return;
        }

        // Compute prev indicators for crossover detection (second-to-last candle window)
        const prevIndicators =
          candles.length > 2 ? (computeIndicators(candles.slice(0, -1)) ?? undefined) : undefined;

        const sentimentScore = state.sentiment?.score ?? 0;
        const signal = generateSignal(indicators, sentimentScore, prevIndicators);
        state.signals[symbol] = signal;

        if (signal.direction !== "HOLD") {
          await notifySignal(symbol, signal);
          await handleSignal(symbol, signal);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Signal check failed for ${symbol}`, err);
        state.errors.push(`[${symbol}] ${msg}`);
        // Keep last 50 errors
        if (state.errors.length > 50) {
          state.errors.splice(0, state.errors.length - 50);
        }
      }
    }),
  );

  updatePrices(priceMap);
  Object.assign(state.prices, priceMap);
  state.lastUpdate = Date.now();
}

export async function startBot() {
  if (state.running) {
    log.warn("Bot already running");
    return;
  }

  log.info(
    `Starting bot — symbols: ${config.bot.symbols.join(", ")}, dryRun: ${config.bot.dryRun}`,
  );
  state.running = true;

  // Initial runs
  await refreshSentiment();
  await checkSignals();

  // Recurring timers
  sentimentInterval = setInterval(refreshSentiment, SENTIMENT_INTERVAL_MS);
  signalInterval = setInterval(checkSignals, SIGNAL_INTERVAL_MS);

  // Arbitrage scanner
  if (config.arbitrage.enabled) {
    startArbitrage();
  }

  log.info(
    `Bot running — signal check every ${SIGNAL_INTERVAL_MS / 60000}min, sentiment every ${SENTIMENT_INTERVAL_MS / 60000}min`,
  );
}

export function stopBot() {
  if (sentimentInterval) {
    clearInterval(sentimentInterval);
  }
  if (signalInterval) {
    clearInterval(signalInterval);
  }
  stopArbitrage();
  state.running = false;
  log.info("Bot stopped");
}
