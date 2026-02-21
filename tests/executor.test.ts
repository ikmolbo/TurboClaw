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
  // 3. Continue mode: default behavior passes -c flag
  // -------------------------------------------------------------------------
  test("passes -c flag by default (continue mode)", async () => {
    const result = await executePrompt(WORK_DIR, "continue me");

    expect(lastSpawnArgs).toContain("-c");
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
      const proc = makeFakeProc({ chunks: ["alpha", "beta", "gamma"] });
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
      const proc = makeFakeProc({ chunks: ["final output"] });
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
  // 15. Streaming also passes -c flag by default
  // -------------------------------------------------------------------------
  test("passes -c flag by default in streaming mode", async () => {
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

    expect(lastSpawnArgs).toContain("-c");
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
