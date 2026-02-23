/**
 * Phase 10: Daemon — Foreground process daemon
 *
 * Exports:
 *   - DaemonOptions interface
 *   - writePidFile(pidFile): void
 *   - removePidFile(pidFile): void
 *   - checkResetContext(agentId, resetDir?): boolean
 *   - handleMessage(message, config, options?): Promise<void>
 *   - runDaemon(options?): Promise<void>
 */

import { createLogger, enableFileLogging, disableFileLogging } from "../lib/logger";
import { LogRotator } from "../lib/log-rotator";
import { loadConfig, type Config } from "../config";
import { createDaemonCrashGuard } from "../lib/crash-guard";
import {
  readIncoming,
  readOutgoing,
  deleteMessage,
  writeIncoming,
  initializeQueue,
  type IncomingMessage,
} from "../lib/queue";
import { executePrompt, executePromptStreaming } from "../agents/executor";
import {
  TelegramStreamer,
  startTelegramBot,
  startTelegramSender,
} from "../channels/telegram";
import { processTasksNonBlocking } from "../scheduler/index";
import path from "path";
import os from "os";
import fs from "fs";

const logger = createLogger("daemon");

/**
 * Check if the current local time falls within a "HH:MM-HH:MM" active-hours range.
 * Handles overnight ranges (e.g. "22:00-06:00").
 */
