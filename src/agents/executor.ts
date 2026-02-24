import { spawn } from "child_process";
import { createLogger } from "../lib/logger";
import { join } from "path";
import os from "os";
import { format } from "date-fns";
import type { Config } from "../config";

const logger = createLogger("executor");

export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}

/**
 * Model name mapping from shorthand to full model ID
 */
const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

/**
 * Find the claude executable path
 * Checks `which claude` first, then common locations
 */
export function findClaudePath(): string {
  const possiblePaths = [
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    join(os.homedir(), ".bun/bin/claude"),
    join(os.homedir(), ".local/bin/claude"),
  ];

  const { execSync } = require("child_process");

  // Try 'which claude' first
  try {
    const whichResult = execSync("which claude", { encoding: "utf-8" }).trim();
    if (whichResult) {
      return whichResult;
    }
  } catch {
    // Fall through to check common paths
  }

  // Check common paths
  const { existsSync } = require("fs");
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Default to just 'claude' and let shell resolve it
  return "claude";
}

/**
 * Build a system context string with date, timezone, and OS info
 */
function buildSystemContext(agentId?: string): string {
  // "Wednesday 18th February 2026"
  const dateStr = format(new Date(), "EEEE do MMMM yyyy");

  // Timezone from system locale
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // System info
  const platform = os.type();
  const platformName =
    platform === "Darwin" ? "macOS"
    : platform === "Windows_NT" ? "Windows"
    : platform;
  const release = os.release();
  const arch = os.arch();

  let context = `Today's date is ${dateStr}. Timezone: ${timezone}. System: ${platformName} ${release} (${arch}).`;
  if (agentId) {
    context += ` Your agent ID is: ${agentId}`;
  }
  return context;
}

/**
 * Options shared between executePrompt and executePromptStreaming
 */
export interface ExecuteOptions {
  continue?: boolean;
  reset?: boolean;
  config?: Config;
  agentId?: string;
  /** Claude session UUID. When provided, --session-id or --resume is passed. */
  sessionId?: string;
  /** When true, use --session-id (new session). When false, use --resume (continue). */
  isNewSession?: boolean;
}

/**
 * Build the args and env for spawning claude
 */
function buildSpawnParams(
  workingDirectory: string,
  message: string,
  options: ExecuteOptions
): { claudePath: string; args: string[]; env: NodeJS.ProcessEnv } {
  const claudePath = findClaudePath();

  // Prepare environment (delete CLAUDECODE to prevent nested session errors)
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;

  // Apply top-level env vars from config
  if (options.config?.env) {
    Object.assign(env, options.config.env);
  }

  // Inject agent ID
  if (options.agentId) {
    env.TURBOCLAW_AGENT_ID = options.agentId;
  }

  // Apply provider configuration
  if (options.config && options.agentId) {
    const agent = options.config.agents?.[options.agentId];
    if (agent) {
      const provider = options.config.providers[agent.provider];

      if (provider) {
        if (provider.api_key) {
          env.ANTHROPIC_API_KEY = provider.api_key;
        }
        if (provider.base_url) {
          env.ANTHROPIC_BASE_URL = provider.base_url;
        }
      }

      // Map model shorthand to full model ID
      const modelName = MODEL_MAP[agent.model.toLowerCase()] ?? agent.model;
      env.ANTHROPIC_MODEL = modelName;
    }
  }

  // Prepare arguments
  const args: string[] = [
    "--dangerously-skip-permissions",
  ];

  // --session-id creates a new session with that UUID; --resume continues an existing one
  if (options.sessionId) {
    if (options.isNewSession) {
      args.push("--session-id", options.sessionId);
    } else {
      args.push("--resume", options.sessionId);
    }
  }

  args.push("--append-system-prompt", buildSystemContext(options.agentId));
  args.push("-p", message);

  return { claudePath, args, env };
}

/**
 * Execute a Claude prompt (non-streaming).
 * Returns a Promise<ExecutionResult>.
 */
