/**
 * Triangular Arbitrage Strategy
 *
 * Exploits price discrepancies between three trading pairs on Coinbase.
 * Example cycle: USD → BTC → ETH → USD
 *
 * If the product of the three conversion rates > 1 (after fees),
 * a risk-free profit opportunity exists.
 *
 * Runs on a tight loop (every 10s) independently of the main signal bot.
 */

import { config } from "./config.js";
import { notifyArbitrage } from "./discord.js";
import { getExchange, fetchTicker } from "./exchange.js";
import { log } from "./logger.js";

export interface ArbitrageOpportunity {
  cycle: [string, string, string]; // e.g. ["BTC/USD", "ETH/BTC", "ETH/USD"]
  directions: [ArbitrageDirection, ArbitrageDirection, ArbitrageDirection];
  rates: [number, number, number];
  impliedRate: number; // product of all three — >1 means profit
  profitPct: number; // after fees
  startUsd: number;
  endUsd: number;
  timestamp: number;
}

type ArbitrageDirection = "buy" | "sell";

// Triangular cycles to monitor
// Each cycle is [leg1, leg2, leg3] with direction (buy/sell base asset)
const CYCLES: Array<{
  legs: [string, string, string];
  dirs: [ArbitrageDirection, ArbitrageDirection, ArbitrageDirection];
}> = [
  // USD → BTC → ETH → USD
  // Buy BTC with USD, buy ETH with BTC, sell ETH for USD
  {
    legs: ["BTC/USD", "ETH/BTC", "ETH/USD"],
    dirs: ["buy", "buy", "sell"],
  },
  // USD → ETH → BTC → USD
  // Buy ETH with USD, sell ETH for BTC, sell BTC for USD
  {
    legs: ["ETH/USD", "ETH/BTC", "BTC/USD"],
    dirs: ["buy", "sell", "sell"],
  },
  // USD → BTC → SOL (via SOL/BTC if available) → USD — add more cycles as needed
];

// Minimum profit after fees to execute (0.002 = 0.2%)
const MIN_PROFIT_PCT = parseFloat(process.env.ARB_MIN_PROFIT_PCT ?? "0.002");

// Capital to deploy per arbitrage opportunity (USD)
const ARB_CAPITAL_USD = parseFloat(process.env.ARB_CAPITAL_USD ?? "500");

// Check interval in ms
const ARB_INTERVAL_MS = parseInt(process.env.ARB_INTERVAL_MS ?? "10000", 10);

// Stats
export interface ArbitrageStats {
  checksRun: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  totalProfitUsd: number;
  lastCheck: number;
  lastOpportunity: ArbitrageOpportunity | null;
  recentOpportunities: ArbitrageOpportunity[];
}

export const arbStats: ArbitrageStats = {
  checksRun: 0,
  opportunitiesFound: 0,
  tradesExecuted: 0,
  totalProfitUsd: 0,
  lastCheck: 0,
  lastOpportunity: null,
  recentOpportunities: [],
};

/**
 * Given a direction and a ticker, return the effective rate:
 * - "buy"  → you spend quote to get base → rate = 1 / ask
 * - "sell" → you spend base to get quote → rate = bid
 */
function effectiveRate(dir: ArbitrageDirection, bid: number, ask: number, feePct: number): number {
  if (dir === "buy") {
    // Paying ask price, taker fee applies
    return (1 / ask) * (1 - feePct);
  } else {
    // Receiving bid price, taker fee applies
    return bid * (1 - feePct);
  }
}

/**
 * Check a single triangular cycle for arbitrage.
 * Returns opportunity if profitable, null otherwise.
 */
async function checkCycle(
  legs: [string, string, string],
  dirs: [ArbitrageDirection, ArbitrageDirection, ArbitrageDirection],
  capitalUsd: number,
): Promise<ArbitrageOpportunity | null> {
  const fee = config.strategy.takerFeePct; // arb uses market orders (speed > fee savings)

  try {
    const [t1, t2, t3] = await Promise.all([
      fetchTicker(legs[0]),
      fetchTicker(legs[1]),
      fetchTicker(legs[2]),
    ]);

    const tickers = [t1, t2, t3];
    const rates = dirs.map((dir, i) => effectiveRate(dir, tickers[i].bid, tickers[i].ask, fee)) as [
      number,
      number,
      number,
    ];

    // Implied rate: multiply all three conversion rates
    // >1 means we end up with more USD than we started with
    const impliedRate = rates[0] * rates[1] * rates[2];
    const profitPct = (impliedRate - 1) * 100;

    if (profitPct <= MIN_PROFIT_PCT * 100) return null;

    const endUsd = capitalUsd * impliedRate;

    return {
      cycle: legs,
      directions: dirs,
      rates,
      impliedRate,
      profitPct,
      startUsd: capitalUsd,
      endUsd,
      timestamp: Date.now(),
    };
  } catch (err) {
    log.debug(`Arb cycle check failed for ${legs.join("→")}: ${err}`);
    return null;
  }
}

