/**
 * Phase 9 Scheduler — unified module
 *
 * Merges schema.ts, parser.ts, executor.ts, tick.ts into a single file.
 * Uses the `croner` library instead of the custom cron parser.
 */

import { z } from "zod";
import { Cron } from "croner";
import * as YAML from "yaml";
import fs from "fs";
import path from "path";
import { writeIncoming } from "../lib/queue";
import { createLogger } from "../lib/logger";

const logger = createLogger("scheduler");

// ============================================================================
// TYPES & SCHEMA
// ============================================================================

const TaskActionSchema = z.object({
  type: z.enum(["agent-message", "heartbeat", "command"]),
  agent: z.string().optional(),
  message: z.string().optional(),
  command: z.string().optional(),
  condition: z.string().optional(),
  replyTo: z.string().optional(),
  /** Session mode for agent-message tasks: "isolated" (default) starts a
   *  throwaway session; "latest" continues the agent's current session. */
  session: z.enum(["isolated", "latest"]).default("isolated"),
});

const TaskSchema = z.object({
  name: z.string().min(1, "Task name is required"),
  schedule: z.string().min(1, "Cron schedule is required"),
  action: TaskActionSchema,
  lastRun: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});

export type Task = z.infer<typeof TaskSchema>;

export type TaskFile = {
  filename: string;
  task: Task;
};

// ============================================================================
// SCHEMA VALIDATION
// ============================================================================

export function validateTask(
  data: unknown
): { success: true; data: Task } | { success: false; error: string } {
  const result = TaskSchema.safeParse(data);

  if (!result.success) {
    return {
      success: false,
      error: result.error.message || "Validation failed",
    };
  }

  const task = result.data;

  if (task.action.type === "agent-message") {
    if (!task.action.agent) {
      return { success: false, error: "agent-message requires 'agent' field" };
    }
    if (!task.action.message) {
      return { success: false, error: "agent-message requires 'message' field" };
    }
  }

  if (task.action.type === "heartbeat") {
    if (!task.action.agent) {
      return { success: false, error: "heartbeat requires 'agent' field" };
    }
  }

  if (task.action.type === "command") {
    if (!task.action.command) {
      return { success: false, error: "command requires 'command' field" };
    }
  }

  return { success: true, data: task };
}

// ============================================================================
// CRON SCHEDULING (croner-based, UTC timezone)
// ============================================================================

export function shouldRunNow(
  cronExpr: string,
  lastRun: string | null | undefined,
  now: Date = new Date()
): boolean {
  try {
    if (!cronExpr) return false;
    const job = new Cron(cronExpr, { timezone: "UTC" });

    // Get next run after just before the current minute starts
    const startOfCurrentMinute = new Date(now);
    startOfCurrentMinute.setUTCSeconds(0, 0);
    const justBefore = new Date(startOfCurrentMinute.getTime() - 1);

    const nextRun = job.nextRun(justBefore);
    if (!nextRun) return false;

    // Does croner's next run fall in the current minute?
    const cronFiresNow =
      nextRun.getUTCFullYear() === now.getUTCFullYear() &&
      nextRun.getUTCMonth() === now.getUTCMonth() &&
      nextRun.getUTCDate() === now.getUTCDate() &&
      nextRun.getUTCHours() === now.getUTCHours() &&
      nextRun.getUTCMinutes() === now.getUTCMinutes();

    if (!cronFiresNow) return false;

    // Prevent duplicate run within same minute
    if (!lastRun) return true;
    const lastRunDate = new Date(lastRun);
    if (isNaN(lastRunDate.getTime())) return true;

    const lastRunMinute = Math.floor(lastRunDate.getTime() / 60000);
    const nowMinute = Math.floor(now.getTime() / 60000);
    return nowMinute > lastRunMinute;
  } catch {
    return false;
  }
}

export function getNextRunTime(cronExpr: string, from: Date = new Date()): Date {
  const job = new Cron(cronExpr, { timezone: "UTC" });
  const next = job.nextRun(from);
  if (!next) throw new Error(`Could not compute next run time for: ${cronExpr}`);
  return next;
}

// ============================================================================
// FILE I/O
// ============================================================================

