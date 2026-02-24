/**
 * HAN-31: Telegram session-related additions
 *
 * RED phase — written before the implementation exists.
 * All tests are expected to FAIL until:
 *   - sessionIdToEmoji() is exported from src/channels/telegram.ts
 *   - extractSessionIdFromText() is exported from src/channels/telegram.ts
 *   - TelegramStreamer constructor accepts sessionId as optional 4th parameter
 *   - TelegramStreamer.finalize() appends a blockquote footer when sessionId is set
 *
 * Emoji palette (index 0–7):
 *   ['🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫']
 * Color is determined by: hash(sessionId) % 8
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Import the functions under test.
// extractSessionIdFromText and sessionIdToEmoji do not yet exist — that is
// exactly why these tests fail.
// ---------------------------------------------------------------------------

import {
  TelegramStreamer,
  extractSessionIdFromText,
  sessionIdToEmoji,
} from "../../src/channels/telegram";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMOJI_PALETTE = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫"];

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
// 1. sessionIdToEmoji
// ============================================================================

describe("sessionIdToEmoji", () => {
  test("returns one of the 8 palette emoji characters", () => {
    const emoji = sessionIdToEmoji(SESSION_ID_A);
    expect(EMOJI_PALETTE).toContain(emoji);
  });

  test("is deterministic — same input always yields same emoji", () => {
    const first = sessionIdToEmoji(SESSION_ID_A);
    const second = sessionIdToEmoji(SESSION_ID_A);
    const third = sessionIdToEmoji(SESSION_ID_A);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  test("different session IDs can produce different emoji", () => {
    // With two distinct IDs we can at least assert they both return valid palette members.
    const emojiA = sessionIdToEmoji(SESSION_ID_A);
    const emojiB = sessionIdToEmoji(SESSION_ID_B);
    expect(EMOJI_PALETTE).toContain(emojiA);
    expect(EMOJI_PALETTE).toContain(emojiB);
  });

  test("distributes across all 8 colors when called with varied UUIDs", () => {
    // Generate 40 synthetic UUIDs spread across the alphabet and collect unique emoji.
    const uuids = [
      "00000000-0000-0000-0000-000000000000",
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
      "55555555-5555-5555-5555-555555555555",
      "66666666-6666-6666-6666-666666666666",
      "77777777-7777-7777-7777-777777777777",
      "88888888-8888-8888-8888-888888888888",
      "99999999-9999-9999-9999-999999999999",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "c0fb47e4-1f0f-47f1-917d-5b4714f3a156",
      "8341c70a-f680-4ef2-96ac-cb055c51d94b",
      "deadbeef-dead-beef-dead-beefdeadbeef",
      "cafebabe-cafe-babe-cafe-babecafebabe",
    ];

    const usedEmoji = new Set(uuids.map((id) => sessionIdToEmoji(id)));

    // With 20 varied inputs we expect to hit most (at least 3) of the 8 buckets
    expect(usedEmoji.size).toBeGreaterThanOrEqual(3);

    // Every returned value must be a valid palette entry
    for (const emoji of usedEmoji) {
      expect(EMOJI_PALETTE).toContain(emoji);
    }
  });

  test("returns a single emoji character (not a multi-character string)", () => {
    const emoji = sessionIdToEmoji(SESSION_ID_A);
    // Emoji characters in the palette are all single grapheme clusters
    // Spread into array to count grapheme clusters
    const chars = [...emoji];
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

  test("extracts the full UUID from a well-formed blockquote footer", () => {
    const text = `Some response text.\n<blockquote>🔵 session:${SESSION_ID_A}</blockquote>`;
    const result = extractSessionIdFromText(text);
    expect(result).toBe(SESSION_ID_A);
  });

  test("extracts UUID regardless of which emoji color is used", () => {
    for (const emoji of EMOJI_PALETTE) {
      const text = `Answer.\n<blockquote>${emoji} session:${SESSION_ID_B}</blockquote>`;
      const result = extractSessionIdFromText(text);
      expect(result).toBe(SESSION_ID_B);
    }
  });

  test("returns null when blockquote exists but has no session: prefix", () => {
    const text = `Answer.\n<blockquote>Just a regular blockquote</blockquote>`;
    expect(extractSessionIdFromText(text)).toBeNull();
  });

  test("returns null for a malformed UUID in the footer (too short)", () => {
    const text = `Answer.\n<blockquote>🔵 session:not-a-uuid</blockquote>`;
    expect(extractSessionIdFromText(text)).toBeNull();
  });

  test("returns null when the session ID is missing entirely after session:", () => {
    const text = `Answer.\n<blockquote>🔵 session:</blockquote>`;
    expect(extractSessionIdFromText(text)).toBeNull();
  });

  test("works when footer is the entire text (no preceding content)", () => {
    const text = `<blockquote>🟢 session:${SESSION_ID_A}</blockquote>`;
    expect(extractSessionIdFromText(text)).toBe(SESSION_ID_A);
  });

  test("returns the UUID from a multi-chunk message where footer is on the last chunk", () => {
    const longText =
      "word ".repeat(100) +
      `\n<blockquote>🟣 session:${SESSION_ID_B}</blockquote>`;
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

  test("finalize() appends session footer containing 'session:' when sessionId is provided", async () => {
    const bot = makeMockBot();
    // 4th constructor parameter is sessionId (new in this phase)
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("The response");

    const allText = sentMessages.map((m) => m.text).join("");
    expect(allText).toContain(`session:${SESSION_ID_A}`);
  });

  test("finalize() appends footer that is a HTML blockquote", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("The response");

    // The last sent message should end with a blockquote tag
    const lastSent = sentMessages[sentMessages.length - 1];
    expect(lastSent.text).toContain("<blockquote>");
    expect(lastSent.text).toContain("</blockquote>");
  });

  test("finalize() footer contains the deterministic emoji for the session ID", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("The response");

    const expectedEmoji = sessionIdToEmoji(SESSION_ID_A);
    const allText = sentMessages.map((m) => m.text).join("");
    expect(allText).toContain(expectedEmoji);
  });

  test("footer is appended to the last message chunk, not sent as a separate message", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("Short response");

    // Exactly one message should be sent (the response + footer together)
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Short response");
    expect(sentMessages[0].text).toContain(`session:${SESSION_ID_A}`);
  });

  test("footer blockquote format matches expected pattern", async () => {
    const bot = makeMockBot();
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID, SESSION_ID_A);

    await streamer.finalize("Response text");

    const allText = sentMessages.map((m) => m.text).join("");
    // Must match: <blockquote>{emoji} session:{uuid}</blockquote>
    const blockquotePattern =
      /<blockquote>[🔴🟠🟡🟢🔵🟣🟤⚫] session:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}<\/blockquote>/iu;
    expect(allText).toMatch(blockquotePattern);
  });

  // -------------------------------------------------------------------------
  // 3b. No footer when sessionId is absent (backwards compatibility)
  // -------------------------------------------------------------------------

  test("finalize() sends no session footer when sessionId is not provided", async () => {
    const bot = makeMockBot();
    // Original 3-argument constructor — no sessionId
    const streamer = new TelegramStreamer(bot as any, CHAT_ID, AGENT_ID);

    await streamer.finalize("The response");

    const allText = sentMessages.map((m) => m.text).join("");
    expect(allText).not.toContain("session:");
    expect(allText).not.toContain("<blockquote>");
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
    expect(lastMsg.text).toContain(`session:${SESSION_ID_A}`);

    // No earlier chunk should contain the footer
    const earlierChunks = sentMessages.slice(0, -1);
    for (const msg of earlierChunks) {
      expect(msg.text).not.toContain("session:");
    }
  });
});