/**
 * Execute a triangular arbitrage opportunity.
 * Fires three sequential market orders. Speed matters — any delay
 * risks the opportunity disappearing.
 */
async function executeArbitrage(opp: ArbitrageOpportunity): Promise<void> {
  const ex = getExchange();
  const { cycle, directions, startUsd } = opp;

  log.trade(
    `⚡ ARB EXECUTING: ${cycle.join(" → ")} | profit: +${opp.profitPct.toFixed(3)}% | $${(opp.endUsd - opp.startUsd).toFixed(2)} expected`,
  );

  if (config.bot.dryRun) {
    log.trade(
      `[DRY RUN] Would execute: ${cycle[0]} ${directions[0].toUpperCase()} → ${cycle[1]} ${directions[1].toUpperCase()} → ${cycle[2]} ${directions[2].toUpperCase()}`,
    );
    arbStats.tradesExecuted++;
    arbStats.totalProfitUsd += opp.endUsd - opp.startUsd;
    await notifyArbitrage(opp);
    return;
  }

  try {
    let currentUsd = startUsd;

    for (let i = 0; i < 3; i++) {
      const symbol = cycle[i];
      const dir = directions[i];
      const ticker = await fetchTicker(symbol);

      if (dir === "buy") {
        // currentUsd → base asset
        const qty = currentUsd / ticker.ask;
        log.trade(`  Leg ${i + 1}: MARKET BUY ${qty.toFixed(6)} ${symbol}`);
        await ex.createMarketBuyOrder(symbol, qty);
        currentUsd = qty; // now holding base asset units
      } else {
        // currentUsd (base units) → USD
        log.trade(`  Leg ${i + 1}: MARKET SELL ${currentUsd.toFixed(6)} ${symbol}`);
        await ex.createMarketSellOrder(symbol, currentUsd);
        currentUsd = currentUsd * ticker.bid; // back to USD
      }
    }

    const actualProfit = currentUsd - startUsd;
    arbStats.tradesExecuted++;
    arbStats.totalProfitUsd += actualProfit;

    log.trade(
      `✅ ARB COMPLETE: +$${actualProfit.toFixed(2)} profit | total: $${arbStats.totalProfitUsd.toFixed(2)}`,
    );

    await notifyArbitrage(opp);
  } catch (err) {
    log.error(`Arbitrage execution failed mid-cycle — check positions immediately!`, err);
  }
}

let arbInterval: NodeJS.Timeout | null = null;

/**
 * Main arbitrage scanner loop.
 * Checks all cycles every ARB_INTERVAL_MS and executes if profitable.
 */
async function scanArbitrage(): Promise<void> {
  arbStats.checksRun++;
  arbStats.lastCheck = Date.now();

  const checks = CYCLES.map((c) => checkCycle(c.legs, c.dirs, ARB_CAPITAL_USD));

  const results = await Promise.all(checks);
  const opportunities = results.filter((r): r is ArbitrageOpportunity => r !== null);

  if (opportunities.length === 0) return;

  // Take the best opportunity
  const best = opportunities.sort((a, b) => b.profitPct - a.profitPct)[0];

  arbStats.opportunitiesFound++;
  arbStats.lastOpportunity = best;
  arbStats.recentOpportunities = [best, ...arbStats.recentOpportunities].slice(0, 20);

  log.signal(
    `⚡ ARB OPPORTUNITY: ${best.cycle.join("→")} | +${best.profitPct.toFixed(3)}% | $${(best.endUsd - best.startUsd).toFixed(2)}`,
  );

  await executeArbitrage(best);
}

export function startArbitrage(): void {
  if (arbInterval) {
    log.warn("Arbitrage scanner already running");
    return;
  }

  log.info(
    `⚡ Arbitrage scanner starting — checking ${CYCLES.length} cycles every ${ARB_INTERVAL_MS / 1000}s | min profit: ${(MIN_PROFIT_PCT * 100).toFixed(2)}% | capital: $${ARB_CAPITAL_USD}`,
  );

  // Run immediately, then on interval
  scanArbitrage();
  arbInterval = setInterval(scanArbitrage, ARB_INTERVAL_MS);
}

export function stopArbitrage(): void {
  if (arbInterval) {
    clearInterval(arbInterval);
    arbInterval = null;
    log.info("Arbitrage scanner stopped");
  }
}
