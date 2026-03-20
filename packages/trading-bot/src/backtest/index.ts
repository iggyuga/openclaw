import 'dotenv/config'
import { fetchHistoricalCandles } from './fetcher.js'
import { runBacktest } from './runner.js'
import { printReport, toJSON } from './report.js'
import { setLogLevel } from '../logger.js'
import { config } from '../config.js'

setLogLevel('info')

// Parse CLI args: --symbol ETH/USD --days 180 --capital 10000 --timeframe 1h --json
const args = process.argv.slice(2)
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? (args[i + 1] ?? fallback) : fallback
}

const symbol    = arg('symbol', config.bot.symbols[0])
const days      = parseInt(arg('days', '180'), 10)
const capital   = parseFloat(arg('capital', '10000'))
const timeframe = arg('timeframe', config.strategy.timeframe)
const jsonMode  = args.includes('--json')

console.log(`\nRunning backtest: ${symbol} | ${days} days | ${timeframe} | $${capital} capital`)

const candles = await fetchHistoricalCandles(symbol, timeframe, days)

if (candles.length < 300) {
  console.error(`Not enough candles (${candles.length}) — need at least 300 for warmup. Try more days.`)
  process.exit(1)
}

const result = runBacktest(symbol, timeframe, candles, capital)

if (jsonMode) {
  console.log(toJSON(result))
} else {
  printReport(result)
}