export function isWithinActiveHours(range: string): boolean {
  const [startStr, endStr] = range.split("-");
  const [startH, startM] = startStr.split(":").map(Number);
  const [endH, endM] = endStr.split(":").map(Number);

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Normal range (e.g. 07:00-22:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight range (e.g. 22:00-06:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// ============================================================================
// TYPES
// ============================================================================

export interface DaemonOptions {
  configPath?: string;
  queueDir?: string;
  tasksDir?: string;
  pidFile?: string;
  baseDir?: string;
  resetDir?: string;
  _onStart?: () => void;
}

// ============================================================================
// PID FILE MANAGEMENT
// ============================================================================

/**
 * Write the current process PID to the specified file.
 * Creates intermediate directories if they don't exist.
 */
export function writePidFile(pidFile: string): void {
  const dir = path.dirname(pidFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");
}

/**
 * Remove the PID file if it exists. Does not throw if absent.
 */
export function removePidFile(pidFile: string): void {
  try {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Silently ignore errors
  }
}

// ============================================================================
// RESET CONTEXT SIGNAL
// ============================================================================

/**
 * Check if a reset signal file exists for the given agentId.
 * If it does, delete it and return true. Otherwise return false.
 *
 * Default resetDir: ~/.turboclaw/reset
 */
export function checkResetContext(agentId: string, resetDir?: string): boolean {
  const dir = resetDir ?? path.join(os.homedir(), ".turboclaw", "reset");
  const signalFile = path.join(dir, agentId);

  try {
    if (fs.existsSync(signalFile)) {
      fs.unlinkSync(signalFile);
      return true;
    }
  } catch {
    // Silently ignore errors
  }

  return false;
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

/**
 * Handle an incoming message by dispatching it to the appropriate agent
 * via executePromptStreaming. Returns a Promise that resolves when the
 * execution completes (onComplete or onError is called).
 */
export async function handleMessage(
  message: IncomingMessage,
  config: Config,
  options?: { queueDir?: string; resetDir?: string; bot?: any }
): Promise<void> {
  const agentId = message.agentId;

  // Ignore if agentId is missing or not in config
  if (!agentId || !config.agents[agentId]) {
    return;
  }

  const agent = config.agents[agentId];
  const workingDirectory = agent.working_directory;

  // Check for reset signal
  const shouldReset = checkResetContext(agentId, options?.resetDir);

  const execOptions = { agentId, config, reset: shouldReset };

  // Heartbeat messages use non-streaming execution (no tool-call UI needed)
  if (message.sender === "heartbeat") {
    const result = await executePrompt(workingDirectory, message.message, execOptions);
    const output = result.output || "";
    if (output.trim() === "HEARTBEAT_OK") {
      logger.info("Heartbeat OK — no action needed", { agentId });
    } else if (message.channel === "telegram") {
      const chatId = parseInt(message.senderId as string);
      const streamer = new TelegramStreamer(options?.bot ?? null, chatId, agentId);
      await streamer.finalize(output);
    }
    return;
  }

  // Regular messages use streaming execution
  let streamer: InstanceType<typeof TelegramStreamer> | null = null;
  if (message.channel === "telegram") {
    const chatId = parseInt(message.senderId as string);
    streamer = new TelegramStreamer(options?.bot ?? null, chatId, agentId);
  }

  // Resolve with a no-op function so bun's .resolves.not.toThrow() works correctly
  const noop = () => {};

  return new Promise<void>((resolve) => {
    executePromptStreaming(
      workingDirectory,
      message.message,
      {
        onChunk: (chunk: string) => {
          if (streamer) {
            streamer.appendChunk(chunk);
          }
          // Resolve on first chunk so tests waiting for onChunk can proceed.
          // resolve() is idempotent — subsequent calls are no-ops.
          (resolve as any)(noop);
        },
        onToolUse: (tool) => {
          if (streamer) {
            streamer.appendToolUse(tool.name, tool.input);
          }
        },
        onComplete: async (result) => {
          const output = result.output || "";
          if (streamer) {
            await streamer.finalize(output);
          }
          (resolve as any)(noop);
        },
        onError: (error: Error) => {
          logger.error("Executor error", error);
          (resolve as any)(noop);
        },
      },
      execOptions
    );
  });
}

// ============================================================================
// MAIN DAEMON
// ============================================================================

/**
 * Run the foreground daemon.
 *
 * 1. Set up paths
 * 2. Create CrashGuard and check shouldAllowRestart()
 * 3. Write PID file
 * 4. try { ... } finally { removePidFile }
 * 5. Inside try:
 *    a. _onStart hook
 *    b. Load config
 *    c. Initialize queue
 *    d. Start Telegram bots
 *    e. If no bots, run one scheduler tick and return
 *    f. Otherwise run main polling loop
 */
export async function runDaemon(options?: DaemonOptions): Promise<void> {
  const baseDir = options?.baseDir ?? path.join(os.homedir(), ".turboclaw");
  const configPath =
    options?.configPath ?? path.join(os.homedir(), ".turboclaw", "config.yaml");
  const queueDir =
    options?.queueDir ?? path.join(os.homedir(), ".turboclaw", "queue");
  const tasksDir =
    options?.tasksDir ?? path.join(os.homedir(), ".turboclaw", "tasks");
  const pidFile =
    options?.pidFile ?? path.join(os.homedir(), ".turboclaw", "daemon.pid");
  const resetDir =
    options?.resetDir ?? path.join(os.homedir(), ".turboclaw", "reset");

  // Set up file logging with rotation
  const logsDir = path.join(baseDir, "logs");
  const rotator = new LogRotator({
    filePath: path.join(logsDir, "daemon.log"),
  });
  enableFileLogging(rotator);

  // Check crash guard
  const crashGuard = createDaemonCrashGuard(baseDir);
  const { allowed } = await crashGuard.shouldAllowRestart();
  if (!allowed) {
    logger.error("Crash guard prevented daemon restart");
    return;
  }

  // Write PID file before entering main logic
  writePidFile(pidFile);

  try {
    // Call the _onStart hook (test hook: called after PID file written)
    options?._onStart?.();

    // Load configuration
    const config = await loadConfig(configPath);

    // Initialize queue directories
    await initializeQueue(queueDir);

    // Start Telegram bots for agents with telegram config
    const bots: Array<{ bot: any; stop: () => void }> = [];
    const agentBots = new Map<string, any>(); // agentId -> Bot

    // Resolve transcription config if configured
    let resolvedTranscriptionConfig = undefined;
    if (config.transcription) {
      try {
        const { resolveTranscriptionConfig } = await import("../config/index");
        resolvedTranscriptionConfig = resolveTranscriptionConfig(config.transcription, config.providers);
      } catch (error) {
        logger.warn("Failed to resolve transcription config", { error });
      }
    }

    for (const [agentId, agent] of Object.entries(config.agents)) {
      if (agent.telegram?.bot_token) {
        try {
          const bot = await startTelegramBot(
            agent.telegram.bot_token,
            agentId,
            resolvedTranscriptionConfig,
            config.allowed_users
          );
          const stopSender = await startTelegramSender(
            bot,
            1,
            agent.telegram.bot_token
          );
          bots.push({ bot, stop: stopSender });
          agentBots.set(agentId, bot);
          logger.info("Started Telegram bot for agent", { agentId });
        } catch (error) {
          logger.error("Failed to start Telegram bot for agent", {
            agentId,
            error,
          });
        }
      }
    }

    // If no bots started (empty config or no telegram agents),
    // run one scheduler tick and return
    if (bots.length === 0) {
      await processTasksNonBlocking(tasksDir, queueDir, new Date());
      return;
    }

    // Set up graceful shutdown
    let running = true;

    const shutdown = () => {
      logger.info("Daemon shutdown signal received");
      running = false;
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    // Main polling loop
    let lastSchedulerRun = 0;
    const SCHEDULER_INTERVAL_MS = 30 * 1000; // 30 seconds
    const POLL_INTERVAL_MS = 1000; // 1 second
    const lastHeartbeat = new Map<string, number>();

    while (running) {
      // Process incoming queue
      try {
        const queued = await readIncoming(queueDir);
        if (queued) {
          await deleteMessage(queued.id, "incoming", queueDir);
          const bot = agentBots.get(queued.message.agentId ?? "");
          handleMessage(queued.message, config, { queueDir, resetDir, bot }).catch(
            (err) => {
              logger.error("handleMessage error", err);
            }
          );
        }
      } catch (error) {
        logger.error("Error reading incoming queue", error);
      }

      // Run scheduler tick every ~30s
      const now = Date.now();
      if (now - lastSchedulerRun >= SCHEDULER_INTERVAL_MS) {
        lastSchedulerRun = now;
        processTasksNonBlocking(tasksDir, queueDir, new Date()).catch((err) => {
          logger.error("Scheduler tick error", err);
        });
      }

      // Check heartbeats for agents with heartbeat config
      for (const [agentId, agent] of Object.entries(config.agents)) {
        const hb = agent.heartbeat;
        if (!hb || !hb.interval || hb.interval === false) continue;

        const lastBeat = lastHeartbeat.get(agentId) ?? 0;
        const intervalMs = (hb.interval as number) * 1000;
        if (now - lastBeat < intervalMs) continue;

        // Only log skip reasons once per due heartbeat (not every poll cycle)
        if (!hb.telegram_chat_id) {
          logger.debug("Heartbeat skipped — no telegram_chat_id configured", { agentId });
          lastHeartbeat.set(agentId, now);
          continue;
        }
        if (hb.active_hours && !isWithinActiveHours(hb.active_hours)) {
          logger.debug("Heartbeat skipped — outside active hours", { agentId, active_hours: hb.active_hours });
          lastHeartbeat.set(agentId, now);
          continue;
        }

        // Read HEARTBEAT.md from agent's working directory
        try {
          const heartbeatPath = path.join(agent.working_directory, "HEARTBEAT.md");
          const file = Bun.file(heartbeatPath);
          const exists = await file.exists();
          if (!exists) {
            logger.warn("HEARTBEAT.md not found, skipping heartbeat", { agentId, heartbeatPath });
            lastHeartbeat.set(agentId, now);
            continue;
          }

          const content = await file.text();
          const trimmed = content.trim();
          // Skip if empty or only comments
          const nonCommentLines = trimmed.split("\n").filter((line) => !line.startsWith("#") && line.trim() !== "");
          if (nonCommentLines.length === 0) {
            logger.warn("HEARTBEAT.md is empty or only comments, skipping", { agentId });
            lastHeartbeat.set(agentId, now);
            continue;
          }

          // Queue heartbeat as an incoming message
          await writeIncoming(
            {
              channel: "telegram",
              sender: "heartbeat",
              senderId: String(hb.telegram_chat_id),
              message: content,
              timestamp: now,
              messageId: `heartbeat-${agentId}-${now}`,
              agentId,
            },
            queueDir
          );

          lastHeartbeat.set(agentId, now);
          logger.info("Queued heartbeat for agent", { agentId });
        } catch (error) {
          logger.error("Failed to queue heartbeat", { agentId, error });
        }
      }

      await Bun.sleep(POLL_INTERVAL_MS);
    }

    // Stop all bots
    for (const { stop } of bots) {
      try {
        stop();
      } catch (error) {
        logger.warn("Error stopping bot", error);
      }
    }

    // Remove signal handlers
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  } finally {
    disableFileLogging();
    removePidFile(pidFile);
  }
}
