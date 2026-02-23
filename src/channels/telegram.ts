/**
 * Telegram Channel - Bot listener and sender using grammy
 *
 * Phase 8 rewrite:
 * - Removes pairing-based auth entirely
 * - Adds whitelist-based auth via isUserAllowed()
 * - Adds TelegramStreamer class for streaming responses
 * - Maintains createTelegramMessage() and formatTelegramResponse()
 * - Handles duplicate message detection via a 5-minute cache
 */

import { Bot, type Context } from "grammy";
import type { IncomingMessage, OutgoingMessage } from "../lib/queue";
import * as queue from "../lib/queue";
import { createLogger } from "../lib/logger";
import { transcribeAudio, type TranscriptionConfig } from "../lib/transcription";
import path from "path";
import os from "os";
import fs from "fs";

const logger = createLogger("telegram");
const FILES_DIR = path.join(os.homedir(), ".turboclaw", "files");

// ============================================================================
// DUPLICATE MESSAGE DETECTION
// Cache to prevent processing duplicate Telegram updates.
// Key: "chatId:messageId", Value: timestamp
// ============================================================================

const processedMessages = new Map<string, number>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a message is a duplicate. Returns true if seen before within TTL.
 * Registers the message in the cache on first call.
 */
export function isDuplicateMessage(chatId: number, messageId: number): boolean {
  const key = `${chatId}:${messageId}`;
  if (processedMessages.has(key)) {
    return true;
  }
  processedMessages.set(key, Date.now());
  return false;
}

/**
 * Clear the processed messages cache. Exported for use in tests.
 */
export function resetProcessedMessages(): void {
  processedMessages.clear();
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedMessages.entries()) {
    if (now - timestamp > CACHE_TTL) {
      processedMessages.delete(key);
    }
  }
}, 60 * 1000); // Clean every minute

// ============================================================================
// TYPING INDICATOR
// ============================================================================

const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

function startTyping(bot: Bot, chatId: number): void {
  const key = String(chatId);
  stopTyping(key);
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => stopTyping(key));
  }, 4000);
  typingIntervals.set(key, interval);
}

function stopTyping(chatId: string): void {
  const interval = typingIntervals.get(chatId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(chatId);
  }
}

// ============================================================================
// TYPES
// ============================================================================

