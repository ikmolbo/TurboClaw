import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Config } from "../../config/index";
import { expandPath } from "../../config/index";

/**
 * Resolve the memory root directory for an agent.
 * Always <working_directory>/memory/ — shared mode uses a symlink.
 */
function resolveMemoryRoot(agentId: string, config: Config): string {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Agent '${agentId}' not found in config`);
  }
  return join(expandPath(agentConfig.working_directory), "memory");
}

/**
 * Format the current time as HH:MM.
 */
function timeStamp(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * Format today's date as YYYY-MM-DD.
 */
function dateStamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── Log subcommand ──────────────────────────────────────────────────────────

/**
 * Append a tagged entry to today's daily log.
 *
 * Usage: turboclaw memory log <agent-id> [tag] <message>
 */
function logEntry(agentId: string, tag: string, message: string, config: Config): void {
  const memRoot = resolveMemoryRoot(agentId, config);

  if (!existsSync(memRoot)) {
    mkdirSync(memRoot, { recursive: true });
  }

  const dailyFile = join(memRoot, `${dateStamp()}.md`);
  const line = `## ${timeStamp()} @${agentId} - [${tag}] ${message}\n`;
  appendFileSync(dailyFile, line, "utf-8");

  console.log(`Logged to ${dailyFile}`);
}

// ── Search subcommand ───────────────────────────────────────────────────────

/**
 * Search across MEMORY.md, daily logs, and archives.
 *
 * Usage: turboclaw memory search <agent-id> <query> [--tag <tag>]
 */
function searchMemory(
  agentId: string,
  query: string,
  config: Config,
  options: { tag?: string } = {}
): void {
  const memRoot = resolveMemoryRoot(agentId, config);

  if (!existsSync(memRoot)) {
    console.log("No memory directory found.");
    return;
  }

  const files: Array<{ path: string; label: string }> = [];

  // MEMORY.md first
  const memoryFile = join(memRoot, "MEMORY.md");
  if (existsSync(memoryFile)) {
    files.push({ path: memoryFile, label: "MEMORY.md" });
  }

  // Daily logs
  try {
    for (const f of readdirSync(memRoot).sort()) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) {
        files.push({ path: join(memRoot, f), label: f });
      }
    }
  } catch { /* ignore */ }


  const queryLower = query.toLowerCase();
  const tagFilter = options.tag ? `[${options.tag}]` : null;
  let matchCount = 0;

  for (const { path: filePath, label } of files) {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (tagFilter && !line.includes(tagFilter)) continue;
      if (!line.toLowerCase().includes(queryLower)) continue;

      if (matchCount === 0) {
        // Print header on first match
      }
      console.log(`[${label}] ${line}`);
      matchCount++;
    }
  }

  if (matchCount === 0) {
    console.log(`No matches for "${query}"${tagFilter ? ` with tag ${tagFilter}` : ""}`);
  } else {
    console.log(`\n${matchCount} match${matchCount === 1 ? "" : "es"} found.`);
  }
}

// ── CLI entry point ─────────────────────────────────────────────────────────

export async function memoryCommand(args: string[], config: Config): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "log": {
      // turboclaw memory log <agent-id> [tag] <message...>
      const agentId = args[1];
      if (!agentId) {
        console.error("Usage: turboclaw memory log <agent-id> [tag] <message>");
        console.error("  tag defaults to 'note' if omitted");
        console.error("  Example: turboclaw memory log coder decision Switched to Redis for caching");
        process.exit(1);
      }

      let tag: string;
      let message: string;

      // Check if args[2] looks like a tag (single word, no spaces, common tags)
      const validTags = ["decision", "preference", "task", "context", "bug", "note"];
      if (args[2] && validTags.includes(args[2])) {
        tag = args[2];
        message = args.slice(3).join(" ");
      } else {
        tag = "note";
        message = args.slice(2).join(" ");
      }

      if (!message) {
        console.error("Error: message is required");
        process.exit(1);
      }

      logEntry(agentId, tag, message, config);
      break;
    }

    case "search": {
      // turboclaw memory search <agent-id> <query> [--tag <tag>]
      const agentId = args[1];
      if (!agentId) {
        console.error("Usage: turboclaw memory search <agent-id> <query> [--tag <tag>]");
        console.error("  Example: turboclaw memory search support gmail");
        console.error("  Example: turboclaw memory search coder --tag decision API");
        process.exit(1);
      }

      // Parse --tag flag
      let tag: string | undefined;
      const remaining: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--tag" && args[i + 1]) {
          tag = args[++i];
        } else {
          remaining.push(args[i]);
        }
      }

      const query = remaining.join(" ");
      if (!query) {
        console.error("Error: search query is required");
        process.exit(1);
      }

      searchMemory(agentId, query, config, { tag });
      break;
    }

    default: {
      console.error(`Unknown memory command: ${subcommand ?? "(none)"}`);
      console.log("\nUsage: turboclaw memory <command> <agent-id> [options]");
      console.log("\nCommands:");
      console.log("  log <agent-id> [tag] <message>          Log an entry to today's daily log");
      console.log("  search <agent-id> <query> [--tag <tag>]  Search across all memory files");
      console.log("\nTags: decision, preference, task, context, bug, note (default: note)");
      process.exit(1);
    }
  }
}
