/**
 * Queue System - File-based message queue
 * Uses atomic writes and Zod validation.
 */

import path from "path";
import fs from "fs";
import os from "os";
import { z } from "zod";
import { createLogger } from "./logger";

const logger = createLogger("queue");

// ============================================================================
// SCHEMAS
// ============================================================================

const IncomingMessageSchema = z.object({
  channel: z.string(),
  sender: z.string(),
  senderId: z.union([z.string(), z.number()]),
  message: z.string(),
  timestamp: z.number(),
  messageId: z.string(),
  agentId: z.string().optional(),
  botToken: z.string().optional(),
  sessionId: z.string().optional(),
  media: z
    .array(
      z.object({
        type: z.string(),
        fileId: z.string(),
        mimeType: z.string().optional(),
      })
    )
    .optional(),
});

const OutgoingMessageSchema = z.object({
  channel: z.string(),
  senderId: z.union([z.string(), z.number()]),
  message: z.string(),
  timestamp: z.number(),
  botToken: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        caption: z.string().optional(),
      })
    )
    .optional(),
});

// ============================================================================
// TYPES
// ============================================================================

export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>;

export interface QueuedMessage<T> {
  id: string;
  message: T;
  filePath: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Generate a timestamp-based file ID: <timestamp>-<random>
 */
function generateFileId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}`;
}

/**
 * Atomically write JSON to file using tmp → rename.
 * Validates data against schema before writing.
 */
async function atomicWriteJSON(
  filePath: string,
  data: unknown,
  schema: z.ZodSchema
): Promise<void> {
  const validated = schema.parse(data);
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(validated, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Safely read and parse a JSON file against a schema.
 * On any error (parse failure or validation failure), moves the file
 * to the errors/ directory and returns null.
 */
async function safeReadJSON<T>(
  filePath: string,
  schema: z.ZodSchema,
  queueDir: string
): Promise<T | null> {
  try {
    const content = await Bun.file(filePath).text();
    const parsed = JSON.parse(content);
    return schema.parse(parsed) as T;
  } catch (error) {
    const errorsDir = path.join(queueDir, "errors");
    if (!fs.existsSync(errorsDir)) {
      fs.mkdirSync(errorsDir, { recursive: true });
    }
    const destPath = path.join(errorsDir, path.basename(filePath));
    try {
      fs.renameSync(filePath, destPath);
      logger.warn(`Moved corrupt file to errors/`, { filePath, destPath });
    } catch (moveErr) {
      logger.error(`Failed to move corrupt file`, { filePath, moveErr });
    }
    return null;
  }
}

/**
 * List JSON files in a directory sorted by mtime (oldest first).
 * Skips .tmp files.
 */
function listFilesByMtime(dir: string): Array<{ name: string; filePath: string }> {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .map((f) => ({
      name: f,
      filePath: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtime.getTime(),
    }))
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ name, filePath }) => ({ name, filePath }));
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Create incoming/, outgoing/, and errors/ subdirectories under queueDir.
 * Idempotent — safe to call multiple times.
 */
export async function initializeQueue(queueDir?: string): Promise<void> {
  const base = queueDir ?? path.join(os.homedir(), ".turboclaw", "queue");
  for (const sub of ["incoming", "outgoing", "errors"]) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

// ============================================================================
// INCOMING QUEUE
// ============================================================================

/**
 * Write a message to the incoming queue.
 * Returns the file ID (without .json extension).
 */
export async function writeIncoming(
  message: IncomingMessage,
  queueDir?: string
): Promise<string> {
  const base = queueDir ?? path.join(os.homedir(), ".turboclaw", "queue");
  const id = generateFileId();
  const filePath = path.join(base, "incoming", `${id}.json`);
  await atomicWriteJSON(filePath, message, IncomingMessageSchema);
  return id;
}

/**
 * Read the oldest message from the incoming queue (FIFO).
 * Skips and quarantines corrupt files.
 * Returns null if the queue is empty or the directory does not exist.
 */
export async function readIncoming(
  queueDir?: string,
  options?: { skipAgentIds?: Set<string> }
): Promise<QueuedMessage<IncomingMessage> | null> {
  const base = queueDir ?? path.join(os.homedir(), ".turboclaw", "queue");
  const dir = path.join(base, "incoming");

  if (!fs.existsSync(dir)) {
    return null;
  }

  for (const { name, filePath } of listFilesByMtime(dir)) {
    const message = await safeReadJSON<IncomingMessage>(
      filePath,
      IncomingMessageSchema,
      base
    );
    if (message) {
      if (options?.skipAgentIds?.has(message.agentId ?? "")) {
        continue;
      }
      return { id: name.replace(".json", ""), message, filePath };
    }
  }

  return null;
}

// ============================================================================
// OUTGOING QUEUE
// ============================================================================

/**
 * Write a message to the outgoing queue.
 * Returns the file ID (without .json extension).
 */
export async function writeOutgoing(
  message: OutgoingMessage,
  queueDir?: string
): Promise<string> {
  const base = queueDir ?? path.join(os.homedir(), ".turboclaw", "queue");
  const id = generateFileId();
  const filePath = path.join(base, "outgoing", `${id}.json`);
  await atomicWriteJSON(filePath, message, OutgoingMessageSchema);
  return id;
}

/**
 * Read the oldest message from the outgoing queue (FIFO).
 * Skips and quarantines corrupt files.
 * Returns null if the queue is empty or the directory does not exist.
 */
export async function readOutgoing(
  queueDir?: string
): Promise<QueuedMessage<OutgoingMessage> | null> {
  const base = queueDir ?? path.join(os.homedir(), ".turboclaw", "queue");
  const dir = path.join(base, "outgoing");

  if (!fs.existsSync(dir)) {
    return null;
  }

  for (const { name, filePath } of listFilesByMtime(dir)) {
    const message = await safeReadJSON<OutgoingMessage>(
      filePath,
      OutgoingMessageSchema,
      base
    );
    if (message) {
      return { id: name.replace(".json", ""), message, filePath };
    }
  }

  return null;
}

// ============================================================================
// DELETE
// ============================================================================

/**
 * Delete a queued message by its file ID.
 * Does not throw if the file does not exist.
 */
export async function deleteMessage(
  messageId: string,
  queueType: "incoming" | "outgoing",
  queueDir?: string
): Promise<void> {
  const base = queueDir ?? path.join(os.homedir(), ".turboclaw", "queue");
  const filePath = path.join(base, queueType, `${messageId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
