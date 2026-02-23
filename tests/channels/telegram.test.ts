/**
 * Telegram Channel Tests - TDD for Phase 8
 *
 * These tests are written BEFORE the production code is rewritten (RED phase).
 * They describe the new, clean Telegram channel that:
 *  - Removes all pairing-based auth
 *  - Adds whitelist-based auth via isUserAllowed()
 *  - Adds TelegramStreamer class for streaming responses
 *  - Maintains createTelegramMessage() and formatTelegramResponse()
 *  - Handles duplicate message detection via a 5-minute cache
 */

import {
  test,
  expect,
  describe,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

import {
  isUserAllowed,
  createTelegramMessage,
  formatTelegramResponse,
  TelegramStreamer,
} from "../../src/channels/telegram";

import type { IncomingMessage } from "../../src/lib/queue";

// ============================================================================
// 1. isUserAllowed
// ============================================================================

describe("isUserAllowed", () => {
  test("returns true when user is in the whitelist", () => {
    expect(isUserAllowed(42, [42, 99, 777])).toBe(true);
  });

  test("returns true when userId matches as a number from a string-keyed list", () => {
    // allowedUsers may be stored as numbers in config
    expect(isUserAllowed(123, [100, 123, 200])).toBe(true);
  });

  test("returns false when user is NOT in the whitelist", () => {
    expect(isUserAllowed(9999, [42, 99, 777])).toBe(false);
  });

  test("returns true when whitelist is empty (allow all)", () => {
    expect(isUserAllowed(42, [])).toBe(true);
  });

  test("returns true when whitelist is undefined (allow all)", () => {
    expect(isUserAllowed(42, undefined as unknown as number[])).toBe(true);
  });

  test("returns true when whitelist is null (allow all)", () => {
    expect(isUserAllowed(42, null as unknown as number[])).toBe(true);
  });

  test("works with large user IDs (Telegram supports up to 64-bit int)", () => {
    const bigId = 9_999_999_999;
    expect(isUserAllowed(bigId, [bigId])).toBe(true);
    expect(isUserAllowed(bigId, [1, 2, 3])).toBe(false);
  });
});

// ============================================================================
// 2. formatTelegramResponse
// ============================================================================

describe("formatTelegramResponse", () => {
  test("returns short messages as a single chunk", () => {
    const msg = "Hello, world!";
    expect(formatTelegramResponse(msg)).toEqual([msg]);
  });

  test("returns empty string as single empty chunk", () => {
    expect(formatTelegramResponse("")).toEqual([""]);
  });

  test("returns message of exactly 4096 chars as single chunk", () => {
    const msg = "x".repeat(4096);
    const chunks = formatTelegramResponse(msg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(msg);
  });

  test("splits message longer than 4096 chars into multiple chunks", () => {
    const msg = "a".repeat(5000);
    const chunks = formatTelegramResponse(msg);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("every chunk is at most 4096 characters", () => {
    const msg = "a".repeat(9000);
    const chunks = formatTelegramResponse(msg);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  });

  test("splits at newline boundary when possible", () => {
    // 4000 a's + newline + 1000 b's  =>  split after 'a' block
    const msg = "a".repeat(4000) + "\n" + "b".repeat(1000);
    const chunks = formatTelegramResponse(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(4000));
    expect(chunks[1]).toBe("b".repeat(1000));
  });

  test("reassembles into original content (no bytes lost)", () => {
    const msg = "line one\nline two\n" + "x".repeat(8000) + "\nline end";
    const chunks = formatTelegramResponse(msg);
    // Join without separator because splitting strips leading newline
    const reassembled = chunks.join("\n");
    // Every original word/line should be present
    expect(reassembled).toContain("line one");
    expect(reassembled).toContain("line end");
    expect(reassembled).toContain("x".repeat(100));
  });

  test("handles message with no newlines by falling back to space or hard cut", () => {
    const msg = "word ".repeat(1100); // ~5500 chars, no newlines between words except spaces
    const chunks = formatTelegramResponse(msg);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  });

  test("handles message with no whitespace at all (hard cut)", () => {
    const msg = "z".repeat(9000);
    const chunks = formatTelegramResponse(msg);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    // All original characters must be preserved
    expect(chunks.join("").length).toBe(9000);
  });

  test("multiple splits produce chunks all within limit", () => {
    // 3 × 4500 chars = 13 500 chars total → at least 4 chunks
    const msg = "m".repeat(13_500);
    const chunks = formatTelegramResponse(msg);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  });
});

// ============================================================================
// 3. createTelegramMessage
// ============================================================================

describe("createTelegramMessage", () => {
  test("creates IncomingMessage with channel='telegram'", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    expect(result.channel).toBe("telegram");
  });

  test("sets sender to 'FirstName LastName' when both are provided", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "John", last_name: "Doe" },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    expect(result.sender).toBe("John Doe");
  });

  test("sets sender to first name only when last name is absent", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    expect(result.sender).toBe("Alice");
  });

  test("sets sender to 'Unknown' when no name is present", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111 },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    expect(result.sender).toBe("Unknown");
  });

  test("converts Unix timestamp (seconds) to milliseconds", () => {
    const unixSecs = 1_700_000_000;
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "hi",
      timestamp: unixSecs,
    });
    expect(result.timestamp).toBe(unixSecs * 1000);
  });

  test("uses text as message body", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "Hello bot!",
      timestamp: 1_700_000_000,
    });
    expect(result.message).toBe("Hello bot!");
  });

  test("falls back to caption when text is absent", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      caption: "Photo caption",
      timestamp: 1_700_000_000,
    });
    expect(result.message).toBe("Photo caption");
  });

  test("message is empty string when neither text nor caption is provided", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      timestamp: 1_700_000_000,
    });
    expect(result.message).toBe("");
  });

  test("messageId starts with 'telegram_'", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    expect(result.messageId).toMatch(/^telegram_/);
  });

  test("each call produces a unique messageId", () => {
    const makeMsg = () =>
      createTelegramMessage({
        chatId: 111,
        messageId: 1,
        from: { id: 111, first_name: "Alice" },
        text: "hi",
        timestamp: 1_700_000_000,
      });
    const ids = new Set([makeMsg().messageId, makeMsg().messageId, makeMsg().messageId]);
    expect(ids.size).toBe(3);
  });

  test("senderId matches the chatId as a string", () => {
    const result = createTelegramMessage({
      chatId: 987654,
      messageId: 1,
      from: { id: 987654, first_name: "Alice" },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    expect(result.senderId).toBe("987654");
  });

  test("attaches media array when provided", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "Photo here",
      timestamp: 1_700_000_000,
      media: [{ type: "photo", fileId: "file_abc123", mimeType: "image/jpeg" }],
    });
    expect(result.media).toBeDefined();
    expect(result.media).toHaveLength(1);
    expect(result.media?.[0]).toMatchObject({
      type: "photo",
      fileId: "file_abc123",
      mimeType: "image/jpeg",
    });
  });

  test("media is undefined when not provided", () => {
    const result = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    expect(result.media).toBeUndefined();
  });

  test("result satisfies IncomingMessage shape", () => {
    const result: IncomingMessage = createTelegramMessage({
      chatId: 111,
      messageId: 1,
      from: { id: 111, first_name: "Alice" },
      text: "hi",
      timestamp: 1_700_000_000,
    });
    // If the type assignment above compiles, the shape is correct.
    expect(result).toBeDefined();
  });
});

