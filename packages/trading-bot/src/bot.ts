import { fetchCandles, fetchTicker } from './exchange.js'
import { computeIndicators, generateSignal } from './strategy.js'
import { fetchSentiment } from './sentiment.js'
import { handleSignal, checkStopsAndTakeProfit } from './trader.js'
import { updatePrices } from './portfolio.js'
import { notifySignal, notifySentiment } from './discord.js'
import { config } from './config.js'
import { log } from './logger.js'

// Shared state for the UI
export interface BotState {
  running: boolean
  lastUpdate: number
  symbols: string[]
  prices: Record<string, number>
  signals: Record<string, ReturnType<typeof generateSignal>>
  sentiment: Awaited<ReturnType<typeof fetchSentiment>> | null
  errors: string[]
}

export const state: BotState = {
  running: false,
  lastUpdate: 0,
  symbols: config.bot.symbols,
  prices: {},
  signals: {},
  sentiment: null,
  errors: [],
}

let sentimentInterval: NodeJS.Timeout | null = null
let signalInterval: NodeJS.Timeout | null = null

// Refresh sentiment every 30 minutes
const SENTIMENT_INTERVAL_MS = 30 * 60 * 1000
// Check signals every 5 minutes (aligned with 1h candle updates)
const SIGNAL_INTERVAL_MS = 5 * 60 * 1000

async function refreshSentiment() {
  try {
    state.sentiment = await fetchSentiment()
    await notifySentiment(state.sentiment)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('Sentiment refresh failed', err)
    state.errors.push(`[sentiment] ${msg}`)
  }
}

async function checkSignals() {
  // Check stop-loss and take-profit on open positions first
  await checkStopsAndTakeProfit()

  const priceMap: Record<string, number> = {}

  await Promise.allSettled(
    config.bot.symbols.map(async symbol => {
      try {
        const [candles, ticker] = await Promise.all([
          fetchCandles(symbol, config.strategy.timeframe, config.strategy.candleLimit),
          fetchTicker(symbol),
        ])

        priceMap[symbol] = ticker.price

        const indicators = computeIndicators(candles)
        if (!indicators) {
          log.warn(`Not enough candle data for ${symbol}`)
          return
        }

        const sentimentScore = state.sentiment?.score ?? 0
        const signal = generateSignal(indicators, sentimentScore)
        state.signals[symbol] = signal

        if (signal.direction !== 'HOLD') {
          await notifySignal(symbol, signal)
          await handleSignal(symbol, signal)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`Signal check failed for ${symbol}`, err)
        state.errors.push(`[${symbol}] ${msg}`)
        // Keep last 50 errors
        if (state.errors.length > 50) state.errors.splice(0, state.errors.length - 50)
      }
    })
  )

  updatePrices(priceMap)
  Object.assign(state.prices, priceMap)
  state.lastUpdate = Date.now()
}

export async function startBot() {
  if (state.running) {
    log.warn('Bot already running')
    return
  }

  log.info(`Starting bot — symbols: ${config.bot.symbols.join(', ')}, dryRun: ${config.bot.dryRun}`)
  state.running = true

  // Initial runs
  await refreshSentiment()
  await checkSignals()

  // Recurring timers
  sentimentInterval = setInterval(refreshSentiment, SENTIMENT_INTERVAL_MS)
  signalInterval = setInterval(checkSignals, SIGNAL_INTERVAL_MS)

  log.info(`Bot running — signal check every ${SIGNAL_INTERVAL_MS / 60000}min, sentiment every ${SENTIMENT_INTERVAL_MS / 60000}min`)
}

export function stopBot() {
  if (sentimentInterval) clearInterval(sentimentInterval)
  if (signalInterval) clearInterval(signalInterval)
  state.running = false
  log.info('Bot stopped')
}
