import { computeIndicators, generateSignal } from '../strategy.js'
import { config } from '../config.js'
import type { Candle } from '../exchange.js'

export interface BacktestTrade {
  symbol: string
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  qty: number
  costUsd: number
  pnlUsd: number
  pnlPct: number
  durationHours: number
  entryReasons: string[]
}

export interface EquityPoint {
  timestamp: number
  equity: number
  price: number
}

export interface BacktestResult {
  symbol: string
  timeframe: string
  days: number
  startDate: string
  endDate: string
  trades: BacktestTrade[]
  equityCurve: EquityPoint[]
  metrics: BacktestMetrics
}

export interface BacktestMetrics {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  totalReturnPct: number
  totalReturnUsd: number
  maxDrawdownPct: number
  avgWinPct: number
  avgLossPct: number
  profitFactor: number    // gross profit / gross loss
  sharpeRatio: number
  avgDurationHours: number
  bestTradePct: number
  worstTradePct: number
  finalEquity: number
}

export function runBacktest(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  initialCapital = 10_000,
  riskPerTrade = config.strategy.riskPerTrade,
  feePct = config.strategy.makerFeePct,  // use maker fee (limit orders)
): BacktestResult {
  const warmup = config.strategy.candleLimit
  const trades: BacktestTrade[] = []
  const equityCurve: EquityPoint[] = []

  let capital = initialCapital
  let position: { qty: number; entryPrice: number; entryTime: number; cost: number; reasons: string[] } | null = null

  // Walk forward candle by candle starting after warmup
  for (let i = warmup; i < candles.length - 1; i++) {
    const window = candles.slice(0, i + 1)
    const current = candles[i]
    const next = candles[i + 1]  // fills execute at next open (no lookahead)

    const indicators = computeIndicators(window)
    if (!indicators) continue

    // No sentiment in backtest (historical sentiment not available) — use 0 (neutral)
    const signal = generateSignal(indicators, 0)

    if (signal.direction === 'BUY' && !position) {
      const riskAmount = capital * riskPerTrade * signal.strength
      if (riskAmount < 5) continue

      const fillPrice = next.open  // realistic: fills at next candle open
      const qty = riskAmount / fillPrice
      const cost = qty * fillPrice * (1 + feePct)  // entry fee

      position = {
        qty,
        entryPrice: fillPrice,
        entryTime: next.timestamp,
        cost,
        reasons: signal.reasons,
      }
      capital -= cost

    } else if (signal.direction === 'SELL' && position) {
      const fillPrice = next.open
      const proceeds = position.qty * fillPrice * (1 - feePct)  // exit fee
      const pnlUsd = proceeds - position.cost
      const pnlPct = (pnlUsd / position.cost) * 100
      const durationHours = (next.timestamp - position.entryTime) / 3_600_000

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
      })

      capital += proceeds
      position = null
    }

    // Record equity snapshot every ~12 candles to keep curve manageable
    if (i % 12 === 0) {
      const unrealized = position ? position.qty * current.close - position.cost : 0
      equityCurve.push({ timestamp: current.timestamp, equity: capital + unrealized, price: current.close })
    }
  }

  // Close any open position at last candle close
  if (position) {
    const lastCandle = candles[candles.length - 1]
    const fillPrice = lastCandle.close
    const proceeds = position.qty * fillPrice * (1 - feePct)
    const pnlUsd = proceeds - position.cost
    const pnlPct = (pnlUsd / position.cost) * 100
    const durationHours = (lastCandle.timestamp - position.entryTime) / 3_600_000

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
    })

    capital += proceeds
  }

  const days = Math.round((candles[candles.length - 1].timestamp - candles[warmup].timestamp) / 86_400_000)

  return {
    symbol,
    timeframe,
    days,
    startDate: new Date(candles[warmup].timestamp).toISOString().split('T')[0],
    endDate: new Date(candles[candles.length - 1].timestamp).toISOString().split('T')[0],
    trades,
    equityCurve,
    metrics: computeMetrics(trades, initialCapital, capital),
  }
}

function computeMetrics(
  trades: BacktestTrade[],
  initialCapital: number,
  finalEquity: number,
): BacktestMetrics {
  if (!trades.length) {
    return {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
      totalReturnPct: 0, totalReturnUsd: 0, maxDrawdownPct: 0,
      avgWinPct: 0, avgLossPct: 0, profitFactor: 0, sharpeRatio: 0,
      avgDurationHours: 0, bestTradePct: 0, worstTradePct: 0, finalEquity,
    }
  }

  const winners = trades.filter(t => t.pnlPct > 0)
  const losers  = trades.filter(t => t.pnlPct <= 0)

  const grossProfit = winners.reduce((s, t) => s + t.pnlUsd, 0)
  const grossLoss   = Math.abs(losers.reduce((s, t) => s + t.pnlUsd, 0))

  // Max drawdown — walk equity curve
  let peak = initialCapital
  let equity = initialCapital
  let maxDrawdownPct = 0
  for (const t of trades) {
    equity += t.pnlUsd
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak * 100
    if (dd > maxDrawdownPct) maxDrawdownPct = dd
  }

  // Sharpe ratio (annualised, using per-trade returns, assuming 0 risk-free rate)
  const returns = trades.map(t => t.pnlPct / 100)
  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length
  const stdDev = Math.sqrt(variance)
  const tradesPerYear = (365 * 24) / (trades.reduce((s, t) => s + t.durationHours, 0) / trades.length || 1)
  const sharpeRatio = stdDev > 0 ? (meanReturn * Math.sqrt(tradesPerYear)) / stdDev : 0

  return {
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: (winners.length / trades.length) * 100,
    totalReturnPct: ((finalEquity - initialCapital) / initialCapital) * 100,
    totalReturnUsd: finalEquity - initialCapital,
    maxDrawdownPct,
    avgWinPct: winners.length ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0,
    avgLossPct: losers.length  ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length  : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    sharpeRatio,
    avgDurationHours: trades.reduce((s, t) => s + t.durationHours, 0) / trades.length,
    bestTradePct:  Math.max(...trades.map(t => t.pnlPct)),
    worstTradePct: Math.min(...trades.map(t => t.pnlPct)),
    finalEquity,
  }
}
