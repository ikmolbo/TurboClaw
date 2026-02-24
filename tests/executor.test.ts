/**
 * Phase 7: Comprehensive tests for the new executor.ts
 *
 * These tests are written BEFORE the production code is rewritten (RED phase).
 * They describe the new, clean executor that:
 *  - Has NO circuit breaker or rate limiter
 *  - Exports executePrompt() and executePromptStreaming()
 *  - Maps model shorthands (opus/sonnet/haiku) to full model IDs
 *  - Injects TURBOCLAW_AGENT_ID into the child process environment
 *  - Appends system context (date/timezone/OS) via --append-system-prompt
 *  - Controls -c (continue) flag based on options.reset
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Fake process factory
// ---------------------------------------------------------------------------

/** Creates a fresh fake child_process each time it is called. */
function makeFakeProc(opts: {
  chunks?: string[];
  exitCode?: number;
  errorChunks?: string[];
} = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof mock>;
    _triggerExit: () => void;
  };

  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});

  proc._triggerExit = () => {
    const chunks = opts.chunks ?? ["hello world"];
    const errorChunks = opts.errorChunks ?? [];
    const code = opts.exitCode ?? 0;

    for (const chunk of chunks) {
      proc.stdout.emit("data", Buffer.from(chunk));
    }
    for (const chunk of errorChunks) {
      proc.stderr.emit("data", Buffer.from(chunk));
    }
    proc.emit("close", code);
  };

  return proc;
}

// ---------------------------------------------------------------------------
// Module-level spawn mock (must be declared before the executor import)
// ---------------------------------------------------------------------------

// Holds the most-recently spawned fake process so tests can inspect it.
let lastProc: ReturnType<typeof makeFakeProc> | null = null;
// Holds the args and options passed to the most recent spawn() call.
let lastSpawnArgs: string[] = [];
let lastSpawnOptions: Record<string, any> = {};

const spawnMock = mock((_cmd: string, args: string[], options: Record<string, any>) => {
  const proc = makeFakeProc();
  lastProc = proc;
  lastSpawnArgs = args;
  lastSpawnOptions = options;
  // Trigger async exit so callers have a chance to attach listeners first.
  setImmediate(() => proc._triggerExit());
  return proc;
});

