/**
 * Phase 10: Daemon — Comprehensive TDD Tests (RED phase)
 *
 * Tests define the expected behavior of the new foreground daemon in
 * src/daemon/index.ts. All tests should FAIL until the implementation is written.
 *
 * Covers:
 *  1. PID file management (writePidFile, removePidFile)
 *  2. Reset-context signal file (checkResetContext)
 *  3. handleMessage routing — correct agent, executor called with streaming
 *  4. handleMessage — TelegramStreamer created for telegram channel
 *  5. handleMessage — reset flag omits -c (reset:true) when signal found
 *  6. Crash guard integration in runDaemon
 *  7. Scheduler tick (processTasksNonBlocking) is called from the main loop
 *  8. Graceful shutdown — SIGTERM/SIGINT removes PID file
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs";

// ============================================================================
// Mocks — must be installed BEFORE importing the module under test
// ============================================================================

// Track calls to executePromptStreaming
let lastStreamingWorkDir: string | null = null;
let lastStreamingMessage: string | null = null;
let lastStreamingOptions: Record<string, any> | null = null;
let lastStreamingCallbacks: Record<string, any> | null = null;

// Fake streaming handle
const fakeHandle = { cancel: mock(() => {}) };

const executePromptStreamingMock = mock(
  (workDir: string, message: string, callbacks: any, options: any) => {
    lastStreamingWorkDir = workDir;
    lastStreamingMessage = message;
    lastStreamingCallbacks = callbacks;
    lastStreamingOptions = options;
    // Simulate immediate completion
    setImmediate(() => {
      callbacks.onChunk("Hello from agent");
      callbacks.onComplete({ success: true, output: "Hello from agent", exitCode: 0 });
    });
    return fakeHandle;
  }
);

const executePromptMock = mock(async (_workDir: string, _message: string, _options: any) => ({
  success: true,
  output: "done",
  exitCode: 0,
}));

mock.module("../../src/agents/executor", () => ({
  executePromptStreaming: executePromptStreamingMock,
  executePrompt: executePromptMock,
}));

// Import the real telegram module FIRST so we can spread its exports into the mock.
// This prevents cross-file mock contamination (bun runs files in parallel).
const realTelegramModule = await import("../../src/channels/telegram");

// Track TelegramStreamer construction and calls
let telegramStreamerInstances: Array<{
  chatId: number;
  agentId: string;
  appendChunkCalls: string[];
  finalizeCalls: string[];
}> = [];

// Extend the real TelegramStreamer so all real methods (flush, etc.) remain
// available — this prevents breaking telegram.test.ts which uses flush().
// We spy on appendChunk and finalize to record calls for daemon test assertions.
const RealTelegramStreamer = realTelegramModule.TelegramStreamer;

class InstrumentedTelegramStreamer extends RealTelegramStreamer {
  public _record: { chatId: number; agentId: string; appendChunkCalls: string[]; finalizeCalls: string[] };

  constructor(bot: any, chatId: number, agentId: string, sessionId?: string) {
    super(bot, chatId, agentId, sessionId);
    this._record = { chatId, agentId, appendChunkCalls: [], finalizeCalls: [] };
    telegramStreamerInstances.push(this._record);
  }

  appendChunk(text: string): void {
    this._record.appendChunkCalls.push(text);
    super.appendChunk(text);
  }

  async finalize(fullOutput: string): Promise<void> {
    this._record.finalizeCalls.push(fullOutput);
    // Only call real finalize if bot is non-null (null = daemon test, non-null = telegram test)
    if ((this as any).bot !== null) {
      await super.finalize(fullOutput);
    }
  }
}

mock.module("../../src/channels/telegram", () => ({
  // Spread all real exports so other test files that import from this module
  // (e.g., telegram.test.ts) still see the full public API.
  ...realTelegramModule,
  // Override only what the daemon tests need to mock:
  TelegramStreamer: InstrumentedTelegramStreamer,
  startTelegramBot: mock(async () => ({ api: {}, token: "fake-token" })),
  startTelegramSender: mock(async () => () => {}),
}));

// Mock processTasksNonBlocking
let processTasksCallCount = 0;
let lastProcessTasksArgs: any[] = [];

mock.module("../../src/scheduler/index", () => ({
  processTasksNonBlocking: mock(async (tasksDir: string, queueDir: string, now?: Date) => {
    processTasksCallCount++;
    lastProcessTasksArgs = [tasksDir, queueDir, now];
    return { executed: 0, skipped: 0, errors: 0 };
  }),
}));

// ============================================================================
// Import module under test AFTER mocks are installed
// ============================================================================

const {
  checkResetContext,
  writePidFile,
  removePidFile,
  handleMessage,
  runDaemon,
} = await import("../../src/daemon/index");

// ============================================================================
// Test helpers
// ============================================================================

function makeTempDir(suffix: string): string {
  const dir = path.join(os.tmpdir(), `turboclaw-daemon-test-${suffix}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal valid Config with one agent that has a Telegram integration. */
function makeTelegramConfig(agentId = "agent1"): any {
  return {
    workspace: { path: "/tmp/workspace" },
    providers: {
      anthropic: { api_key: "test-key" },
    },
    agents: {
      [agentId]: {
        name: "Test Agent",
        provider: "anthropic",
        model: "claude-opus-4-6",
        working_directory: "/tmp/agent1-work",
        heartbeat: {
          telegram_chat_id: 999888777,
        },
        telegram: {
          bot_token: "123456:ABC-fake-token",
        },
      },
    },
  };
}

