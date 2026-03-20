import {
  createMarketBuy, createLimitBuy,
  createMarketSell, createLimitSell,
  fetchTicker,
} from './exchange.js'
import { openPosition, closePosition, hasPosition, getPosition, getAllPositions, getPortfolioSummary } from './portfolio.js'
import { config } from './config.js'
import { log } from './logger.js'
import type { Signal } from './strategy.js'

// Called every signal cycle — check stops/TPs before processing new signals
export async function checkStopsAndTakeProfit(): Promise<void> {
  const positions = getAllPositions()
  for (const pos of positions) {
    const ticker = await fetchTicker(pos.symbol).catch(() => null)
    if (!ticker) continue

    const pnlPct = (ticker.price - pos.entryPrice) / pos.entryPrice

    if (pnlPct <= -config.strategy.stopLossPct) {
      log.warn(`STOP LOSS triggered for ${pos.symbol}: ${(pnlPct * 100).toFixed(2)}% (entry $${pos.entryPrice} → $${ticker.price})`)
      await executeExit(pos.symbol, pos.qty, 'stop-loss')
    } else if (pnlPct >= config.strategy.takeProfitPct) {
      log.trade(`TAKE PROFIT triggered for ${pos.symbol}: +${(pnlPct * 100).toFixed(2)}%`)
      await executeExit(pos.symbol, pos.qty, 'take-profit')
    }
  }
}

export async function handleSignal(symbol: string, signal: Signal): Promise<void> {
  const { direction, strength, reasons } = signal

  log.signal(`${symbol} → ${direction} (strength: ${strength.toFixed(2)})`)
  reasons.forEach(r => log.debug(`  • ${r}`))

  if (direction === 'HOLD') return

  if (direction === 'BUY' && !hasPosition(symbol)) {
    await executeBuy(symbol, signal)
  } else if (direction === 'SELL' && hasPosition(symbol)) {
    const pos = getPosition(symbol)
    if (pos) await executeExit(symbol, pos.qty, 'signal')
  }
}

async function executeBuy(symbol: string, signal: Signal): Promise<void> {
  const portfolio = await getPortfolioSummary()
  if (!portfolio) return

  const usdAvailable = portfolio.usdFree
  const fee = config.strategy.useLimitOrders ? config.strategy.makerFeePct : config.strategy.takerFeePct
  // Signal strength scales trade size; subtract fee from available capital
  const riskAmount = usdAvailable * config.strategy.riskPerTrade * signal.strength * (1 - fee)

  if (riskAmount < 5) {
    log.warn(`Risk amount $${riskAmount.toFixed(2)} too small (min $5), skipping BUY`)
    return
  }

  const ticker = await fetchTicker(symbol)
  const fillPrice = config.strategy.useLimitOrders
    ? ticker.ask * (1 - config.strategy.limitOffsetPct)
    : ticker.price

  log.info(`Entry: $${riskAmount.toFixed(2)} | stop: -${(config.strategy.stopLossPct * 100).toFixed(1)}% ($${(fillPrice * (1 - config.strategy.stopLossPct)).toFixed(2)}) | tp: +${(config.strategy.takeProfitPct * 100).toFixed(1)}% ($${(fillPrice * (1 + config.strategy.takeProfitPct)).toFixed(2)}) | fee: ${(fee * 100).toFixed(2)}%`)

  if (config.bot.dryRun) {
    log.trade(`[DRY RUN] ${config.strategy.useLimitOrders ? 'LIMIT' : 'MARKET'} BUY ${symbol}: $${riskAmount.toFixed(2)} @ $${fillPrice.toFixed(2)}`)
    openPosition(symbol, riskAmount / fillPrice, fillPrice)
    return
  }

  try {
    if (config.strategy.useLimitOrders) {
      await createLimitBuy(symbol, riskAmount, config.strategy.limitOffsetPct)
    } else {
      await createMarketBuy(symbol, riskAmount)
    }
    openPosition(symbol, riskAmount / fillPrice, fillPrice)
  } catch (err) {
    log.error(`Failed to execute BUY for ${symbol}`, err)
  }
}

async function executeExit(symbol: string, qty: number, reason: string): Promise<void> {
  const ticker = await fetchTicker(symbol)
  const fee = config.strategy.useLimitOrders && reason === 'take-profit'
    ? config.strategy.makerFeePct
    : config.strategy.takerFeePct  // stop-loss always market (urgent)

  if (config.bot.dryRun) {
    log.trade(`[DRY RUN] SELL ${symbol}: ${qty.toFixed(6)} @ $${ticker.price.toFixed(2)} (reason: ${reason}, fee: ${(fee * 100).toFixed(2)}%)`)
    closePosition(symbol, ticker.price * (1 - fee))
    return
  }

  try {
    if (config.strategy.useLimitOrders && reason === 'take-profit') {
      await createLimitSell(symbol, qty, config.strategy.limitOffsetPct)
    } else {
      await createMarketSell(symbol, qty)
    }
    closePosition(symbol, ticker.price * (1 - fee))
  } catch (err) {
    log.error(`Failed to execute SELL for ${symbol} (${reason})`, err)
  }
}