mock.module("child_process", () => ({
  spawn: spawnMock,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER the mock is installed
// ---------------------------------------------------------------------------

const { executePrompt, executePromptStreaming } = await import(
  "../src/agents/executor"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid Config object for tests that exercise provider/model logic. */
function makeConfig(model = "opus") {
  return {
    workspace: { path: "/tmp/workspace" },
    providers: {
      anthropic: { api_key: "test-key" },
    },
    agents: {
      "test-agent": {
        name: "Test Agent",
        provider: "anthropic",
        model,
        working_directory: "/tmp/agent",
      },
    },
  } as any;
}

const WORK_DIR = "/tmp/test-work";

/** Build a stream-json text_delta NDJSON line (with trailing newline). */
function streamTextDelta(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  }) + "\n";
}

/** Build a stream-json result NDJSON line (with trailing newline). */
function streamResult(result: string): string {
  return JSON.stringify({ type: "result", result }) + "\n";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executor — executePrompt()", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    lastProc = null;
    lastSpawnArgs = [];
    lastSpawnOptions = {};
  });

  // -------------------------------------------------------------------------
  // 1. Basic happy-path: spawns claude and returns full output
  // -------------------------------------------------------------------------
  test("returns ExecutionResult with success:true and captured output on exit 0", async () => {
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc({ chunks: ["chunk1 ", "chunk2"] });
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    const result = await executePrompt(WORK_DIR, "Hello, agent");

    expect(result.success).toBe(true);
    expect(result.output).toContain("chunk1");
    expect(result.output).toContain("chunk2");
    expect(result.exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. Non-zero exit code → success:false
  // -------------------------------------------------------------------------
  test("returns success:false when process exits with non-zero code", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc({
        exitCode: 1,
        errorChunks: ["something went wrong"],
      });
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    const result = await executePrompt(WORK_DIR, "fail");

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Default behavior: no session ID means no -c and no --session-id
  // -------------------------------------------------------------------------
  test("does not pass -c or --session-id by default (no sessionId provided)", async () => {
    const result = await executePrompt(WORK_DIR, "continue me");

    expect(lastSpawnArgs).not.toContain("-c");
  });

  // -------------------------------------------------------------------------
  // 4. Reset mode: omits -c flag
  // -------------------------------------------------------------------------
  test("omits -c flag when reset:true is passed", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "fresh start", { reset: true });

    expect(lastSpawnArgs).not.toContain("-c");
  });

  // -------------------------------------------------------------------------
  // 5. Explicit continue:false also omits -c flag
  // -------------------------------------------------------------------------
  test("omits -c flag when continue:false is passed", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "no continue", { continue: false });

    expect(lastSpawnArgs).not.toContain("-c");
  });

  // -------------------------------------------------------------------------
  // 6. Model mapping: "opus" → "claude-opus-4-6"
  // -------------------------------------------------------------------------
  test("maps model shorthand 'opus' to claude-opus-4-6 via ANTHROPIC_MODEL env", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "opus task", {
      agentId: "test-agent",
      config: makeConfig("opus"),
    });

    expect(lastSpawnOptions.env?.ANTHROPIC_MODEL).toBe("claude-opus-4-6");
  });

  // -------------------------------------------------------------------------
  // 7. Model mapping: "sonnet" → "claude-sonnet-4-5-20250929"
  // -------------------------------------------------------------------------
  test("maps model shorthand 'sonnet' to claude-sonnet-4-5-20250929 via ANTHROPIC_MODEL env", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "sonnet task", {
      agentId: "test-agent",
      config: makeConfig("sonnet"),
    });

    expect(lastSpawnOptions.env?.ANTHROPIC_MODEL).toBe("claude-sonnet-4-5-20250929");
  });

  // -------------------------------------------------------------------------
  // 8. Model mapping: "haiku" → "claude-haiku-4-5-20251001"
  // -------------------------------------------------------------------------
  test("maps model shorthand 'haiku' to claude-haiku-4-5-20251001 via ANTHROPIC_MODEL env", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "haiku task", {
      agentId: "test-agent",
      config: makeConfig("haiku"),
    });

    expect(lastSpawnOptions.env?.ANTHROPIC_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  // -------------------------------------------------------------------------
  // 9. TURBOCLAW_AGENT_ID env var is set on the spawned process
  // -------------------------------------------------------------------------
  test("injects TURBOCLAW_AGENT_ID into the spawned process environment", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "agent id test", {
      agentId: "my-agent",
      config: makeConfig("opus"),
    });

    expect(lastSpawnOptions.env?.TURBOCLAW_AGENT_ID).toBe("my-agent");
  });

  // -------------------------------------------------------------------------
  // 10. System context: --append-system-prompt arg with date/OS info
  // -------------------------------------------------------------------------
  test("passes --append-system-prompt with date and OS information", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "system context check");

    const appendIdx = lastSpawnArgs.indexOf("--append-system-prompt");
    expect(appendIdx).toBeGreaterThanOrEqual(0);

    const contextValue = lastSpawnArgs[appendIdx + 1];
    expect(contextValue).toBeDefined();
    // Must contain date-like info (year 2026)
    expect(contextValue).toMatch(/2026/);
    // Must contain timezone info
    expect(contextValue.toLowerCase()).toMatch(/timezone/i);
    // Must contain OS/system info
    expect(contextValue.toLowerCase()).toMatch(/system|macos|linux|windows/i);
  });

  test("includes agent ID in --append-system-prompt when provided", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "hello", { agentId: "support", config: makeConfig() });

    const appendIdx = lastSpawnArgs.indexOf("--append-system-prompt");
    const contextValue = lastSpawnArgs[appendIdx + 1];
    expect(contextValue).toContain("support");
  });

  // -------------------------------------------------------------------------
  // 11. No circuit breaker or rate limiter: module imports must not reference them
  // -------------------------------------------------------------------------
  test("executor module does not import rate-limiter or circuit-breaker", async () => {
    // Read the source and verify banned imports are absent.
    const src = await Bun.file(new URL("../src/agents/executor.ts", import.meta.url).pathname).text();
    expect(src).not.toContain("rate-limiter");
    expect(src).not.toContain("circuit-breaker");
    expect(src).not.toContain("createClaudeRateLimiter");
    expect(src).not.toContain("createClaudeCircuitBreaker");
  });
});

// ---------------------------------------------------------------------------
// Tests for executePromptStreaming()
// ---------------------------------------------------------------------------