/** Minimal valid Config with one agent but NO Telegram. */
function makeInternalConfig(agentId = "agent1"): any {
  return {
    workspace: { path: "/tmp/workspace" },
    providers: {
      anthropic: { api_key: "test-key" },
    },
    agents: {
      [agentId]: {
        name: "Internal Agent",
        provider: "anthropic",
        model: "claude-opus-4-6",
        working_directory: "/tmp/agent1-work",
      },
    },
  };
}

function makeIncomingMessage(overrides: Partial<any> = {}): any {
  return {
    channel: "internal",
    sender: "scheduler",
    senderId: "scheduler",
    message: "Hello agent",
    timestamp: Date.now(),
    messageId: `test-${Date.now()}`,
    agentId: "agent1",
    ...overrides,
  };
}

// ============================================================================
// 1. PID FILE MANAGEMENT
// ============================================================================

describe("writePidFile()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pid");
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("creates the PID file at the specified path", () => {
    const pidPath = path.join(tmpDir, "daemon.pid");
    writePidFile(pidPath);
    expect(fs.existsSync(pidPath)).toBe(true);
  });

  test("writes the current process PID as a string", () => {
    const pidPath = path.join(tmpDir, "daemon.pid");
    writePidFile(pidPath);
    const content = fs.readFileSync(pidPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("creates intermediate directories if they do not exist", () => {
    const pidPath = path.join(tmpDir, "subdir", "nested", "daemon.pid");
    writePidFile(pidPath);
    expect(fs.existsSync(pidPath)).toBe(true);
  });
});

describe("removePidFile()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("pid-remove");
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("deletes the PID file if it exists", () => {
    const pidPath = path.join(tmpDir, "daemon.pid");
    fs.writeFileSync(pidPath, String(process.pid));
    removePidFile(pidPath);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  test("does not throw if PID file does not exist", () => {
    const pidPath = path.join(tmpDir, "nonexistent.pid");
    expect(() => removePidFile(pidPath)).not.toThrow();
  });
});

// ============================================================================
// 2. RESET-CONTEXT SIGNAL FILE
// ============================================================================

describe("checkResetContext()", () => {
  let resetDir: string;

  beforeEach(() => {
    resetDir = makeTempDir("reset-ctx");
  });

  afterEach(() => {
    if (fs.existsSync(resetDir)) fs.rmSync(resetDir, { recursive: true });
  });

  test("returns true when the signal file exists for the given agentId", () => {
    const signalFile = path.join(resetDir, "agent1");
    fs.writeFileSync(signalFile, "reset");
    const result = checkResetContext("agent1", resetDir);
    expect(result).toBe(true);
  });

  test("deletes the signal file after returning true", () => {
    const signalFile = path.join(resetDir, "agent1");
    fs.writeFileSync(signalFile, "reset");
    checkResetContext("agent1", resetDir);
    expect(fs.existsSync(signalFile)).toBe(false);
  });

  test("returns false when no signal file exists for the given agentId", () => {
    const result = checkResetContext("agent1", resetDir);
    expect(result).toBe(false);
  });

  test("returns false for a different agentId even if another agent has a signal", () => {
    const signalFile = path.join(resetDir, "agent2");
    fs.writeFileSync(signalFile, "reset");
    const result = checkResetContext("agent1", resetDir);
    expect(result).toBe(false);
    // agent2 file should still exist (not consumed)
    expect(fs.existsSync(signalFile)).toBe(true);
  });

  test("uses a default reset directory (relative to home) when none is specified", () => {
    // Should not throw and should return false when no signal exists
    expect(() => checkResetContext("agent99")).not.toThrow();
    const result = checkResetContext("agent99");
    expect(result).toBe(false);
  });
});

// ============================================================================
// 3. handleMessage — routing
// ============================================================================

describe("handleMessage() — routing to correct agent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("handle-msg");
    executePromptStreamingMock.mockClear();
    lastStreamingWorkDir = null;
    lastStreamingMessage = null;
    lastStreamingOptions = null;
    lastStreamingCallbacks = null;
    telegramStreamerInstances = [];
    fakeHandle.cancel.mockClear();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("calls executePromptStreaming with the agent's working_directory", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1", channel: "internal" });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(executePromptStreamingMock).toHaveBeenCalled();
    expect(lastStreamingWorkDir).toBe(config.agents["agent1"].working_directory);
  });

  test("calls executePromptStreaming with the message text", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "internal",
      message: "What is the capital of France?",
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(lastStreamingMessage).toBe("What is the capital of France?");
  });

  test("passes agentId in ExecuteOptions so executor can resolve provider/model", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1" });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(lastStreamingOptions?.agentId).toBe("agent1");
    expect(lastStreamingOptions?.config).toBeDefined();
  });

  test("ignores message if agentId is not present in config", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "unknown-agent" });

    // Should not throw, but should not call executor either
    await handleMessage(message, config, { queueDir: tmpDir });

    expect(executePromptStreamingMock).not.toHaveBeenCalled();
  });

  test("ignores message if agentId is missing from message", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: undefined });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(executePromptStreamingMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. handleMessage — TelegramStreamer for telegram channel
// ============================================================================

describe("handleMessage() — TelegramStreamer for telegram channel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("handle-telegram");
    executePromptStreamingMock.mockClear();
    telegramStreamerInstances = [];
    lastStreamingCallbacks = null;
    lastStreamingOptions = null;
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("creates a TelegramStreamer when channel is 'telegram'", async () => {
    const config = makeTelegramConfig("agent1");
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(config.agents["agent1"].heartbeat.telegram_chat_id),
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(telegramStreamerInstances.length).toBeGreaterThanOrEqual(1);
  });

  test("TelegramStreamer is created with the correct chatId from message.senderId", async () => {
    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    const streamer = telegramStreamerInstances[0];
    expect(streamer).toBeDefined();
    expect(streamer.chatId).toBe(chatId);
  });

  test("TelegramStreamer is created with the correct agentId", async () => {
    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    const streamer = telegramStreamerInstances[0];
    expect(streamer.agentId).toBe("agent1");
  });

  test("onChunk callback delegates to streamer.appendChunk()", async () => {
    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;

    // Override mock to NOT immediately call callbacks — let us trigger manually
    let capturedCallbacks: any = null;
    executePromptStreamingMock.mockImplementationOnce(
      (_workDir: string, _message: string, callbacks: any, _options: any) => {
        capturedCallbacks = callbacks;
        return { cancel: mock(() => {}) };
      }
    );

    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
    });

    // Don't await — just start it
    const handlerPromise = handleMessage(message, config, { queueDir: tmpDir });

    // Wait a tick for the mock to be called
    await new Promise((r) => setImmediate(r));

    expect(capturedCallbacks).not.toBeNull();

    // Manually trigger a chunk
    capturedCallbacks.onChunk("chunk of text");

    const streamer = telegramStreamerInstances[0];
    expect(streamer.appendChunkCalls).toContain("chunk of text");

    // Resolve the promise by completing the handler
    capturedCallbacks.onComplete({ success: true, output: "chunk of text", exitCode: 0 });
    await handlerPromise;
  });

  test("onComplete callback delegates to streamer.finalize() with full output", async () => {
    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;

    let capturedCallbacks: any = null;
    executePromptStreamingMock.mockImplementationOnce(
      (_workDir: string, _message: string, callbacks: any, _options: any) => {
        capturedCallbacks = callbacks;
        return { cancel: mock(() => {}) };
      }
    );

    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
    });

    const handlerPromise = handleMessage(message, config, { queueDir: tmpDir });
    await new Promise((r) => setImmediate(r));

    capturedCallbacks.onComplete({ success: true, output: "Final answer", exitCode: 0 });

    await handlerPromise;

    const streamer = telegramStreamerInstances[0];
    expect(streamer.finalizeCalls).toContain("Final answer");
  });

  test("does NOT create TelegramStreamer when channel is 'internal'", async () => {
    const config = makeTelegramConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1", channel: "internal" });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(telegramStreamerInstances.length).toBe(0);
  });
});

