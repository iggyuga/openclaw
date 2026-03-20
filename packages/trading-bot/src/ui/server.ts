import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { fetchHistoricalCandles } from "../backtest/fetcher.js";
import { runBacktest } from "../backtest/runner.js";
import { state, startBot, stopBot } from "../bot.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getPortfolioSummary } from "../portfolio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function startUI() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, "public")));

  // Bot state for dashboard polling
  app.get("/api/state", (_req, res) => {
    res.json(state);
  });

  // Portfolio
  app.get("/api/portfolio", async (_req, res) => {
    const portfolio = await getPortfolioSummary();
    res.json(portfolio);
  });

  // Start / stop
  app.post("/api/bot/start", async (_req, res) => {
    await startBot();
    res.json({ ok: true, running: state.running });
  });

  app.post("/api/bot/stop", (_req, res) => {
    stopBot();
    res.json({ ok: true, running: state.running });
  });

  // Run backtest — POST /api/backtest { symbol, days, capital, timeframe }
  app.post("/api/backtest", async (req, res) => {
    const symbol = req.body.symbol ?? config.bot.symbols[0];
    const days = parseInt(req.body.days ?? "180", 10);
    const capital = parseFloat(req.body.capital ?? "10000");
    const timeframe = req.body.timeframe ?? config.strategy.timeframe;

    log.info(`Backtest request: ${symbol} ${days}d ${timeframe} $${capital}`);

    try {
      const candles = await fetchHistoricalCandles(symbol, timeframe, days);
      if (candles.length < 300) {
        res.status(400).json({ error: `Not enough candles (${candles.length}), try more days` });
        return;
      }
      const result = runBacktest(symbol, timeframe, candles, capital);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Backtest failed", err);
      res.status(500).json({ error: msg });
    }
  });

  // Serve dashboard for any non-API route
  app.get("*", (_req, res) => {
    res.sendFile(join(__dirname, "public", "index.html"));
  });

  app.listen(config.bot.uiPort, () => {
    log.info(`Dashboard: http://localhost:${config.bot.uiPort}`);
  });
}
