import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  writeIncoming,
  readIncoming,
  writeOutgoing,
  readOutgoing,
  deleteMessage,
  initializeQueue,
} from "../../src/lib/queue";
import { loadConfig } from "../../src/config/index";
import { isUserAllowed } from "../../src/channels/telegram";
import { CrashGuard } from "../../src/lib/crash-guard";

const TEST_DIR = join(import.meta.dir, ".test-e2e");
const QUEUE_DIR = join(TEST_DIR, "queue");
const CONFIG_PATH = join(TEST_DIR, "config.yaml");
const CRASH_LOG_PATH = join(TEST_DIR, "crash.log");

describe("End-to-End Integration", () => {
  beforeAll(async () => {
    // Create test queue directories
    await initializeQueue(QUEUE_DIR);
    mkdirSync(TEST_DIR, { recursive: true });

    // Create a valid config using the strict new schema (no channels/files/conversations)
    const testConfig = `workspace:
  path: /tmp/test-workspace
providers:
  anthropic: {}
agents:
  test-agent:
    name: Test Agent
    provider: anthropic
    model: sonnet
    working_directory: /tmp/test-workspace/test-agent
    telegram:
      bot_token: test-token
      chat_id: 123456789
`;
    writeFileSync(CONFIG_PATH, testConfig);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ==========================================================================
  // FULL MESSAGE FLOW: incoming queue -> (executor) -> outgoing delivery
  // ==========================================================================

  describe("Message Flow", () => {
    it("should write incoming message and read it back with correct fields", async () => {
      const messageId = await writeIncoming(
        {
          messageId: "e2e_msg_1",
          channel: "telegram",
          sender: "TestUser",
          senderId: "12345",
          message: "Hello from e2e test",
          timestamp: Date.now(),
          agentId: "test-agent",
        },
        QUEUE_DIR
      );

      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe("string");

      // Read it back
      const queued = await readIncoming(QUEUE_DIR);
      expect(queued).not.toBeNull();
      expect(queued!.message.channel).toBe("telegram");
      expect(queued!.message.sender).toBe("TestUser");
      expect(queued!.message.senderId).toBe("12345");
      expect(queued!.message.message).toBe("Hello from e2e test");
      expect(queued!.message.agentId).toBe("test-agent");

      // Clean up so it does not affect later tests
      await deleteMessage(queued!.id, "incoming", QUEUE_DIR);
    });

    it("should write outgoing message and read it back", async () => {
      const outId = await writeOutgoing(
        {
          channel: "telegram",
          senderId: "12345",
          message: "Response from executor",
          timestamp: Date.now(),
          botToken: "test-token",
        },
        QUEUE_DIR
      );

      expect(outId).toBeDefined();
      expect(typeof outId).toBe("string");

      const queued = await readOutgoing(QUEUE_DIR);
      expect(queued).not.toBeNull();
      expect(queued!.message.channel).toBe("telegram");
      expect(queued!.message.senderId).toBe("12345");
      expect(queued!.message.message).toBe("Response from executor");
      expect(queued!.message.botToken).toBe("test-token");

      await deleteMessage(queued!.id, "outgoing", QUEUE_DIR);
    });

    it("should handle media attachments with fileId schema", async () => {
      const messageId = await writeIncoming(
        {
          messageId: "e2e_msg_media",
          channel: "telegram",
          sender: "TestUser",
          senderId: "12345",
          message: "Check this image",
          timestamp: Date.now(),
          agentId: "test-agent",
          media: [
            {
              type: "photo",
              fileId: "AgACAgIAAxkB",
              mimeType: "image/jpeg",
            },
          ],
        },
        QUEUE_DIR
      );

      expect(messageId).toBeDefined();

      const queued = await readIncoming(QUEUE_DIR);
      expect(queued).not.toBeNull();
      expect(queued!.message.media).toBeDefined();
      expect(queued!.message.media).toBeArrayOfSize(1);
      expect(queued!.message.media![0].type).toBe("photo");
      expect(queued!.message.media![0].fileId).toBe("AgACAgIAAxkB");
      expect(queued!.message.media![0].mimeType).toBe("image/jpeg");

      await deleteMessage(queued!.id, "incoming", QUEUE_DIR);
    });
  });

  // ==========================================================================
  // WHITELIST: blocks unauthorized users
  // ==========================================================================

  describe("Whitelist Auth", () => {
    it("should block a user NOT in the whitelist", () => {
      const allowed = isUserAllowed(99999, [111, 222, 333]);
      expect(allowed).toBe(false);
    });

    it("should allow a user IN the whitelist", () => {
      const allowed = isUserAllowed(222, [111, 222, 333]);
      expect(allowed).toBe(true);
    });

    it("should allow everyone when whitelist is empty", () => {
      expect(isUserAllowed(99999, [])).toBe(true);
    });
  });

  // ==========================================================================
  // CRASH GUARD: blocks after threshold
  // ==========================================================================

  describe("Crash Guard", () => {
    it("should block restart after recording maxCrashes crashes", async () => {
      const guard = new CrashGuard({
        maxCrashes: 5,
        windowMs: 15 * 60 * 1000,
        crashLogPath: CRASH_LOG_PATH,
      });

      // Start clean
      await guard.clearCrashes();

      // Record 5 crashes
      for (let i = 0; i < 5; i++) {
        await guard.recordCrash(`test crash ${i}`);
      }

      const result = await guard.shouldAllowRestart();
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("should allow restart after clearing crashes", async () => {
      const guard = new CrashGuard({
        maxCrashes: 5,
        windowMs: 15 * 60 * 1000,
        crashLogPath: CRASH_LOG_PATH,
      });

      await guard.clearCrashes();

      const result = await guard.shouldAllowRestart();
      expect(result.allowed).toBe(true);
    });
  });

  // ==========================================================================
  // CONFIG: loads correctly with new strict schema
  // ==========================================================================

  describe("Config", () => {
    it("should load configuration with new strict schema", async () => {
      const config = await loadConfig(CONFIG_PATH);

      expect(config).toBeDefined();
      expect(config.workspace.path).toBe("/tmp/test-workspace");
      expect(config.agents).toBeDefined();
      expect(config.agents["test-agent"]).toBeDefined();
      expect(config.agents["test-agent"].name).toBe("Test Agent");
      // "sonnet" shorthand should be expanded to full model ID
      expect(config.agents["test-agent"].model).toContain("claude-");
      expect(config.agents["test-agent"].working_directory).toBe(
        "/tmp/test-workspace/test-agent"
      );
    });

    it("should strip unknown top-level keys silently (non-strict schema)", async () => {
      const invalidConfigPath = join(TEST_DIR, "invalid-config.yaml");
      const invalidConfig = `workspace:
  path: /tmp/test-workspace
providers:
  anthropic: {}
agents: {}
channels:
  telegram:
    enabled: false
`;
      writeFileSync(invalidConfigPath, invalidConfig);

      // Phase 14: schema no longer uses .strict(), unknown keys are stripped silently
      const loaded = await loadConfig(invalidConfigPath);
      expect(loaded.workspace.path).toBe("/tmp/test-workspace");
      expect((loaded as any).channels).toBeUndefined();
    });
  });

  // ==========================================================================
  // QUEUE MESSAGE FORMAT VALIDATION
  // ==========================================================================

  describe("Queue Message Format Validation", () => {
    it("should reject incoming messages missing required fields", async () => {
      await expect(
        writeIncoming(
          {
            // Missing channel, sender, senderId, timestamp, messageId
            message: "test",
          } as any,
          QUEUE_DIR
        )
      ).rejects.toThrow();
    });

    it("should reject media with path instead of fileId", async () => {
      await expect(
        writeIncoming(
          {
            messageId: "bad_media_msg",
            channel: "telegram",
            sender: "TestUser",
            senderId: "12345",
            message: "bad media",
            timestamp: Date.now(),
            media: [
              {
                type: "photo",
                // "path" is the old wrong field; schema requires "fileId"
                path: "/path/to/photo.jpg",
              } as any,
            ],
          },
          QUEUE_DIR
        )
      ).rejects.toThrow();
    });

    it("should accept valid incoming message with correct media schema", async () => {
      const id = await writeIncoming(
        {
          messageId: "valid_media_msg",
          channel: "telegram",
          sender: "TestUser",
          senderId: "12345",
          message: "valid media",
          timestamp: Date.now(),
          media: [
            {
              type: "document",
              fileId: "BQACAgIAAxkB",
              mimeType: "application/pdf",
            },
          ],
        },
        QUEUE_DIR
      );

      expect(id).toBeDefined();
      await deleteMessage(id, "incoming", QUEUE_DIR);
    });
  });
});