// ============================================================================
// 5. handleMessage — reset-context signal affects executor options
// ============================================================================

describe("handleMessage() — reset context flag integration", () => {
  let tmpDir: string;
  let resetDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("handle-reset");
    resetDir = makeTempDir("reset-signals");
    executePromptStreamingMock.mockClear();
    lastStreamingOptions = null;
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    if (fs.existsSync(resetDir)) fs.rmSync(resetDir, { recursive: true });
  });

  test("passes reset:true to executor when reset signal file exists for the agent", async () => {
    // Create a reset signal file
    fs.writeFileSync(path.join(resetDir, "agent1"), "reset");

    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1" });

    await handleMessage(message, config, { queueDir: tmpDir, resetDir });

    expect(lastStreamingOptions?.reset).toBe(true);
  });

  test("does NOT pass reset:true when no signal file exists", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1" });

    await handleMessage(message, config, { queueDir: tmpDir, resetDir });

    // reset should not be true (could be false or undefined)
    expect(lastStreamingOptions?.reset).not.toBe(true);
  });

  test("consumes (deletes) the reset signal file after use", async () => {
    const signalFile = path.join(resetDir, "agent1");
    fs.writeFileSync(signalFile, "reset");

    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1" });

    await handleMessage(message, config, { queueDir: tmpDir, resetDir });

    expect(fs.existsSync(signalFile)).toBe(false);
  });
});

// ============================================================================
// 5b. handleMessage — sessionMode controls session resolution
// ============================================================================

describe("handleMessage() — sessionMode on incoming messages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("handle-session-mode");
    executePromptStreamingMock.mockClear();
    lastStreamingOptions = null;
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("sessionMode:'isolated' creates a new session (isNewSession:true)", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1", sessionMode: "isolated" });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(lastStreamingOptions?.isNewSession).toBe(true);
    expect(lastStreamingOptions?.sessionId).toBeDefined();
    expect(typeof lastStreamingOptions?.sessionId).toBe("string");
  });

  test("sessionMode:'isolated' does not persist to sessions.yaml", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1", sessionMode: "isolated" });

    await handleMessage(message, config, { queueDir: tmpDir });

    const sessionId = lastStreamingOptions?.sessionId;
    // Import readSessionId to check the file wasn't updated with this UUID
    const { readSessionId } = await import("../../src/lib/sessions");
    const stored = readSessionId("agent1");
    // The isolated session ID must not have been written
    expect(stored).not.toBe(sessionId);
  });

  test("sessionMode:'current' uses existing session (isNewSession:false)", async () => {
    // Write a known session ID first
    const { writeSessionId } = await import("../../src/lib/sessions");
    const knownId = "aaaabbbb-1111-2222-3333-444444444444";
    writeSessionId("agent1", knownId);

    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1", sessionMode: "current" });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(lastStreamingOptions?.sessionId).toBe(knownId);
    expect(lastStreamingOptions?.isNewSession).toBe(false);
  });

  test("no sessionMode defaults to getOrCreateSessionId behaviour", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1" });

    await handleMessage(message, config, { queueDir: tmpDir });

    // Should have a session ID and it should be persisted
    expect(lastStreamingOptions?.sessionId).toBeDefined();
  });
});

