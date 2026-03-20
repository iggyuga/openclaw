import {
  EMA,
  RSI,
  BollingerBands,
  MACD,
  ATR,
} from 'technicalindicators'
import type { Candle } from './exchange.js'
import { config } from './config.js'

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD'

export interface IndicatorSnapshot {
  emaFast: number
  emaSlow: number
  emaLong: number
  rsi: number
  bbUpper: number
  bbMiddle: number
  bbLower: number
  macdLine: number
  macdSignal: number
  macdHistogram: number
  atr: number
  price: number
}

export interface Signal {
  direction: SignalDirection
  strength: number       // 0–1, how confident
  reasons: string[]
  indicators: IndicatorSnapshot
  timestamp: number
}

export function computeIndicators(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < config.strategy.candleLimit / 2) return null

  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)

  const emaFastValues = EMA.calculate({ period: config.strategy.emaFast, values: closes })
  const emaSlowValues = EMA.calculate({ period: config.strategy.emaSlow, values: closes })
  const emaLongValues = EMA.calculate({ period: config.strategy.emaLong, values: closes })
  const rsiValues = RSI.calculate({ period: config.strategy.rsiPeriod, values: closes })
  const bbValues = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes })
  const macdValues = MACD.calculate({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    values: closes,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  })
  const atrValues = ATR.calculate({ period: 14, high: highs, low: lows, close: closes })

  // All arrays have different lengths due to indicator warmup — take last value
  const last = <T>(arr: T[]): T => arr[arr.length - 1]

  const bb = last(bbValues)
  const macd = last(macdValues)

  if (!bb || !macd) return null

  return {
    price: last(closes),
    emaFast: last(emaFastValues),
    emaSlow: last(emaSlowValues),
    emaLong: last(emaLongValues),
    rsi: last(rsiValues),
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    macdLine: macd.MACD ?? 0,
    macdSignal: macd.signal ?? 0,
    macdHistogram: macd.histogram ?? 0,
    atr: last(atrValues),
  }
}

export function generateSignal(indicators: IndicatorSnapshot, sentimentScore: number): Signal {
  const { emaFast, emaSlow, emaLong, rsi, price, bbLower, bbUpper, macdHistogram, macdLine, macdSignal } = indicators
  const reasons: string[] = []
  let bullishPoints = 0
  let bearishPoints = 0

  // --- Trend: EMA stack ---
  if (emaFast > emaSlow && emaSlow > emaLong) {
    bullishPoints += 2
    reasons.push('EMA stack bullish (fast > slow > long)')
  } else if (emaFast < emaSlow && emaSlow < emaLong) {
    bearishPoints += 2
    reasons.push('EMA stack bearish (fast < slow < long)')
  }

  // --- EMA crossover signal ---
  if (emaFast > emaSlow) {
    bullishPoints += 1
    reasons.push('EMA fast above slow')
  } else {
    bearishPoints += 1
    reasons.push('EMA fast below slow')
  }

  // --- RSI ---
  if (rsi < config.strategy.rsiOversold) {
    bullishPoints += 2
    reasons.push(`RSI oversold (${rsi.toFixed(1)})`)
  } else if (rsi > config.strategy.rsiOverbought) {
    bearishPoints += 2
    reasons.push(`RSI overbought (${rsi.toFixed(1)})`)
  } else if (rsi < 50) {
    bullishPoints += 0.5
  } else {
    bearishPoints += 0.5
  }

  // --- Bollinger Band mean reversion ---
  if (price < bbLower) {
    bullishPoints += 1.5
    reasons.push('Price below lower Bollinger Band (mean reversion opportunity)')
  } else if (price > bbUpper) {
    bearishPoints += 1.5
    reasons.push('Price above upper Bollinger Band (overbought)')
  }

  // --- MACD ---
  if (macdHistogram > 0 && macdLine > macdSignal) {
    bullishPoints += 1
    reasons.push('MACD histogram positive, bullish crossover')
  } else if (macdHistogram < 0 && macdLine < macdSignal) {
    bearishPoints += 1
    reasons.push('MACD histogram negative, bearish crossover')
  }

  // --- Sentiment overlay ---
  // sentimentScore: -1 (very bearish) to +1 (very bullish)
  if (sentimentScore > 0.3) {
    bullishPoints += 1
    reasons.push(`Sentiment bullish (score: ${sentimentScore.toFixed(2)})`)
  } else if (sentimentScore < -0.3) {
    bearishPoints += 1
    reasons.push(`Sentiment bearish (score: ${sentimentScore.toFixed(2)})`)
  }

  const total = bullishPoints + bearishPoints
  const netBull = (bullishPoints - bearishPoints) / total

  let direction: SignalDirection = 'HOLD'
  let strength = 0

  if (netBull > 0.3) {
    direction = 'BUY'
    strength = Math.min(netBull, 1)
  } else if (netBull < -0.3) {
    direction = 'SELL'
    strength = Math.min(Math.abs(netBull), 1)
  }

  return {
    direction,
    strength,
    reasons,
    indicators,
    timestamp: Date.now(),
  }
}
