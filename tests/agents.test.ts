import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as yaml from "yaml";
import { listAgents, getAgent, createAgent, removeAgent } from "../src/cli/commands/agents";
import type { Config } from "../src/config/index";

const TEST_DIR = join(import.meta.dir, ".test-agents");
const TEST_CONFIG_PATH = join(TEST_DIR, "config.yaml");
const TEST_AGENTS_DIR = join(TEST_DIR, "agents");

describe("Agent Management", () => {
  beforeEach(() => {
    // Create test directory
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_AGENTS_DIR, { recursive: true });

    // Create minimal config
    const config = {
      workspace: {
        path: TEST_AGENTS_DIR,
        skills_path: join(TEST_DIR, "skills"),
      },
      channels: {},
      agents: {},
    };

    writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("List Agents", () => {
    it("should return empty array when no agents exist", () => {
      const config = yaml.parse(readFileSync(TEST_CONFIG_PATH, "utf-8"));
      const agents = listAgents(config);
      expect(agents).toEqual([]);
    });

    it("should list all agents from config", () => {
      const config = {
        workspace: {
          path: TEST_AGENTS_DIR,
          skills_path: join(TEST_DIR, "skills"),
        },
        channels: {},
        agents: {
          coder: {
            name: "Code Assistant",
            provider: "anthropic",
            model: "sonnet",
            working_directory: join(TEST_AGENTS_DIR, "coder"),
            heartbeat_interval: 10800,
            memory_mode: "shared",
          },
          support: {
            name: "Support Bot",
            provider: "anthropic",
            model: "haiku",
            working_directory: join(TEST_AGENTS_DIR, "support"),
            heartbeat_interval: 7200,
            memory_mode: "isolated",
          },
        },
      };

      const agents = listAgents(config);
      expect(agents.length).toBe(2);
      expect(agents[0].id).toBe("coder");
      expect(agents[0].name).toBe("Code Assistant");
      expect(agents[1].id).toBe("support");
      expect(agents[1].name).toBe("Support Bot");
    });
  });

  describe("Get Agent", () => {
    it("should return agent details", () => {
      const config = {
        workspace: {
          path: TEST_AGENTS_DIR,
          skills_path: join(TEST_DIR, "skills"),
        },
        channels: {},
        agents: {
          coder: {
            name: "Code Assistant",
            provider: "anthropic",
            model: "sonnet",
            working_directory: join(TEST_AGENTS_DIR, "coder"),
            heartbeat_interval: 10800,
            memory_mode: "shared",
          },
        },
      };

      const agent = getAgent("coder", config);
      expect(agent).toBeDefined();
      expect(agent?.id).toBe("coder");
      expect(agent?.name).toBe("Code Assistant");
      expect(agent?.model).toBe("sonnet");
    });

    it("should return undefined for non-existent agent", () => {
      const config = {
        workspace: {
          path: TEST_AGENTS_DIR,
          skills_path: join(TEST_DIR, "skills"),
        },
        channels: {},
        agents: {},
      };

      const agent = getAgent("nonexistent", config);
      expect(agent).toBeUndefined();
    });
  });

  describe("Create Agent", () => {
    it("should create agent with required fields", async () => {
      const agentData = {
        id: "test-agent",
        name: "Test Agent",
        provider: "anthropic" as const,
        model: "sonnet" as const,
        working_directory: join(TEST_AGENTS_DIR, "test-agent"),
        heartbeat_interval: 10800,
        memory_mode: "shared" as const,
      };

      await createAgent(agentData, TEST_CONFIG_PATH);

      // Verify config was updated
      const config = yaml.parse(readFileSync(TEST_CONFIG_PATH, "utf-8"));
      expect(config.agents["test-agent"]).toBeDefined();
      expect(config.agents["test-agent"].name).toBe("Test Agent");

      // Verify agent directory was created
      expect(existsSync(agentData.working_directory)).toBe(true);
    });

    it("should create agent workspace directory", async () => {
      const agentData = {
        id: "workspace-test",
        name: "Workspace Test",
        provider: "anthropic" as const,
        model: "haiku" as const,
        working_directory: join(TEST_AGENTS_DIR, "workspace-test"),
        heartbeat_interval: 7200,
        memory_mode: "isolated" as const,
      };

      await createAgent(agentData, TEST_CONFIG_PATH);

      expect(existsSync(agentData.working_directory)).toBe(true);
    });

    it("should throw error if agent ID already exists", async () => {
      const config = {
        workspace: {
          path: TEST_AGENTS_DIR,
          skills_path: join(TEST_DIR, "skills"),
        },
        channels: {},
        agents: {
          existing: {
            name: "Existing Agent",
            provider: "anthropic",
            model: "sonnet",
            working_directory: join(TEST_AGENTS_DIR, "existing"),
            heartbeat_interval: 10800,
            memory_mode: "shared",
          },
        },
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const agentData = {
        id: "existing",
        name: "Duplicate Agent",
        provider: "anthropic" as const,
        model: "sonnet" as const,
        working_directory: join(TEST_AGENTS_DIR, "existing"),
        heartbeat_interval: 10800,
        memory_mode: "shared" as const,
      };

      expect(async () => {
        await createAgent(agentData, TEST_CONFIG_PATH);
      }).toThrow();
    });
  });

  describe("Template Copying", () => {
    it("should copy templates to agent workspace on creation", async () => {
      const agentData = {
        id: "template-test",
        name: "Template Test",
        provider: "anthropic" as const,
        model: "sonnet" as const,
        working_directory: join(TEST_AGENTS_DIR, "template-test"),
        heartbeat_interval: 10800,
        memory_mode: "shared" as const,
      };

      await createAgent(agentData, TEST_CONFIG_PATH);

      // Verify workspace templates were copied
      const workspaceTemplates = ["HEARTBEAT.md", "ONBOARDING.md"];
      for (const template of workspaceTemplates) {
        const templatePath = join(agentData.working_directory, template);
        expect(existsSync(templatePath)).toBe(true);

        // Verify content exists (not empty)
        const content = readFileSync(templatePath, "utf-8");
        expect(content.length).toBeGreaterThan(0);
      }

      // Verify CLAUDE.md was copied to .claude directory
      const claudeMdPath = join(agentData.working_directory, "CLAUDE.md");
      expect(existsSync(claudeMdPath)).toBe(true);
      const claudeContent = readFileSync(claudeMdPath, "utf-8");
      expect(claudeContent.length).toBeGreaterThan(0);
    });

    it("should not overwrite existing templates", async () => {
      const agentData = {
        id: "existing-template-test",
        name: "Existing Template Test",
        provider: "anthropic" as const,
        model: "sonnet" as const,
        working_directory: join(TEST_AGENTS_DIR, "existing-template-test"),
        heartbeat_interval: 10800,
        memory_mode: "shared" as const,
      };

      // Create workspace directory manually
      mkdirSync(agentData.working_directory, { recursive: true });

      // Create a custom ONBOARDING.md file
      const customContent = "# Custom Onboarding\nThis is my custom content that should not be overwritten.";
      const onboardingPath = join(agentData.working_directory, "ONBOARDING.md");
      writeFileSync(onboardingPath, customContent, "utf-8");

      await createAgent(agentData, TEST_CONFIG_PATH);

      // Verify custom content was preserved
      const content = readFileSync(onboardingPath, "utf-8");
      expect(content).toBe(customContent);

      // Verify other templates were still copied
      const heartbeatPath = join(agentData.working_directory, "HEARTBEAT.md");
      expect(existsSync(heartbeatPath)).toBe(true);
    });

    it("should create .claude/skills directory", async () => {
      const agentData = {
        id: "skills-dir-test",
        name: "Skills Directory Test",
        provider: "anthropic" as const,
        model: "sonnet" as const,
        working_directory: join(TEST_AGENTS_DIR, "skills-dir-test"),
        heartbeat_interval: 10800,
        memory_mode: "shared" as const,
      };

      await createAgent(agentData, TEST_CONFIG_PATH);

      // Verify .claude/skills directory was created
      const skillsDir = join(agentData.working_directory, ".claude", "skills");
      expect(existsSync(skillsDir)).toBe(true);
    });
  });

  describe("Remove Agent", () => {
    it("should remove agent from config", async () => {
      const config = {
        workspace: {
          path: TEST_AGENTS_DIR,
          skills_path: join(TEST_DIR, "skills"),
        },
        channels: {},
        agents: {
          "to-remove": {
            name: "Agent to Remove",
            provider: "anthropic",
            model: "sonnet",
            working_directory: join(TEST_AGENTS_DIR, "to-remove"),
            heartbeat_interval: 10800,
            memory_mode: "shared",
          },
        },
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      await removeAgent("to-remove", TEST_CONFIG_PATH);

      // Verify agent was removed from config
      const updatedConfig = yaml.parse(readFileSync(TEST_CONFIG_PATH, "utf-8"));
      expect(updatedConfig.agents["to-remove"]).toBeUndefined();
    });

    it("should throw error if agent does not exist", async () => {
      const config = {
        workspace: {
          path: TEST_AGENTS_DIR,
          skills_path: join(TEST_DIR, "skills"),
        },
        channels: {},
        agents: {},
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      expect(async () => {
        await removeAgent("nonexistent", TEST_CONFIG_PATH);
      }).toThrow();
    });
  });
});
