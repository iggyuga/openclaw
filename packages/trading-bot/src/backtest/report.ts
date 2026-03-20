import chalk from "chalk";
import type { BacktestResult } from "./runner.js";

export function printReport(result: BacktestResult): void {
  const { metrics: m, trades, symbol, timeframe, days, startDate, endDate } = result;

  const hr = "─".repeat(60);
  const returnColor = m.totalReturnPct >= 0 ? chalk.green : chalk.red;
  const drawdownColor =
    m.maxDrawdownPct > 20 ? chalk.red : m.maxDrawdownPct > 10 ? chalk.yellow : chalk.green;
  const winRateColor = m.winRate >= 50 ? chalk.green : chalk.yellow;
  const calmarColor =
    m.calmarRatio > 1 ? chalk.green : m.calmarRatio > 0 ? chalk.yellow : chalk.red;

  console.log();
  console.log(chalk.bold.cyan(`  BACKTEST RESULTS — ${symbol}`));
  console.log(chalk.gray(`  ${hr}`));
  console.log(chalk.gray(`  Period    : ${startDate} → ${endDate} (${days} days)`));
  console.log(chalk.gray(`  Timeframe : ${timeframe}`));
  console.log(chalk.gray(`  ${hr}`));

  console.log();
  console.log(chalk.bold("  Performance"));
  console.log(
    `  Total Return   : ${returnColor(`${m.totalReturnPct >= 0 ? "+" : ""}${m.totalReturnPct.toFixed(2)}%`)}  ($${m.totalReturnUsd >= 0 ? "+" : ""}${m.totalReturnUsd.toFixed(2)})`,
  );
  console.log(`  Final Equity   : $${m.finalEquity.toFixed(2)}`);
  console.log(`  Max Drawdown   : ${drawdownColor(`-${m.maxDrawdownPct.toFixed(2)}%`)}`);
  console.log(`  Sharpe Ratio   : ${m.sharpeRatio.toFixed(2)}`);
  console.log(`  Calmar Ratio   : ${calmarColor(m.calmarRatio.toFixed(2))}`);
  console.log(
    `  Profit Factor  : ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}`,
  );

  console.log();
  console.log(chalk.bold("  Trades"));
  console.log(`  Total          : ${m.totalTrades}`);
  console.log(
    `  Win Rate       : ${winRateColor(`${m.winRate.toFixed(1)}%`)}  (${m.winningTrades}W / ${m.losingTrades}L)`,
  );
  console.log(`  Avg Win        : ${chalk.green(`+${m.avgWinPct.toFixed(2)}%`)}`);
  console.log(`  Avg Loss       : ${chalk.red(`${m.avgLossPct.toFixed(2)}%`)}`);
  console.log(`  Best Trade     : ${chalk.green(`+${m.bestTradePct.toFixed(2)}%`)}`);
  console.log(`  Worst Trade    : ${chalk.red(`${m.worstTradePct.toFixed(2)}%`)}`);
  console.log(`  Avg Duration   : ${m.avgDurationHours.toFixed(1)}h`);
  console.log(`  Max Consec. W  : ${chalk.green(String(m.maxConsecutiveWins))}`);
  console.log(`  Max Consec. L  : ${chalk.red(String(m.maxConsecutiveLosses))}`);

  console.log();
  console.log(chalk.bold("  Exit Breakdown"));
  console.log(`  Signal exits   : ${m.signalExits}`);
  console.log(`  Stop-loss hits : ${chalk.red(String(m.stopLossHits))}`);
  console.log(`  Take-profit    : ${chalk.green(String(m.takeProfitHits))}`);

  if (trades.length) {
    console.log();
    console.log(chalk.bold("  Trade Log"));
    console.log(
      chalk.gray(
        `  ${"Date".padEnd(12)} ${"Entry".padStart(10)} ${"Exit".padStart(10)} ${"PnL%".padStart(8)} ${"Duration".padStart(10)} ${"Exit".padStart(12)}`,
      ),
    );
    console.log(chalk.gray(`  ${"-".repeat(66)}`));

    for (const t of trades) {
      const date = new Date(t.entryTime).toISOString().split("T")[0];
      const pnlStr = `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`;
      const pnlCol =
        t.pnlPct >= 0 ? chalk.green(pnlStr.padStart(8)) : chalk.red(pnlStr.padStart(8));
      const dur = `${t.durationHours.toFixed(0)}h`.padStart(10);
      const exitCol =
        t.exitReason === "stop-loss"
          ? chalk.red(t.exitReason.padStart(12))
          : t.exitReason === "take-profit"
            ? chalk.green(t.exitReason.padStart(12))
            : chalk.gray(t.exitReason.padStart(12));
      console.log(
        `  ${date.padEnd(12)} ${("$" + t.entryPrice.toFixed(2)).padStart(10)} ${("$" + t.exitPrice.toFixed(2)).padStart(10)} ${pnlCol} ${dur} ${exitCol}`,
      );
    }
  }

  console.log();
  const verdict = getVerdict(m);
  console.log(chalk.gray(`  ${hr}`));
  console.log(`  ${verdict}`);
  console.log(chalk.gray(`  ${hr}`));
  console.log();
}

function getVerdict(m: BacktestResult["metrics"]): string {
  if (m.totalTrades < 5) {
    return chalk.yellow("⚠  Too few trades to draw conclusions — try a longer period");
  }
  if (m.totalReturnPct < 0) {
    return chalk.red("✗  Strategy lost money in this period — review parameters");
  }
  if (m.maxDrawdownPct > 30) {
    return chalk.yellow("⚠  High drawdown — strategy is risky, consider tighter stops");
  }
  if (m.winRate < 40) {
    return chalk.yellow("⚠  Low win rate — may still be profitable if avg win > avg loss");
  }
  if (m.calmarRatio > 1 && m.sharpeRatio > 1 && m.totalReturnPct > 5) {
    return chalk.green("✓  Solid risk-adjusted returns — reasonable to test live with small size");
  }
  if (m.sharpeRatio > 1 && m.totalReturnPct > 5) {
    return chalk.green("✓  Good Sharpe, reasonable to test live");
  }
  if (m.totalReturnPct > 0) {
    return chalk.cyan("~  Profitable but marginal — keep paper trading and refining");
  }
  return chalk.gray("  Inconclusive");
}

export function toJSON(result: BacktestResult): string {
  return JSON.stringify(result, null, 2);
}
