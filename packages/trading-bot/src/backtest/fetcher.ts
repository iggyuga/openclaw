import ccxt, { kraken as Kraken } from 'ccxt'
import { log } from '../logger.js'
import type { Candle } from '../exchange.js'

// Kraken: US-accessible, free public OHLCV, no API key needed
// Symbols match Coinbase format directly (ETH/USD, BTC/USD)

let kraken: Kraken

function getKraken() {
  if (!kraken) {
    kraken = new ccxt.kraken({ enableRateLimit: true })
  }
  return kraken
}

export async function fetchHistoricalCandles(
  symbol: string,
  timeframe: string,
  days: number,
): Promise<Candle[]> {
  const ex = getKraken()

  const msPerCandle = timeframeToMs(timeframe)
  const totalCandles = Math.ceil((days * 24 * 60 * 60 * 1000) / msPerCandle)
  const since = Date.now() - days * 24 * 60 * 60 * 1000

  log.info(`Fetching ${totalCandles} ${timeframe} candles for ${symbol} via Kraken (${days} days)...`)

  const allCandles: Candle[] = []
  let fromTs = since

  // Kraken returns max 720 candles per request — paginate
  while (allCandles.length < totalCandles) {
    const batch = await ex.fetchOHLCV(symbol, timeframe, fromTs, 720)
    if (!batch.length) break

    allCandles.push(...batch.map(candle => ({
      timestamp: candle[0] as number,
      open: candle[1] as number,
      high: candle[2] as number,
      low: candle[3] as number,
      close: candle[4] as number,
      volume: candle[5] as number,
    })))

    fromTs = (batch[batch.length - 1][0] as number) + msPerCandle
    if (fromTs >= Date.now()) break

    log.debug(`  fetched ${allCandles.length}/${totalCandles} candles...`)
  }

  log.info(`Fetched ${allCandles.length} candles total`)
  return allCandles
}

function timeframeToMs(timeframe: string): number {
  const units: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  const match = timeframe.match(/^(\d+)([mhd])$/)
  if (!match) throw new Error(`Unknown timeframe: ${timeframe}`)
  return parseInt(match[1], 10) * units[match[2]]
}
