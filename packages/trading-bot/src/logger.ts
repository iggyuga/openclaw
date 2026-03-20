import chalk from "chalk";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: Level = "info";

export function setLogLevel(level: Level) {
  minLevel = level;
}

function timestamp() {
  return new Date().toISOString();
}

function shouldLog(level: Level) {
  return LEVELS[level] >= LEVELS[minLevel];
}

export const log = {
  debug: (msg: string, data?: unknown) => {
    if (!shouldLog("debug")) return;
    console.debug(chalk.gray(`[${timestamp()}] DEBUG ${msg}`), data ?? "");
  },
  info: (msg: string, data?: unknown) => {
    if (!shouldLog("info")) return;
    console.info(chalk.cyan(`[${timestamp()}] INFO  ${msg}`), data ?? "");
  },
  warn: (msg: string, data?: unknown) => {
    if (!shouldLog("warn")) return;
    console.warn(chalk.yellow(`[${timestamp()}] WARN  ${msg}`), data ?? "");
  },
  error: (msg: string, err?: unknown) => {
    if (!shouldLog("error")) return;
    console.error(chalk.red(`[${timestamp()}] ERROR ${msg}`), err ?? "");
  },
  trade: (msg: string, data?: unknown) => {
    console.info(chalk.green(`[${timestamp()}] TRADE ${msg}`), data ?? "");
  },
  signal: (msg: string, data?: unknown) => {
    console.info(chalk.magenta(`[${timestamp()}] SIGNAL ${msg}`), data ?? "");
  },
};
