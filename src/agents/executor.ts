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
function buildSystemContext(): string {
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

  return `Today's date is ${dateStr}. Timezone: ${timezone}. System: ${platformName} ${release} (${arch}).`;
}

/**
 * Options shared between executePrompt and executePromptStreaming
 */
export interface ExecuteOptions {
  continue?: boolean;
  reset?: boolean;
  config?: Config;
  agentId?: string;
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

  // Only pass -c flag if NOT resetting and continue is not explicitly false
  if (options.reset !== true && options.continue !== false) {
    args.push("-c");
  }

  args.push("--append-system-prompt", buildSystemContext());
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
export interface StreamingCallbacks {
  onChunk: (chunk: string) => void;
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
 * Execute a Claude prompt with streaming output.
 * Returns a handle with cancel() immediately (synchronous).
 */
export function executePromptStreaming(
  workingDirectory: string,
  message: string,
  callbacks: StreamingCallbacks,
  options: ExecuteOptions = {}
): StreamingHandle {
  const { claudePath, args, env } = buildSpawnParams(workingDirectory, message, options);

  logger.info("Executing Claude (streaming)", {
    workingDir: workingDirectory,
    messageLength: message.length,
    agentId: options.agentId,
  });

  let output = "";
  let errorOutput = "";

  const childProcess = spawn(claudePath, args, {
    cwd: workingDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  childProcess.stdout?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    output += chunk;
    callbacks.onChunk(chunk);
  });

  childProcess.stderr?.on("data", (data: Buffer) => {
    errorOutput += data.toString();
  });

  childProcess.on("error", (error: Error) => {
    logger.error("Failed to execute Claude (streaming)", error);
    callbacks.onError(error);
  });

  childProcess.on("close", (exitCode: number | null) => {
    const code = exitCode ?? 0;
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
