/**
 * HAN-31: Telegram session-related additions
 *
 * Tests for:
 *   - sessionIdToDot() — deterministic dot for session IDs
 *   - extractSessionIdFromText() — extract UUID from message footer
 *   - TelegramStreamer.finalize() — expandable blockquote footer with session ID
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

import {
  TelegramStreamer,
  extractSessionIdFromText,
  sessionIdToDot,
} from "../../src/channels/telegram";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Known session IDs used across tests
const SESSION_ID_A = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";
const SESSION_ID_B = "8341c70a-f680-4ef2-96ac-cb055c51d94b";

// ---------------------------------------------------------------------------
// Mock bot factory — mirrors the shape used in telegram.test.ts
// ---------------------------------------------------------------------------

type SentMessage = { chatId: number; text: string; options?: object };
type EditedMessage = { chatId: number; messageId: number; text: string; options?: object };
type DeletedMessage = { chatId: number; messageId: number };

let sentMessages: SentMessage[];
let editedMessages: EditedMessage[];
let deletedMessages: DeletedMessage[];
let nextMessageId: number;

function makeMockBot() {
  sentMessages = [];
  editedMessages = [];
  deletedMessages = [];
  nextMessageId = 1000;

  const api = {
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

// ============================================================================
// 1. sessionIdToDot
// ============================================================================

describe("sessionIdToDot", () => {
  test("returns a dot character", () => {
    const dot = sessionIdToDot(SESSION_ID_A);
    expect(dot).toBe("●");
  });

  test("is deterministic — same input always yields same result", () => {
    const first = sessionIdToDot(SESSION_ID_A);
    const second = sessionIdToDot(SESSION_ID_A);
    const third = sessionIdToDot(SESSION_ID_A);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  test("returns a single character", () => {
    const dot = sessionIdToDot(SESSION_ID_A);
    const chars = [...dot];
    expect(chars.length).toBe(1);
  });
});

// ============================================================================
// 2. extractSessionIdFromText
// ============================================================================

describe("extractSessionIdFromText", () => {
  test("returns null for plain text with no session footer", () => {
    const result = extractSessionIdFromText("Hello, this is a normal message.");
    expect(result).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractSessionIdFromText("")).toBeNull();
  });

  test("extracts UUID from compact format (s:uuid)", () => {
    const text = `Some response text.\n<blockquote expandable>● s:${SESSION_ID_A}</blockquote>`;
    const result = extractSessionIdFromText(text);
    expect(result).toBe(SESSION_ID_A);
  });

  test("extracts UUID from legacy format (session:uuid)", () => {
    const text = `Some response text.\n<blockquote>🔵 session:${SESSION_ID_A}</blockquote>`;
    const result = extractSessionIdFromText(text);
    expect(result).toBe(SESSION_ID_A);
  });

  test("returns null when blockquote exists but has no s: or session: prefix", () => {
    const text = `Answer.\n<blockquote>Just a regular blockquote</blockquote>`;
    expect(extractSessionIdFromText(text)).toBeNull();
  });

  test("returns null for a malformed UUID (too short)", () => {
    const text = `Answer.\n<blockquote expandable>● s:not-a-uuid</blockquote>`;
    expect(extractSessionIdFromText(text)).toBeNull();
  });

  test("returns null when the session ID is missing entirely after s:", () => {
    const text = `Answer.\n<blockquote expandable>● s:</blockquote>`;
    expect(extractSessionIdFromText(text)).toBeNull();
  });

  test("works when footer is the entire text (no preceding content)", () => {
    const text = `<blockquote expandable>● s:${SESSION_ID_A}</blockquote>`;
    expect(extractSessionIdFromText(text)).toBe(SESSION_ID_A);
  });

  test("returns the UUID from a multi-chunk message where footer is on the last chunk", () => {
    const longText =
      "word ".repeat(100) +
      `\n<blockquote expandable>● s:${SESSION_ID_B}</blockquote>`;
    expect(extractSessionIdFromText(longText)).toBe(SESSION_ID_B);
  });
});

// ============================================================================
// 3. TelegramStreamer.finalize() — session footer behaviour
// ============================================================================

describe("TelegramStreamer finalize() session footer", () => {
  // -------------------------------------------------------------------------
  // 3a. Footer appended when sessionId is provided
  // -------------------------------------------------------------------------

  test("finalize() appends session footer containing 's:' when sessionId is provided", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("The response");

    const allText = sentMessages.map((m) => m.text).join("");
    expect(allText).toContain(`s:${SESSION_ID_A}`);
  });

  test("finalize() appends footer as an expandable HTML blockquote", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("The response");

    const lastSent = sentMessages[sentMessages.length - 1];
    expect(lastSent.text).toContain("<blockquote expandable>");
    expect(lastSent.text).toContain("</blockquote>");
  });

  test("finalize() footer contains the dot character for the session ID", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("The response");

    const expectedDot = sessionIdToDot(SESSION_ID_A);
    const allText = sentMessages.map((m) => m.text).join("");
    expect(allText).toContain(expectedDot);
  });

  test("footer is appended to the last message chunk, not sent as a separate message", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("Short response");

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Short response");
    expect(sentMessages[0].text).toContain(`s:${SESSION_ID_A}`);
  });

  test("footer blockquote format matches expected pattern", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("Response text");

    const allText = sentMessages.map((m) => m.text).join("");
    // Must match: <blockquote expandable>● s:{uuid}</blockquote>
    const blockquotePattern =
      /<blockquote expandable>● s:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}<\/blockquote>/iu;
    expect(allText).toMatch(blockquotePattern);
  });

  // -------------------------------------------------------------------------
  // 3b. No footer when sessionId is absent (backwards compatibility)
  // -------------------------------------------------------------------------

  test("finalize() sends no session footer when sessionId is not provided", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    await streamer.finalize("The response");

    const allText = sentMessages.map((m) => m.text).join("");
    expect(allText).not.toContain("s:");
    expect(allText).not.toContain("<blockquote");
  });

  test("finalize() without sessionId still sends the response text", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    await streamer.finalize("Plain response without session");

    const allText = sentMessages.map((m) => m.text).join("");
    expect(allText).toContain("Plain response without session");
  });

  // -------------------------------------------------------------------------
  // 3c. Footer extracted round-trip
  // -------------------------------------------------------------------------

  test("text sent by finalize() can have its session ID recovered via extractSessionIdFromText", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_B);

    await streamer.finalize("Check round-trip");

    const lastSent = sentMessages[sentMessages.length - 1];
    const recovered = extractSessionIdFromText(lastSent.text);
    expect(recovered).toBe(SESSION_ID_B);
  });

  // -------------------------------------------------------------------------
  // 3d. Long output — footer on last chunk
  // -------------------------------------------------------------------------

  test("footer appears only on the last message chunk when output is long", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    // Force a multi-chunk split (> 4096 chars)
    const longOutput = "f".repeat(5000);
    await streamer.finalize(longOutput);

    // Must have sent more than one message
    expect(sentMessages.length).toBeGreaterThan(1);

    // Footer must appear exactly once — on the last message
    const lastMsg = sentMessages[sentMessages.length - 1];
    expect(lastMsg.text).toContain(`s:${SESSION_ID_A}`);

    // No earlier chunk should contain the footer
    const earlierChunks = sentMessages.slice(0, -1);
    for (const msg of earlierChunks) {
      expect(msg.text).not.toContain("s:");
    }
  });
});
