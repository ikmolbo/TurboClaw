import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// This import will fail if the file doesn't exist — intentionally RED
import { sendCommand } from "../../src/cli/commands/send";
import { initializeQueue, readOutgoing } from "../../src/lib/queue";
import type { Config } from "../../src/config/index";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "turboclaw-send-test-"));
}

const mockConfig: Config = {
  workspace: { path: "/tmp/test-workspace" },
  providers: {},
  agents: {
    coder: {
      name: "Code Assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      working_directory: "/tmp/coder",
      heartbeat_interval: false,
      memory_mode: "isolated",
      telegram: { bot_token: "123:ABC", chat_id: 12345 },
    },
  },
};

// ----------------------------------------------------------------------------
// sendCommand tests
// ----------------------------------------------------------------------------

describe("sendCommand(args, config)", () => {
  let tmpDir: string;
  let originalAgentId: string | undefined;
  let originalQueueDir: string | undefined;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    originalAgentId = process.env.TURBOCLAW_AGENT_ID;
    originalQueueDir = process.env.TURBOCLAW_QUEUE_DIR;

    // Point the queue to a temp directory so tests are isolated
    process.env.TURBOCLAW_QUEUE_DIR = tmpDir;
    await initializeQueue(tmpDir);

    // Spy on process.exit to prevent test runner from actually exiting
    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    // Restore env vars
    if (originalAgentId === undefined) {
      delete process.env.TURBOCLAW_AGENT_ID;
    } else {
      process.env.TURBOCLAW_AGENT_ID = originalAgentId;
    }

    if (originalQueueDir === undefined) {
      delete process.env.TURBOCLAW_QUEUE_DIR;
    } else {
      process.env.TURBOCLAW_QUEUE_DIR = originalQueueDir;
    }

    processExitSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a message to the outgoing queue when TURBOCLAW_AGENT_ID is set and --message is provided", async () => {
    process.env.TURBOCLAW_AGENT_ID = "coder";

    await sendCommand(["--message", "hello world"], mockConfig);

    const queued = await readOutgoing(tmpDir);
    expect(queued).not.toBeNull();
    expect(queued!.message.message).toBe("hello world");
  });

  it("exits with code 1 when TURBOCLAW_AGENT_ID env var is not set", async () => {
    delete process.env.TURBOCLAW_AGENT_ID;

    await expect(sendCommand(["--message", "hello"], mockConfig)).rejects.toThrow();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when --message flag is missing", async () => {
    process.env.TURBOCLAW_AGENT_ID = "coder";

    await expect(sendCommand([], mockConfig)).rejects.toThrow();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when --message value is an empty string", async () => {
    process.env.TURBOCLAW_AGENT_ID = "coder";

    await expect(sendCommand(["--message", ""], mockConfig)).rejects.toThrow();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("uses TURBOCLAW_AGENT_ID as the agent identifier in the outgoing message", async () => {
    process.env.TURBOCLAW_AGENT_ID = "coder";

    await sendCommand(["--message", "test message"], mockConfig);

    const queued = await readOutgoing(tmpDir);
    expect(queued).not.toBeNull();
    // The message should reference the agent from env
    expect(queued!.message.channel).toBeDefined();
  });
});
