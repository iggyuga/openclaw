import { config } from './config.js'
import { log } from './logger.js'
import type { Signal } from './strategy.js'
import type { SentimentSnapshot } from './sentiment.js'

async function postWebhook(payload: object): Promise<void> {
  const url = config.discord.webhookUrl
  if (!url) return

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) log.warn(`Discord webhook returned ${res.status}`)
  } catch (err) {
    log.warn('Discord webhook failed', err)
  }
}

const COLORS = {
  BUY: 0x00c851,   // green
  SELL: 0xff4444,  // red
  HOLD: 0x6c757d,  // gray
  INFO: 0x33b5e5,  // blue
}

export async function notifySignal(symbol: string, signal: Signal): Promise<void> {
  if (signal.direction === 'HOLD') return

  const { direction, strength, reasons, indicators } = signal
  const { price, emaFast, emaSlow, rsi } = indicators

  await postWebhook({
    embeds: [{
      title: `${direction === 'BUY' ? '🟢' : '🔴'} ${direction} Signal — ${symbol}`,
      color: COLORS[direction],
      fields: [
        { name: 'Price', value: `$${price.toLocaleString()}`, inline: true },
        { name: 'Strength', value: `${(strength * 100).toFixed(0)}%`, inline: true },
        { name: 'RSI', value: rsi.toFixed(1), inline: true },
        { name: 'EMA Fast/Slow', value: `${emaFast.toFixed(2)} / ${emaSlow.toFixed(2)}`, inline: true },
        { name: 'Reasons', value: reasons.map(r => `• ${r}`).join('\n'), inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: config.bot.dryRun ? 'DRY RUN — no real order placed' : 'Live order placed' },
    }],
  })
}

export async function notifySentiment(sentiment: SentimentSnapshot): Promise<void> {
  const { fearGreed, news, score } = sentiment
  const fgEmoji = fearGreed.value < 30 ? '😱' : fearGreed.value < 50 ? '😟' : fearGreed.value < 70 ? '😐' : '🤑'

  const topNews = news.slice(0, 5).map(n => {
    const icon = n.sentiment === 'positive' ? '🟢' : n.sentiment === 'negative' ? '🔴' : '⚪'
    return `${icon} [${n.title}](${n.url})`
  }).join('\n')

  await postWebhook({
    embeds: [{
      title: `${fgEmoji} Market Sentiment Update`,
      color: score > 0.2 ? COLORS.BUY : score < -0.2 ? COLORS.SELL : COLORS.INFO,
      fields: [
        {
          name: 'Fear & Greed Index',
          value: `**${fearGreed.value}/100** — ${fearGreed.classification}`,
          inline: true,
        },
        { name: 'Composite Score', value: score.toFixed(2), inline: true },
        ...(topNews ? [{ name: 'Top News', value: topNews, inline: false }] : []),
      ],
      timestamp: new Date().toISOString(),
    }],
  })
}

export async function notifyStartup(symbols: string[], dryRun: boolean): Promise<void> {
  await postWebhook({
    embeds: [{
      title: '🤖 Trading Bot Started',
      color: COLORS.INFO,
      fields: [
        { name: 'Symbols', value: symbols.join(', '), inline: true },
        { name: 'Mode', value: dryRun ? '🧪 Dry Run' : '💰 Live', inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  })
}
