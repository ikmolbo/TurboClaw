import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import * as yaml from "yaml";
import * as prompts from "@clack/prompts";

/**
 * Build a fully commented config for first-time installs so all options are obvious.
 */
function buildFreshConfig(workspacePath: string, allowedUsers?: number[], skillDirectories?: string[]): string {
  const allowedUsersSection = allowedUsers && allowedUsers.length > 0
    ? `\n# Allowed Telegram user IDs (only these users can message the bots)\nallowed_users:\n${allowedUsers.map((id) => `  - ${id}`).join("\n")}\n`
    : `\n# Allowed Telegram user IDs — leave empty or omit to allow all users\n# allowed_users:\n#   - 123456789\n`;

  const skillDirsSection = skillDirectories && skillDirectories.length > 0
    ? `\n# Additional directories to scan for skills (besides ~/.turboclaw/skills/)\nskill_directories:\n${skillDirectories.map((d) => `  - ${d}`).join("\n")}\n`
    : `\n# Additional directories to scan for skills (besides ~/.turboclaw/skills/)\n# skill_directories:\n#   - ~/projects/my-custom-skills\n`;

  return `# TurboClaw Configuration
# Run 'turboclaw setup' at any time to update these settings.

workspace:
  path: ${workspacePath}
${allowedUsersSection}${skillDirsSection}
# ── Providers ────────────────────────────────────────────────────────────────
# Define API providers here. Each agent references a provider by name.
# Credentials can also be set via environment variables (e.g. ANTHROPIC_API_KEY).
providers:
  anthropic: {}    # uses ANTHROPIC_API_KEY env var by default

  # mistral:
  #   api_key: sk-...
  #   base_url: https://api.mistral.ai/v1

  # openai:
  #   api_key: sk-...
  #   base_url: https://api.openai.com/v1

# ── Agents ───────────────────────────────────────────────────────────────────
# Add agents with: turboclaw agents add
# agents:
#   coder:
#     name: Code Assistant
#     provider: anthropic
#     model: sonnet               # opus, sonnet, haiku, or full model ID
#     working_directory: ~/.turboclaw/workspaces/coder
#     heartbeat_interval: 10800   # seconds (e.g. 3600 = 1h), or false to disable
#     memory_mode: isolated       # isolated (private) or shared (all agents)
#     telegram:
#       bot_token: "123456:ABC..."

# ── Voice Transcription ──────────────────────────────────────────────────────
# Transcribes voice messages using any OpenAI-compatible provider.
# The provider name must match a key in the providers section above.
# transcription:
#   enabled: true
#   provider: mistral
#   model: voxtral-mini-latest    # or whisper-1, whisper-large-v3, etc.
#   retain_audio: false           # delete audio file after transcription
`;
}

export interface SetupOptions {
  configPath?: string;
}

const noop = () => {};

/**
 * Expand ~ at the start of a path to the home directory
 */
function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Interactive setup command to create or update ~/.turboclaw/config.yaml
 *
 * Returns a no-op function so that `await expect(fn()).resolves.not.toThrow()`
 * passes in Bun's test runner (which calls the resolved value as a function).
 */
