/**
 * Phase 4 Queue Tests - RED phase
 *
 * These tests define the expected behavior of the simplified queue.ts.
 * They MUST fail until the new implementation is written.
 *
 * Key changes from previous implementation:
 * - listIncoming() and listOutgoing() are REMOVED
 * - senderId accepts string | number (not just string)
 * - media schema changed: { type, fileId, mimeType? } (not { type, path, transcription? })
 * - files schema changed: Array<{ path, caption? }> (not Array<string>)
 * - File names are timestamp-based: <timestamp>-<random>.json
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import * as queue from "../src/lib/queue";
import path from "path";
import os from "os";
import fs from "fs";

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create a unique temp directory per test run for full isolation.
 * Using a random suffix avoids collisions when tests run in parallel.
 */
function makeTempQueueDir(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `turboclaw-queue-test-${suffix}`);
}

function makeIncomingMessage(
  overrides: Partial<queue.IncomingMessage> = {}
): queue.IncomingMessage {
  return {
    channel: "telegram",
    sender: "Test User",
    senderId: "123456",
    message: "Hello world",
    timestamp: Date.now(),
    messageId: `msg_${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

function makeOutgoingMessage(
  overrides: Partial<queue.OutgoingMessage> = {}
): queue.OutgoingMessage {
  return {
    channel: "telegram",
    senderId: "123456",
    message: "Hello back",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// SETUP / TEARDOWN
// ============================================================================

let TEST_QUEUE_DIR: string;

beforeEach(async () => {
  TEST_QUEUE_DIR = makeTempQueueDir();
  await queue.initializeQueue(TEST_QUEUE_DIR);
});

afterEach(() => {
  if (fs.existsSync(TEST_QUEUE_DIR)) {
    fs.rmSync(TEST_QUEUE_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// initializeQueue()
// ============================================================================

describe("initializeQueue()", () => {
  test("creates incoming/, outgoing/, and errors/ subdirectories", async () => {
    const dir = makeTempQueueDir();
    try {
      await queue.initializeQueue(dir);

      expect(fs.existsSync(path.join(dir, "incoming"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "outgoing"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "errors"))).toBe(true);
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — calling twice does not throw", async () => {
    const dir = makeTempQueueDir();
    try {
      await queue.initializeQueue(dir);
      await expect(queue.initializeQueue(dir)).resolves.toBeUndefined();
    } finally {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// writeIncoming()
// ============================================================================

describe("writeIncoming()", () => {
  test("returns a string message ID", async () => {
    const msg = makeIncomingMessage();
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("creates a JSON file in the incoming/ directory", async () => {
    const msg = makeIncomingMessage();
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("file contains valid JSON matching the written message", async () => {
    const msg = makeIncomingMessage({ message: "persistence check" });
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    const raw = await Bun.file(filePath).text();
    const parsed = JSON.parse(raw);

    expect(parsed.message).toBe("persistence check");
    expect(parsed.channel).toBe("telegram");
    expect(parsed.sender).toBe("Test User");
  });

  test("atomic write leaves no .tmp files behind", async () => {
    const msg = makeIncomingMessage();
    await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const incomingDir = path.join(TEST_QUEUE_DIR, "incoming");
    const tmpFiles = fs.readdirSync(incomingDir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  test("uses timestamp-based file names (<timestamp>-<random>.json)", async () => {
    const before = Date.now();
    const msg = makeIncomingMessage();
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);
    const after = Date.now();

    // ID must start with a numeric timestamp
    const timestampPart = parseInt(id.split("-")[0], 10);
    expect(timestampPart).toBeGreaterThanOrEqual(before);
    expect(timestampPart).toBeLessThanOrEqual(after);
  });

  test("accepts senderId as a number", async () => {
    const msg = makeIncomingMessage({ senderId: 987654 });
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.senderId).toBe(987654);
  });

  test("accepts optional agentId field", async () => {
    const msg = makeIncomingMessage({ agentId: "coder" });
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.agentId).toBe("coder");
  });

  test("accepts optional botToken field", async () => {
    const msg = makeIncomingMessage({ botToken: "123:ABC" });
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.botToken).toBe("123:ABC");
  });

  test("accepts optional media array with new schema (type, fileId, mimeType)", async () => {
    const msg = makeIncomingMessage({
      media: [{ type: "photo", fileId: "file_abc123", mimeType: "image/jpeg" }],
    });
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.media).toHaveLength(1);
    expect(parsed.media[0].fileId).toBe("file_abc123");
    expect(parsed.media[0].mimeType).toBe("image/jpeg");
  });

  test("rejects media items using old schema (path field instead of fileId)", async () => {
    const msg = {
      ...makeIncomingMessage(),
      media: [{ type: "voice", path: "/tmp/audio.ogg", transcription: "hello" }],
    } as any;

    await expect(queue.writeIncoming(msg, TEST_QUEUE_DIR)).rejects.toThrow();
  });

  test("rejects message missing required fields", async () => {
    const invalid = { channel: "telegram" } as any;
    await expect(queue.writeIncoming(invalid, TEST_QUEUE_DIR)).rejects.toThrow();
  });

  test("handles special characters in message content", async () => {
    const specialContent = 'Quotes: "hello" \'world\' \\ newline:\ntab:\t end';
    const msg = makeIncomingMessage({ message: specialContent });
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.message).toBe(specialContent);
  });

  test("multiple writes produce separate files", async () => {
    const msg1 = makeIncomingMessage({ message: "first" });
    const msg2 = makeIncomingMessage({ message: "second" });

    const id1 = await queue.writeIncoming(msg1, TEST_QUEUE_DIR);
    const id2 = await queue.writeIncoming(msg2, TEST_QUEUE_DIR);

    expect(id1).not.toBe(id2);

    const incomingDir = path.join(TEST_QUEUE_DIR, "incoming");
    const files = fs.readdirSync(incomingDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(2);
  });
});

// ============================================================================
// readIncoming()
// ============================================================================

describe("readIncoming()", () => {
  test("returns null when queue is empty", async () => {
    const result = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(result).toBeNull();
  });

  test("returns a QueuedMessage wrapping the original message", async () => {
    const msg = makeIncomingMessage({ message: "read me" });
    await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const queued = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(queued).not.toBeNull();
    expect(queued!.message.message).toBe("read me");
    expect(queued!.message.channel).toBe("telegram");
  });

  test("returned QueuedMessage includes id and filePath", async () => {
    const msg = makeIncomingMessage();
    await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const queued = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(queued).not.toBeNull();
    expect(typeof queued!.id).toBe("string");
    expect(queued!.id.length).toBeGreaterThan(0);
    expect(queued!.filePath).toContain("incoming");
    expect(fs.existsSync(queued!.filePath)).toBe(true);
  });

  test("FIFO ordering — returns oldest message first", async () => {
    const msg1 = makeIncomingMessage({ message: "oldest" });
    const msg2 = makeIncomingMessage({ message: "middle" });
    const msg3 = makeIncomingMessage({ message: "newest" });

    // Introduce mtime separation so sorting is reliable
    await queue.writeIncoming(msg1, TEST_QUEUE_DIR);
    await Bun.sleep(50);
    await queue.writeIncoming(msg2, TEST_QUEUE_DIR);
    await Bun.sleep(50);
    await queue.writeIncoming(msg3, TEST_QUEUE_DIR);

    const first = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(first!.message.message).toBe("oldest");
  });

  test("FIFO ordering — successive reads return messages in order", async () => {
    const messages = ["first", "second", "third"];
    for (const text of messages) {
      await queue.writeIncoming(makeIncomingMessage({ message: text }), TEST_QUEUE_DIR);
      await Bun.sleep(30);
    }

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await queue.readIncoming(TEST_QUEUE_DIR);
      expect(q).not.toBeNull();
      order.push(q!.message.message);
      await queue.deleteMessage(q!.id, "incoming", TEST_QUEUE_DIR);
    }

    expect(order).toEqual(messages);
  });

  test("skips corrupt JSON and returns next valid message", async () => {
    // Write a corrupt file with an old-style name (ensure it sorts first by mtime)
    const corruptPath = path.join(TEST_QUEUE_DIR, "incoming", "corrupt_001.json");
    await Bun.write(corruptPath, "{ not valid json }");

    await Bun.sleep(20);
    const msg = makeIncomingMessage({ message: "valid after corrupt" });
    await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const queued = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(queued).not.toBeNull();
    expect(queued!.message.message).toBe("valid after corrupt");
  });

  test("moves corrupt JSON file to errors/ directory", async () => {
    const corruptName = "corrupt_error_test.json";
    const corruptPath = path.join(TEST_QUEUE_DIR, "incoming", corruptName);
    await Bun.write(corruptPath, "<<< totally broken >>>");

    await queue.readIncoming(TEST_QUEUE_DIR);

    const errorPath = path.join(TEST_QUEUE_DIR, "errors", corruptName);
    expect(fs.existsSync(errorPath)).toBe(true);
    expect(fs.existsSync(corruptPath)).toBe(false);
  });

  test("returns null when all files are corrupt", async () => {
    for (let i = 0; i < 3; i++) {
      const corruptPath = path.join(TEST_QUEUE_DIR, "incoming", `corrupt_${i}.json`);
      await Bun.write(corruptPath, `{ bad json ${i} `);
    }

    const result = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(result).toBeNull();
  });

  test("returns null when incoming directory does not exist", async () => {
    const emptyDir = makeTempQueueDir();
    try {
      // Do NOT call initializeQueue — directory should not exist
      const result = await queue.readIncoming(emptyDir);
      expect(result).toBeNull();
    } finally {
      if (fs.existsSync(emptyDir)) fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("does not return .tmp files as messages", async () => {
    // Leave a stale temp file in the incoming dir
    const tmpPath = path.join(TEST_QUEUE_DIR, "incoming", "stale_write.json.tmp");
    await Bun.write(tmpPath, JSON.stringify(makeIncomingMessage()));

    const result = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(result).toBeNull();
  });
});

// ============================================================================
// writeOutgoing()
// ============================================================================

describe("writeOutgoing()", () => {
  test("returns a string message ID", async () => {
    const msg = makeOutgoingMessage();
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("creates a JSON file in the outgoing/ directory", async () => {
    const msg = makeOutgoingMessage();
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "outgoing", `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("file contains valid JSON matching the written message", async () => {
    const msg = makeOutgoingMessage({ message: "outgoing persistence" });
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "outgoing", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.message).toBe("outgoing persistence");
  });

  test("atomic write leaves no .tmp files behind", async () => {
    const msg = makeOutgoingMessage();
    await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const outgoingDir = path.join(TEST_QUEUE_DIR, "outgoing");
    const tmpFiles = fs.readdirSync(outgoingDir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  test("uses timestamp-based file names (<timestamp>-<random>.json)", async () => {
    const before = Date.now();
    const msg = makeOutgoingMessage();
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);
    const after = Date.now();

    const timestampPart = parseInt(id.split("-")[0], 10);
    expect(timestampPart).toBeGreaterThanOrEqual(before);
    expect(timestampPart).toBeLessThanOrEqual(after);
  });

  test("accepts senderId as a number", async () => {
    const msg = makeOutgoingMessage({ senderId: 42 });
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "outgoing", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.senderId).toBe(42);
  });

  test("accepts optional botToken field", async () => {
    const msg = makeOutgoingMessage({ botToken: "555:XYZ" });
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "outgoing", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.botToken).toBe("555:XYZ");
  });

  test("accepts optional files array with new schema ({ path, caption? })", async () => {
    const msg = makeOutgoingMessage({
      files: [
        { path: "/tmp/image.png", caption: "A screenshot" },
        { path: "/tmp/doc.pdf" },
      ],
    });
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "outgoing", `${id}.json`);
    const parsed = JSON.parse(await Bun.file(filePath).text());
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].path).toBe("/tmp/image.png");
    expect(parsed.files[0].caption).toBe("A screenshot");
    expect(parsed.files[1].path).toBe("/tmp/doc.pdf");
    expect(parsed.files[1].caption).toBeUndefined();
  });

  test("rejects files array using old schema (array of strings)", async () => {
    const msg = {
      ...makeOutgoingMessage(),
      files: ["/tmp/old-style.png"],
    } as any;

    await expect(queue.writeOutgoing(msg, TEST_QUEUE_DIR)).rejects.toThrow();
  });

  test("rejects message missing required fields", async () => {
    const invalid = { channel: "telegram" } as any;
    await expect(queue.writeOutgoing(invalid, TEST_QUEUE_DIR)).rejects.toThrow();
  });
});

