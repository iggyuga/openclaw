import { config } from "../config.js";
import type { Candle } from "../exchange.js";
import { computeIndicators, generateSignal } from "../strategy.js";

export interface BacktestTrade {
  symbol: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  costUsd: number;
  pnlUsd: number;
  pnlPct: number;
  durationHours: number;
  entryReasons: string[];
  exitReason: "signal" | "stop-loss" | "take-profit";
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  price: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  days: number;
  startDate: string;
  endDate: string;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalReturnPct: number;
  totalReturnUsd: number;
  maxDrawdownPct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  sharpeRatio: number;
  calmarRatio: number;
  avgDurationHours: number;
  bestTradePct: number;
  worstTradePct: number;
  finalEquity: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  stopLossHits: number;
  takeProfitHits: number;
  signalExits: number;
}

export function runBacktest(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  initialCapital = 10_000,
  riskPerTrade = config.strategy.riskPerTrade,
  feePct = config.strategy.makerFeePct,
  stopLossPct = config.strategy.stopLossPct,
  takeProfitPct = config.strategy.takeProfitPct,
): BacktestResult {
  const warmup = config.strategy.candleLimit;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  let capital = initialCapital;
  let position: {
    qty: number;
    entryPrice: number;
    entryTime: number;
    cost: number;
    reasons: string[];
    stopPrice: number;
    tpPrice: number;
  } | null = null;

  for (let i = warmup; i < candles.length - 1; i++) {
    const window = candles.slice(0, i + 1);
    const current = candles[i];
    const next = candles[i + 1];

    // ── Check SL / TP on open position ──────────────────────────────────
    if (position) {
      let exitReason: BacktestTrade["exitReason"] | null = null;
      let fillPrice = 0;

      // Check SL first (takes priority)
      if (current.low <= position.stopPrice) {
        exitReason = "stop-loss";
        fillPrice = position.stopPrice;
      } else if (current.high >= position.tpPrice) {
        exitReason = "take-profit";
        fillPrice = position.tpPrice;
      }

      if (exitReason && fillPrice > 0) {
        const proceeds = position.qty * fillPrice * (1 - feePct);
        const pnlUsd = proceeds - position.cost;
        const pnlPct = (pnlUsd / position.cost) * 100;
        const durationHours = (current.timestamp - position.entryTime) / 3_600_000;

        trades.push({
          symbol,
          entryTime: position.entryTime,
          exitTime: current.timestamp,
          entryPrice: position.entryPrice,
          exitPrice: fillPrice,
          qty: position.qty,
          costUsd: position.cost,
          pnlUsd,
          pnlPct,
          durationHours,
          entryReasons: position.reasons,
          exitReason,
        });

        capital += proceeds;
        position = null;

        // Record equity after SL/TP close
        equityCurve.push({ timestamp: current.timestamp, equity: capital, price: current.close });
        continue;
      }
    }

    // ── Compute signal ───────────────────────────────────────────────────
    const indicators = computeIndicators(window);
    if (!indicators) {
      continue;
    }

    const prevIndicators =
      i > warmup ? (computeIndicators(candles.slice(0, i)) ?? undefined) : undefined;

    // No live sentiment in backtest
    const signal = generateSignal(indicators, 0, prevIndicators);

    // ── Entry ────────────────────────────────────────────────────────────
    if (signal.direction === "BUY" && !position) {
      const riskAmount = capital * riskPerTrade * signal.strength;
      if (riskAmount < 5) {
        continue;
      }

      const fillPrice = next.open;
      const qty = riskAmount / fillPrice;
      const cost = qty * fillPrice * (1 + feePct);

      position = {
        qty,
        entryPrice: fillPrice,
        entryTime: next.timestamp,
        cost,
        reasons: signal.reasons,
        stopPrice: fillPrice * (1 - stopLossPct),
        tpPrice: fillPrice * (1 + takeProfitPct),
      };
      capital -= cost;

      // ── Signal-based exit ────────────────────────────────────────────────
    } else if (signal.direction === "SELL" && position) {
      const fillPrice = next.open;
      const proceeds = position.qty * fillPrice * (1 - feePct);
      const pnlUsd = proceeds - position.cost;
      const pnlPct = (pnlUsd / position.cost) * 100;
      const durationHours = (next.timestamp - position.entryTime) / 3_600_000;

      trades.push({
        symbol,
        entryTime: position.entryTime,
        exitTime: next.timestamp,
        entryPrice: position.entryPrice,
        exitPrice: fillPrice,
        qty: position.qty,
        costUsd: position.cost,
        pnlUsd,
        pnlPct,
        durationHours,
        entryReasons: position.reasons,
        exitReason: "signal",
      });

      capital += proceeds;
      position = null;
    }

    // ── Equity snapshot every 12 candles ─────────────────────────────────
    if (i % 12 === 0) {
      const unrealized = position ? position.qty * current.close - position.cost : 0;
      equityCurve.push({
        timestamp: current.timestamp,
        equity: capital + unrealized,
        price: current.close,
      });
    }
  }

  // ── Force-close any open position at last candle ─────────────────────────
  if (position) {
    const lastCandle = candles[candles.length - 1];
    const fillPrice = lastCandle.close;
    const proceeds = position.qty * fillPrice * (1 - feePct);
    const pnlUsd = proceeds - position.cost;
    const pnlPct = (pnlUsd / position.cost) * 100;
    const durationHours = (lastCandle.timestamp - position.entryTime) / 3_600_000;

    trades.push({
      symbol,
      entryTime: position.entryTime,
      exitTime: lastCandle.timestamp,
      entryPrice: position.entryPrice,
      exitPrice: fillPrice,
      qty: position.qty,
      costUsd: position.cost,
      pnlUsd,
      pnlPct,
      durationHours,
      entryReasons: position.reasons,
      exitReason: "signal",
    });

    capital += proceeds;
  }

  const days = Math.round(
    (candles[candles.length - 1].timestamp - candles[warmup].timestamp) / 86_400_000,
  );

  return {
    symbol,
    timeframe,
    days,
    startDate: new Date(candles[warmup].timestamp).toISOString().split("T")[0],
    endDate: new Date(candles[candles.length - 1].timestamp).toISOString().split("T")[0],
    trades,
    equityCurve,
    metrics: computeMetrics(trades, initialCapital, capital, days),
  };
}

