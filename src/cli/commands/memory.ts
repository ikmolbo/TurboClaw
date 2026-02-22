import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
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

const VALID_TAGS = ["decision", "preference", "task", "context", "bug", "note"];

// ── Read subcommand ──────────────────────────────────────────────────────────

/**
 * Read memory contents and print to stdout.
 *
 * Default: reads all daily logs (memory/daily/*.md).
 * With --consolidated: reads long-term memory (memory/MEMORY.md).
 */
function readMemory(agentId: string, config: Config, consolidated: boolean): void {
  const memRoot = resolveMemoryRoot(agentId, config);

  if (consolidated) {
    const memoryFile = join(memRoot, "MEMORY.md");
    if (!existsSync(memoryFile)) {
      console.log("No consolidated memory found.");
      return;
    }
    process.stdout.write(readFileSync(memoryFile, "utf-8"));
  } else {
    const dailyDir = join(memRoot, "daily");
    if (!existsSync(dailyDir)) {
      console.log("No daily logs found.");
      return;
    }

    const files = readdirSync(dailyDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();

    if (files.length === 0) {
      console.log("No daily logs found.");
      return;
    }

    for (const f of files) {
      process.stdout.write(readFileSync(join(dailyDir, f), "utf-8"));
    }
  }
}

// ── Write subcommand ─────────────────────────────────────────────────────────

/**
 * Append an entry to memory.
 *
 * Default: appends to today's daily log (memory/daily/YYYY-MM-DD.md).
 *   Format: ## HH:MM @agent-id - [tag] message
 *
 * With --consolidated: appends a raw line to long-term memory (memory/MEMORY.md).
 *   The caller is responsible for formatting (typically ## YYYY-MM-DD [tag] text).
 */
function writeMemory(
  agentId: string,
  tag: string,
  message: string,
  config: Config,
  consolidated: boolean
): void {
  const memRoot = resolveMemoryRoot(agentId, config);

  if (consolidated) {
    if (!existsSync(memRoot)) {
      mkdirSync(memRoot, { recursive: true });
    }
    const memoryFile = join(memRoot, "MEMORY.md");
    appendFileSync(memoryFile, `${message}\n`, "utf-8");
    console.log(`Appended to MEMORY.md`);
  } else {
    const dailyDir = join(memRoot, "daily");
    if (!existsSync(dailyDir)) {
      mkdirSync(dailyDir, { recursive: true });
    }
    const dailyFile = join(dailyDir, `${dateStamp()}.md`);
    const line = `## ${timeStamp()} @${agentId} - [${tag}] ${message}\n`;
    appendFileSync(dailyFile, line, "utf-8");
    console.log(`Logged to daily/${dateStamp()}.md`);
  }
}

// ── Search subcommand ────────────────────────────────────────────────────────

/**
 * Search across MEMORY.md and daily logs.
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
  const dailyDir = join(memRoot, "daily");
  try {
    for (const f of readdirSync(dailyDir).sort()) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) {
        files.push({ path: join(dailyDir, f), label: `daily/${f}` });
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
    case "read": {
      // turboclaw memory read <agent-id> [--consolidated]
      const agentId = args[1];
      if (!agentId) {
        console.error("Usage: turboclaw memory read <agent-id> [--consolidated]");
        console.error("  Default: reads all daily logs");
        console.error("  --consolidated: reads long-term memory (MEMORY.md)");
        process.exit(1);
      }
      const consolidated = args.includes("--consolidated");
      readMemory(agentId, config, consolidated);
      break;
    }

    case "write":
    case "log": {
      // turboclaw memory write <agent-id> [tag] <message...>
      // turboclaw memory write <agent-id> --consolidated <message...>
      const agentId = args[1];
      if (!agentId) {
        console.error("Usage: turboclaw memory write <agent-id> [tag] <message>");
        console.error("       turboclaw memory write <agent-id> --consolidated <message>");
        console.error(`  Tags: ${VALID_TAGS.join(", ")} (default: note)`);
        process.exit(1);
      }

      const consolidated = args.includes("--consolidated");
      const rest = args.slice(2).filter((a) => a !== "--consolidated");

      let tag: string;
      let message: string;

      if (consolidated) {
        // For consolidated writes, there's no tag — the message is the raw line
        tag = "";
        message = rest.join(" ");
      } else {
        // Check if first arg after agent-id looks like a tag
        if (rest[0] && VALID_TAGS.includes(rest[0])) {
          tag = rest[0];
          message = rest.slice(1).join(" ");
        } else {
          tag = "note";
          message = rest.join(" ");
        }
      }

      if (!message) {
        console.error("Error: message is required");
        process.exit(1);
      }

      writeMemory(agentId, tag, message, config, consolidated);
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
      console.log("  read <agent-id> [--consolidated]         Read daily logs or long-term memory");
      console.log("  write <agent-id> [tag] <message>         Write to today's daily log");
      console.log("  write <agent-id> --consolidated <msg>    Append to long-term memory");
      console.log("  search <agent-id> <query> [--tag <tag>]  Search across all memory files");
      console.log(`\nTags: ${VALID_TAGS.join(", ")} (default: note)`);
      process.exit(1);
    }
  }
}
