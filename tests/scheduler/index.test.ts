/**
 * Phase 9 Scheduler Tests — RED phase
 *
 * These tests import from "../../src/scheduler/index" which does not exist yet.
 * They are written against the new unified API that will be implemented in Phase 9.
 * All tests should FAIL until src/scheduler/index.ts is created.
 *
 * Key design changes from the old 4-file layout:
 *   - Custom cron parser replaced with croner library
 *   - 4 files (schema.ts, parser.ts, executor.ts, tick.ts) merged into index.ts
 *   - Only agent-message and command action types remain
 *   - processTasksNonBlocking updates lastRun BEFORE execution
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as YAML from "yaml";

// ============================================================================
// IMPORT FROM THE NOT-YET-EXISTING UNIFIED MODULE
// All imports below will cause the test suite to fail until
// src/scheduler/index.ts is created and exports the right things.
// ============================================================================
import {
  validateTask,
  shouldRunNow,
  getNextRunTime,
  loadTaskFiles,
  saveTask,
  executeTask,
  processTasksNonBlocking,
  type Task,
  type TaskFile,
} from "../../src/scheduler/index";

// ============================================================================
// HELPERS
// ============================================================================

/** Build a minimal valid agent-message task */
function makeAgentMessageTask(overrides: Partial<Task> = {}): Task {
  return {
    name: "Send daily memo",
    schedule: "0 9 * * *",
    action: {
      type: "agent-message",
      agent: "coder",
      message: "Run daily checks",
    },
    enabled: true,
    ...overrides,
  };
}

/** Build a minimal valid heartbeat task */
function makeHeartbeatTask(overrides: Partial<Task> = {}): Task {
  return {
    name: "Heartbeat for coder",
    schedule: "0 */3 * * *",
    action: {
      type: "heartbeat",
      agent: "coder",
    },
    enabled: true,
    ...overrides,
  };
}

/** Build a minimal valid command task */
function makeCommandTask(command = "true", overrides: Partial<Task> = {}): Task {
  return {
    name: "Run shell command",
    schedule: "0 * * * *",
    action: {
      type: "command",
      command,
    },
    enabled: true,
    ...overrides,
  };
}