// ============================================================================
// 4. Duplicate message detection
// ============================================================================

describe("Duplicate message detection", () => {
  // The module exposes an isDuplicateMessage() helper (or equivalent mechanism).
  // We test the observable behaviour: calling the function twice with the same
  // key returns true on the second call, but we need a way to reset the cache
  // between test runs.  The module should export a testable helper or the
  // processed-messages Map should be resetable.

  // Import the detection helpers — these MUST be exported by the new implementation.
  // If they are not exported yet the test will fail at import time (good — RED).
  let isDuplicateMessage: (chatId: number, messageId: number) => boolean;
  let resetProcessedMessages: () => void;

  beforeEach(async () => {
    // Dynamic import so that a missing export causes a clear failure
    const mod = await import("../../src/channels/telegram");
    isDuplicateMessage = (mod as any).isDuplicateMessage;
    resetProcessedMessages = (mod as any).resetProcessedMessages;
    if (typeof resetProcessedMessages === "function") {
      resetProcessedMessages();
    }
  });

  test("isDuplicateMessage is exported", () => {
    expect(typeof isDuplicateMessage).toBe("function");
  });

  test("resetProcessedMessages is exported", () => {
    expect(typeof resetProcessedMessages).toBe("function");
  });

  test("first call returns false (not a duplicate)", () => {
    expect(isDuplicateMessage(100, 1)).toBe(false);
  });

  test("second call with same chatId and messageId returns true", () => {
    isDuplicateMessage(200, 2); // first call — registers the message
    expect(isDuplicateMessage(200, 2)).toBe(true);
  });

  test("different messageId is not considered duplicate", () => {
    isDuplicateMessage(300, 10);
    expect(isDuplicateMessage(300, 11)).toBe(false);
  });

  test("different chatId is not considered duplicate", () => {
    isDuplicateMessage(400, 20);
    expect(isDuplicateMessage(401, 20)).toBe(false);
  });

  test("resetProcessedMessages clears the cache", () => {
    isDuplicateMessage(500, 30);
    resetProcessedMessages();
    expect(isDuplicateMessage(500, 30)).toBe(false);
  });
});