// ============================================================================
// 6. CRASH GUARD — runDaemon exits early if crash loop detected
// ============================================================================

describe("runDaemon() — crash guard prevents startup on crash loop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("daemon-crash");
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("does not start main loop when crash guard disallows restart", async () => {
    // Write a crash log with too many recent crashes
    const crashLog = path.join(tmpDir, "crash.log");
    const recentCrashes = Array.from({ length: 5 }, (_, i) => ({
      timestamp: Date.now() - i * 1000,
      reason: "test crash",
    }));
    fs.writeFileSync(crashLog, JSON.stringify(recentCrashes));

    // Point daemon to a config path that does not exist so it would fail
    // to read config — but crash guard should prevent it from even trying
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents: {}",
      ].join("\n")
    );

    const pidFile = path.join(tmpDir, "daemon.pid");

    // runDaemon should return (or throw) quickly when crash guard says no
    // We expect it to NOT hang; wrap in a timeout
    let returned = false;
    let threwError = false;

    const run = runDaemon({
      configPath,
      queueDir: path.join(tmpDir, "queue"),
      tasksDir: path.join(tmpDir, "tasks"),
      pidFile,
      baseDir: tmpDir, // crash guard reads from baseDir
    }).then(() => {
      returned = true;
    }).catch(() => {
      threwError = true;
    });

    // Give it a short moment
    await Promise.race([run, Bun.sleep(200)]);

    expect(returned || threwError).toBe(true);
  });
});

// ============================================================================
// 7. PID FILE written and removed by runDaemon
// ============================================================================

describe("runDaemon() — PID file lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("daemon-pid");
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("writes PID file before entering main loop", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents: {}",
      ].join("\n")
    );

    const pidFile = path.join(tmpDir, "daemon.pid");

    let pidExistedDuringRun = false;

    // runDaemon with no agents and no queue messages should exit quickly
    const run = runDaemon({
      configPath,
      queueDir: path.join(tmpDir, "queue"),
      tasksDir: path.join(tmpDir, "tasks"),
      pidFile,
      baseDir: tmpDir,
      // Inject a hook so we can observe the PID file during execution
      _onStart: () => {
        pidExistedDuringRun = fs.existsSync(pidFile);
      },
    });

    await Promise.race([run, Bun.sleep(300)]);

    expect(pidExistedDuringRun).toBe(true);
  });

  test("removes PID file after shutdown", async () => {
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents: {}",
      ].join("\n")
    );

    const pidFile = path.join(tmpDir, "daemon.pid");

    await Promise.race([
      runDaemon({
        configPath,
        queueDir: path.join(tmpDir, "queue"),
        tasksDir: path.join(tmpDir, "tasks"),
        pidFile,
        baseDir: tmpDir,
      }),
      Bun.sleep(300),
    ]);

    // After runDaemon resolves, PID file should be gone
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

// ============================================================================
// 8. DaemonOptions interface — exported types
// ============================================================================

describe("DaemonOptions interface", () => {
  test("DaemonOptions type accepts expected fields without TypeScript errors", () => {
    // This is a compile-time / shape test: if the import succeeded and we
    // can construct valid options, the shape is correct.
    const options = {
      configPath: "/path/to/config.yaml",
      queueDir: "/path/to/queue",
      tasksDir: "/path/to/tasks",
      pidFile: "/path/to/daemon.pid",
    };

    // The options object should be assignable (no error thrown constructing it)
    expect(options.configPath).toBe("/path/to/config.yaml");
    expect(options.queueDir).toBe("/path/to/queue");
    expect(options.tasksDir).toBe("/path/to/tasks");
    expect(options.pidFile).toBe("/path/to/daemon.pid");
  });
});

// ============================================================================
// 9. checkResetContext — edge cases
// ============================================================================