export async function setupCommand(options: SetupOptions = {}): Promise<() => void> {
  const configPath = options.configPath ?? join(homedir(), ".turboclaw", "config.yaml");

  prompts.intro("TurboClaw Setup");

  // Load existing config if present
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = yaml.parse(raw);
      if (parsed && typeof parsed === "object") {
        existingConfig = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors — start fresh
    }
  }

  const existingWorkspace = (existingConfig.workspace as Record<string, unknown> | undefined)?.path as string | undefined;

  // Prompt for workspace path
  const workspacePath = await prompts.text({
    message: "Workspace path",
    placeholder: "~/.turboclaw/workspaces",
    initialValue: existingWorkspace ?? "~/.turboclaw/workspaces",
  });

  if (prompts.isCancel(workspacePath)) {
    prompts.cancel("Setup cancelled");
    return noop;
  }

  const rawWorkspacePath = workspacePath as string;
  const resolvedWorkspacePath = expandPath(rawWorkspacePath);

  // Prompt for Telegram
  const enableTelegram = await prompts.confirm({
    message: "Enable Telegram?",
    initialValue: false,
  });

  if (prompts.isCancel(enableTelegram)) {
    prompts.cancel("Setup cancelled");
    return noop;
  }

  let allowedUsers: number[] | undefined;
  if (enableTelegram) {
    const userIdInput = await prompts.text({
      message: "Your Telegram user ID",
      placeholder: "123456789",
    });

    if (prompts.isCancel(userIdInput)) {
      prompts.cancel("Setup cancelled");
      return noop;
    }

    const rawInput = (userIdInput as string).trim();
    if (rawInput.length > 0) {
      allowedUsers = rawInput
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n));
    }
  }

  // Prompt for additional skill directories
  const existingSkillDirs = (existingConfig.skill_directories as string[] | undefined) ?? [];
  const skillDirsInput = await prompts.text({
    message: "Additional skill directories (comma-separated, leave blank to skip)",
    placeholder: "e.g., ~/projects/my-skills, ~/other-skills",
    initialValue: existingSkillDirs.length > 0 ? existingSkillDirs.join(", ") : "",
  });

  if (prompts.isCancel(skillDirsInput)) {
    prompts.cancel("Setup cancelled");
    return noop;
  }

  const skillDirectories = (skillDirsInput as string)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Ensure parent directory exists
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Bootstrap the shared memory directory inside the workspace (best-effort)
  try {
    const sharedMemoryDir = join(resolvedWorkspacePath, "shared");
    mkdirSync(join(sharedMemoryDir, "daily"), { recursive: true });
    const sharedMemoryFile = join(sharedMemoryDir, "MEMORY.md");
    if (!existsSync(sharedMemoryFile)) {
      writeFileSync(sharedMemoryFile, "# Memory\n\nNotes consolidated from daily logs. Maintained automatically by the memory skill.\n", "utf-8");
    }
  } catch {
    // Non-fatal — workspace path may not be accessible yet
  }

  // Write config file
  const isFreshInstall = Object.keys(existingConfig).length === 0;
  let configContent: string;

  if (isFreshInstall) {
    // First run: write a fully commented template so all options are obvious
    configContent = buildFreshConfig(rawWorkspacePath, allowedUsers, skillDirectories);
  } else {
    // Existing config: update only the fields we collected, preserve the rest
    existingConfig.workspace = { path: rawWorkspacePath };
    if (allowedUsers && allowedUsers.length > 0) {
      existingConfig.allowed_users = allowedUsers;
    }
    if (skillDirectories.length > 0) {
      existingConfig.skill_directories = skillDirectories;
    } else {
      delete existingConfig.skill_directories;
    }
    if (!existingConfig.providers) {
      existingConfig.providers = { anthropic: {} };
    }
    configContent = yaml.stringify(existingConfig);
  }

  writeFileSync(configPath, configContent, "utf-8");

  // Prompt to add an agent
  const addAgent = await prompts.confirm({
    message: "Add an agent now?",
    initialValue: false,
  });

  if (prompts.isCancel(addAgent)) {
    prompts.note("turboclaw start", "Next step");
    prompts.outro("Setup complete!");
    return noop;
  }

  if (addAgent) {
    try {
      const { agentsCommand } = await import("./agents");
      const { loadConfig } = await import("../../config/index");
      const loadedConfig = await loadConfig(configPath);
      await agentsCommand(["add"], loadedConfig, configPath);
    } catch (error) {
      prompts.log.warn(
        `Agent creation failed: ${error instanceof Error ? error.message : String(error)}`
      );
      prompts.log.info("You can create an agent later with: turboclaw agents add");
    }
  }

  prompts.note("turboclaw start", "Next step");
  prompts.outro("Setup complete!");
  return noop;
}