describe("executor — executePromptStreaming()", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    lastProc = null;
    lastSpawnArgs = [];
    lastSpawnOptions = {};
  });

  // -------------------------------------------------------------------------
  // 12. onChunk is called for every stdout data event
  // -------------------------------------------------------------------------
  test("calls onChunk for each stdout data event", async () => {
    const chunks: string[] = [];

    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc({
        chunks: [
          streamTextDelta("alpha"),
          streamTextDelta("beta"),
          streamTextDelta("gamma"),
        ],
      });
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      // Do NOT auto-exit yet; let the test control timing
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "streaming test",
        {
          onChunk: (chunk) => {
            chunks.push(chunk);
          },
          onComplete: () => resolve(),
          onError: (err) => { throw err; },
        }
      );
    });

    // Now trigger the emissions
    setImmediate(() => capturedProc?._triggerExit());

    await completionPromise;

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.join("")).toContain("alpha");
    expect(chunks.join("")).toContain("beta");
    expect(chunks.join("")).toContain("gamma");
  });

  // -------------------------------------------------------------------------
  // 13. onComplete is called with the full result when the process exits
  // -------------------------------------------------------------------------
  test("calls onComplete with ExecutionResult when process exits", async () => {
    let capturedResult: any = null;
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc({
        chunks: [
          streamTextDelta("final output"),
          streamResult("final output"),
        ],
      });
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "completion test",
        {
          onChunk: () => {},
          onComplete: (result) => {
            capturedResult = result;
            resolve();
          },
          onError: (err) => { throw err; },
        }
      );
    });

    setImmediate(() => capturedProc?._triggerExit());

    await completionPromise;

    expect(capturedResult).not.toBeNull();
    expect(capturedResult.success).toBe(true);
    expect(capturedResult.output).toContain("final output");
  });

  // -------------------------------------------------------------------------
  // 14. cancel() kills the child process
  // -------------------------------------------------------------------------
  test("returned cancel() function calls kill() on the child process", async () => {
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      // Don't auto-exit so we can test cancellation before the process ends
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = mock(() => {});
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const handle = executePromptStreaming(
      WORK_DIR,
      "cancel test",
      {
        onChunk: () => {},
        onComplete: () => {},
        onError: () => {},
      }
    );

    expect(typeof handle.cancel).toBe("function");

    handle.cancel();

    expect(capturedProc?.kill).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 15a. Streaming passes --output-format=stream-json
  // -------------------------------------------------------------------------
  test("passes --output-format=stream-json and --verbose flags", async () => {
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "stream format check",
        {
          onChunk: () => {},
          onComplete: () => resolve(),
          onError: (err) => { throw err; },
        }
      );
    });

    setImmediate(() => capturedProc?._triggerExit());
    await completionPromise;

    expect(lastSpawnArgs).toContain("--output-format=stream-json");
    expect(lastSpawnArgs).toContain("--verbose");
    expect(lastSpawnArgs).toContain("--include-partial-messages");
  });

  // -------------------------------------------------------------------------
  // 15. Streaming mode: no session ID means no -c and no --session-id
  // -------------------------------------------------------------------------
  test("does not pass -c or --session-id by default in streaming mode (no sessionId provided)", async () => {
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "streaming continue",
        {
          onChunk: () => {},
          onComplete: () => resolve(),
          onError: (err) => { throw err; },
        }
      );
    });

    setImmediate(() => capturedProc?._triggerExit());
    await completionPromise;

    expect(lastSpawnArgs).not.toContain("-c");
  });

  // -------------------------------------------------------------------------
  // 16. Streaming omits -c flag when reset:true
  // -------------------------------------------------------------------------
  test("omits -c flag in streaming mode when reset:true", async () => {
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "streaming reset",
        {
          onChunk: () => {},
          onComplete: () => resolve(),
          onError: (err) => { throw err; },
        },
        { reset: true }
      );
    });

    setImmediate(() => capturedProc?._triggerExit());
    await completionPromise;

    expect(lastSpawnArgs).not.toContain("-c");
  });

  // -------------------------------------------------------------------------
  // 17. Streaming also injects TURBOCLAW_AGENT_ID
  // -------------------------------------------------------------------------
  test("injects TURBOCLAW_AGENT_ID into spawned process env in streaming mode", async () => {
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "streaming agent id",
        {
          onChunk: () => {},
          onComplete: () => resolve(),
          onError: (err) => { throw err; },
        },
        {
          agentId: "streaming-agent",
          config: makeConfig("opus"),
        }
      );
    });

    setImmediate(() => capturedProc?._triggerExit());
    await completionPromise;

    expect(lastSpawnOptions.env?.TURBOCLAW_AGENT_ID).toBe("streaming-agent");
  });
});

// ---------------------------------------------------------------------------
// HAN-31: Session ID flag tests
// These tests are written in the RED phase before implementation.
// They will FAIL until buildSpawnParams is updated to use --session-id.
// ---------------------------------------------------------------------------