// ============================================================================
// readOutgoing()
// ============================================================================

describe("readOutgoing()", () => {
  test("returns null when queue is empty", async () => {
    const result = await queue.readOutgoing(TEST_QUEUE_DIR);
    expect(result).toBeNull();
  });

  test("returns a QueuedMessage wrapping the original message", async () => {
    const msg = makeOutgoingMessage({ message: "outgoing read" });
    await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const queued = await queue.readOutgoing(TEST_QUEUE_DIR);
    expect(queued).not.toBeNull();
    expect(queued!.message.message).toBe("outgoing read");
  });

  test("returned QueuedMessage includes id and filePath", async () => {
    const msg = makeOutgoingMessage();
    await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const queued = await queue.readOutgoing(TEST_QUEUE_DIR);
    expect(queued).not.toBeNull();
    expect(typeof queued!.id).toBe("string");
    expect(queued!.filePath).toContain("outgoing");
    expect(fs.existsSync(queued!.filePath)).toBe(true);
  });

  test("FIFO ordering — returns oldest outgoing message first", async () => {
    const msg1 = makeOutgoingMessage({ message: "sent first" });
    const msg2 = makeOutgoingMessage({ message: "sent second" });

    await queue.writeOutgoing(msg1, TEST_QUEUE_DIR);
    await Bun.sleep(50);
    await queue.writeOutgoing(msg2, TEST_QUEUE_DIR);

    const queued = await queue.readOutgoing(TEST_QUEUE_DIR);
    expect(queued!.message.message).toBe("sent first");
  });

  test("FIFO ordering — successive reads return outgoing messages in order", async () => {
    const texts = ["alpha", "beta", "gamma"];
    for (const t of texts) {
      await queue.writeOutgoing(makeOutgoingMessage({ message: t }), TEST_QUEUE_DIR);
      await Bun.sleep(30);
    }

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await queue.readOutgoing(TEST_QUEUE_DIR);
      expect(q).not.toBeNull();
      order.push(q!.message.message);
      await queue.deleteMessage(q!.id, "outgoing", TEST_QUEUE_DIR);
    }

    expect(order).toEqual(texts);
  });

  test("skips corrupt outgoing JSON and returns next valid message", async () => {
    const corruptPath = path.join(TEST_QUEUE_DIR, "outgoing", "corrupt_out_001.json");
    await Bun.write(corruptPath, "definitely not json");

    await Bun.sleep(20);
    const msg = makeOutgoingMessage({ message: "valid outgoing" });
    await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const queued = await queue.readOutgoing(TEST_QUEUE_DIR);
    expect(queued).not.toBeNull();
    expect(queued!.message.message).toBe("valid outgoing");
  });

  test("moves corrupt outgoing JSON to errors/ directory", async () => {
    const corruptName = "corrupt_out_error.json";
    const corruptPath = path.join(TEST_QUEUE_DIR, "outgoing", corruptName);
    await Bun.write(corruptPath, "[broken");

    await queue.readOutgoing(TEST_QUEUE_DIR);

    const errorPath = path.join(TEST_QUEUE_DIR, "errors", corruptName);
    expect(fs.existsSync(errorPath)).toBe(true);
    expect(fs.existsSync(corruptPath)).toBe(false);
  });

  test("returns null when outgoing directory does not exist", async () => {
    const emptyDir = makeTempQueueDir();
    try {
      const result = await queue.readOutgoing(emptyDir);
      expect(result).toBeNull();
    } finally {
      if (fs.existsSync(emptyDir)) fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("does not return .tmp files as outgoing messages", async () => {
    const tmpPath = path.join(TEST_QUEUE_DIR, "outgoing", "stale.json.tmp");
    await Bun.write(tmpPath, JSON.stringify(makeOutgoingMessage()));

    const result = await queue.readOutgoing(TEST_QUEUE_DIR);
    expect(result).toBeNull();
  });
});

// ============================================================================
// deleteMessage()
// ============================================================================

describe("deleteMessage()", () => {
  test("removes an incoming message file", async () => {
    const msg = makeIncomingMessage();
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "incoming", `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    await queue.deleteMessage(id, "incoming", TEST_QUEUE_DIR);

    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("removes an outgoing message file", async () => {
    const msg = makeOutgoingMessage();
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    const filePath = path.join(TEST_QUEUE_DIR, "outgoing", `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    await queue.deleteMessage(id, "outgoing", TEST_QUEUE_DIR);

    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("does not throw when message does not exist", async () => {
    await expect(
      queue.deleteMessage("nonexistent-id", "incoming", TEST_QUEUE_DIR)
    ).resolves.toBeUndefined();
  });

  test("does not throw for outgoing when message does not exist", async () => {
    await expect(
      queue.deleteMessage("nonexistent-id", "outgoing", TEST_QUEUE_DIR)
    ).resolves.toBeUndefined();
  });

  test("after delete, readIncoming no longer returns that message", async () => {
    const msg = makeIncomingMessage({ message: "to be deleted" });
    const id = await queue.writeIncoming(msg, TEST_QUEUE_DIR);

    await queue.deleteMessage(id, "incoming", TEST_QUEUE_DIR);

    const result = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(result).toBeNull();
  });

  test("after delete, readOutgoing no longer returns that message", async () => {
    const msg = makeOutgoingMessage({ message: "outgoing deleted" });
    const id = await queue.writeOutgoing(msg, TEST_QUEUE_DIR);

    await queue.deleteMessage(id, "outgoing", TEST_QUEUE_DIR);

    const result = await queue.readOutgoing(TEST_QUEUE_DIR);
    expect(result).toBeNull();
  });

  test("only deletes the targeted message, leaves others intact", async () => {
    const msg1 = makeIncomingMessage({ message: "keep me" });
    const msg2 = makeIncomingMessage({ message: "delete me" });

    await queue.writeIncoming(msg1, TEST_QUEUE_DIR);
    await Bun.sleep(30);
    const id2 = await queue.writeIncoming(msg2, TEST_QUEUE_DIR);

    await queue.deleteMessage(id2, "incoming", TEST_QUEUE_DIR);

    const remaining = await queue.readIncoming(TEST_QUEUE_DIR);
    expect(remaining).not.toBeNull();
    expect(remaining!.message.message).toBe("keep me");
  });
});

// ============================================================================
// listIncoming / listOutgoing are REMOVED — verify they are not exported
// ============================================================================

describe("removed exports", () => {
  test("listIncoming is not exported from queue module", () => {
    expect((queue as any).listIncoming).toBeUndefined();
  });

  test("listOutgoing is not exported from queue module", () => {
    expect((queue as any).listOutgoing).toBeUndefined();
  });
});