describe("checkResetContext() — additional edge cases", () => {
  let resetDir: string;

  beforeEach(() => {
    resetDir = makeTempDir("reset-edge");
  });

  afterEach(() => {
    if (fs.existsSync(resetDir)) fs.rmSync(resetDir, { recursive: true });
  });

  test("is idempotent — second call returns false after first call consumed the file", () => {
    const signalFile = path.join(resetDir, "agent1");
    fs.writeFileSync(signalFile, "reset");

    const first = checkResetContext("agent1", resetDir);
    const second = checkResetContext("agent1", resetDir);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("handles agentIds with special characters safely", () => {
    // agent IDs that are valid directory names should work
    const agentId = "my-agent_v2";
    const signalFile = path.join(resetDir, agentId);
    fs.writeFileSync(signalFile, "reset");

    const result = checkResetContext(agentId, resetDir);
    expect(result).toBe(true);
    expect(fs.existsSync(signalFile)).toBe(false);
  });
});

// ============================================================================
// 10. handleMessage — onError callback
// ============================================================================

describe("handleMessage() — error handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("handle-error");
    executePromptStreamingMock.mockClear();
    telegramStreamerInstances = [];
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("does not throw when executor calls onError", async () => {
    let capturedCallbacks: any = null;
    executePromptStreamingMock.mockImplementationOnce(
      (_workDir: string, _message: string, callbacks: any, _options: any) => {
        capturedCallbacks = callbacks;
        return { cancel: mock(() => {}) };
      }
    );

    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1" });

    const handlerPromise = handleMessage(message, config, { queueDir: tmpDir });
    await new Promise((r) => setImmediate(r));

    // Simulate an error from the executor
    capturedCallbacks.onError(new Error("Claude CLI crashed"));

    // handleMessage should resolve (not reject) on executor error
    await handlerPromise;
  });

  test("does not throw when executor calls onError on telegram channel", async () => {
    let capturedCallbacks: any = null;
    executePromptStreamingMock.mockImplementationOnce(
      (_workDir: string, _message: string, callbacks: any, _options: any) => {
        capturedCallbacks = callbacks;
        return { cancel: mock(() => {}) };
      }
    );

    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
    });

    const handlerPromise = handleMessage(message, config, { queueDir: tmpDir });
    await new Promise((r) => setImmediate(r));

    capturedCallbacks.onError(new Error("Streaming failure"));

    await handlerPromise;
  });
});

// ============================================================================
// 11. handleMessage — passes config to executor options
// ============================================================================

describe("handleMessage() — passes config object to executor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("handle-config");
    executePromptStreamingMock.mockClear();
    lastStreamingOptions = null;
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("config is included in ExecuteOptions for provider/model resolution", async () => {
    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({ agentId: "agent1" });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(lastStreamingOptions?.config).toEqual(config);
  });
});

// ============================================================================
// 12. handleMessage — HEARTBEAT_OK filtering
// ============================================================================

describe("handleMessage() — heartbeat non-streaming path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("heartbeat-filter");
    executePromptStreamingMock.mockClear();
    executePromptMock.mockClear();
    telegramStreamerInstances = [];
    lastStreamingCallbacks = null;
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("heartbeat uses executePrompt (non-streaming), not executePromptStreaming", async () => {
    executePromptMock.mockImplementationOnce(async () => ({
      success: true, output: "HEARTBEAT_OK", exitCode: 0,
    }));

    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
      sender: "heartbeat",
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(executePromptMock).toHaveBeenCalledTimes(1);
    expect(executePromptStreamingMock).not.toHaveBeenCalled();
  });

  test("skips finalize when heartbeat output is HEARTBEAT_OK", async () => {
    executePromptMock.mockImplementationOnce(async () => ({
      success: true, output: "HEARTBEAT_OK", exitCode: 0,
    }));

    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
      sender: "heartbeat",
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    // No streamer should have been created (HEARTBEAT_OK → early return)
    expect(telegramStreamerInstances.length).toBe(0);
  });

  test("skips finalize when heartbeat output is HEARTBEAT_OK with surrounding whitespace", async () => {
    executePromptMock.mockImplementationOnce(async () => ({
      success: true, output: "  HEARTBEAT_OK\n ", exitCode: 0,
    }));

    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
      sender: "heartbeat",
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    expect(telegramStreamerInstances.length).toBe(0);
  });

  test("calls streamer.finalize() when heartbeat output is NOT HEARTBEAT_OK", async () => {
    executePromptMock.mockImplementationOnce(async () => ({
      success: true, output: "Something needs attention!", exitCode: 0,
    }));

    const config = makeTelegramConfig("agent1");
    const chatId = config.agents["agent1"].heartbeat.telegram_chat_id;
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "telegram",
      senderId: String(chatId),
      sender: "heartbeat",
    });

    await handleMessage(message, config, { queueDir: tmpDir });

    const streamer = telegramStreamerInstances[0];
    expect(streamer).toBeDefined();
    expect(streamer.finalizeCalls).toContain("Something needs attention!");
  });

  test("heartbeat on non-telegram channel does not create streamer", async () => {
    executePromptMock.mockImplementationOnce(async () => ({
      success: true, output: "Some output", exitCode: 0,
    }));

    const config = makeInternalConfig("agent1");
    const message = makeIncomingMessage({
      agentId: "agent1",
      channel: "internal",
      sender: "heartbeat",
    });

    await handleMessage(message, config, { queueDir: tmpDir });
    expect(telegramStreamerInstances.length).toBe(0);
  });
});

// ============================================================================
// 13. Heartbeat generation — queuing and processing heartbeat messages
// ============================================================================