// ============================================================================
// 1. SCHEMA VALIDATION — all 4 action types
// ============================================================================
describe("validateTask — schema validation", () => {
  describe("agent-message", () => {
    test("accepts valid agent-message task", () => {
      const result = validateTask(makeAgentMessageTask());
      expect(result.success).toBe(true);
    });

    test("rejects agent-message missing agent field", () => {
      const data = {
        name: "Test",
        schedule: "* * * * *",
        action: { type: "agent-message", message: "hello" },
        enabled: true,
      };
      const result = validateTask(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("agent");
      }
    });

    test("rejects agent-message missing message field", () => {
      const data = {
        name: "Test",
        schedule: "* * * * *",
        action: { type: "agent-message", agent: "coder" },
        enabled: true,
      };
      const result = validateTask(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("message");
      }
    });
  });

  describe("heartbeat", () => {
    test("accepts valid heartbeat task", () => {
      const result = validateTask(makeHeartbeatTask());
      expect(result.success).toBe(true);
    });

    test("rejects heartbeat missing agent field", () => {
      const data = {
        name: "Heartbeat",
        schedule: "0 */3 * * *",
        action: { type: "heartbeat" },
        enabled: true,
      };
      const result = validateTask(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("agent");
      }
    });
  });

  describe("command", () => {
    test("accepts valid command task", () => {
      const result = validateTask(makeCommandTask("echo hello"));
      expect(result.success).toBe(true);
    });

    test("rejects command task missing command field", () => {
      const data = {
        name: "Command",
        schedule: "* * * * *",
        action: { type: "command" },
        enabled: true,
      };
      const result = validateTask(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("command");
      }
    });
  });

  describe("shared schema rules", () => {
    test("rejects task missing name", () => {
      const data = {
        schedule: "* * * * *",
        action: { type: "agent-message", agent: "coder", message: "hi" },
        enabled: true,
      };
      const result = validateTask(data);
      expect(result.success).toBe(false);
    });

    test("rejects task with empty name", () => {
      const data = {
        name: "",
        schedule: "* * * * *",
        action: { type: "agent-message", agent: "coder", message: "hi" },
        enabled: true,
      };
      const result = validateTask(data);
      expect(result.success).toBe(false);
    });

    test("rejects task missing schedule", () => {
      const data = {
        name: "No schedule",
        action: { type: "agent-message", agent: "coder", message: "hi" },
        enabled: true,
      };
      const result = validateTask(data);
      expect(result.success).toBe(false);
    });

    test("defaults enabled to true when omitted", () => {
      const data = {
        name: "Test",
        schedule: "* * * * *",
        action: { type: "agent-message", agent: "coder", message: "hi" },
      };
      const result = validateTask(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
      }
    });

    test("accepts enabled: false", () => {
      const task = makeAgentMessageTask({ enabled: false });
      const result = validateTask(task);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
      }
    });

    test("accepts lastRun as ISO 8601 timestamp", () => {
      const task = makeAgentMessageTask({ lastRun: "2026-02-17T02:00:00.000Z" });
      const result = validateTask(task);
      expect(result.success).toBe(true);
    });

    test("accepts lastRun as null", () => {
      const task = makeAgentMessageTask({ lastRun: null });
      const result = validateTask(task);
      expect(result.success).toBe(true);
    });

    test("accepts lastRun omitted (undefined)", () => {
      const task = makeAgentMessageTask();
      delete (task as any).lastRun;
      const result = validateTask(task);
      expect(result.success).toBe(true);
    });

    test("accepts conditional field in action", () => {
      const task = makeCommandTask("echo hi", {
        action: { type: "command", command: "echo hi", condition: "test -f /tmp/flag" },
      });
      const result = validateTask(task);
      expect(result.success).toBe(true);
    });

    test("accepts replyTo field in agent-message action", () => {
      const task = makeAgentMessageTask({
        action: { type: "agent-message", agent: "coder", message: "hi", replyTo: "123456789" },
      });
      const result = validateTask(task);
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// 2. shouldRunNow — croner-based schedule matching
// ============================================================================
describe("shouldRunNow — uses croner for schedule matching", () => {
  test("returns true when never run and cron matches current minute", () => {
    // "* * * * *" matches every minute, so at 10:00 it should be true
    const now = new Date("2026-02-17T10:00:00Z");
    expect(shouldRunNow("* * * * *", null, now)).toBe(true);
    expect(shouldRunNow("* * * * *", undefined, now)).toBe(true);
  });

  test("returns false when task already ran in the same minute", () => {
    const now = new Date("2026-02-17T10:00:45Z");
    const lastRun = "2026-02-17T10:00:05Z"; // same minute
    expect(shouldRunNow("* * * * *", lastRun, now)).toBe(false);
  });

  test("returns true when last run was in a previous minute", () => {
    const now = new Date("2026-02-17T10:01:00Z");
    const lastRun = "2026-02-17T10:00:00Z"; // one minute ago
    expect(shouldRunNow("* * * * *", lastRun, now)).toBe(true);
  });

  test("returns true for hourly task at the hour boundary", () => {
    const now = new Date("2026-02-17T11:00:00Z");
    const lastRun = "2026-02-17T10:00:00Z";
    expect(shouldRunNow("0 * * * *", lastRun, now)).toBe(true);
  });

  test("returns false for hourly task when not at minute 0", () => {
    const now = new Date("2026-02-17T11:30:00Z");
    const lastRun = "2026-02-17T11:00:00Z";
    expect(shouldRunNow("0 * * * *", lastRun, now)).toBe(false);
  });

  test("returns true for daily 9am task at exactly 9am after running yesterday", () => {
    const now = new Date("2026-02-17T09:00:00Z");
    const lastRun = "2026-02-16T09:00:00Z";
    expect(shouldRunNow("0 9 * * *", lastRun, now)).toBe(true);
  });

  test("returns false for daily 9am task at 10am (wrong time)", () => {
    const now = new Date("2026-02-17T10:00:00Z");
    const lastRun = "2026-02-16T09:00:00Z";
    expect(shouldRunNow("0 9 * * *", lastRun, now)).toBe(false);
  });

  test("returns false for invalid cron expression", () => {
    const now = new Date("2026-02-17T10:00:00Z");
    expect(shouldRunNow("not-a-cron", null, now)).toBe(false);
    expect(shouldRunNow("", null, now)).toBe(false);
    expect(shouldRunNow("99 99 99 99 99", null, now)).toBe(false);
  });

  test("returns true for every-3-hours task at correct time", () => {
    // "0 */3 * * *" fires at 0, 3, 6, 9, 12, 15, 18, 21 UTC
    const now = new Date("2026-02-17T09:00:00Z");
    const lastRun = "2026-02-17T06:00:00Z";
    expect(shouldRunNow("0 */3 * * *", lastRun, now)).toBe(true);
  });

  test("returns false for every-3-hours task at hour 10 (not a multiple of 3)", () => {
    const now = new Date("2026-02-17T10:00:00Z");
    const lastRun = "2026-02-17T09:00:00Z";
    expect(shouldRunNow("0 */3 * * *", lastRun, now)).toBe(false);
  });

  test("defaults now to current time when omitted", () => {
    // This just tests the function doesn't throw; the result depends on real time
    const result = shouldRunNow("* * * * *", null);
    expect(typeof result).toBe("boolean");
  });
});

// ============================================================================
// 3. getNextRunTime — croner-based next-run computation
// ============================================================================
describe("getNextRunTime — uses croner to compute next run", () => {
  test("calculates next run for every-minute schedule", () => {
    const now = new Date("2026-02-17T10:00:00Z");
    const next = getNextRunTime("* * * * *", now);
    // croner returns next AFTER now, so it should be at least 10:01
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getUTCMinutes()).toBe(1);
    expect(next.getUTCHours()).toBe(10);
  });

  test("calculates next hourly run from mid-hour", () => {
    const now = new Date("2026-02-17T10:30:00Z");
    const next = getNextRunTime("0 * * * *", now);
    // Next :00 is 11:00
    expect(next.getUTCHours()).toBe(11);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test("calculates next daily 2am run from 10am", () => {
    const now = new Date("2026-02-17T10:00:00Z");
    const next = getNextRunTime("0 2 * * *", now);
    // Next 2am is 2026-02-18T02:00Z
    expect(next.getUTCFullYear()).toBe(2026);
    expect(next.getUTCMonth()).toBe(1); // February (0-indexed)
    expect(next.getUTCDate()).toBe(18);
    expect(next.getUTCHours()).toBe(2);
    expect(next.getUTCMinutes()).toBe(0);
  });

  test("returns a Date instance", () => {
    const now = new Date("2026-02-17T10:00:00Z");
    const next = getNextRunTime("0 * * * *", now);
    expect(next).toBeInstanceOf(Date);
    expect(isNaN(next.getTime())).toBe(false);
  });

  test("next run is always strictly after the from time", () => {
    const now = new Date("2026-02-17T10:00:00Z");
    const next = getNextRunTime("* * * * *", now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  test("defaults from to current time when omitted", () => {
    const before = Date.now();
    const next = getNextRunTime("* * * * *");
    expect(next.getTime()).toBeGreaterThan(before);
  });
});

// ============================================================================
// 4. loadTaskFiles — reads YAML task files from directory
// ============================================================================
describe("loadTaskFiles — reads YAML task files from directory", () => {
  let tasksDir: string;

  beforeEach(() => {
    tasksDir = mkdtempSync(join(tmpdir(), "tc-tasks-"));
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
  });

  test("returns empty list for empty directory", async () => {
    const result = await loadTaskFiles(tasksDir);
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toBe(0);
  });

  test("returns empty list for non-existent directory", async () => {
    const result = await loadTaskFiles(join(tmpdir(), "does-not-exist-" + Date.now()));
    expect(result.tasks).toHaveLength(0);
    expect(result.errors).toBe(0);
  });

  test("loads valid .yaml task files", async () => {
    const task1 = makeAgentMessageTask({ name: "Task Alpha" });
    const task2 = makeCommandTask("echo hello", { name: "Task Beta" });
    writeFileSync(join(tasksDir, "alpha.yaml"), YAML.stringify(task1));
    writeFileSync(join(tasksDir, "beta.yaml"), YAML.stringify(task2));

    const result = await loadTaskFiles(tasksDir);
    expect(result.tasks).toHaveLength(2);
    expect(result.errors).toBe(0);

    const names = result.tasks.map((t: TaskFile) => t.task.name).sort();
    expect(names).toEqual(["Task Alpha", "Task Beta"]);
  });

  test("each TaskFile includes filename (absolute path) and task", async () => {
    const task = makeAgentMessageTask({ name: "Filepath Task" });
    writeFileSync(join(tasksDir, "fp.yaml"), YAML.stringify(task));

    const result = await loadTaskFiles(tasksDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].filename).toContain("fp.yaml");
    expect(result.tasks[0].task.name).toBe("Filepath Task");
  });

  test("counts errors for invalid YAML files and continues", async () => {
    writeFileSync(join(tasksDir, "broken.yaml"), "invalid: [[[yaml syntax");
    const task = makeAgentMessageTask({ name: "Good Task" });
    writeFileSync(join(tasksDir, "good.yaml"), YAML.stringify(task));

    const result = await loadTaskFiles(tasksDir);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].task.name).toBe("Good Task");
  });

  test("counts errors for schema-invalid task files and continues", async () => {
    // Missing required 'agent' field for agent-message
    const bad = { name: "Bad Task", schedule: "* * * * *", action: { type: "agent-message" }, enabled: true };
    writeFileSync(join(tasksDir, "bad.yaml"), YAML.stringify(bad));
    const good = makeAgentMessageTask({ name: "Good Task" });
    writeFileSync(join(tasksDir, "good.yaml"), YAML.stringify(good));

    const result = await loadTaskFiles(tasksDir);
    expect(result.errors).toBe(1);
    expect(result.tasks).toHaveLength(1);
  });

  test("ignores non-.yaml files", async () => {
    writeFileSync(join(tasksDir, "README.md"), "# ignore me");
    writeFileSync(join(tasksDir, "config.json"), JSON.stringify({ foo: "bar" }));
    const task = makeAgentMessageTask();
    writeFileSync(join(tasksDir, "task.yaml"), YAML.stringify(task));

    const result = await loadTaskFiles(tasksDir);
    expect(result.tasks).toHaveLength(1);
  });
});

// ============================================================================
// 5. saveTask — writes YAML atomically to file (tmp → rename)
// ============================================================================
describe("saveTask — atomic YAML write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tc-save-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes a task file to disk", async () => {
    const task = makeAgentMessageTask({ name: "Persist Me" });
    const filepath = join(dir, "persist.yaml");

    await saveTask(filepath, task);

    expect(existsSync(filepath)).toBe(true);
    const raw = readFileSync(filepath, "utf-8");
    const parsed = YAML.parse(raw);
    expect(parsed.name).toBe("Persist Me");
  });

  test("does NOT leave a .tmp file behind after write", async () => {
    const task = makeAgentMessageTask();
    const filepath = join(dir, "atomic.yaml");
    await saveTask(filepath, task);

    expect(existsSync(filepath + ".tmp")).toBe(false);
  });

  test("overwrites existing file with updated task", async () => {
    const task = makeAgentMessageTask({ name: "Original Name" });
    const filepath = join(dir, "overwrite.yaml");
    await saveTask(filepath, task);

    const updated = { ...task, name: "Updated Name" };
    await saveTask(filepath, updated);

    const raw = readFileSync(filepath, "utf-8");
    expect(YAML.parse(raw).name).toBe("Updated Name");
  });

  test("round-trips through validateTask cleanly", async () => {
    const task = makeAgentMessageTask({ lastRun: "2026-02-17T09:00:00.000Z" });
    const filepath = join(dir, "roundtrip.yaml");
    await saveTask(filepath, task);

    const raw = readFileSync(filepath, "utf-8");
    const parsed = YAML.parse(raw);
    const validation = validateTask(parsed);
    expect(validation.success).toBe(true);
  });
});

// ============================================================================
// 6. executeTask — dispatches by action type
// ============================================================================
describe("executeTask — action type dispatch", () => {
  let queueDir: string;
  let incomingDir: string;

  beforeEach(() => {
    queueDir = mkdtempSync(join(tmpdir(), "tc-queue-"));
    incomingDir = join(queueDir, "incoming");
    mkdirSync(incomingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
  });

  // --- agent-message ---

  test("agent-message: returns success and writes file to incoming queue", async () => {
    const task = makeAgentMessageTask({
      action: { type: "agent-message", agent: "coder", message: "Run checks" },
    });

    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(true);

    const files = require("fs").readdirSync(incomingDir);
    expect(files.length).toBe(1);
  });

  test("agent-message: queued message has correct agentId and channel", async () => {
    const task = makeAgentMessageTask({
      action: { type: "agent-message", agent: "myagent", message: "hello world" },
    });

    await executeTask(task, queueDir);

    const files = require("fs").readdirSync(incomingDir);
    const content = JSON.parse(readFileSync(join(incomingDir, files[0]), "utf-8"));
    expect(content.agentId).toBe("myagent");
    expect(content.channel).toBe("internal");
    expect(content.message).toBe("hello world");
  });

  test("agent-message with replyTo: sets channel to telegram and senderId to replyTo", async () => {
    const task = makeAgentMessageTask({
      action: { type: "agent-message", agent: "coder", message: "check in", replyTo: "987654321" },
    });

    await executeTask(task, queueDir);

    const files = require("fs").readdirSync(incomingDir);
    const content = JSON.parse(readFileSync(join(incomingDir, files[0]), "utf-8"));
    expect(content.channel).toBe("telegram");
    expect(content.senderId).toBe("987654321");
    expect(content.agentId).toBe("coder");
  });

  test("agent-message without replyTo: sets channel to internal and senderId to scheduler", async () => {
    const task = makeAgentMessageTask({
      action: { type: "agent-message", agent: "coder", message: "no reply" },
    });

    await executeTask(task, queueDir);

    const files = require("fs").readdirSync(incomingDir);
    const content = JSON.parse(readFileSync(join(incomingDir, files[0]), "utf-8"));
    expect(content.channel).toBe("internal");
    expect(content.senderId).toBe("scheduler");
  });

  // --- heartbeat ---

  test("heartbeat: returns success and writes file to incoming queue", async () => {
    const task = makeHeartbeatTask({
      action: { type: "heartbeat", agent: "myagent" },
    });

    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(true);

    const files = require("fs").readdirSync(incomingDir);
    expect(files.length).toBe(1);
  });

  test("heartbeat: queued message targets correct agent", async () => {
    const task = makeHeartbeatTask({
      action: { type: "heartbeat", agent: "hearagent" },
    });

    await executeTask(task, queueDir);

    const files = require("fs").readdirSync(incomingDir);
    const content = JSON.parse(readFileSync(join(incomingDir, files[0]), "utf-8"));
    expect(content.agentId).toBe("hearagent");
    expect(content.channel).toBe("internal");
  });

  // --- command ---

  test("command: runs 'true' and returns success", async () => {
    const task = makeCommandTask("true");
    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(true);
  });

  test("command: runs 'echo hello' and returns success with output", async () => {
    const task = makeCommandTask("echo hello");
    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message).toContain("hello");
    }
  });

  test("command: returns failure when command exits non-zero", async () => {
    const task = makeCommandTask("false");
    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(false);
  });

  test("command: returns failure with error message on non-zero exit", async () => {
    const task = makeCommandTask("exit 42");
    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe("string");
      expect(result.error!.length).toBeGreaterThan(0);
    }
  });

  // --- result shape ---

  test("executeTask returns { success, message } or { success, error } shape", async () => {
    const ok = await executeTask(makeCommandTask("true"), queueDir);
    expect("success" in ok).toBe(true);

    const fail = await executeTask(makeCommandTask("false"), queueDir);
    expect("success" in fail).toBe(true);
    expect(fail.success).toBe(false);
    if (!fail.success) {
      expect(typeof fail.error).toBe("string");
    }
  });
});

// ============================================================================
// 7. Conditional tasks — condition shell command gate
// ============================================================================
describe("executeTask — conditional execution (condition field)", () => {
  let queueDir: string;
  let incomingDir: string;

  beforeEach(() => {
    queueDir = mkdtempSync(join(tmpdir(), "tc-cond-queue-"));
    incomingDir = join(queueDir, "incoming");
    mkdirSync(incomingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
  });

  test("condition=true (exit 0): task RUNS and returns success", async () => {
    const task: Task = {
      name: "Conditional Pass",
      schedule: "* * * * *",
      action: { type: "command", command: "echo ran", condition: "true" },
      enabled: true,
    };

    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(true);
  });

  test("condition=false (exit 1): task is SKIPPED", async () => {
    const task: Task = {
      name: "Conditional Skip",
      schedule: "* * * * *",
      action: { type: "command", command: "echo never-ran", condition: "false" },
      enabled: true,
    };

    const result = await executeTask(task, queueDir);
    // The task should be skipped — not a hard failure, but not success either
    // The new API returns { success: false, skipped: true } or { success: true, skipped: true }
    // We test that skipped is truthy OR success is false
    expect(result.skipped === true || result.success === false).toBe(true);
  });

  test("condition=false: does NOT write anything to the incoming queue", async () => {
    const task: Task = {
      name: "Conditional Skip Queue",
      schedule: "* * * * *",
      action: { type: "agent-message", agent: "ghost", message: "phantom", condition: "false" },
      enabled: true,
    };

    await executeTask(task, queueDir);
    const files = require("fs").readdirSync(incomingDir);
    expect(files.length).toBe(0);
  });

  test("condition with exit 0 from shell command: task executes", async () => {
    const task: Task = {
      name: "Conditional Custom",
      schedule: "* * * * *",
      // condition uses a command that always succeeds
      action: { type: "command", command: "echo yes", condition: "test 1 -eq 1" },
      enabled: true,
    };

    const result = await executeTask(task, queueDir);
    expect(result.success).toBe(true);
  });

  test("condition with exit 1 from shell command: task is skipped with skipped=true", async () => {
    const task: Task = {
      name: "Conditional Fail",
      schedule: "* * * * *",
      action: { type: "command", command: "echo nope", condition: "test 1 -eq 2" },
      enabled: true,
    };

    const result = await executeTask(task, queueDir);
    // Must indicate a skip
    expect(result.skipped).toBe(true);
  });
});

// ============================================================================
// 8. processTasksNonBlocking — updates lastRun BEFORE execution
// ============================================================================
describe("processTasksNonBlocking — lastRun updated BEFORE execution", () => {
  let tasksDir: string;
  let queueDir: string;

  beforeEach(() => {
    tasksDir = mkdtempSync(join(tmpdir(), "tc-ptnb-tasks-"));
    queueDir = mkdtempSync(join(tmpdir(), "tc-ptnb-queue-"));
    mkdirSync(join(queueDir, "incoming"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
    rmSync(queueDir, { recursive: true, force: true });
  });

  test("skips disabled tasks, counting them in skipped", async () => {
    const task = makeAgentMessageTask({ enabled: false, schedule: "* * * * *" });
    writeFileSync(join(tasksDir, "disabled.yaml"), YAML.stringify(task));

    const now = new Date("2026-02-17T10:00:00Z");
    const result = await processTasksNonBlocking(tasksDir, queueDir, now);
    expect(result.skipped).toBe(1);
    expect(result.executed).toBe(0);
  });

  test("executes task that matches schedule and has no lastRun", async () => {
    const task = makeCommandTask("true", {
      name: "MatchingTask",
      schedule: "* * * * *", // every minute
    });
    writeFileSync(join(tasksDir, "matching.yaml"), YAML.stringify(task));

    const now = new Date("2026-02-17T10:00:00Z");
    const result = await processTasksNonBlocking(tasksDir, queueDir, now);
    expect(result.executed).toBeGreaterThanOrEqual(1);
  });

  test("does NOT execute task that ran in the same minute", async () => {
    const now = new Date("2026-02-17T10:00:30Z");
    const task = makeCommandTask("echo check", {
      name: "AlreadyRanTask",
      schedule: "* * * * *",
      lastRun: "2026-02-17T10:00:05Z", // same minute
    });
    writeFileSync(join(tasksDir, "already-ran.yaml"), YAML.stringify(task));

    const result = await processTasksNonBlocking(tasksDir, queueDir, now);
    expect(result.executed).toBe(0);
  });

  test("updates lastRun in the YAML file BEFORE execution completes", async () => {
    // The key Phase 9 behavioral requirement:
    // lastRun must be written to disk before executeTask is awaited,
    // so a second tick in the same minute won't double-execute.
    const task = makeCommandTask("sleep 0.05", {
      name: "PreemptiveLastRun",
      schedule: "* * * * *",
    });
    const taskFile = join(tasksDir, "preemptive.yaml");
    writeFileSync(taskFile, YAML.stringify(task));

    const now = new Date("2026-02-17T10:00:00Z");

    // Start processTasksNonBlocking but do NOT await it yet — check file mid-flight
    const processPromise = processTasksNonBlocking(tasksDir, queueDir, now);

    // Give the function a tick to write lastRun (it's async and writes before executing)
    await new Promise(resolve => setTimeout(resolve, 20));

    // Read back the YAML — lastRun should already be set on disk
    const raw = readFileSync(taskFile, "utf-8");
    const onDisk = YAML.parse(raw) as Task;
    expect(onDisk.lastRun).toBeDefined();
    expect(onDisk.lastRun).not.toBeNull();

    // Now let the process finish
    await processPromise;
  });

  test("returns counts: { executed, skipped, errors }", async () => {
    const task = makeAgentMessageTask({ schedule: "* * * * *" });
    writeFileSync(join(tasksDir, "task.yaml"), YAML.stringify(task));

    const now = new Date("2026-02-17T10:00:00Z");
    const result = await processTasksNonBlocking(tasksDir, queueDir, now);

    expect(typeof result.executed).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(typeof result.errors).toBe("number");
  });

  test("handles invalid task files gracefully, counting errors", async () => {
    writeFileSync(join(tasksDir, "corrupt.yaml"), "totally: [invalid: yaml");

    const now = new Date("2026-02-17T10:00:00Z");
    const result = await processTasksNonBlocking(tasksDir, queueDir, now);
    expect(result.errors).toBeGreaterThan(0);
  });
});
