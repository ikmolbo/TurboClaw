import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createLogger } from "./logger";

const logger = createLogger("crash-guard");

export interface CrashRecord {
  timestamp: number;
  reason?: string;
}

export interface CrashGuardOptions {
  maxCrashes: number;
  windowMs: number;
  crashLogPath: string;
}

export class CrashGuard {
  private options: CrashGuardOptions;

  constructor(options: CrashGuardOptions) {
    this.options = options;
  }

  async recordCrash(reason?: string): Promise<void> {
    const crashes = this.loadCrashes();
    crashes.push({ timestamp: Date.now(), reason });
    this.saveCrashes(crashes);
    logger.debug("Crash recorded", { total: crashes.length, reason });
  }

  async shouldAllowRestart(): Promise<{ allowed: boolean; reason?: string }> {
    const crashes = this.getRecentCrashes();
    if (crashes.length >= this.options.maxCrashes) {
      const windowMinutes = Math.floor(this.options.windowMs / 60000);
      const reason = `Too many crashes (${crashes.length}) in last ${windowMinutes} minutes`;
      logger.error("Crash loop detected", { crashes: crashes.length, window: windowMinutes, max: this.options.maxCrashes });
      return { allowed: false, reason };
    }
    return { allowed: true };
  }

  getRecentCrashes(): CrashRecord[] {
    const crashes = this.loadCrashes();
    const cutoff = Date.now() - this.options.windowMs;
    return crashes.filter((crash) => crash.timestamp > cutoff);
  }

  async clearCrashes(): Promise<void> {
    this.saveCrashes([]);
    logger.info("Crash history cleared");
  }

  getStats(): { total: number; recent: number; oldestRecent?: Date } {
    const all = this.loadCrashes();
    const recent = this.getRecentCrashes();
    return {
      total: all.length,
      recent: recent.length,
      oldestRecent: recent.length > 0 ? new Date(recent[0].timestamp) : undefined,
    };
  }

  private loadCrashes(): CrashRecord[] {
    if (!existsSync(this.options.crashLogPath)) return [];
    try {
      const content = readFileSync(this.options.crashLogPath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      logger.warn("Failed to load crash log", error);
      return [];
    }
  }

  private saveCrashes(crashes: CrashRecord[]): void {
    try {
      writeFileSync(this.options.crashLogPath, JSON.stringify(crashes, null, 2), "utf-8");
    } catch (error) {
      logger.error("Failed to save crash log", error);
    }
  }
}

export function createDaemonCrashGuard(baseDir: string): CrashGuard {
  return new CrashGuard({
    maxCrashes: 5,
    windowMs: 15 * 60 * 1000,
    crashLogPath: join(baseDir, "crash.log"),
  });
}