// ============================================================================
// 5. TelegramStreamer
// ============================================================================

describe("TelegramStreamer", () => {
  // We inject a mock bot-like object that records API calls.

  type SentMessage = { chatId: number; text: string; options?: object };
  type EditedMessage = { chatId: number; messageId: number; text: string; options?: object };
  type DeletedMessage = { chatId: number; messageId: number };

  let sentMessages: SentMessage[];
  let editedMessages: EditedMessage[];
  let deletedMessages: DeletedMessage[];

  // Fake message_id counter for sendMessage responses
  let nextMessageId: number;

  function makeMockBotApi() {
    sentMessages = [];
    editedMessages = [];
    deletedMessages = [];
    nextMessageId = 1000;

    return {
      sendMessage: mock(async (chatId: number, text: string, options?: object) => {
        sentMessages.push({ chatId, text, options });
        return { message_id: nextMessageId++ };
      }),
      editMessageText: mock(
        async (chatId: number, messageId: number, text: string, options?: object) => {
          editedMessages.push({ chatId, messageId, text, options });
          return {};
        }
      ),
      deleteMessage: mock(async (chatId: number, messageId: number) => {
        deletedMessages.push({ chatId, messageId });
        return true;
      }),
    };
  }

  // Fake bot shape: { api: mockBotApi }
  function makeMockBot() {
    const api = makeMockBotApi();
    return { api };
  }

  const CHAT_ID = 42;
  const AGENT_ID = "test-agent";

  beforeEach(() => {
    sentMessages = [];
    editedMessages = [];
    deletedMessages = [];
    nextMessageId = 1000;
  });

  // -------------------------------------------------------------------------
  // 5a. Construction
  // -------------------------------------------------------------------------

  test("TelegramStreamer is a class that can be instantiated", () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);
    expect(streamer).toBeDefined();
  });

  test("TelegramStreamer exposes appendChunk() method", () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);
    expect(typeof streamer.appendChunk).toBe("function");
  });

  test("TelegramStreamer exposes finalize() method", () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);
    expect(typeof streamer.finalize).toBe("function");
  });

  // -------------------------------------------------------------------------
  // 5b. appendChunk — text accumulation
  // -------------------------------------------------------------------------

  test("appendChunk accumulates text in an internal buffer", () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);
    streamer.appendChunk("Hello");
    streamer.appendChunk(", ");
    streamer.appendChunk("world!");
    // Access internal buffer via a testable property
    expect((streamer as any).buffer).toBe("Hello, world!");
  });

  // -------------------------------------------------------------------------
  // 5c. First flush — sendMessage
  // -------------------------------------------------------------------------

  test("flush() sends initial message on first tool use", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);
    streamer.appendToolUse("Read", { file_path: "/tmp/test.md" });
    // appendToolUse flushes immediately; wait for it
    await new Promise((r) => setTimeout(r, 50));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].chatId).toBe(CHAT_ID);
    expect(sentMessages[0].text).toContain("Reading test.md");
    expect(editedMessages).toHaveLength(0);
  });

  test("flush() stores the returned message_id for subsequent edits", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);
    streamer.appendToolUse("Read", { file_path: "/tmp/file.ts" });
    await new Promise((r) => setTimeout(r, 50));

    expect((streamer as any).streamingMessageId).toBe(1000);
  });

  // -------------------------------------------------------------------------
  // 5d. Subsequent flushes — editMessageText
  // -------------------------------------------------------------------------

  test("second tool use edits the existing message instead of sending a new one", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    streamer.appendToolUse("Read", { file_path: "/tmp/a.ts" });
    await new Promise((r) => setTimeout(r, 50)); // sends message, gets ID 1000

    streamer.appendToolUse("Edit", { file_path: "/tmp/b.ts" });
    await new Promise((r) => setTimeout(r, 50)); // should edit

    expect(sentMessages).toHaveLength(1);
    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0].chatId).toBe(CHAT_ID);
    expect(editedMessages[0].messageId).toBe(1000);
    expect(editedMessages[0].text).toContain("Reading a.ts");
    expect(editedMessages[0].text).toContain("Editing b.ts");
  });

  // -------------------------------------------------------------------------
  // 5e. Truncation during streaming
  // -------------------------------------------------------------------------

  test("flush() truncates tool lines when over 4096 limit", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    // Add many tool lines to exceed 4096 chars
    for (let i = 0; i < 100; i++) {
      streamer.appendToolUse("Read", { file_path: `/tmp/${"x".repeat(50)}-${i}.ts` });
    }
    await new Promise((r) => setTimeout(r, 50));

    // All sent/edited messages must be within Telegram's limit
    for (const m of [...sentMessages, ...editedMessages]) {
      expect(m.text.length).toBeLessThanOrEqual(4096);
    }
  });

  // -------------------------------------------------------------------------
  // 5f. Throttle — ~2.5s intervals
  // -------------------------------------------------------------------------

  test("appendChunk does not immediately send a message (throttled)", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    streamer.appendChunk("chunk one");
    // No await — the internal timer has NOT fired yet
    // At this point, no messages should have been sent
    expect(sentMessages).toHaveLength(0);
  });

  test("TelegramStreamer stores throttle interval duration of approximately 2500ms", () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);
    // The implementation should expose the throttle interval for testing
    const interval = (streamer as any).throttleMs ?? (streamer as any).intervalMs;
    expect(interval).toBeGreaterThanOrEqual(2000);
    expect(interval).toBeLessThanOrEqual(3000);
  });

  // -------------------------------------------------------------------------
  // 5g. finalize()
  // -------------------------------------------------------------------------

  test("finalize() deletes the streaming message if one was sent", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    streamer.appendToolUse("Read", { file_path: "/tmp/test.md" });
    await new Promise((r) => setTimeout(r, 50)); // creates streaming message with ID 1000

    await streamer.finalize("Full final response");

    expect(deletedMessages).toHaveLength(1);
    expect(deletedMessages[0].chatId).toBe(CHAT_ID);
    expect(deletedMessages[0].messageId).toBe(1000);
  });

  test("finalize() sends the full output as a new message", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    streamer.appendToolUse("Read", { file_path: "/tmp/test.md" });
    await new Promise((r) => setTimeout(r, 50));

    const sentCountBefore = sentMessages.length; // 1 streaming message
    await streamer.finalize("The complete answer");

    // At least one new sendMessage call after the streaming message
    const newlySent = sentMessages.slice(sentCountBefore);
    expect(newlySent.length).toBeGreaterThanOrEqual(1);
    const combinedText = newlySent.map((m) => m.text).join("");
    expect(combinedText).toContain("The complete answer");
  });

  test("finalize() sends final message with Markdown parse mode", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    streamer.appendToolUse("Read", { file_path: "/tmp/test.md" });
    await new Promise((r) => setTimeout(r, 50));

    await streamer.finalize("**Bold answer**");

    const finalMessages = sentMessages.slice(1); // skip streaming message
    expect(finalMessages.length).toBeGreaterThanOrEqual(1);
    const lastCall = finalMessages[finalMessages.length - 1];
    expect(lastCall.options).toMatchObject({ parse_mode: "Markdown" });
  });

  test("finalize() does NOT delete streaming message if no message was sent", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    // Never flushed, so no streaming message exists
    await streamer.finalize("Direct answer");

    expect(deletedMessages).toHaveLength(0);
    // But it should still send the final message
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
  });

  test("finalize() splits long final output across multiple messages", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    // 10 000 char final output → must be split
    const longOutput = "f".repeat(10_000);
    await streamer.finalize(longOutput);

    // All sent messages combined should contain the full content
    const combined = sentMessages.map((m) => m.text).join("");
    expect(combined.length).toBe(10_000);
    // Every individual message must be within the limit
    expect(sentMessages.every((m) => m.text.length <= 4096)).toBe(true);
  });

  test("finalize() clears the internal throttle timer", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    streamer.appendToolUse("Read", { file_path: "/tmp/test.md" });
    await new Promise((r) => setTimeout(r, 50));
    await streamer.finalize("done");

    // After finalize, the timer should be null/cleared
    const timer = (streamer as any).flushTimer ?? (streamer as any).timer;
    expect(timer).toBeNull();
  });
});
