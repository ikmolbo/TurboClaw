import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as yaml from "yaml";
import * as os from "os";
import { createLogger, setLogLevel, LogLevel } from "../../lib/logger";
import type { Config } from "../../config/index";
import { expandPath, unexpandPath } from "../../config/index";
import * as prompts from "@clack/prompts";

const logger = createLogger("cli");

import { copyTemplatesToAgent, setupAgentMemory } from "../../lib/templates";

export interface AgentInfo {
  id: string;
  name: string;
  provider: string;
  model: string;
  workingDirectory: string;
  heartbeat_interval: number | false;
  memory_mode: "shared" | "isolated";
  telegram?: {
    bot_token: string;
  };
}

export interface CreateAgentData {
  id: string;
  name: string;
  provider: "anthropic";
  model: "opus" | "sonnet" | "haiku";
  working_directory: string;
  heartbeat_interval: number | false;
  memory_mode: "shared" | "isolated";
  telegram?: {
    bot_token: string;
  };
}


/**
 * List all agents from config
 */
export function listAgents(config: Config): AgentInfo[] {
  const agents: AgentInfo[] = [];

  for (const [id, agentConfig] of Object.entries(config.agents || {})) {
    agents.push({
      id,
      name: agentConfig.name,
      provider: agentConfig.provider,
      model: agentConfig.model,
      workingDirectory: agentConfig.working_directory,
      heartbeat_interval: agentConfig.heartbeat_interval ?? false,
      memory_mode: agentConfig.memory_mode ?? "shared",
      ...(agentConfig.telegram && { telegram: agentConfig.telegram }),
    });
  }

  return agents;
}

/**
 * Get agent by ID
 */
export function getAgent(id: string, config: Config): AgentInfo | undefined {
  const agentConfig = config.agents?.[id];

  if (!agentConfig) {
    return undefined;
  }

  return {
    id,
    name: agentConfig.name,
    provider: agentConfig.provider,
    model: agentConfig.model,
    workingDirectory: agentConfig.working_directory,
    heartbeat_interval: agentConfig.heartbeat_interval ?? false,
    memory_mode: agentConfig.memory_mode ?? "shared",
    ...(agentConfig.telegram && { telegram: agentConfig.telegram }),
  };
}

/**
 * Create a new agent
 */
