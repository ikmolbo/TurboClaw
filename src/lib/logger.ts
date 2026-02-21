import chalk from "chalk";

// Force chalk to output colors even in non-TTY environments (e.g., tests)
chalk.level = 3;

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLogLevel: LogLevel = LogLevel.DEBUG;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export interface Logger {
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
}

const SYMBOLS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: chalk.dim("·"),
  [LogLevel.INFO]: chalk.cyan("◆"),
  [LogLevel.WARN]: chalk.yellow("▲"),
  [LogLevel.ERROR]: chalk.red("✖"),
};

function formatTime(): string {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, "0");
  const m = now.getMinutes().toString().padStart(2, "0");
  const s = now.getSeconds().toString().padStart(2, "0");
  return chalk.dim(`${h}:${m}:${s}`);
}

function formatData(data: any): string {
  if (data === undefined || data === null) return "";

  if (data instanceof Error) {
    const msg = `Error: ${data.message}`;
    if (data.stack) {
      const indented = data.stack
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      return `  ${chalk.dim(msg)}\n${chalk.dim(indented)}`;
    }
    return `  ${chalk.dim(msg)}`;
  }

  if (typeof data === "object") {
    try {
      const pairs = Object.entries(data)
        .map(([k, v]) => {
          const val = typeof v === "string" ? `"${v}"` : JSON.stringify(v);
          return `${k}=${val}`;
        })
        .join(" ");
      return pairs ? `  ${chalk.dim(pairs)}` : "";
    } catch {
      return `  ${chalk.dim("[Circular]")}`;
    }
  }

  return `  ${chalk.dim(String(data))}`;
}

function log(level: LogLevel, component: string, message: string, data: any): void {
  if (level < currentLogLevel) return;

  const time = formatTime();
  const symbol = SYMBOLS[level];
  const comp = chalk.dim(`[${component}]`);
  const msg =
    level === LogLevel.ERROR
      ? chalk.red(message)
      : level === LogLevel.WARN
      ? chalk.yellow(message)
      : message;
  const dataStr = formatData(data);

  console.log(`${time} ${symbol} ${comp} ${msg}${dataStr}`);
}

export function createLogger(component: string): Logger {
  return {
    debug(message: string, data?: any) { log(LogLevel.DEBUG, component, message, data); },
    info(message: string, data?: any) { log(LogLevel.INFO, component, message, data); },
    warn(message: string, data?: any) { log(LogLevel.WARN, component, message, data); },
    error(message: string, data?: any) { log(LogLevel.ERROR, component, message, data); },
  };
}