export async function loadTaskFiles(
  tasksDir: string
): Promise<{ tasks: TaskFile[]; errors: number }> {
  if (!fs.existsSync(tasksDir)) {
    return { tasks: [], errors: 0 };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(tasksDir);
  } catch {
    return { tasks: [], errors: 0 };
  }

  const yamlFiles = entries.filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml")
  );

  const tasks: TaskFile[] = [];
  let errors = 0;

  for (const filename of yamlFiles) {
    const filepath = path.join(tasksDir, filename);
    try {
      let raw = await Bun.file(filepath).text();
      // Bare cron expressions starting with * are invalid YAML (alias syntax).
      // Auto-quote them so hand-edited task files don't break.
      raw = raw.replace(/^(\s*schedule:\s*)(\*.*)$/m, '$1"$2"');
      const parsed = YAML.parse(raw);
      const validation = validateTask(parsed);
      if (validation.success) {
        tasks.push({ filename: filepath, task: validation.data });
      } else {
        logger.warn(`Invalid task in ${filename}: ${validation.error}`);
        errors++;
      }
    } catch (err) {
      logger.warn(`Failed to load task file ${filename}`, err);
      errors++;
    }
  }

  return { tasks, errors };
}

export async function saveTask(filepath: string, task: Task): Promise<void> {
  const tmpPath = `${filepath}.tmp`;
  await Bun.write(tmpPath, YAML.stringify(task));
  fs.renameSync(tmpPath, filepath);
}

// ============================================================================
// EXECUTION
// ============================================================================

export async function executeTask(
  task: Task,
  queueDir?: string
): Promise<{ success: boolean; message?: string; error?: string; skipped?: boolean }> {
  const { action } = task;

  // Check condition gate first
  if (action.condition) {
    const condProc = Bun.spawn(["sh", "-c", action.condition], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await condProc.exited;
    if (exitCode !== 0) {
      return { success: false, error: "Condition not met", skipped: true };
    }
  }

  switch (action.type) {
    case "agent-message": {
      const hasReplyTo = !!action.replyTo;
      await writeIncoming(
        {
          channel: hasReplyTo ? "telegram" : "internal",
          sender: "scheduler",
          senderId: action.replyTo ?? "scheduler",
          agentId: action.agent!,
          message: action.message!,
          timestamp: Date.now(),
          messageId: `scheduler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionMode: action.session === "latest" ? "current" : "isolated",
        },
        queueDir
      );
      return { success: true, message: "Message queued" };
    }

    case "heartbeat": {
      const hasReplyTo = !!action.replyTo;
      await writeIncoming(
        {
          channel: hasReplyTo ? "telegram" : "internal",
          sender: "heartbeat",
          senderId: action.replyTo ?? "heartbeat",
          agentId: action.agent!,
          message: "🫀 Automated heartbeat check",
          timestamp: Date.now(),
          messageId: `heartbeat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
        queueDir
      );
      return { success: true, message: "Heartbeat queued" };
    }

    case "command": {
      const cmd = action.command!;
      const proc = Bun.spawn(["sh", "-c", cmd], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) {
        return {
          success: false,
          error: `Command failed (exit ${exitCode}): ${stderr || stdout}`.trim(),
        };
      }
      return { success: true, message: stdout.trim() };
    }

    default: {
      return { success: false, error: `Unknown action type: ${(action as any).type}` };
    }
  }
}

// ============================================================================
// TICK — process all due tasks non-blocking
// ============================================================================

export async function processTasksNonBlocking(
  tasksDir: string,
  queueDir: string,
  now: Date = new Date()
): Promise<{ executed: number; skipped: number; errors: number }> {
  const result = { executed: 0, skipped: 0, errors: 0 };

  const { tasks, errors } = await loadTaskFiles(tasksDir);
  result.errors += errors;

  for (const { filename, task } of tasks) {
    // Skip disabled tasks
    if (!task.enabled) {
      result.skipped++;
      continue;
    }

    // Check if task should run now
    if (!shouldRunNow(task.schedule, task.lastRun, now)) {
      continue;
    }

    // CRITICAL: Update lastRun FIRST before execution
    task.lastRun = now.toISOString();
    await saveTask(filename, task);

    result.executed++;

    // Fire in background (non-blocking)
    (async () => {
      try {
        const taskResult = await executeTask(task, queueDir);
        if (taskResult.skipped) {
          logger.debug("Task skipped (condition not met)", { name: task.name });
        } else if (taskResult.success) {
          logger.info("Task executed", { name: task.name, message: taskResult.message });
        } else {
          logger.error("Task failed", { name: task.name, error: taskResult.error });
        }
      } catch (err) {
        logger.error("Task threw exception", { name: task.name, error: err });
      }
    })();
  }

  return result;
}
