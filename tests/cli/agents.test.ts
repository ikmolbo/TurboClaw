import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as yaml from "yaml";
import { listAgents, createAgent, removeAgent } from "../../src/cli/commands/agents";
import type { Config } from "../../src/config/index";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "turboclaw-agents-test-"));
}

function writeConfig(configPath: string, data: object): void {
  writeFileSync(configPath, yaml.stringify(data), "utf-8");
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const mockConfig: Config = {
  workspace: { path: "/tmp/test-workspace" },
  providers: {},
  agents: {
    coder: {
      name: "Code Assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      working_directory: "/tmp/coder",
      heartbeat: {
        interval: 3600,
        telegram_chat_id: 12345,
      },
      memory_mode: "shared",
      telegram: { bot_token: "123:ABC" },
    },
    writer: {
      name: "Writer",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      working_directory: "/tmp/writer",
      heartbeat: {
        interval: false,
        telegram_chat_id: 67890,
      },
      memory_mode: "isolated",
      telegram: { bot_token: "456:DEF" },
    },
  },
};

const emptyConfig: Config = {
  workspace: { path: "/tmp/test-workspace" },
  providers: {},
  agents: {},
};

// ----------------------------------------------------------------------------
// listAgents
// ----------------------------------------------------------------------------

describe("listAgents(config)", () => {
  it("returns one entry per agent", () => {
    const result = listAgents(mockConfig);
    expect(result.length).toBe(2);
  });

  it("each entry has id, name, model, workingDirectory (camelCase)", () => {
    const result = listAgents(mockConfig);
    const coder = result.find((a) => a.id === "coder");
    expect(coder).toBeDefined();
    expect(coder!.name).toBe("Code Assistant");
    expect(coder!.model).toBe("claude-sonnet-4-5-20250929");
    // Phase 11: listAgents must return workingDirectory (camelCase), not working_directory
    expect((coder as any).workingDirectory).toBe("/tmp/coder");
  });

  it("returns empty array when agents config is empty", () => {
    const result = listAgents(emptyConfig);
    expect(result).toEqual([]);
  });

  it("includes id field derived from config key", () => {
    const result = listAgents(mockConfig);
    const ids = result.map((a) => a.id).sort();
    expect(ids).toEqual(["coder", "writer"]);
  });
});

// ----------------------------------------------------------------------------
// createAgent
// ----------------------------------------------------------------------------

describe("createAgent(data, configPath)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    configPath = join(tmpDir, "config.yaml");

    // Write a minimal base config
    writeConfig(configPath, {
      workspace: { path: tmpDir },
      providers: {},
      agents: {},
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the working directory for the new agent", async () => {
    const workDir = join(tmpDir, "new-agent-workspace");

    await createAgent(
      {
        id: "new-agent",
        name: "New Agent",
        provider: "anthropic",
        model: "haiku",
        working_directory: workDir,
        heartbeat: { interval: false },
        memory_mode: "isolated",
      },
      configPath
    );

    expect(existsSync(workDir)).toBe(true);
  });

  it("writes updated config to configPath with the new agent entry", async () => {
    const workDir = join(tmpDir, "new-agent-workspace");

    await createAgent(
      {
        id: "new-agent",
        name: "New Agent",
        provider: "anthropic",
        model: "haiku",
        working_directory: workDir,
        heartbeat: { interval: false },
        memory_mode: "isolated",
      },
      configPath
    );

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    expect(parsed.agents).toBeDefined();
    expect(parsed.agents["new-agent"]).toBeDefined();
    expect(parsed.agents["new-agent"].name).toBe("New Agent");
  });

  it("does not overwrite existing agents in the config", async () => {
    // Pre-populate config with an existing agent
    writeConfig(configPath, {
      workspace: { path: tmpDir },
      providers: {},
      agents: {
        existing: {
          name: "Existing Agent",
          provider: "anthropic",
          model: "haiku",
          working_directory: join(tmpDir, "existing"),
          heartbeat: { interval: false },
          memory_mode: "isolated",
        },
      },
    });

    const workDir = join(tmpDir, "second-agent");

    await createAgent(
      {
        id: "second",
        name: "Second Agent",
        provider: "anthropic",
        model: "sonnet",
        working_directory: workDir,
        heartbeat: { interval: 3600 },
        memory_mode: "shared",
      },
      configPath
    );

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    expect(parsed.agents["existing"]).toBeDefined();
    expect(parsed.agents["second"]).toBeDefined();
  });

  it("throws an error if agent ID already exists", async () => {
    writeConfig(configPath, {
      workspace: { path: tmpDir },
      providers: {},
      agents: {
        duplicate: {
          name: "Existing",
          provider: "anthropic",
          model: "haiku",
          working_directory: join(tmpDir, "dupe"),
          heartbeat: { interval: false },
          memory_mode: "isolated",
        },
      },
    });

    await expect(
      createAgent(
        {
          id: "duplicate",
          name: "New Duplicate",
          provider: "anthropic",
          model: "haiku",
          working_directory: join(tmpDir, "dupe2"),
          heartbeat: { interval: false },
          memory_mode: "isolated",
        },
        configPath
      )
    ).rejects.toThrow();
  });
});

// ----------------------------------------------------------------------------
// removeAgent
// ----------------------------------------------------------------------------

describe("removeAgent(id, configPath)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    configPath = join(tmpDir, "config.yaml");

    writeConfig(configPath, {
      workspace: { path: tmpDir },
      providers: {},
      agents: {
        coder: {
          name: "Code Assistant",
          provider: "anthropic",
          model: "sonnet",
          working_directory: join(tmpDir, "coder"),
          heartbeat: { interval: 3600 },
          memory_mode: "shared",
        },
        writer: {
          name: "Writer",
          provider: "anthropic",
          model: "haiku",
          working_directory: join(tmpDir, "writer"),
          heartbeat: { interval: false },
          memory_mode: "isolated",
        },
      },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the agent entry from config YAML", async () => {
    await removeAgent("coder", configPath);

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    expect(parsed.agents["coder"]).toBeUndefined();
  });

  it("leaves other agents intact after removal", async () => {
    await removeAgent("coder", configPath);

    const raw = readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);

    expect(parsed.agents["writer"]).toBeDefined();
  });

  it("does NOT delete the working directory — only removes from config", async () => {
    const coderDir = join(tmpDir, "coder");
    mkdirSync(coderDir, { recursive: true });

    await removeAgent("coder", configPath);

    // Directory should still exist (removeAgent only edits config)
    expect(existsSync(coderDir)).toBe(true);
  });

  it("throws an error if the agent ID does not exist", async () => {
    await expect(removeAgent("nonexistent", configPath)).rejects.toThrow();
  });
});
