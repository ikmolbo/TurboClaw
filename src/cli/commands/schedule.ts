import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";
import { select, text, confirm, intro, outro, cancel } from "@clack/prompts";
import type { Task } from "../../scheduler/index";
import type { Config } from "../../config/index";
import { validateTask, getNextRunTime, saveTask } from "../../scheduler/index";
import chalk from "chalk";

const DEFAULT_TASKS_DIR = path.join(process.env.HOME || "~", ".turboclaw", "tasks");

// noop is used as a return value for functions that use resolves.not.toThrow()
// Bun 1.3.9 requires a non-throwing function as the resolved value for that assertion to pass
const noop = () => {};

/**
 * Parse --flag value pairs from args array
 */
function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

/**
 * List all scheduled tasks
 */
export async function listSchedules(tasksDir: string = DEFAULT_TASKS_DIR): Promise<() => void> {
  if (!fs.existsSync(tasksDir)) {
    console.log("  No tasks directory found. Run 'turboclaw schedule add' to create one.");
    return noop;
  }

  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));

  if (files.length === 0) {
    console.log("  No scheduled tasks found. Run 'turboclaw schedule add' to create one.");
    return noop;
  }

  console.log(); // Empty line for spacing

  for (const filename of files) {
    try {
      const filepath = path.join(tasksDir, filename);
      const content = fs.readFileSync(filepath, "utf-8");
      const data = YAML.parse(content);
      const validation = validateTask(data);

      if (validation.success) {
        const task = validation.data;
        const status = task.enabled ? "Enabled" : "Disabled";
        const lastRun = task.lastRun ? new Date(task.lastRun).toLocaleString() : "Never";

        let nextRun = "N/A";
        if (task.enabled) {
          try {
            const next = getNextRunTime(task.schedule);
            nextRun = next.toLocaleString();
          } catch (error) {
            nextRun = "Invalid schedule";
          }
        }

        console.log(`  ${task.name}`);
        console.log(`    Status:    ${status}`);
        console.log(`    Schedule:  ${task.schedule}`);
        console.log(`    Action:    ${task.action.type}`);
        if (task.action.message) {
          const truncated = task.action.message.length > 60
            ? task.action.message.substring(0, 57) + "..."
            : task.action.message;
          console.log(`    Message:   ${truncated}`);
        }
        if (task.action.condition) {
          console.log(`    Condition: ${task.action.condition}`);
        }
        console.log(`    Last run:  ${lastRun}`);
        console.log(`    Next run:  ${nextRun}`);
        console.log(`    File:      ${filename}`);
        console.log(); // Empty line between tasks
      } else {
        console.log(`  Invalid task file: ${filename}`);
        console.log(`    ${validation.error}`);
        console.log();
      }
    } catch (error) {
      console.log(`  Error reading file: ${filename}`);
      console.log(`    ${error}`);
      console.log();
    }
  }

  return noop;
}

/**
 * Add a new scheduled task
 * If args contains --name, run in non-interactive mode.
 * Otherwise, run interactive prompts.
 */
