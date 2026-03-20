import { EMA, RSI, BollingerBands, MACD, ATR, SMA } from "technicalindicators";
import { config } from "./config.js";
import type { Candle } from "./exchange.js";

export type SignalDirection = "BUY" | "SELL" | "HOLD";

export interface IndicatorSnapshot {
  emaFast: number;
  emaSlow: number;
  emaLong: number;
  rsi: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  atr: number;
  price: number;
  volume: number;
  avgVolume: number;
}

export interface SignalBreakdown {
  reason: string;
  points: number;
  side: "bull" | "bear";
}

export interface Signal {
  direction: SignalDirection;
  strength: number; // 0–1, how confident
  reasons: string[];
  breakdown: SignalBreakdown[];
  indicators: IndicatorSnapshot;
  timestamp: number;
}

export function computeIndicators(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < config.strategy.candleLimit / 2) {
    return null;
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const emaFastValues = EMA.calculate({ period: config.strategy.emaFast, values: closes });
  const emaSlowValues = EMA.calculate({ period: config.strategy.emaSlow, values: closes });
  const emaLongValues = EMA.calculate({ period: config.strategy.emaLong, values: closes });
  const rsiValues = RSI.calculate({ period: config.strategy.rsiPeriod, values: closes });
  const bbValues = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const macdValues = MACD.calculate({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    values: closes,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const atrValues = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const avgVolumeValues = SMA.calculate({ period: 20, values: volumes });

  const last = <T>(arr: T[]): T => arr[arr.length - 1];

  const bb = last(bbValues);
  const macd = last(macdValues);
  if (!bb || !macd) {
    return null;
  }

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
    volume: last(volumes),
    avgVolume: last(avgVolumeValues) ?? last(volumes),
  };
}

/**
 * ATR-based position sizing.
 * Uses 1.5x ATR as stop distance so volatile assets get smaller positions.
 * Returns USD amount to deploy (not qty).
 */
export function computePositionSizeByATR(
  capital: number,
  atr: number,
  price: number,
  riskPct: number,
): number {
  if (atr <= 0 || price <= 0) {
    return capital * riskPct;
  }
  const stopDistance = atr * 1.5; // stop placed 1.5 ATR from entry
  const stopPct = stopDistance / price;
  const riskAmount = capital * riskPct; // max USD we're willing to lose on the trade
  const positionUsd = riskAmount / stopPct;
  return Math.min(positionUsd, capital * 0.2); // hard cap at 20% of capital
}

export function generateSignal(
  indicators: IndicatorSnapshot,
  sentimentScore: number,
  prevIndicators?: IndicatorSnapshot,
): Signal {
  const {
    emaFast,
    emaSlow,
    emaLong,
    rsi,
    price,
    bbLower,
    bbUpper,
    macdHistogram,
    macdLine,
    macdSignal,
    volume,
    avgVolume,
  } = indicators;

  const breakdown: SignalBreakdown[] = [];
  let bullishPoints = 0;
  let bearishPoints = 0;

  const addBull = (reason: string, pts: number) => {
    bullishPoints += pts;
    breakdown.push({ reason, points: pts, side: "bull" });
  };
  const addBear = (reason: string, pts: number) => {
    bearishPoints += pts;
    breakdown.push({ reason, points: pts, side: "bear" });
  };

  // ── Trend: EMA stack ──────────────────────────────────────────────────────
  if (emaFast > emaSlow && emaSlow > emaLong) {
    addBull("EMA stack bullish (fast > slow > long)", 2);
  } else if (emaFast < emaSlow && emaSlow < emaLong) {
    addBear("EMA stack bearish (fast < slow < long)", 2);
  }

  // ── EMA fast vs slow ─────────────────────────────────────────────────────
  if (emaFast > emaSlow) {
    addBull("EMA fast above slow", 1);
  } else {
    addBear("EMA fast below slow", 1);
  }

  // ── Fresh EMA crossover ──────────────────────────────────────────────────
  if (prevIndicators) {
    const wasAbove = prevIndicators.emaFast > prevIndicators.emaSlow;
    const isAbove = emaFast > emaSlow;
    if (!wasAbove && isAbove) {
      addBull("Fresh bullish EMA crossover (fast crossed above slow)", 1);
    } else if (wasAbove && !isAbove) {
      addBear("Fresh bearish EMA crossover (fast crossed below slow)", 1);
    }
  }

  // ── RSI with tiers ───────────────────────────────────────────────────────
  if (rsi < config.strategy.rsiOversold) {
    addBull(`RSI oversold (${rsi.toFixed(1)})`, 2);
  } else if (rsi > config.strategy.rsiOverbought) {
    addBear(`RSI overbought (${rsi.toFixed(1)})`, 2);
  } else if (rsi >= 30 && rsi < 45) {
    addBull(`RSI in recovery zone (${rsi.toFixed(1)})`, 0.5);
  } else if (rsi > 55 && rsi <= 70) {
    addBear(`RSI in distribution zone (${rsi.toFixed(1)})`, 0.5);
  } else if (rsi < 50) {
    addBull("RSI below midline", 0.25);
  } else {
    addBear("RSI above midline", 0.25);
  }

  // ── Bollinger Band mean reversion ────────────────────────────────────────
  if (price < bbLower) {
    addBull("Price below lower Bollinger Band (mean reversion opportunity)", 1.5);
  } else if (price > bbUpper) {
    addBear("Price above upper Bollinger Band (overbought)", 1.5);
  }

  // ── MACD ─────────────────────────────────────────────────────────────────
  if (macdHistogram > 0 && macdLine > macdSignal) {
    addBull("MACD histogram positive, bullish crossover", 1);
  } else if (macdHistogram < 0 && macdLine < macdSignal) {
    addBear("MACD histogram negative, bearish crossover", 1);
  }

  // ── Volume confirmation ───────────────────────────────────────────────────
  if (avgVolume > 0) {
    const volRatio = volume / avgVolume;
    if (volRatio >= 1.5) {
      if (bullishPoints >= bearishPoints) {
        addBull(`Volume surge confirms breakout (${volRatio.toFixed(1)}x avg)`, 1);
      } else {
        addBear(`Volume surge confirms breakdown (${volRatio.toFixed(1)}x avg)`, 1);
      }
    }
  }

  // ── Sentiment overlay ─────────────────────────────────────────────────────
  if (sentimentScore > 0.3) {
    addBull(`Sentiment bullish (score: ${sentimentScore.toFixed(2)})`, 1);
  } else if (sentimentScore < -0.3) {
    addBear(`Sentiment bearish (score: ${sentimentScore.toFixed(2)})`, 1);
  }

  const total = bullishPoints + bearishPoints;
  const netBull = total > 0 ? (bullishPoints - bearishPoints) / total : 0;

  let direction: SignalDirection = "HOLD";
  let strength = 0;

  if (netBull > 0.3) {
    direction = "BUY";
    strength = Math.min(netBull, 1);
  } else if (netBull < -0.3) {
    direction = "SELL";
    strength = Math.min(Math.abs(netBull), 1);
  }

  return {
    direction,
    strength,
    reasons: breakdown.map((b) => b.reason),
    breakdown,
    indicators,
    timestamp: Date.now(),
  };
}
