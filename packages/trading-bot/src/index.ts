import 'dotenv/config'
import { config } from './config.js'
import { setLogLevel } from './logger.js'
import { startBot } from './bot.js'
import { startUI } from './ui/server.js'
import { notifyStartup } from './discord.js'
import { log } from './logger.js'

setLogLevel(config.bot.logLevel)

log.info('='.repeat(50))
log.info('Trading Bot')
log.info(`Symbols : ${config.bot.symbols.join(', ')}`)
log.info(`Mode    : ${config.bot.dryRun ? 'DRY RUN (no real orders)' : 'LIVE'}`)
log.info(`Timeframe: ${config.strategy.timeframe}`)
log.info('='.repeat(50))

// Start web dashboard
startUI()

// Notify Discord
await notifyStartup(config.bot.symbols, config.bot.dryRun)

// Start bot
await startBot()
