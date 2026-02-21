#!/usr/bin/env bun

export type CLICommand =
  | "start"
  | "stop"
  | "status"
  | "agents"
  | "schedule"
  | "send"
  | "reset-context"
  | "reset-crashes"
  | "setup"
  | "help"
  | "version"
  | "menu"
  | "unknown";

export interface ParsedArgs {
  command: CLICommand;
  args: string[];
}

/**
 * Parse command line arguments
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // Handle empty args - show menu
  if (argv.length === 0) {
    return { command: "menu", args: [] };
  }

  const firstArg = argv[0];

  // Handle flags
  if (firstArg === "--help" || firstArg === "-h") {
    return { command: "help", args: [] };
  }

  if (firstArg === "--version" || firstArg === "-v") {
    return { command: "version", args: [] };
  }

  // Handle commands
  const validCommands: CLICommand[] = ["start", "stop", "status", "agents", "schedule", "send", "reset-context", "reset-crashes", "setup"];

  if (validCommands.includes(firstArg as CLICommand)) {
    return {
      command: firstArg as CLICommand,
      args: argv.slice(1),
    };
  }

  // Unknown command
  return {
    command: "unknown",
    args: argv,
  };
}

/**
 * Display help text
 */
function showHelp(): void {
  console.log(`
TurboClaw - AI Agent Management System

Usage:
  turboclaw [command] [options]

Commands:
  setup              Interactive setup wizard (create or update config)
  start              Start the daemon
  stop               Stop the daemon
  status             Show system status
  agents [cmd]       Manage agents (list, add, show, remove)
  schedule [cmd]     Manage scheduled tasks (list, add, remove, enable, disable)
  send               Send a message to a user
  reset-context <id> Reset context for an agent
  reset-crashes      Clear crash history (for manual recovery)

Options:
  -h, --help         Show this help message
  -v, --version      Show version

Examples:
  turboclaw start              # Start daemon
  turboclaw status             # Check status
  turboclaw agents list        # List agents
  turboclaw schedule list      # List schedules
`);
}

/**
 * Display version
 */
function showVersion(): void {
  try {
    const packageJson = require("../../package.json");
    console.log(`TurboClaw v${packageJson.version || "0.0.1"}`);
  } catch {
    console.log("TurboClaw v0.0.1");
  }
}

/**
 * Execute a single command
 */
async function executeCommand(parsed: ParsedArgs) {
  switch (parsed.command) {
    case "help":
      showHelp();
      break;

    case "version":
      showVersion();
      break;

    case "start": {
      const { startCommand } = await import("./commands/start");
      await startCommand();
      break;
    }

    case "stop": {
      const { stopCommand } = await import("./commands/stop");
      await stopCommand();
      break;
    }

    case "status": {
      const { statusCommand } = await import("./commands/status");
      await statusCommand();
      break;
    }

    case "agents": {
      const { agentsCommand } = await import("./commands/agents");
      const { loadConfig } = await import("../config/index");
      const path = await import("path");
      const os = await import("os");

      const configPath = path.join(os.homedir(), ".turboclaw", "config.yaml");
      const config = await loadConfig(configPath);
      await agentsCommand(parsed.args, config, configPath);
      break;
    }

    case "schedule": {
      const path = await import("path");
      const os = await import("os");
      const tasksDir = path.join(os.homedir(), ".turboclaw", "tasks");

      const subcommand = parsed.args[0];
      const subArgs = parsed.args.slice(1);

      if (!subcommand || subcommand === "list") {
        const { listSchedules } = await import("./commands/schedule");
        await listSchedules(tasksDir);
      } else if (subcommand === "add") {
        const { addSchedule } = await import("./commands/schedule");
        const { loadConfig } = await import("../config/index");
        const configPath = path.join(os.homedir(), ".turboclaw", "config.yaml");
        let config;
        try { config = await loadConfig(configPath); } catch { config = undefined; }
        await addSchedule(tasksDir, subArgs, config);
      } else if (subcommand === "remove") {
        const taskName = parsed.args[1];
        if (!taskName) {
          console.error("Error: Task name required");
          console.error("Usage: turboclaw schedule remove <task-name>");
          process.exit(1);
        }
        const { removeSchedule } = await import("./commands/schedule");
        await removeSchedule(taskName, tasksDir);
      } else if (subcommand === "enable") {
        const taskName = parsed.args[1];
        if (!taskName) {
          console.error("Error: Task name required");
          console.error("Usage: turboclaw schedule enable <task-name>");
          process.exit(1);
        }
        const { toggleSchedule } = await import("./commands/schedule");
        await toggleSchedule(taskName, true, tasksDir);
      } else if (subcommand === "disable") {
        const taskName = parsed.args[1];
        if (!taskName) {
          console.error("Error: Task name required");
          console.error("Usage: turboclaw schedule disable <task-name>");
          process.exit(1);
        }
        const { toggleSchedule } = await import("./commands/schedule");
        await toggleSchedule(taskName, false, tasksDir);
      } else {
        console.error(`Unknown schedule command: ${subcommand}`);
        console.error("Valid commands: list, add, remove, enable, disable");
        process.exit(1);
      }
      break;
    }

    case "send": {
      const { sendCommand } = await import("./commands/send");
      const { loadConfig } = await import("../config/index");
      const path = await import("path");
      const os = await import("os");

      const configPath = path.join(os.homedir(), ".turboclaw", "config.yaml");
      let config;
      try {
        config = await loadConfig(configPath);
      } catch {
        config = undefined;
      }
      await sendCommand(parsed.args, config);
      break;
    }

    case "reset-context": {
      const { resetContextCommand } = await import("./commands/reset-context");
      await resetContextCommand(parsed.args);
      break;
    }

    case "reset-crashes": {
      const path = await import("path");
      const os = await import("os");
      const { createDaemonCrashGuard } = await import("../lib/crash-guard");

      const baseDir = path.join(os.homedir(), ".turboclaw");
      const guard = createDaemonCrashGuard(baseDir);

      const stats = guard.getStats();
      console.log(`Current crash history: ${stats.recent} recent, ${stats.total} total`);

      await guard.clearCrashes();
      console.log("Crash history cleared");
      console.log("You can now restart the daemon: turboclaw start");
      break;
    }

    case "setup": {
      const { setupCommand } = await import("./commands/setup");
      await setupCommand({});
      break;
    }

    case "menu":
      showHelp();
      break;

    case "unknown":
      console.error(`Unknown command: ${parsed.args[0]}`);
      console.error("Run 'turboclaw --help' for usage information");
      process.exit(1);

    default:
      console.error("Invalid command");
      process.exit(1);
  }
}

/**
 * Main CLI entry point
 */
export async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  await executeCommand(parsed);
}

// Run CLI if this is the main module
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