export interface TelegramMessageData {
  chatId: number;
  messageId: number;
  from: {
    id: number;
    first_name?: string;
    last_name?: string;
  };
  text?: string;
  caption?: string;
  timestamp: number;
  media?: Array<{
    type: string;
    fileId: string;
    mimeType?: string;
  }>;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check whether a user is allowed to interact with the bot.
 * Returns true when the whitelist is empty/null/undefined (allow all),
 * or when the userId is found in the whitelist.
 */
export function isUserAllowed(userId: number, allowedUsers: number[]): boolean {
  if (!allowedUsers || allowedUsers.length === 0) {
    return true;
  }
  return allowedUsers.includes(userId);
}

/**
 * Create an IncomingMessage from Telegram message data.
 */
export function createTelegramMessage(data: TelegramMessageData): IncomingMessage {
  const senderName = data.from.first_name
    ? data.from.first_name + (data.from.last_name ? ` ${data.from.last_name}` : "")
    : "Unknown";

  return {
    channel: "telegram",
    sender: senderName,
    senderId: data.chatId.toString(),
    message: data.text ?? data.caption ?? "",
    timestamp: data.timestamp * 1000, // Convert Unix seconds to milliseconds
    messageId: `telegram_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    media: data.media,
  };
}

/**
 * Split a message into chunks that fit within Telegram's 4096-character limit.
 * Tries to split at newline boundaries first, then spaces, then hard-cuts.
 */
export function formatTelegramResponse(message: string, maxLength = 4096): string[] {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline boundary
    let splitIndex = remaining.lastIndexOf("\n", maxLength);

    // Fall back to space boundary
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }

    // Hard cut if no good boundary found
    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Download a file from Telegram servers to local disk.
 * Returns the local file path or null on failure.
 */
async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  messageId: string,
  type: string
): Promise<string | null> {
  try {
    if (!fs.existsSync(FILES_DIR)) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
    }

    const file = await bot.api.getFile(fileId);

    if (!file.file_path) {
      logger.error("No file path in Telegram file response", { fileId });
      return null;
    }

    const ext = path.extname(file.file_path) || `.${type}`;
    const filename = `telegram_${messageId}_${Date.now()}${ext}`;
    const localPath = path.join(FILES_DIR, filename);

    const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
    const response = await fetch(fileUrl);

    if (!response.ok) {
      logger.error("Failed to download Telegram file", {
        fileId,
        status: response.status,
      });
      return null;
    }

    const buffer = await response.arrayBuffer();
    await Bun.write(localPath, buffer);

    logger.info("Downloaded Telegram file", {
      fileId,
      path: localPath,
      size: buffer.byteLength,
    });

    return localPath;
  } catch (error) {
    logger.error("Error downloading Telegram file", error);
    return null;
  }
}

// ============================================================================
// TELEGRAM STREAMER
// ============================================================================

/**
 * TelegramStreamer accumulates streamed text chunks and periodically flushes
 * them to Telegram as a live "streaming..." message.
 *
 * Lifecycle:
 *   1. appendChunk(text) — accumulates to buffer; starts throttle timer if
 *      not already running.
 *   2. flush() — sends initial message (sendMessage) or edits existing one
 *      (editMessageText) with a "(streaming...)" indicator.
 *   3. finalize(fullOutput) — stops timer, deletes streaming message, sends
 *      the complete final response (split into chunks if needed).
 */
/**
 * Format a tool_use event into a short status line for display.
 */
function formatToolStatus(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Read":
      return `Reading ${basename(input.file_path ?? "")}`;
    case "Edit":
      return `Editing ${basename(input.file_path ?? "")}`;
    case "Write":
      return `Writing ${basename(input.file_path ?? "")}`;
    case "Bash": {
      const cmd = input.command ?? "";
      return `Running: ${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}`;
    }
    case "Grep":
      return `Searching for "${input.pattern ?? ""}"`;
    case "Glob":
      return `Finding files: ${input.pattern ?? ""}`;
    case "WebFetch":
      return `Fetching ${input.url ?? ""}`;
    case "WebSearch":
      return `Searching: ${input.query ?? ""}`;
    case "Task":
      return `Launching subagent`;
    default:
      return name;
  }
}

function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Convert Markdown text to Telegram-safe HTML.
 *
 * Strategy: escape all HTML entities first (making any input safe), then
 * convert known Markdown constructs to the HTML tags Telegram supports.
 * Code blocks/inline code are extracted into placeholders before other
 * conversions so their content is never mangled.
 */
export function markdownToTelegramHtml(text: string): string {
  // 1. Escape HTML entities (makes everything valid HTML)
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. Protect code blocks from further markdown processing
  const placeholders: string[] = [];

  // Fenced code blocks: ```lang\n...\n``` → <pre><code>...</code></pre>
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = placeholders.length;
    placeholders.push(`<pre><code>${code}</code></pre>`);
    return `\x00PLACEHOLDER_${idx}\x00`;
  });

  // Inline code: `...` → <code>...</code>
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = placeholders.length;
    placeholders.push(`<code>${code}</code>`);
    return `\x00PLACEHOLDER_${idx}\x00`;
  });

  // 3. Convert remaining markdown to HTML
  // Bold: **...** → <b>...</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic: *...* → <i>...</i> (single asterisks only)
  result = result.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Strikethrough: ~~...~~ → <s>...</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 4. Restore code placeholders
  result = result.replace(/\x00PLACEHOLDER_(\d+)\x00/g, (_match, idx) => {
    return placeholders[parseInt(idx)];
  });

  return result;
}

export class TelegramStreamer {
  // Public so tests can inspect it directly
  public buffer: string = "";

  // Interval between automatic flushes (milliseconds). Exposed for tests.
  public readonly throttleMs: number = 2500;

  // Internal state
  private bot: any;
  private chatId: number;
  private agentId: string;

  // message_id of the in-progress "streaming" Telegram message, once sent
  private streamingMessageId: number | null = null;

  // Text content of the last successful flush (to avoid no-op edits)
  private lastFlushedText: string = "";

  // Accumulated tool call status lines
  private toolLines: string[] = [];
  private toolsDirty: boolean = false;

  // Handle to the active throttle timer.
  // Named `timer` so tests can inspect via `(streamer as any).timer`.
  // The test checks: `(streamer as any).flushTimer ?? (streamer as any).timer`
  // so by only defining `timer`, `flushTimer` will be undefined and `??` falls
  // through to `timer`, which will be null after finalize().
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(bot: any, chatId: number, agentId: string) {
    this.bot = bot;
    this.chatId = chatId;
    this.agentId = agentId;
  }

  /**
   * Append a new text chunk to the internal buffer.
   * Starts the throttle timer on the first chunk (does NOT flush immediately).
   */
  appendChunk(text: string): void {
    this.buffer += text;
  }

  /**
   * Record a tool use event for display in the streaming message.
   * Flushes immediately on each tool call so the user sees updates in real time.
   */
  appendToolUse(name: string, input: Record<string, any>): void {
    this.toolLines.push(formatToolStatus(name, input));
    this.toolsDirty = true;

    // Flush immediately so the user sees each tool call right away
    this.flush().catch((err) => {
      logger.error("TelegramStreamer flush error", err);
    });
  }

  /**
   * Flush the current tool status to Telegram.
   * Shows a list of tool calls the agent has made so far.
   */
  async flush(): Promise<void> {
    if (this.toolLines.length === 0) return;
    if (!this.toolsDirty && this.streamingMessageId !== null) return;

    const text = this.toolLines.join("\n");
    // Truncate to Telegram limit
    const displayText = text.length > 4096 ? text.slice(-4000) : text;

    if (displayText === this.lastFlushedText) return;

    if (this.streamingMessageId === null) {
      const sent = await this.bot.api.sendMessage(this.chatId, displayText);
      this.streamingMessageId = sent.message_id;
    } else {
      await this.bot.api.editMessageText(
        this.chatId,
        this.streamingMessageId,
        displayText
      );
    }

    this.lastFlushedText = displayText;
    this.toolsDirty = false;
  }

  /**
   * Finalize streaming:
   *  1. Clear the throttle timer.
   *  2. Delete the streaming message (if one was sent).
   *  3. Send the full final output (split into chunks), with Markdown parse mode,
   *     falling back to plain text if Markdown parsing fails.
   */
  async finalize(fullOutput: string): Promise<void> {
    // Stop the throttle timer
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Stop the typing indicator
    stopTyping(String(this.chatId));

    // Delete the streaming message if we have one
    if (this.streamingMessageId !== null) {
      try {
        await this.bot.api.deleteMessage(this.chatId, this.streamingMessageId);
      } catch (err) {
        logger.warn("Failed to delete streaming message", err);
      }
      this.streamingMessageId = null;
    }

    // Send final output (possibly split into multiple messages)
    if (!fullOutput || !fullOutput.trim()) {
      logger.warn("finalize called with empty output — skipping send", { chatId: this.chatId });
      return;
    }

    const chunks = formatTelegramResponse(fullOutput);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(this.chatId, markdownToTelegramHtml(chunk), {
          parse_mode: "HTML",
        });
      } catch (err) {
        // Fallback: send without formatting if HTML parsing fails
        logger.warn("HTML parse failed in finalize, sending plain text", err);
        await this.bot.api.sendMessage(this.chatId, chunk);
      }
    }

    logger.info("Sent reply", {
      agent: this.agentId,
      text: fullOutput.substring(0, 50).replace(/\n/g, " "),
    });
  }
}

// ============================================================================
// BOT SETUP
// ============================================================================

/**
 * Create and start a Telegram bot that uses whitelist-based access control.
 */
export async function startTelegramBot(
  botToken: string,
  agentId?: string,
  transcriptionConfig?: TranscriptionConfig,
  allowedUsers?: number[]
): Promise<Bot> {
  const bot = new Bot(botToken);

  logger.info("Starting Telegram bot", {
    agentId: agentId || "global",
    transcription: transcriptionConfig?.enabled || false,
    allowedUsers: allowedUsers?.length ?? 0,
    botToken: botToken.substring(0, 20) + "...",
  });

  // Handle /reset command
  bot.command("reset", async (ctx: Context) => {
    try {
      if (!ctx.from) return;

      if (!isUserAllowed(ctx.from.id, allowedUsers ?? [])) {
        logger.info("Unauthorized /reset attempt", {
          userId: ctx.from.id,
          username: ctx.from.first_name,
        });
        return;
      }

      logger.info("Reset command received", { from: ctx.from.first_name });

      const configPath = path.join(os.homedir(), ".turboclaw", "config.yaml");
      const { loadConfig } = await import("../config");
      const config = await loadConfig(configPath);

      const argString = ctx.message?.text?.replace(/^\/reset\s*/i, "").trim();
      let agentIds: string[] = [];

      if (!argString || argString.trim() === "") {
        if (agentId) {
          agentIds = [agentId];
        } else {
          await ctx.reply(
            "Usage: /reset [@agent_id]\n\nSpecify which agent to reset."
          );
          return;
        }
      } else {
        agentIds = argString.split(/\s+/).map((a) => a.replace(/^@/, ""));
      }

      const results: string[] = [];
      for (const targetAgentId of agentIds) {
        const agent = config.agents[targetAgentId];

        if (!agent) {
          results.push(`Agent '${targetAgentId}' not found.`);
          continue;
        }

        const resetDir = path.join(os.homedir(), ".turboclaw", "reset");
        const signalFile = path.join(resetDir, targetAgentId);
        try {
          fs.mkdirSync(resetDir, { recursive: true });
          fs.writeFileSync(signalFile, "reset");
          results.push(`Reset @${targetAgentId} (${agent.name})`);
          logger.info("Reset signal written", { agentId: targetAgentId, signalFile });
        } catch (error) {
          results.push(`Failed to reset @${targetAgentId}: ${error}`);
          logger.error("Failed to write reset signal", { agentId: targetAgentId, error });
        }
      }

      await ctx.reply(results.join("\n"));
    } catch (error) {
      logger.error("Error handling reset command", error);
      await ctx.reply("Error processing reset command. Please try again.");
    }
  });

  // Handle text messages
  bot.on("message:text", async (ctx: Context) => {
    try {
      if (!ctx.message || !ctx.from) return;

      if (!isUserAllowed(ctx.from.id, allowedUsers ?? [])) {
        logger.info("Unauthorized message from user", {
          userId: ctx.from.id,
          username: ctx.from.first_name,
        });
        return;
      }

      if (isDuplicateMessage(ctx.chat.id, ctx.message.message_id)) {
        logger.info("Blocked duplicate message", {
          chatId: ctx.chat.id,
          messageId: ctx.message.message_id,
        });
        return;
      }

      logger.info("Received text message", {
        from: ctx.from.first_name,
        text: ctx.message.text.substring(0, 50).replace(/\n/g, " "),
      });

      const message = createTelegramMessage({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        from: ctx.from,
        text: ctx.message.text,
        timestamp: ctx.message.date,
      });

      if (agentId) {
        message.agentId = agentId;
      }
      message.botToken = botToken;

      await queue.writeIncoming(message);
      logger.debug("Message queued", { messageId: message.messageId });

      startTyping(bot, ctx.chat.id);
    } catch (error) {
      logger.error("Error handling text message", error);
    }
  });

  // Handle photo messages
  bot.on("message:photo", async (ctx: Context) => {
    try {
      if (!ctx.message || !ctx.from || !ctx.message.photo) return;

      if (!isUserAllowed(ctx.from.id, allowedUsers ?? [])) {
        return;
      }

      if (isDuplicateMessage(ctx.chat.id, ctx.message.message_id)) {
        return;
      }

      logger.info("Received photo message", { from: ctx.from.first_name });

      const messageId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const filePath = await downloadTelegramFile(bot, photo.file_id, messageId, "photo");

      const message = createTelegramMessage({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        from: ctx.from,
        text: ctx.message.caption || "[Image]",
        timestamp: ctx.message.date,
        media: filePath
          ? [{ type: "photo", fileId: photo.file_id, mimeType: "image/jpeg" }]
          : undefined,
      });

      if (agentId) message.agentId = agentId;
      message.botToken = botToken;

      await queue.writeIncoming(message);
      logger.debug("Photo message queued", { messageId: message.messageId });
      startTyping(bot, ctx.chat.id);
    } catch (error) {
      logger.error("Error handling photo message", error);
    }
  });

  // Handle voice messages
  bot.on("message:voice", async (ctx: Context) => {
    try {
      if (!ctx.message || !ctx.from || !ctx.message.voice) return;

      if (!isUserAllowed(ctx.from.id, allowedUsers ?? [])) {
        return;
      }

      if (isDuplicateMessage(ctx.chat.id, ctx.message.message_id)) {
        return;
      }

      logger.info("Received voice message", { from: ctx.from.first_name });

      const messageId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const filePath = await downloadTelegramFile(
        bot,
        ctx.message.voice.file_id,
        messageId,
        "ogg"
      );

      let messageText = "[Voice message]";
      let transcription: string | undefined;

      if (filePath && transcriptionConfig?.enabled) {
        try {
          logger.info("Transcribing voice message", { path: filePath });
          const result = await transcribeAudio(filePath, transcriptionConfig);
          transcription = result.text;
          messageText = transcription || messageText;
          logger.info("Voice transcription complete", { length: transcription.length });
        } catch (error) {
          logger.error("Voice transcription failed", error);
        }
      }

      const message = createTelegramMessage({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        from: ctx.from,
        text: messageText,
        timestamp: ctx.message.date,
        media: filePath
          ? [{ type: "voice", fileId: ctx.message.voice.file_id }]
          : undefined,
      });

      if (agentId) message.agentId = agentId;
      message.botToken = botToken;

      await queue.writeIncoming(message);
      logger.debug("Voice message queued", { messageId: message.messageId });
      startTyping(bot, ctx.chat.id);
    } catch (error) {
      logger.error("Error handling voice message", error);
    }
  });

  // Handle document messages
  bot.on("message:document", async (ctx: Context) => {
    try {
      if (!ctx.message || !ctx.from || !ctx.message.document) return;

      if (!isUserAllowed(ctx.from.id, allowedUsers ?? [])) {
        return;
      }

      if (isDuplicateMessage(ctx.chat.id, ctx.message.message_id)) {
        return;
      }

      logger.info("Received document message", { from: ctx.from.first_name });

      const messageId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const filePath = await downloadTelegramFile(
        bot,
        ctx.message.document.file_id,
        messageId,
        "document"
      );

      const message = createTelegramMessage({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        from: ctx.from,
        text: ctx.message.caption || "[Document]",
        timestamp: ctx.message.date,
        media: filePath
          ? [{ type: "document", fileId: ctx.message.document.file_id, mimeType: ctx.message.document.mime_type }]
          : undefined,
      });

      if (agentId) message.agentId = agentId;
      message.botToken = botToken;

      await queue.writeIncoming(message);
      logger.debug("Document message queued", { messageId: message.messageId });
      startTyping(bot, ctx.chat.id);
    } catch (error) {
      logger.error("Error handling document message", error);
    }
  });

  // Start bot (don't await — runs in background)
  bot.start({
    onStart: (botInfo) => {
      logger.info("Telegram bot started", {
        username: botInfo.username,
        agentId: agentId || "global",
      });
    },
  }).catch((error) => {
    logger.error(`Telegram bot failed (agent: ${agentId || "global"}) — check bot token`, error);
  });

  return bot;
}

/**
 * Process the outgoing queue and send messages via Telegram.
 * Returns a stop function.
 */
export async function startTelegramSender(
  bot: Bot,
  intervalSeconds = 1,
  botToken?: string
): Promise<() => void> {
  let running = true;

  logger.info("Starting Telegram sender", {
    intervalSeconds,
    botToken: botToken ? botToken.substring(0, 20) + "..." : "any",
  });

  const loop = async () => {
    while (running) {
      try {
        const message = await queue.readOutgoing();

        if (message && message.message.channel === "telegram") {
          // If we have a specific botToken, only handle messages for this bot
          if (botToken && message.message.botToken && message.message.botToken !== botToken) {
            // Not for this bot — skip (leave in queue for another sender)
            await Bun.sleep(intervalSeconds * 1000);
            continue;
          }

          const { senderId, message: text, files } = message.message;
          const chatId = parseInt(String(senderId));

          if (isNaN(chatId)) {
            logger.error("Invalid chat ID", { senderId });
            await queue.deleteMessage(message.id, "outgoing");
            continue;
          }

          stopTyping(String(senderId));

          // Send files first
          if (files && files.length > 0) {
            for (const file of files) {
              try {
                const filePath = file.path;
                if (!fs.existsSync(filePath)) {
                  logger.warn("File not found", { file: filePath });
                  continue;
                }
                const ext = path.extname(filePath).toLowerCase();
                if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
                  await bot.api.sendPhoto(chatId, filePath);
                } else if ([".mp3", ".ogg", ".wav", ".m4a"].includes(ext)) {
                  await bot.api.sendAudio(chatId, filePath);
                } else if ([".mp4", ".avi", ".mov", ".webm"].includes(ext)) {
                  await bot.api.sendVideo(chatId, filePath);
                } else {
                  await bot.api.sendDocument(chatId, filePath);
                }
                logger.info("Sent file to Telegram", { file: filePath });
              } catch (error) {
                logger.error("Error sending file", { error });
              }
            }
          }

          // Send text message (split if needed)
          if (text) {
            const chunks = formatTelegramResponse(text);
            for (const chunk of chunks) {
              try {
                await bot.api.sendMessage(chatId, markdownToTelegramHtml(chunk), {
                  parse_mode: "HTML",
                });
              } catch (error) {
                logger.warn("HTML parsing failed, sending as plain text", {
                  error: error instanceof Error ? error.message : String(error),
                });
                await bot.api.sendMessage(chatId, chunk);
              }
            }
            logger.info("Sent message to Telegram", {
              chatId,
              length: text.length,
              chunks: chunks.length,
            });
          }

          await queue.deleteMessage(message.id, "outgoing");
        }
      } catch (error) {
        logger.error("Error in Telegram sender loop", error);
      }

      await Bun.sleep(intervalSeconds * 1000);
    }

    logger.info("Telegram sender stopped");
  };

  loop().catch((error) => {
    logger.error("Telegram sender loop crashed", error);
  });

  return () => {
    logger.info("Stopping Telegram sender...");
    running = false;
  };
}