describe("executor — session ID flag (HAN-31)", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    lastProc = null;
    lastSpawnArgs = [];
    lastSpawnOptions = {};
  });

  // -------------------------------------------------------------------------
  // S1. sessionId + isNewSession:true → --session-id <uuid> appears in args
  // -------------------------------------------------------------------------
  test("passes --session-id flag when isNewSession is true", async () => {
    const sessionId = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "session test", { sessionId, isNewSession: true });

    expect(lastSpawnArgs).toContain("--session-id");
    const idx = lastSpawnArgs.indexOf("--session-id");
    expect(lastSpawnArgs[idx + 1]).toBe(sessionId);
    expect(lastSpawnArgs).not.toContain("--resume");
  });

  // -------------------------------------------------------------------------
  // S1b. sessionId without isNewSession → --resume <uuid> appears in args
  // -------------------------------------------------------------------------
  test("passes --resume flag when sessionId provided without isNewSession", async () => {
    const sessionId = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "session test", { sessionId });

    expect(lastSpawnArgs).toContain("--resume");
    const idx = lastSpawnArgs.indexOf("--resume");
    expect(lastSpawnArgs[idx + 1]).toBe(sessionId);
    expect(lastSpawnArgs).not.toContain("--session-id");
  });

  // -------------------------------------------------------------------------
  // S2. sessionId provided → -c flag must NOT appear
  // -------------------------------------------------------------------------
  test("does not pass -c flag when sessionId is provided", async () => {
    const sessionId = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "session test", { sessionId, isNewSession: true });

    expect(lastSpawnArgs).not.toContain("-c");
  });

  // -------------------------------------------------------------------------
  // S3. No sessionId provided → neither -c nor --session-id nor --resume
  // -------------------------------------------------------------------------
  test("passes neither -c, --session-id, nor --resume when no sessionId is provided", async () => {
    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "no session reset", { reset: true });

    expect(lastSpawnArgs).not.toContain("-c");
    expect(lastSpawnArgs).not.toContain("--session-id");
    expect(lastSpawnArgs).not.toContain("--resume");
  });

  // -------------------------------------------------------------------------
  // S4. reset: true with sessionId + isNewSession → --session-id (new session)
  // -------------------------------------------------------------------------
  test("passes --session-id when reset:true and isNewSession:true", async () => {
    const sessionId = "8341c70a-f680-4ef2-96ac-cb055c51d94b";

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      setImmediate(() => proc._triggerExit());
      return proc;
    });

    await executePrompt(WORK_DIR, "session with reset", { sessionId, reset: true, isNewSession: true });

    expect(lastSpawnArgs).toContain("--session-id");
    const idx = lastSpawnArgs.indexOf("--session-id");
    expect(lastSpawnArgs[idx + 1]).toBe(sessionId);
    expect(lastSpawnArgs).not.toContain("-c");
    expect(lastSpawnArgs).not.toContain("--resume");
  });

  // -------------------------------------------------------------------------
  // S5. sessionId in streaming mode → --resume appears (existing session)
  // -------------------------------------------------------------------------
  test("passes --resume in streaming mode when sessionId is provided", async () => {
    const sessionId = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "streaming session",
        {
          onChunk: () => {},
          onComplete: () => resolve(),
          onError: (err) => { throw err; },
        },
        { sessionId }
      );
    });

    setImmediate(() => capturedProc?._triggerExit());
    await completionPromise;

    expect(lastSpawnArgs).toContain("--resume");
    const idx = lastSpawnArgs.indexOf("--resume");
    expect(lastSpawnArgs[idx + 1]).toBe(sessionId);
    expect(lastSpawnArgs).not.toContain("-c");
    expect(lastSpawnArgs).not.toContain("--session-id");
  });

  // -------------------------------------------------------------------------
  // S6. No sessionId in streaming mode → no --session-id and no --resume
  // -------------------------------------------------------------------------
  test("does not pass --session-id or --resume in streaming mode when no sessionId provided", async () => {
    let capturedProc: ReturnType<typeof makeFakeProc> | null = null;

    spawnMock.mockImplementationOnce((_cmd, args, options) => {
      const proc = makeFakeProc();
      capturedProc = proc;
      lastSpawnArgs = args;
      lastSpawnOptions = options;
      return proc;
    });

    const completionPromise = new Promise<void>((resolve) => {
      executePromptStreaming(
        WORK_DIR,
        "streaming no session",
        {
          onChunk: () => {},
          onComplete: () => resolve(),
          onError: (err) => { throw err; },
        },
        { reset: true }  // no sessionId
      );
    });

    setImmediate(() => capturedProc?._triggerExit());
    await completionPromise;

    expect(lastSpawnArgs).not.toContain("--session-id");
    expect(lastSpawnArgs).not.toContain("--resume");
  });
});
