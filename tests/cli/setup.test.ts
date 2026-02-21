/**
 * tests/cli/setup.test.ts
 *
 * Tests for Phase 13: Setup Command
 *
 * These tests verify the behavior of `setupCommand()` exported from
 * `src/cli/commands/setup.ts`. They are intentionally written to FAIL
 * before Phase 13 is implemented and PASS after.
 *
 * Interactive prompts are mocked so tests do not hang.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import * as yaml from "yaml";

// ---------------------------------------------------------------------------
// Mock @clack/prompts before any module that uses it is imported
// ---------------------------------------------------------------------------

// We define a factory so individual tests can override return values
let mockPromptResponses: Record<string, unknown> = {};

mock.module("@clack/prompts", () => ({
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  note: mock(() => {}),
  spinner: mock(() => ({
    start: mock(() => {}),
    stop: mock(() => {}),
  })),
  isCancel: mock((value: unknown) => value === Symbol.for("clack/cancel")),
  text: mock(async (opts: { message: string; placeholder?: string; initialValue?: string }) => {
    // Return the initialValue when available, or use mockPromptResponses keyed by message
    const key = opts.message;
    if (mockPromptResponses[key] !== undefined) return mockPromptResponses[key];
    if (opts.initialValue !== undefined) return opts.initialValue;
    if (opts.placeholder !== undefined) return opts.placeholder;
    return "";
  }),
  select: mock(async (opts: { message: string; options: Array<{ value: unknown }> }) => {
    const key = opts.message;
    if (mockPromptResponses[key] !== undefined) return mockPromptResponses[key];
    // Default: return first option's value
    return opts.options[0]?.value;
  }),
  confirm: mock(async (opts: { message: string; initialValue?: boolean }) => {
    const key = opts.message;
    if (mockPromptResponses[key] !== undefined) return mockPromptResponses[key];
    return opts.initialValue ?? false;
  }),
  multiselect: mock(async (_opts: unknown) => []),
  password: mock(async (opts: { message: string }) => {
    const key = opts.message;
    if (mockPromptResponses[key] !== undefined) return mockPromptResponses[key];
    return "";
  }),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocking its dependencies
// ---------------------------------------------------------------------------

// We import lazily inside tests / describe blocks using dynamic import so that
// the mock above is applied first (bun:test mock.module is applied before the
// module is evaluated).

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "turboclaw-setup-test-"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupCommand() — module export", () => {
  it("setupCommand is exported from src/cli/commands/setup.ts", async () => {
    // This import will fail until Phase 13 creates the file — that's expected.
    const mod = await import("../../src/cli/commands/setup");
    expect(typeof mod.setupCommand).toBe("function");
  });
});

describe("setupCommand() — no existing config", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    configPath = join(tmpDir, "config.yaml");

    // Reset prompt responses for each test
    mockPromptResponses = {
      // Workspace path prompt
      "Workspace path": tmpDir,
      // No telegram
      "Enable Telegram?": false,
      "Enable transcription?": false,
      "Add an agent now?": false,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a config file at the specified path", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    expect(existsSync(configPath)).toBe(true);
  });

  it("created config is valid YAML (parseable without throwing)", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    expect(() => yaml.parse(raw)).not.toThrow();
  });

  it("created config is parseable by loadConfig() without throwing", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");
    const { loadConfig } = await import("../../src/config/index");

    await setupCommand({ configPath });

    await expect(loadConfig(configPath)).resolves.toBeDefined();
  });

  it("created config has a workspace.path field", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);
    expect(parsed.workspace).toBeDefined();
    expect(typeof parsed.workspace.path).toBe("string");
    expect(parsed.workspace.path.length).toBeGreaterThan(0);
  });

  it("creates parent directory if it does not exist", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    const deepConfigPath = join(tmpDir, "nested", "dir", "config.yaml");

    await setupCommand({ configPath: deepConfigPath });

    expect(existsSync(deepConfigPath)).toBe(true);
  });
});

describe("setupCommand() — config without optional sections", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    configPath = join(tmpDir, "config.yaml");

    mockPromptResponses = {
      "Workspace path": tmpDir,
      "Enable Telegram?": false,
      "Enable transcription?": false,
      "Add an agent now?": false,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("config without agents section loads without error", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");
    const { loadConfig } = await import("../../src/config/index");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    // Remove agents to simulate minimal config
    delete parsed.agents;
    writeFileSync(configPath, yaml.stringify(parsed));

    await expect(loadConfig(configPath)).resolves.toBeDefined();
  });

  it("config without providers section loads without error", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");
    const { loadConfig } = await import("../../src/config/index");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    // Remove providers to simulate minimal config
    delete parsed.providers;
    writeFileSync(configPath, yaml.stringify(parsed));

    await expect(loadConfig(configPath)).resolves.toBeDefined();
  });

  it("minimal config with only workspace.path passes schema validation", async () => {
    const { ConfigSchema } = await import("../../src/config/index");

    const minimalConfig = {
      workspace: { path: tmpDir },
    };

    const result = ConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });
});

describe("setupCommand() — telegram enabled flow", () => {
  let tmpDir: string;
  let configPath: string;
  const testUserId = 987654321;

  beforeEach(() => {
    tmpDir = makeTempDir();
    configPath = join(tmpDir, "config.yaml");

    mockPromptResponses = {
      "Workspace path": tmpDir,
      "Enable Telegram?": true,
      "Your Telegram user ID": String(testUserId),
      "Enable transcription?": false,
      "Add an agent now?": false,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("when telegram is enabled, allowed_users contains the entered user ID", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    expect(parsed.allowed_users).toBeDefined();
    expect(Array.isArray(parsed.allowed_users)).toBe(true);
    expect(parsed.allowed_users).toContain(testUserId);
  });

  it("allowed_users values are numbers (not strings)", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    if (parsed.allowed_users) {
      parsed.allowed_users.forEach((id: unknown) => {
        expect(typeof id).toBe("number");
      });
    }
  });
});

describe("setupCommand() — existing config (update/re-run flow)", () => {
  let tmpDir: string;
  let configPath: string;

  const existingConfig = {
    workspace: { path: "/existing/workspace" },
    providers: {
      anthropic: { api_key: "existing-key" },
    },
    agents: {
      existing_agent: {
        name: "Existing Agent",
        provider: "anthropic",
        model: "sonnet",
        working_directory: "/existing/workspace/agent",
        heartbeat_interval: 3600,
        memory_mode: "shared",
      },
    },
  };

  beforeEach(() => {
    tmpDir = makeTempDir();
    configPath = join(tmpDir, "config.yaml");

    // Write existing config before running setup
    writeFileSync(configPath, yaml.stringify(existingConfig));

    // When re-running setup with existing config, use existing values as defaults
    mockPromptResponses = {
      "Workspace path": existingConfig.workspace.path,
      "Enable Telegram?": false,
      "Enable transcription?": false,
      "Add an agent now?": false,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads existing config values when config file already exists", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    // Should not throw even when config already exists
    await expect(setupCommand({ configPath })).resolves.not.toThrow();
  });

  it("preserves existing agents when re-running setup without adding new ones", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    // Existing agent should still be present
    expect(parsed.agents?.existing_agent).toBeDefined();
  });

  it("resulting config after re-run is still parseable by loadConfig()", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");
    const { loadConfig } = await import("../../src/config/index");

    await setupCommand({ configPath });

    await expect(loadConfig(configPath)).resolves.toBeDefined();
  });
});

describe("setupCommand() — config file output validity", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    configPath = join(tmpDir, "config.yaml");

    mockPromptResponses = {
      "Workspace path": tmpDir,
      "Enable Telegram?": false,
      "Enable transcription?": false,
      "Add an agent now?": false,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("output file has .yaml extension and valid YAML structure", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    expect(configPath.endsWith(".yaml") || configPath.endsWith(".yml")).toBe(true);

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });

  it("output config passes ConfigSchema validation", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");
    const { ConfigSchema } = await import("../../src/config/index");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);
    const result = ConfigSchema.safeParse(parsed);

    expect(result.success).toBe(true);
  });

  it("workspace.path in output config is a non-empty string", async () => {
    const { setupCommand } = await import("../../src/cli/commands/setup");

    await setupCommand({ configPath });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    expect(typeof parsed.workspace.path).toBe("string");
    expect(parsed.workspace.path.trim().length).toBeGreaterThan(0);
  });
});