export async function createAgent(
  agentData: CreateAgentData,
  configPath: string
): Promise<void> {
  logger.info("Creating agent", { id: agentData.id, name: agentData.name });

  // Expand ~ so all filesystem operations use absolute paths
  const workingDir = expandPath(agentData.working_directory);

  // Load current config
  const configContent = readFileSync(configPath, "utf-8");
  const config = yaml.parse(configContent);

  // Check if agent already exists
  if (config.agents?.[agentData.id]) {
    throw new Error(`Agent with ID '${agentData.id}' already exists`);
  }

  // Create agent workspace directory
  try {
    if (!existsSync(workingDir)) {
      mkdirSync(workingDir, { recursive: true });
      logger.debug("Created agent workspace", { path: workingDir });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create workspace directory '${workingDir}': ${message}`);
  }

  // Create .claude directory for skills
  const claudeDir = join(workingDir, ".claude");
  const skillsDir = join(claudeDir, "skills");
  try {
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
      logger.debug("Created .claude/skills directory", { path: skillsDir });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create .claude/skills directory: ${message}`);
  }

  // Copy template files to agent workspace with variable substitution
  try {
    copyTemplatesToAgent(workingDir, {
      memory_mode: agentData.memory_mode,
      agent_id: agentData.id,
      agent_name: agentData.name,
    });
    logger.debug("Copied templates to agent workspace", { agentId: agentData.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to copy some templates", { error: message });
    // Don't fail agent creation if template copying fails - it's not critical
  }

  // Set up memory structure (shared symlink or isolated directory)
  try {
    const workspacePath = expandPath(String(config.workspace?.path ?? join(os.homedir(), ".turboclaw", "workspaces")));
    const sharedMemoryDir = join(workspacePath, "shared");
    setupAgentMemory(agentData.memory_mode, workingDir, sharedMemoryDir);
    logger.debug("Set up memory structure", { mode: agentData.memory_mode });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to set up memory structure", { error: message });
  }

  // Install bundled TurboClaw skills (always installed)
  try {
    const { readdirSync, cpSync, existsSync } = await import("fs");

    // Get TurboClaw repo root (go up from src/cli/commands to root)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const repoRoot = join(__dirname, "..", "..", "..");
    const bundledSkillsPath = join(repoRoot, "skills");

    if (existsSync(bundledSkillsPath)) {
      const bundledSkills = readdirSync(bundledSkillsPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const skillName of bundledSkills) {
        const sourcePath = join(bundledSkillsPath, skillName);
        const destPath = join(skillsDir, skillName);

        // Copy the skill directory
        cpSync(sourcePath, destPath, { recursive: true });
        logger.debug("Installed bundled skill", { skill: skillName, agent: agentData.id });
      }

      logger.info("Installed bundled TurboClaw skills", {
        count: bundledSkills.length,
        skills: bundledSkills
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to install bundled skills", { error: message });
    // Don't fail agent creation if bundled skill installation fails
  }

  // Build the merged agents section
  const agentEntry: Record<string, unknown> = {
    name: agentData.name,
    provider: agentData.provider,
    model: agentData.model,
    working_directory: unexpandPath(workingDir),
    heartbeat_interval: agentData.heartbeat_interval,
    memory_mode: agentData.memory_mode,
    ...(agentData.telegram && { telegram: agentData.telegram }),
  };
  const mergedAgents = { ...(config.agents ?? {}), [agentData.id]: agentEntry };
  const agentsSnippet = yaml.stringify({ agents: mergedAgents }, null, 2).trimEnd();

  // Patch the config file in-place: find the 'agents:' line (if any) and replace
  // everything from that point, preserving all content and comments above it.
  const lines = configContent.split("\n");
  const agentsLineIdx = lines.findIndex((line) => /^agents:/.test(line));
  const prefix = agentsLineIdx >= 0
    ? lines.slice(0, agentsLineIdx).join("\n").trimEnd()
    : configContent.trimEnd();

  // Write updated config (atomic write)
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, prefix + "\n\n" + agentsSnippet + "\n", "utf-8");
  renameSync(tmpPath, configPath);

  // Note: Heartbeats are now built into the daemon
  // The daemon reads heartbeat_interval from config.yaml and fires heartbeats automatically
  // No need to create separate task files

  logger.info("Agent created successfully", { id: agentData.id });
}

/**
 * Remove an agent
 */
export async function removeAgent(id: string, configPath: string): Promise<void> {
  logger.info("Removing agent", { id });

  // Load current config
  const configContent = readFileSync(configPath, "utf-8");
  const config = yaml.parse(configContent);

  // Check if agent exists
  if (!config.agents?.[id]) {
    throw new Error(`Agent with ID '${id}' does not exist`);
  }

  // Remove agent from config
  delete config.agents[id];

  // Patch the config file in-place, preserving comments above the agents block
  const fileContent = readFileSync(configPath, "utf-8");
  const lines = fileContent.split("\n");
  const agentsLineIdx = lines.findIndex((line) => /^agents:/.test(line));
  const prefix = agentsLineIdx >= 0
    ? lines.slice(0, agentsLineIdx).join("\n").trimEnd()
    : fileContent.trimEnd();

  const agentsSnippet = yaml.stringify({ agents: config.agents }, null, 2).trimEnd();
  const newContent = prefix + "\n\n" + agentsSnippet + "\n";

  // Write updated config (atomic write)
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, newContent, "utf-8");
  renameSync(tmpPath, configPath);

  logger.info("Agent removed successfully", { id });
}

/**
 * Interactive agent creation
 */
export async function interactiveCreateAgent(config: Config, configPath: string): Promise<void> {
  prompts.intro("🤖 Create New Agent");

  const id = await prompts.text({
    message: "Agent ID (lowercase, no spaces)",
    placeholder: "e.g., coder, support, assistant",
    validate: (value) => {
      if (!value) return "Agent ID is required";
      if (!/^[a-z0-9-]+$/.test(value)) return "ID must be lowercase letters, numbers, and dashes only";
      if (config.agents?.[value]) return `Agent '${value}' already exists`;
      return undefined;
    },
  });

  if (prompts.isCancel(id)) {
    prompts.cancel("Agent creation cancelled");
    process.exit(0);
  }

  const name = await prompts.text({
    message: "Agent name",
    placeholder: "e.g., Code Assistant, Support Bot",
    validate: (value) => (value ? undefined : "Name is required"),
  });

  if (prompts.isCancel(name)) {
    prompts.cancel("Agent creation cancelled");
    process.exit(0);
  }

  const model = await prompts.select({
    message: "Select model",
    options: [
      { value: "opus", label: "Opus (most capable, slowest)" },
      { value: "sonnet", label: "Sonnet (balanced)" },
      { value: "haiku", label: "Haiku (fastest, cheapest)" },
    ],
  });

  if (prompts.isCancel(model)) {
    prompts.cancel("Agent creation cancelled");
    process.exit(0);
  }

  const workingDir = await prompts.text({
    message: "Working directory",
    placeholder: unexpandPath(join(config.workspace.path, id as string)),
    initialValue: unexpandPath(join(config.workspace.path, id as string)),
  });

  if (prompts.isCancel(workingDir)) {
    prompts.cancel("Agent creation cancelled");
    process.exit(0);
  }

  const heartbeatInterval = await prompts.select({
    message: "Heartbeat interval",
    options: [
      { value: 3600, label: "Every hour (3600s)" },
      { value: 7200, label: "Every 2 hours (7200s)" },
      { value: 10800, label: "Every 3 hours (10800s)" },
      { value: 21600, label: "Every 6 hours (21600s)" },
      { value: false, label: "Disabled" },
    ],
  });

  if (prompts.isCancel(heartbeatInterval)) {
    prompts.cancel("Agent creation cancelled");
    process.exit(0);
  }

  const memoryMode = await prompts.select({
    message: "Memory mode",
    options: [
      { value: "shared", label: "Shared (agents share memory)" },
      { value: "isolated", label: "Isolated (agent has own memory)" },
    ],
  });

  if (prompts.isCancel(memoryMode)) {
    prompts.cancel("Agent creation cancelled");
    process.exit(0);
  }

  const addTelegram = await prompts.confirm({
    message: "Add Telegram bot?",
    initialValue: false,
  });

  let telegramConfig;
  if (addTelegram && !prompts.isCancel(addTelegram)) {
    const botToken = await prompts.text({
      message: "Telegram bot token",
      placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      validate: (value) => (value ? undefined : "Bot token is required"),
    });

    if (!prompts.isCancel(botToken)) {
      telegramConfig = {
        bot_token: botToken as string,
      };
    }
  }

  // Note about bundled skills
  prompts.note(
    "Essential TurboClaw skills (memory, turboclaw-send-user-message, schedule, skill-creator, imagegen) are automatically installed.",
    "Bundled Skills"
  );

  // Ask about additional skills
  const addSkills = await prompts.confirm({
    message: "Add additional skills?",
    initialValue: false,
  });

  let selectedSkills: string[] | undefined;
  let customSkillsToInstall: Array<{ name: string; path: string }> = [];

  if (addSkills && !prompts.isCancel(addSkills)) {
    const { readdirSync, statSync, existsSync } = await import("fs");

    const defaultSkillsPath = join(process.env.HOME || os.homedir(), ".turboclaw", "skills");

    // Ask for an additional custom skills directory
    const additionalPathInput = await prompts.text({
      message: "Additional skills directory (leave blank to skip)",
      placeholder: "e.g., ~/projects/my-skills",
    });

    if (prompts.isCancel(additionalPathInput)) {
      prompts.cancel("Agent creation cancelled");
      process.exit(0);
    }

    const additionalPath = (additionalPathInput as string).trim()
      ? expandPath((additionalPathInput as string).trim())
      : null;

    // Scan a directory for non-bundled skill folders
    const scanDir = (dir: string): string[] => {
      if (!existsSync(dir)) return [];
      try {
        return readdirSync(dir)
          .filter((item) => {
            try {
              return statSync(join(dir, item)).isDirectory() && !item.startsWith("turboclaw-");
            } catch {
              return false;
            }
          })
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return [];
      }
    };

    const defaultSkills = scanDir(defaultSkillsPath);
    const additionalSkillNames = additionalPath ? scanDir(additionalPath) : [];

    // Build combined option list — deduplicated, custom-path skills show their source as a hint
    const allOptions = [
      ...defaultSkills.map((name) => ({
        value: name,
        label: name,
        hint: "~/.turboclaw/skills",
      })),
      ...additionalSkillNames
        .filter((name) => !defaultSkills.includes(name))
        .map((name) => ({
          value: `__custom__${name}`,
          label: name,
          hint: additionalPath!,
        })),
    ];

    if (allOptions.length > 0) {
      const skillsInput = await prompts.multiselect({
        message: "Select additional skills (space to select, enter to confirm)",
        options: allOptions,
        initialValues: [],
      });

      if (!prompts.isCancel(skillsInput)) {
        const selected = skillsInput as string[];
        // Default-path skills are installed directly after agent creation
        selectedSkills = selected.filter((s) => !s.startsWith("__custom__"));
        // Custom-path skills are installed directly after agent creation
        customSkillsToInstall = selected
          .filter((s) => s.startsWith("__custom__"))
          .map((s) => {
            const name = s.replace("__custom__", "");
            return { name, path: join(additionalPath!, name) };
          });
      }
    } else {
      const pathsMsg = [defaultSkillsPath, additionalPath].filter(Boolean).join("\n  ");
      prompts.note(
        `No additional skills found in:\n  ${pathsMsg}\nBundled TurboClaw skills will be installed automatically.`,
        "Skills"
      );
      selectedSkills = [];
    }
  }

  // Create agent (suppress verbose logger output during interactive UI)
  setLogLevel(LogLevel.WARN);
  const spinner = prompts.spinner();
  spinner.start("Creating agent...");

  try {
    await createAgent(
      {
        id: id as string,
        name: name as string,
        provider: "anthropic",
        model: model as "opus" | "sonnet" | "haiku",
        working_directory: workingDir as string,
        heartbeat_interval: heartbeatInterval as number | false,
        memory_mode: memoryMode as "shared" | "isolated",
        telegram: telegramConfig,
      },
      configPath
    );

    spinner.stop("✅ Agent created successfully!");
    setLogLevel(LogLevel.DEBUG);

    // Install all additional skills directly into the agent's .claude/skills dir
    const allSkillsToInstall: Array<{ name: string; path: string }> = [
      ...(selectedSkills ?? []).map((name) => ({
        name,
        path: join(process.env.HOME || os.homedir(), ".turboclaw", "skills", name),
      })),
      ...customSkillsToInstall,
    ];

    if (allSkillsToInstall.length > 0) {
      const { cpSync, existsSync } = await import("fs");
      const agentSkillsDir = join(expandPath(workingDir as string), ".claude", "skills");
      for (const { name: skillName, path: skillPath } of allSkillsToInstall) {
        try {
          if (existsSync(skillPath)) {
            cpSync(skillPath, join(agentSkillsDir, skillName), { recursive: true });
          }
        } catch {
          // Non-fatal — don't abort agent creation for a skill copy failure
        }
      }
    }

    // Show a tidy summary of what was created
    const sharedMemoryPath = join(config.workspace.path, "shared");
    const memoryLine = (memoryMode as string) === "shared"
      ? `✓ Memory: Shared → ${sharedMemoryPath}`
      : `✓ Memory: Isolated (memory/ in workspace)`;
    const summaryLines: string[] = [
      `✓ Workspace: ${workingDir as string}`,
      memoryLine,
      `✓ Template files installed`,
      `✓ TurboClaw bundled skills installed`,
    ];
    if (allSkillsToInstall.length > 0) {
      summaryLines.push(`✓ Additional skills: ${allSkillsToInstall.map((s) => s.name).join(", ")}`);
    }
    prompts.note(summaryLines.join("\n"), "Files created");

    // Memory skill is always installed (bundled), so offer to create schedules
    const createMemorySchedules = await prompts.confirm({
      message: "Create automated memory management schedules? (Recommended)",
      initialValue: true,
    });

    if (createMemorySchedules && !prompts.isCancel(createMemorySchedules)) {
        try {
          const os = await import("os");
          const tasksDir = join(os.homedir(), ".turboclaw", "tasks");
          const { mkdirSync, existsSync, writeFileSync } = await import("fs");
          const yaml = await import("yaml");

          // Ensure tasks directory exists
          if (!existsSync(tasksDir)) {
            mkdirSync(tasksDir, { recursive: true });
          }

          const scheduleNotes: string[] = [];

          // Memory consolidation: one shared task for shared mode, per-agent for isolated
          if (memoryMode === "shared") {
            const sharedConsolidationFile = join(tasksDir, "shared-memory-consolidation.yaml");
            if (!existsSync(sharedConsolidationFile)) {
              const consolidationTask = {
                name: "Shared Memory Consolidation",
                schedule: "0 2 * * *", // 2am daily
                action: {
                  type: "agent-message",
                  agent: id as string,
                  message: "Use the turboclaw-memory skill with the --consolidate flag to consolidate daily logs into long-term memory",
                },
                enabled: true,
              };
              writeFileSync(sharedConsolidationFile, yaml.stringify(consolidationTask), "utf-8");
              scheduleNotes.push("✓ Daily shared memory consolidation (2am)");
            } else {
              scheduleNotes.push("✓ Shared memory consolidation already scheduled (skipped)");
            }
          } else {
            const consolidationTask = {
              name: `${id} Memory Consolidation`,
              schedule: "0 2 * * *", // 2am daily
              action: {
                type: "agent-message",
                agent: id as string,
                message: "memory --consolidate",
              },
              enabled: true,
            };
            const consolidationFile = join(tasksDir, `${id}-memory-consolidation.yaml`);
            writeFileSync(consolidationFile, yaml.stringify(consolidationTask), "utf-8");
            scheduleNotes.push("✓ Daily memory consolidation (2am)");
          }

          // Context clearing is always per-agent (clears agent conversation, not memory files)
          const contextClearTask = {
            name: `${id} Memory Context Clearing`,
            schedule: "0 */6 * * *", // Every 6 hours
            action: {
              type: "agent-message",
              agent: id as string,
              message: "Use the turboclaw-memory skill with the --clear-context flag to clear conversation context",
            },
            enabled: true,
          };
          const contextClearFile = join(tasksDir, `${id}-memory-context-clearing.yaml`);
          writeFileSync(contextClearFile, yaml.stringify(contextClearTask), "utf-8");
          scheduleNotes.push("✓ Memory context clearing (every 6 hours)");

          prompts.note(scheduleNotes.join("\n"), "Memory schedules created");
        } catch (error) {
          logger.warn("Failed to create memory schedules", { error });
          // Don't fail agent creation if schedule creation fails
        }
    }

    prompts.outro(`Agent '${name}' created with ID: ${id}`);
  } catch (error) {
    spinner.stop("❌ Failed to create agent");
    setLogLevel(LogLevel.DEBUG);
    prompts.cancel(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * CLI command handler for agents
 */
export async function agentsCommand(args: string[], config: Config, configPath: string): Promise<void> {
  const subcommand = args[0] || "list";

  switch (subcommand) {
    case "list": {
      const agents = listAgents(config);

      if (agents.length === 0) {
        console.log("🤖 No agents configured yet");
        console.log("\nCreate your first agent with: turboclaw agents add");
        return;
      }

      console.log("🤖 Configured agents:\n");
      agents.forEach((agent) => {
        console.log(`  ${agent.id}`);
        console.log(`    Name: ${agent.name}`);
        console.log(`    Model: ${agent.model}`);
        console.log(`    Heartbeat: ${agent.heartbeat_interval === false ? "Disabled" : `${agent.heartbeat_interval}s`}`);
        console.log(`    Memory: ${agent.memory_mode}`);
        console.log();
      });
      break;
    }

    case "add": {
      await interactiveCreateAgent(config, configPath);
      break;
    }

    case "show": {
      let agentId = args[1];

      // If no agent ID provided, show interactive selection
      if (!agentId) {
        const agents = listAgents(config);

        if (agents.length === 0) {
          console.log("🤖 No agents configured yet");
          console.log("\nCreate your first agent with: turboclaw agents add");
          return;
        }

        const selected = await prompts.select({
          message: "Select agent to view",
          options: agents.map((a) => ({
            value: a.id,
            label: `${a.name} (${a.id})`,
            hint: a.model,
          })),
        });

        if (prompts.isCancel(selected)) {
          prompts.cancel("Cancelled");
          return;
        }

        agentId = selected as string;
      }

      const agent = getAgent(agentId, config);
      if (!agent) {
        console.error(`❌ Agent '${agentId}' not found`);
        process.exit(1);
      }

      console.log(`🤖 Agent: ${agent.name}\n`);
      console.log(`  ID: ${agent.id}`);
      console.log(`  Provider: ${agent.provider}`);
      console.log(`  Model: ${agent.model}`);
      console.log(`  Working Directory: ${agent.workingDirectory}`);
      console.log(`  Heartbeat: ${agent.heartbeat_interval === false ? "Disabled" : `${agent.heartbeat_interval}s`}`);
      console.log(`  Memory Mode: ${agent.memory_mode}`);

      if (agent.telegram) {
        console.log(`  Telegram: Configured`);
      }
      break;
    }

    case "remove": {
      let agentId = args[1];

      // If no agent ID provided, show interactive selection
      if (!agentId) {
        const agents = listAgents(config);

        if (agents.length === 0) {
          console.log("🤖 No agents configured yet");
          console.log("\nCreate your first agent with: turboclaw agents add");
          return;
        }

        const selected = await prompts.select({
          message: "Select agent to remove",
          options: agents.map((a) => ({
            value: a.id,
            label: `${a.name} (${a.id})`,
            hint: a.model,
          })),
        });

        if (prompts.isCancel(selected)) {
          prompts.cancel("Cancelled");
          return;
        }

        agentId = selected as string;
      }

      const agent = getAgent(agentId, config);
      if (!agent) {
        console.error(`❌ Agent '${agentId}' not found`);
        process.exit(1);
      }

      const confirm = await prompts.confirm({
        message: `Remove agent '${agent.name}' (${agentId})?`,
        initialValue: false,
      });

      if (prompts.isCancel(confirm) || !confirm) {
        console.log("❌ Cancelled");
        return;
      }

      try {
        await removeAgent(agentId, configPath);
        console.log(`✅ Agent '${agentId}' removed`);
      } catch (error) {
        console.error(`❌ Failed to remove agent: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`❌ Unknown subcommand: ${subcommand}`);
      console.log("\nAvailable commands:");
      console.log("  turboclaw agents list        - List all agents");
      console.log("  turboclaw agents add         - Create new agent");
      console.log("  turboclaw agents show <id>   - Show agent details");
      console.log("  turboclaw agents remove <id> - Remove agent");
      process.exit(1);
    }
  }
}