function computeMetrics(
  trades: BacktestTrade[],
  initialCapital: number,
  finalEquity: number,
  days: number,
): BacktestMetrics {
  const empty: BacktestMetrics = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalReturnPct: 0,
    totalReturnUsd: 0,
    maxDrawdownPct: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    profitFactor: 0,
    sharpeRatio: 0,
    calmarRatio: 0,
    avgDurationHours: 0,
    bestTradePct: 0,
    worstTradePct: 0,
    finalEquity,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    stopLossHits: 0,
    takeProfitHits: 0,
    signalExits: 0,
  };
  if (!trades.length) {
    return empty;
  }

  const winners = trades.filter((t) => t.pnlPct > 0);
  const losers = trades.filter((t) => t.pnlPct <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlUsd, 0));
  const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;

  // Max drawdown
  let peak = initialCapital;
  let equity = initialCapital;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    equity += t.pnlUsd;
    if (equity > peak) {
      peak = equity;
    }
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDrawdownPct) {
      maxDrawdownPct = dd;
    }
  }

  // Sharpe (annualised, 0% risk-free)
  const returns = trades.map((t) => t.pnlPct / 100);
  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const avgDurHours = trades.reduce((s, t) => s + t.durationHours, 0) / trades.length;
  const tradesPerYear = (365 * 24) / (avgDurHours || 1);
  const sharpeRatio = stdDev > 0 ? (meanReturn * Math.sqrt(tradesPerYear)) / stdDev : 0;

  // Calmar = annualised return / max drawdown
  const annualisedReturn = days > 0 ? totalReturn * (365 / days) : 0;
  const calmarRatio = maxDrawdownPct > 0 ? annualisedReturn / maxDrawdownPct : 0;

  // Consecutive wins / losses
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let curWins = 0,
    curLosses = 0;
  for (const t of trades) {
    if (t.pnlPct > 0) {
      curWins++;
      curLosses = 0;
      if (curWins > maxConsecutiveWins) {
        maxConsecutiveWins = curWins;
      }
    } else {
      curLosses++;
      curWins = 0;
      if (curLosses > maxConsecutiveLosses) {
        maxConsecutiveLosses = curLosses;
      }
    }
  }

  return {
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: (winners.length / trades.length) * 100,
    totalReturnPct: totalReturn,
    totalReturnUsd: finalEquity - initialCapital,
    maxDrawdownPct,
    avgWinPct: winners.length ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0,
    avgLossPct: losers.length ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    sharpeRatio,
    calmarRatio,
    avgDurationHours: avgDurHours,
    bestTradePct: Math.max(...trades.map((t) => t.pnlPct)),
    worstTradePct: Math.min(...trades.map((t) => t.pnlPct)),
    finalEquity,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    stopLossHits: trades.filter((t) => t.exitReason === "stop-loss").length,
    takeProfitHits: trades.filter((t) => t.exitReason === "take-profit").length,
    signalExits: trades.filter((t) => t.exitReason === "signal").length,
  };
}