export async function executePrompt(
  workingDirectory: string,
  message: string,
  options: ExecuteOptions = {}
): Promise<ExecutionResult> {
  const { claudePath, args, env } = buildSpawnParams(workingDirectory, message, options);

  logger.info("Executing Claude", {
    workingDir: workingDirectory,
    messageLength: message.length,
    continue: options.continue ?? true,
    reset: options.reset ?? false,
    agentId: options.agentId,
  });

  return new Promise<ExecutionResult>((resolve) => {
    let output = "";
    let errorOutput = "";

    const childProcess = spawn(claudePath, args, {
      cwd: workingDirectory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    childProcess.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      errorOutput += data.toString();
    });

    childProcess.on("error", (error: Error) => {
      logger.error("Failed to execute Claude", error);
      resolve({
        success: false,
        error: `Failed to spawn Claude: ${error.message}`,
        exitCode: -1,
      });
    });

    childProcess.on("close", (exitCode: number | null) => {
      const code = exitCode ?? 0;
      if (code === 0) {
        logger.info("Claude execution completed", {
          exitCode: code,
          outputLength: output.length,
        });
        resolve({
          success: true,
          output: output.trim(),
          exitCode: code,
        });
      } else {
        logger.error("Claude execution failed", {
          exitCode: code,
          error: errorOutput,
        });
        resolve({
          success: false,
          error: errorOutput || "Claude execution failed",
          output: output.trim(),
          exitCode: code,
        });
      }
    });
  });
}

/**
 * Streaming callbacks
 */
export interface ToolUseEvent {
  name: string;
  input: Record<string, any>;
}

export interface StreamingCallbacks {
  onChunk: (chunk: string) => void;
  onToolUse?: (tool: ToolUseEvent) => void;
  onComplete: (result: ExecutionResult) => void;
  onError: (error: Error) => void;
}

/**
 * Streaming handle returned by executePromptStreaming
 */
export interface StreamingHandle {
  cancel: () => void;
}

/**
 * Parse a stream-json line and extract text content if present.
 * Returns the text delta string, or null if this event has no text.
 */
function extractStreamText(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);

    // Token-level streaming via --include-partial-messages
    if (
      event.type === "stream_event" &&
      event.event?.type === "content_block_delta" &&
      event.event?.delta?.type === "text_delta" &&
      event.event.delta.text
    ) {
      return event.event.delta.text;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a stream-json line and extract a tool_use event if present.
 */
function extractToolUse(line: string): ToolUseEvent | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name) {
          return { name: block.name, input: block.input ?? {} };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the final result text from a stream-json result event.
 */
function extractResultText(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    if (event.type === "result" && typeof event.result === "string") {
      return event.result;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Execute a Claude prompt with streaming output.
 * Uses --output-format=stream-json for real-time token streaming.
 * Returns a handle with cancel() immediately (synchronous).
 */
export function executePromptStreaming(
  workingDirectory: string,
  message: string,
  callbacks: StreamingCallbacks,
  options: ExecuteOptions = {}
): StreamingHandle {
  const { claudePath, args, env } = buildSpawnParams(workingDirectory, message, options);

  // Enable stream-json output for real-time token streaming
  args.push("--output-format=stream-json", "--verbose", "--include-partial-messages");

  logger.info("Executing Claude (streaming)", {
    workingDir: workingDirectory,
    messageLength: message.length,
    agentId: options.agentId,
  });

  let resultText = "";
  let textFromChunks = "";
  let errorOutput = "";
  let lineBuffer = "";

  const childProcess = spawn(claudePath, args, {
    cwd: workingDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  childProcess.stdout?.on("data", (data: Buffer) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? ""; // Keep incomplete last line in buffer

    for (const line of lines) {
      // Check for text deltas (token streaming)
      const text = extractStreamText(line);
      if (text) {
        textFromChunks += text;
        callbacks.onChunk(text);
        continue;
      }

      // Check for tool use events
      if (callbacks.onToolUse) {
        const tool = extractToolUse(line);
        if (tool) {
          callbacks.onToolUse(tool);
          continue;
        }
      }

      // Check for final result
      const result = extractResultText(line);
      if (result !== null) {
        resultText = result;
      }
    }
  });

  childProcess.stderr?.on("data", (data: Buffer) => {
    errorOutput += data.toString();
  });

  childProcess.on("error", (error: Error) => {
    logger.error("Failed to execute Claude (streaming)", error);
    callbacks.onError(error);
  });

  childProcess.on("close", (exitCode: number | null) => {
    // Process any remaining data in the line buffer
    if (lineBuffer.trim()) {
      const result = extractResultText(lineBuffer);
      if (result !== null) {
        resultText = result;
      }
      const text = extractStreamText(lineBuffer);
      if (text) {
        textFromChunks += text;
        callbacks.onChunk(text);
      }
    }

    const code = exitCode ?? 0;
    // Prefer the result event text, fall back to accumulated chunks
    const output = resultText || textFromChunks;

    if (code === 0) {
      callbacks.onComplete({
        success: true,
        output: output.trim(),
        exitCode: code,
      });
    } else {
      callbacks.onComplete({
        success: false,
        error: errorOutput || "Claude execution failed",
        output: output.trim(),
        exitCode: code,
      });
    }
  });

  return {
    cancel: () => {
      childProcess.kill();
    },
  };
}