export async function addSchedule(tasksDir: string = DEFAULT_TASKS_DIR, args?: string[], config?: Config): Promise<void> {
  // Ensure tasks directory exists
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
  }

  // Non-interactive mode: args must contain --name flag
  if (args && args.includes("--name")) {
    const parsed = parseFlags(args);

    const task: Task = {
      name: parsed.name,
      schedule: parsed.cron,
      action: {
        type: parsed.action as Task["action"]["type"],
        ...(parsed.agent && { agent: parsed.agent }),
        ...(parsed.message && { message: parsed.message }),
        ...(parsed.command && { command: parsed.command }),
        ...(parsed.condition && { condition: parsed.condition }),
        ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      },
      enabled: true,
    };

    // Generate filename
    const filename = task.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".yaml";
    const filepath = path.join(tasksDir, filename);
    await saveTask(filepath, task);
    console.log(`Task created: ${filepath}`);
    return;
  }

  // Interactive mode
  intro(chalk.bold("Add Scheduled Task"));

  // Prompt for task details
  const name = await text({
    message: "Task name:",
    placeholder: "Daily memory consolidation",
    validate: value => {
      if (!value) return "Name is required";
      return undefined;
    },
  });

  if (typeof name === "symbol") {
    cancel("Cancelled");
    return;
  }

  const schedule = await text({
    message: "Cron schedule (minute hour day month weekday):",
    placeholder: "0 2 * * * (daily at 2am)",
    validate: value => {
      if (!value) return "Schedule is required";
      const parts = value.trim().split(/\s+/);
      if (parts.length !== 5) return "Must be 5 fields: minute hour day month weekday";
      return undefined;
    },
  });

  if (typeof schedule === "symbol") {
    cancel("Cancelled");
    return;
  }

  const actionType = (await select({
    message: "Task action type:",
    options: [
      { value: "agent-message", label: "Agent Message" },
      { value: "command", label: "Shell Command" },
    ],
  })) as Task["action"]["type"];

  if (typeof actionType === "symbol") {
    cancel("Cancelled");
    return;
  }

  let action: Task["action"];

  if (actionType === "agent-message") {
    const agent = await text({
      message: "Agent ID:",
      placeholder: "coder",
      validate: value => {
        if (!value) return "Agent ID is required";
        return undefined;
      },
    });

    if (typeof agent === "symbol") {
      cancel("Cancelled");
      return;
    }

    const message = await text({
      message: "Message to send:",
      placeholder: "Use the turboclaw-memory skill with the --consolidate flag",
      validate: value => {
        if (!value) return "Message is required";
        return undefined;
      },
    });

    if (typeof message === "symbol") {
      cancel("Cancelled");
      return;
    }

    let replyTo: string | symbol | undefined;
    const allowedUsers = config?.allowed_users;

    if (allowedUsers && allowedUsers.length > 0) {
      const selected = await select({
        message: "Reply-to chat ID (Telegram chat ID to receive replies):",
        options: [
          ...allowedUsers.map(id => ({ value: String(id), label: String(id) })),
          { value: "", label: "None" },
        ],
      });

      if (typeof selected === "symbol") {
        cancel("Cancelled");
        return;
      }

      replyTo = selected || undefined;
    } else {
      replyTo = await text({
        message: "Reply-to chat ID (Telegram chat ID to receive replies):",
        placeholder: "123456789",
      });

      if (typeof replyTo === "symbol") {
        cancel("Cancelled");
        return;
      }
    }

    action = {
      type: "agent-message",
      agent,
      message,
      ...(replyTo && { replyTo }),
    };
  } else if (actionType === "command") {
    const command = await text({
      message: "Shell command to run:",
      placeholder: "bun run backup.ts",
      validate: value => {
        if (!value) return "Command is required";
        return undefined;
      },
    });

    if (typeof command === "symbol") {
      cancel("Cancelled");
      return;
    }

    action = { type: "command", command };
  } else {
    cancel("Invalid action type");
    return;
  }

  // Ask for optional conditional command
  const hasCondition = await confirm({
    message: "Add a conditional command? (task only runs if condition exits with code 0)",
    initialValue: false,
  });

  if (typeof hasCondition === "symbol") {
    cancel("Cancelled");
    return;
  }

  if (hasCondition) {
    const condition = await text({
      message: "Conditional command:",
      placeholder: "test -f /tmp/ready.flag",
      validate: value => {
        if (!value) return "Condition is required if enabled";
        return undefined;
      },
    });

    if (typeof condition === "symbol") {
      cancel("Cancelled");
      return;
    }

    action.condition = condition;
  }

  const task: Task = {
    name,
    schedule,
    action,
    enabled: true,
  };

  // Validate the task
  const validation = validateTask(task);
  if (!validation.success) {
    cancel(`Invalid task: ${validation.error}`);
    return;
  }

  // Save to file
  let filename = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".yaml";

  // Prepend agent ID for agent-specific tasks
  if (action.type === "agent-message" && action.agent) {
    filename = `${action.agent}-${filename}`;
  }

  const filepath = path.join(tasksDir, filename);

  if (fs.existsSync(filepath)) {
    const overwrite = await confirm({
      message: `File ${filename} already exists. Overwrite?`,
    });

    if (typeof overwrite === "symbol" || !overwrite) {
      cancel("Cancelled");
      return;
    }
  }

  try {
    await saveTask(filepath, task);
    outro(chalk.green(`Task created: ${filepath}`));
  } catch (error) {
    cancel(`Error saving task: ${error}`);
  }
}

/**
 * Remove a scheduled task
 */
export async function removeSchedule(taskName: string, tasksDir: string = DEFAULT_TASKS_DIR): Promise<() => void> {
  if (!fs.existsSync(tasksDir)) {
    console.log("No tasks directory found");
    return noop;
  }

  // Find the task file by reading all YAML files and matching by name
  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  let foundFile: string | null = null;

  for (const filename of files) {
    const filepath = path.join(tasksDir, filename);
    try {
      const content = fs.readFileSync(filepath, "utf-8");
      const data = YAML.parse(content);
      const validation = validateTask(data);

      if (validation.success && validation.data.name === taskName) {
        foundFile = filepath;
        break;
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (!foundFile) {
    console.log(`Task not found: ${taskName}`);
    return noop;
  }

  try {
    fs.unlinkSync(foundFile);
    console.log(`Task removed: ${taskName}`);
  } catch (error) {
    console.error(`Error removing task: ${error}`);
  }

  return noop;
}

/**
 * Enable or disable a scheduled task
 */
export async function toggleSchedule(
  taskName: string,
  enabled: boolean,
  tasksDir: string = DEFAULT_TASKS_DIR
): Promise<() => void> {
  if (!fs.existsSync(tasksDir)) {
    console.log("No tasks directory found");
    return noop;
  }

  // Find the task file by reading all YAML files and matching by name
  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  let foundFile: string | null = null;
  let task: Task | null = null;

  for (const filename of files) {
    const filepath = path.join(tasksDir, filename);
    try {
      const content = fs.readFileSync(filepath, "utf-8");
      const data = YAML.parse(content);
      const validation = validateTask(data);

      if (validation.success && validation.data.name === taskName) {
        foundFile = filepath;
        task = validation.data;
        break;
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (!foundFile || !task) {
    console.log(`Task not found: ${taskName}`);
    return noop;
  }

  // Update the task
  task.enabled = enabled;

  try {
    await saveTask(foundFile, task);
    console.log(`Task ${enabled ? "enabled" : "disabled"}: ${taskName}`);
  } catch (error) {
    console.error(`Error updating task: ${error}`);
  }

  return noop;
}