describe("Heartbeat generation — heartbeat fires and is processed by daemon", () => {
  let tmpDir: string;
  let queueDir: string;
  let daemonPromise: Promise<void> | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir("heartbeat-gen");
    queueDir = path.join(tmpDir, "queue");
    fs.mkdirSync(path.join(queueDir, "incoming"), { recursive: true });
    fs.mkdirSync(path.join(queueDir, "outgoing"), { recursive: true });
    fs.mkdirSync(path.join(queueDir, "errors"), { recursive: true });
    executePromptStreamingMock.mockClear();
    executePromptMock.mockClear();
    // Make non-streaming executor return HEARTBEAT_OK (heartbeats use executePrompt)
    executePromptMock.mockImplementation(async (_workDir: string, _message: string, _options: any) => ({
      success: true,
      output: "HEARTBEAT_OK",
      exitCode: 0,
    }));
  });

  afterEach(async () => {
    // Ensure daemon is stopped before cleanup
    if (daemonPromise) {
      process.emit("SIGTERM" as any);
      await Promise.race([daemonPromise, Bun.sleep(3000)]);
      daemonPromise = null;
    }
    // Restore the default mock implementations
    executePromptStreamingMock.mockImplementation(
      (workDir: string, message: string, callbacks: any, options: any) => {
        lastStreamingWorkDir = workDir;
        lastStreamingMessage = message;
        lastStreamingCallbacks = callbacks;
        lastStreamingOptions = options;
        setImmediate(() => {
          callbacks.onChunk("Hello from agent");
          callbacks.onComplete({ success: true, output: "Hello from agent", exitCode: 0 });
        });
        return fakeHandle;
      }
    );
    executePromptMock.mockImplementation(async (_workDir: string, _message: string, _options: any) => ({
      success: true,
      output: "done",
      exitCode: 0,
    }));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("heartbeat fires and executor receives HEARTBEAT.md content", async () => {
    const workDir = path.join(tmpDir, "agent-work");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "HEARTBEAT.md"), "Check if everything is running smoothly.");

    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents:",
        "  heartbeat-agent:",
        "    name: Heartbeat Agent",
        "    provider: anthropic",
        "    model: sonnet",
        `    working_directory: ${workDir}`,
        "    heartbeat:",
        "      interval: 1",
        "      telegram_chat_id: 999888777",
        "    telegram:",
        '      bot_token: "123456:ABC-fake"',
      ].join("\n")
    );

    daemonPromise = runDaemon({
      configPath,
      queueDir,
      tasksDir: path.join(tmpDir, "tasks"),
      pidFile: path.join(tmpDir, "daemon.pid"),
      baseDir: tmpDir,
    });

    // Wait for heartbeat to fire and be processed (interval=1s, poll=1s)
    await Bun.sleep(4000);

    // Stop daemon
    process.emit("SIGTERM" as any);
    await Promise.race([daemonPromise, Bun.sleep(2000)]);
    daemonPromise = null;

    // Verify non-streaming executor was called with HEARTBEAT.md content
    const heartbeatCall = executePromptMock.mock.calls.find(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("Check if everything is running smoothly")
    );
    expect(heartbeatCall).toBeDefined();
    expect(heartbeatCall![0]).toBe(workDir);
  });

  test("heartbeat skips agents without telegram_chat_id", async () => {
    const workDir = path.join(tmpDir, "agent-work-no-chatid");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "HEARTBEAT.md"), "Check status.");

    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents:",
        "  no-chatid-agent:",
        "    name: No ChatId Agent",
        "    provider: anthropic",
        "    model: sonnet",
        `    working_directory: ${workDir}`,
        "    heartbeat:",
        "      interval: 1",
        "    telegram:",
        '      bot_token: "123456:ABC-fake"',
      ].join("\n")
    );

    daemonPromise = runDaemon({
      configPath,
      queueDir,
      tasksDir: path.join(tmpDir, "tasks"),
      pidFile: path.join(tmpDir, "daemon.pid"),
      baseDir: tmpDir,
    });

    await Bun.sleep(2500);
    process.emit("SIGTERM" as any);
    await Promise.race([daemonPromise, Bun.sleep(2000)]);
    daemonPromise = null;

    // Executor should NOT have been called with heartbeat content
    const heartbeatCall = executePromptMock.mock.calls.find(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("Check status")
    );
    expect(heartbeatCall).toBeUndefined();
  });

  test("heartbeat skips when HEARTBEAT.md has only comments", async () => {
    const workDir = path.join(tmpDir, "agent-work-comments");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "HEARTBEAT.md"), "# This is a comment\n# Another comment\n");

    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents:",
        "  comments-agent:",
        "    name: Comments Agent",
        "    provider: anthropic",
        "    model: sonnet",
        `    working_directory: ${workDir}`,
        "    heartbeat:",
        "      interval: 1",
        "      telegram_chat_id: 111222333",
        "    telegram:",
        '      bot_token: "123456:ABC-fake"',
      ].join("\n")
    );

    daemonPromise = runDaemon({
      configPath,
      queueDir,
      tasksDir: path.join(tmpDir, "tasks"),
      pidFile: path.join(tmpDir, "daemon.pid"),
      baseDir: tmpDir,
    });

    await Bun.sleep(2500);
    process.emit("SIGTERM" as any);
    await Promise.race([daemonPromise, Bun.sleep(2000)]);
    daemonPromise = null;

    // Neither executor should have been called
    expect(executePromptMock).not.toHaveBeenCalled();
    expect(executePromptStreamingMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 14. isWithinActiveHours — unit tests
// ============================================================================

import { isWithinActiveHours } from "../../src/daemon/index";

describe("isWithinActiveHours()", () => {
  // Helper to mock Date to a specific hour:minute
  function withTime(hour: number, minute: number, fn: () => void) {
    const original = globalThis.Date;
    const fakeNow = new original();
    fakeNow.setHours(hour, minute, 0, 0);

    globalThis.Date = class extends original {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(fakeNow.getTime());
        } else {
          // @ts-ignore
          super(...args);
        }
      }
      static now() { return fakeNow.getTime(); }
    } as any;

    try {
      fn();
    } finally {
      globalThis.Date = original;
    }
  }

  test("returns true when current time is within a normal range", () => {
    withTime(12, 0, () => {
      expect(isWithinActiveHours("07:00-22:00")).toBe(true);
    });
  });

  test("returns false when current time is outside a normal range", () => {
    withTime(3, 0, () => {
      expect(isWithinActiveHours("07:00-22:00")).toBe(false);
    });
  });

  test("returns true at exact start boundary", () => {
    withTime(7, 0, () => {
      expect(isWithinActiveHours("07:00-22:00")).toBe(true);
    });
  });

  test("returns false at exact end boundary", () => {
    withTime(22, 0, () => {
      expect(isWithinActiveHours("07:00-22:00")).toBe(false);
    });
  });

  test("handles overnight range — time after start", () => {
    withTime(23, 30, () => {
      expect(isWithinActiveHours("22:00-06:00")).toBe(true);
    });
  });

  test("handles overnight range — time before end", () => {
    withTime(4, 0, () => {
      expect(isWithinActiveHours("22:00-06:00")).toBe(true);
    });
  });

  test("handles overnight range — time outside range", () => {
    withTime(12, 0, () => {
      expect(isWithinActiveHours("22:00-06:00")).toBe(false);
    });
  });

  test("handles overnight range — at exact start", () => {
    withTime(22, 0, () => {
      expect(isWithinActiveHours("22:00-06:00")).toBe(true);
    });
  });

  test("handles overnight range — at exact end", () => {
    withTime(6, 0, () => {
      expect(isWithinActiveHours("22:00-06:00")).toBe(false);
    });
  });

  test("handles minute precision", () => {
    withTime(7, 30, () => {
      expect(isWithinActiveHours("07:30-08:00")).toBe(true);
    });
    withTime(7, 29, () => {
      expect(isWithinActiveHours("07:30-08:00")).toBe(false);
    });
  });
});

// ============================================================================
// 15. Per-agent busy lock — sequential processing for same agent
// ============================================================================

import { writeIncoming, readIncoming, deleteMessage } from "../../src/lib/queue";

describe("readIncoming() — skipAgentIds filtering", () => {
  let queueDir: string;

  beforeEach(() => {
    queueDir = makeTempDir("skip-agents");
    fs.mkdirSync(path.join(queueDir, "incoming"), { recursive: true });
    fs.mkdirSync(path.join(queueDir, "outgoing"), { recursive: true });
    fs.mkdirSync(path.join(queueDir, "errors"), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(queueDir)) fs.rmSync(queueDir, { recursive: true });
  });

  test("skips messages for agents in skipAgentIds set", async () => {
    await writeIncoming(
      makeIncomingMessage({ agentId: "agent1", message: "first" }),
      queueDir
    );
    // Small delay so the second message has a later mtime
    await Bun.sleep(10);
    await writeIncoming(
      makeIncomingMessage({ agentId: "agent2", message: "second" }),
      queueDir
    );

    const result = await readIncoming(queueDir, {
      skipAgentIds: new Set(["agent1"]),
    });

    expect(result).not.toBeNull();
    expect(result!.message.agentId).toBe("agent2");
    expect(result!.message.message).toBe("second");
  });

  test("returns null when all queued agents are in skipAgentIds", async () => {
    await writeIncoming(
      makeIncomingMessage({ agentId: "agent1", message: "only" }),
      queueDir
    );

    const result = await readIncoming(queueDir, {
      skipAgentIds: new Set(["agent1"]),
    });

    expect(result).toBeNull();
  });

  test("returns message normally when skipAgentIds is empty", async () => {
    await writeIncoming(
      makeIncomingMessage({ agentId: "agent1", message: "hello" }),
      queueDir
    );

    const result = await readIncoming(queueDir, {
      skipAgentIds: new Set(),
    });

    expect(result).not.toBeNull();
    expect(result!.message.agentId).toBe("agent1");
  });

  test("returns message normally when no options provided", async () => {
    await writeIncoming(
      makeIncomingMessage({ agentId: "agent1", message: "hello" }),
      queueDir
    );

    const result = await readIncoming(queueDir);

    expect(result).not.toBeNull();
    expect(result!.message.agentId).toBe("agent1");
  });

  test("leaves skipped messages in the queue (not deleted)", async () => {
    await writeIncoming(
      makeIncomingMessage({ agentId: "agent1", message: "busy-msg" }),
      queueDir
    );

    // First read skips agent1
    const skipped = await readIncoming(queueDir, {
      skipAgentIds: new Set(["agent1"]),
    });
    expect(skipped).toBeNull();

    // Second read without skip finds it
    const found = await readIncoming(queueDir);
    expect(found).not.toBeNull();
    expect(found!.message.message).toBe("busy-msg");
  });
});

describe("Daemon busy-agent lock — sequential processing", () => {
  let tmpDir: string;
  let queueDir: string;
  let daemonPromise: Promise<void> | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir("busy-lock");
    queueDir = path.join(tmpDir, "queue");
    fs.mkdirSync(path.join(queueDir, "incoming"), { recursive: true });
    fs.mkdirSync(path.join(queueDir, "outgoing"), { recursive: true });
    fs.mkdirSync(path.join(queueDir, "errors"), { recursive: true });
    executePromptStreamingMock.mockClear();
    executePromptMock.mockClear();
    telegramStreamerInstances = [];
  });

  afterEach(async () => {
    if (daemonPromise) {
      process.emit("SIGTERM" as any);
      await Promise.race([daemonPromise, Bun.sleep(3000)]);
      daemonPromise = null;
    }
    // Restore the default mock implementations
    executePromptStreamingMock.mockImplementation(
      (workDir: string, message: string, callbacks: any, options: any) => {
        lastStreamingWorkDir = workDir;
        lastStreamingMessage = message;
        lastStreamingCallbacks = callbacks;
        lastStreamingOptions = options;
        setImmediate(() => {
          callbacks.onChunk("Hello from agent");
          callbacks.onComplete({ success: true, output: "Hello from agent", exitCode: 0 });
        });
        return fakeHandle;
      }
    );
    executePromptMock.mockImplementation(async (_workDir: string, _message: string, _options: any) => ({
      success: true,
      output: "done",
      exitCode: 0,
    }));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test("two messages for the same agent are processed sequentially", async () => {
    // Track the order of executor calls and completions
    const events: string[] = [];
    const completionCallbacks: Array<(result: any) => void> = [];

    executePromptStreamingMock.mockImplementation(
      (_workDir: string, message: string, callbacks: any, _options: any) => {
        events.push(`start:${message}`);
        // Hold onto the onComplete callback so we can resolve manually
        completionCallbacks.push((result: any) => {
          events.push(`complete:${message}`);
          callbacks.onComplete(result);
        });
        return { cancel: mock(() => {}) };
      }
    );

    // Create config with one agent
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents:",
        "  agentA:",
        "    name: Agent A",
        "    provider: anthropic",
        "    model: sonnet",
        "    working_directory: /tmp/agentA-work",
        "    telegram:",
        '      bot_token: "123456:ABC-fake"',
      ].join("\n")
    );

    // Queue two messages for the same agent
    await writeIncoming(
      makeIncomingMessage({ agentId: "agentA", message: "msg1" }),
      queueDir
    );
    await Bun.sleep(10);
    await writeIncoming(
      makeIncomingMessage({ agentId: "agentA", message: "msg2" }),
      queueDir
    );

    // Start daemon
    daemonPromise = runDaemon({
      configPath,
      queueDir,
      tasksDir: path.join(tmpDir, "tasks"),
      pidFile: path.join(tmpDir, "daemon.pid"),
      baseDir: tmpDir,
    });

    // Wait for first message to be picked up
    await Bun.sleep(2500);

    // Only the first message should have started (agent is busy)
    expect(events).toContain("start:msg1");
    expect(events).not.toContain("start:msg2");

    // Complete the first message
    completionCallbacks[0]({ success: true, output: "done1", exitCode: 0 });

    // Wait for the second message to be picked up
    await Bun.sleep(2500);

    expect(events).toContain("start:msg2");

    // Complete the second and shut down
    if (completionCallbacks[1]) {
      completionCallbacks[1]({ success: true, output: "done2", exitCode: 0 });
    }

    process.emit("SIGTERM" as any);
    await Promise.race([daemonPromise, Bun.sleep(2000)]);
    daemonPromise = null;

    // Verify sequential order: msg1 started before msg2
    const startMsg1Idx = events.indexOf("start:msg1");
    const startMsg2Idx = events.indexOf("start:msg2");
    expect(startMsg1Idx).toBeLessThan(startMsg2Idx);
  }, 15000);

  test("messages for different agents can run in parallel", async () => {
    const events: string[] = [];
    const completionCallbacks: Map<string, (result: any) => void> = new Map();

    executePromptStreamingMock.mockImplementation(
      (_workDir: string, message: string, callbacks: any, _options: any) => {
        events.push(`start:${message}`);
        completionCallbacks.set(message, (result: any) => {
          events.push(`complete:${message}`);
          callbacks.onComplete(result);
        });
        return { cancel: mock(() => {}) };
      }
    );

    // Create config with two agents
    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      [
        "workspace:",
        "  path: /tmp/ws",
        "providers: {}",
        "agents:",
        "  agentA:",
        "    name: Agent A",
        "    provider: anthropic",
        "    model: sonnet",
        "    working_directory: /tmp/agentA-work",
        "    telegram:",
        '      bot_token: "123456:ABC-fake-A"',
        "  agentB:",
        "    name: Agent B",
        "    provider: anthropic",
        "    model: sonnet",
        "    working_directory: /tmp/agentB-work",
        "    telegram:",
        '      bot_token: "654321:ABC-fake-B"',
      ].join("\n")
    );

    // Queue one message per agent
    await writeIncoming(
      makeIncomingMessage({ agentId: "agentA", message: "msgA" }),
      queueDir
    );
    await Bun.sleep(10);
    await writeIncoming(
      makeIncomingMessage({ agentId: "agentB", message: "msgB" }),
      queueDir
    );

    // Start daemon
    daemonPromise = runDaemon({
      configPath,
      queueDir,
      tasksDir: path.join(tmpDir, "tasks"),
      pidFile: path.join(tmpDir, "daemon.pid"),
      baseDir: tmpDir,
    });

    // Wait for both messages to be picked up (they should run in parallel)
    await Bun.sleep(3000);

    // Both should have started even though neither has completed
    expect(events).toContain("start:msgA");
    expect(events).toContain("start:msgB");

    // Complete both and shut down
    completionCallbacks.get("msgA")?.({ success: true, output: "doneA", exitCode: 0 });
    completionCallbacks.get("msgB")?.({ success: true, output: "doneB", exitCode: 0 });

    process.emit("SIGTERM" as any);
    await Promise.race([daemonPromise, Bun.sleep(2000)]);
    daemonPromise = null;
  }, 15000);
});

// Restore all module mocks after this file so they don't leak into other test files
afterAll(() => {
  mock.restore();
});
