import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig, ConfigSchema, expandPath, expandModelShorthand, type Config } from "../src/config/index";
import * as yaml from "yaml";
import * as os from "os";

const TEST_CONFIG_DIR = join(import.meta.dir, ".test-config");
const TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, "config.yaml");

describe("Configuration System", () => {
  beforeEach(() => {
    // Create test directory
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  describe("Config Schema - New Shape", () => {
    it("should validate a minimal valid configuration", () => {
      const validConfig = {
        workspace: {
          path: "~/.turboclaw/workspaces",
        },
        providers: {
          anthropic: {},
        },
        agents: {},
      };

      const result = ConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it("should validate a full configuration with all fields", () => {
      const fullConfig = {
        workspace: {
          path: "~/.turboclaw/workspaces",
        },
        allowed_users: [123456789, 987654321],
        providers: {
          anthropic: {
            api_key: "sk-ant-test-key",
            base_url: "https://api.anthropic.com",
          },
          mistral: {
            api_key: "sk-m-test",
            base_url: "https://api.mistral.ai/v1",
          },
        },
        agents: {
          coder: {
            name: "Code Assistant",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "~/.turboclaw/workspaces/coder",
            heartbeat: {
              interval: 10800,
              telegram_chat_id: 123456789,
            },
            memory_mode: "isolated",
            telegram: {
              bot_token: "123456:ABC-DEF",
            },
          },
        },
        transcription: {
          enabled: true,
          provider: "mistral",
          model: "voxtral-mini-latest",
          retain_audio: false,
        },
      };

      const result = ConfigSchema.safeParse(fullConfig);
      expect(result.success).toBe(true);
    });

    it("should validate agent with telegram config (bot_token only)", () => {
      const config = {
        workspace: { path: "/tmp/workspace" },
        providers: { anthropic: {} },
        agents: {
          assistant: {
            name: "Assistant",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/assistant",
            telegram: {
              bot_token: "token123",
            },
          },
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents.assistant.telegram?.bot_token).toBe("token123");
      }
    });

    it("should validate allowed_users as array of numbers", () => {
      const config = {
        workspace: { path: "/tmp" },
        allowed_users: [111, 222, 333],
        providers: {},
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed_users).toEqual([111, 222, 333]);
      }
    });

    it("should allow allowed_users to be omitted (defaults to empty array or undefined)", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should allow empty allowed_users array", () => {
      const config = {
        workspace: { path: "/tmp" },
        allowed_users: [],
        providers: {},
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should default agents to {} when null", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: null,
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents).toEqual({});
      }
    });

    it("should default providers to {} when null", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: null,
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providers).toEqual({});
      }
    });
  });

  describe("Config Schema - Rejection Cases", () => {
    it("should reject config missing workspace.path", () => {
      const invalidConfig = {
        workspace: {},
        providers: {},
        agents: {},
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject config with non-string workspace.path", () => {
      const invalidConfig = {
        workspace: { path: 123 },
        providers: {},
        agents: {},
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject allowed_users with non-number elements", () => {
      const invalidConfig = {
        workspace: { path: "/tmp" },
        allowed_users: ["not-a-number", 123],
        providers: {},
        agents: {},
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject agent missing required name", () => {
      const invalidConfig = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          broken: {
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/broken",
          },
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject agent missing required provider", () => {
      const invalidConfig = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          broken: {
            name: "Broken",
            model: "sonnet",
            working_directory: "/tmp/broken",
          },
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject agent missing required model", () => {
      const invalidConfig = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          broken: {
            name: "Broken",
            provider: "anthropic",
            working_directory: "/tmp/broken",
          },
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject agent missing required working_directory", () => {
      const invalidConfig = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          broken: {
            name: "Broken",
            provider: "anthropic",
            model: "sonnet",
          },
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject agent with invalid memory_mode", () => {
      const invalidConfig = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          broken: {
            name: "Broken",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/broken",
            memory_mode: "invalid_mode",
          },
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });

    it("should reject telegram config missing bot_token", () => {
      const invalidConfig = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          broken: {
            name: "Broken",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/broken",
            telegram: {
              // Missing bot_token - should fail
            },
          },
        },
      };

      const result = ConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
  });

  describe("Config Schema - Removed Fields", () => {
    it("should NOT require workspace.skills_path (removed)", () => {
      const config = {
        workspace: {
          path: "/tmp/workspace",
          // skills_path intentionally omitted
        },
        providers: {},
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should NOT have channels section (removed) — old key is stripped, not rejected", () => {
      const config = {
        workspace: { path: "/tmp" },
        channels: {
          telegram: { enabled: true, bot_token: "test" },
        },
        providers: {},
        agents: {},
      };

      // Without .strict(), channels should be stripped silently and validation succeeds
      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true); // must pass — schema is not strict
      if (result.success) {
        expect((result.data as any).channels).toBeUndefined();
      }
    });

    it("should NOT have files section (removed) — old key is stripped, not rejected", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {},
        files: { retention_days: 7 },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true); // must pass — schema is not strict
      if (result.success) {
        expect((result.data as any).files).toBeUndefined();
      }
    });

    it("should NOT have conversations section (removed) — old key is stripped, not rejected", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {},
        conversations: { cleanup_days: 14, nightly_consolidation: true },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true); // must pass — schema is not strict
      if (result.success) {
        expect((result.data as any).conversations).toBeUndefined();
      }
    });
  });

  describe("Path Expansion", () => {
    it("should expand ~ to home directory", () => {
      const homeDir = os.homedir();
      expect(expandPath("~/Documents/AI")).toBe(join(homeDir, "Documents/AI"));
    });

    it("should expand ~ at start of path only", () => {
      const homeDir = os.homedir();
      expect(expandPath("~/test")).toBe(join(homeDir, "test"));
      expect(expandPath("/not/~/expanded")).toBe("/not/~/expanded");
    });

    it("should handle paths without ~", () => {
      expect(expandPath("/absolute/path")).toBe("/absolute/path");
      expect(expandPath("relative/path")).toBe("relative/path");
    });

    it("should handle ~ alone", () => {
      const homeDir = os.homedir();
      expect(expandPath("~")).toBe(homeDir);
    });
  });

  describe("Model Shorthand Expansion", () => {
    it("should expand opus to full model ID", () => {
      expect(expandModelShorthand("opus")).toBe("claude-opus-4-6");
    });

    it("should expand sonnet to full model ID", () => {
      expect(expandModelShorthand("sonnet")).toBe("claude-sonnet-4-5-20250929");
    });

    it("should expand haiku to full model ID", () => {
      expect(expandModelShorthand("haiku")).toBe("claude-haiku-4-5-20251001");
    });

    it("should pass through full model IDs unchanged", () => {
      expect(expandModelShorthand("claude-3-opus-20240229")).toBe("claude-3-opus-20240229");
      expect(expandModelShorthand("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5-20250929");
      expect(expandModelShorthand("custom-model-name")).toBe("custom-model-name");
    });

    it("should be case-insensitive for shortcuts", () => {
      expect(expandModelShorthand("OPUS")).toBe("claude-opus-4-6");
      expect(expandModelShorthand("Sonnet")).toBe("claude-sonnet-4-5-20250929");
      expect(expandModelShorthand("HAIKU")).toBe("claude-haiku-4-5-20251001");
    });
  });

  describe("Config Loader", () => {
    it("should load a valid YAML config", async () => {
      const config = {
        workspace: {
          path: "/tmp/workspace",
        },
        providers: {
          anthropic: {
            api_key: "test-key",
          },
        },
        agents: {
          test: {
            name: "Test Agent",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/test",
            telegram: {
              bot_token: "token",
            },
          },
        },
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.workspace.path).toBe("/tmp/workspace");
      expect(loaded.agents.test.name).toBe("Test Agent");
    });

    it("should load a valid JSON config", async () => {
      const config = {
        workspace: {
          path: "/tmp/workspace",
        },
        providers: {},
        agents: {},
      };

      const jsonPath = join(TEST_CONFIG_DIR, "config.json");
      writeFileSync(jsonPath, JSON.stringify(config, null, 2));

      const loaded = await loadConfig(jsonPath);
      expect(loaded.workspace.path).toBe("/tmp/workspace");
    });

    it("should expand ~ paths in workspace.path", async () => {
      const homeDir = os.homedir();
      const config = {
        workspace: {
          path: "~/.turboclaw/workspaces",
        },
        providers: {},
        agents: {},
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.workspace.path).toBe(join(homeDir, ".turboclaw/workspaces"));
    });

    it("should expand ~ paths in agent working_directory", async () => {
      const homeDir = os.homedir();
      const config = {
        workspace: {
          path: "/tmp/workspace",
        },
        providers: {},
        agents: {
          coder: {
            name: "Coder",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "~/.turboclaw/workspaces/coder",
            telegram: {
              bot_token: "token",
            },
          },
        },
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.agents.coder.working_directory).toBe(
        join(homeDir, ".turboclaw/workspaces/coder")
      );
    });

    it("should expand model shorthands in agents", async () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          opus_agent: {
            name: "Opus Agent",
            provider: "anthropic",
            model: "opus",
            working_directory: "/tmp/opus",
            telegram: { bot_token: "t" },
          },
          sonnet_agent: {
            name: "Sonnet Agent",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/sonnet",
            telegram: { bot_token: "t" },
          },
          haiku_agent: {
            name: "Haiku Agent",
            provider: "anthropic",
            model: "haiku",
            working_directory: "/tmp/haiku",
            telegram: { bot_token: "t" },
          },
        },
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.agents.opus_agent.model).toBe("claude-opus-4-6");
      expect(loaded.agents.sonnet_agent.model).toBe("claude-sonnet-4-5-20250929");
      expect(loaded.agents.haiku_agent.model).toBe("claude-haiku-4-5-20251001");
    });

    it("should throw error for missing config file", async () => {
      const nonexistentPath = join(TEST_CONFIG_DIR, "nonexistent.yaml");

      await expect(loadConfig(nonexistentPath)).rejects.toThrow();
    });

    it("should throw error for invalid YAML syntax", async () => {
      writeFileSync(TEST_CONFIG_PATH, "invalid: yaml: [[[");

      await expect(loadConfig(TEST_CONFIG_PATH)).rejects.toThrow();
    });

    it("should throw error for config failing schema validation", async () => {
      const invalidConfig = {
        workspace: {
          // Missing path
        },
        providers: {},
        agents: {},
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(invalidConfig));

      await expect(loadConfig(TEST_CONFIG_PATH)).rejects.toThrow();
    });

    it("should handle null agents gracefully", async () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: null,
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.agents).toEqual({});
    });

    it("should handle null providers gracefully", async () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: null,
        agents: {},
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.providers).toEqual({});
    });
  });

  describe("Complete Example Config from Plan", () => {
    it("should validate the exact example config from SLIM_REWRITE.md", () => {
      // This is the exact config structure from the rewrite plan, updated for Phase 14
      const exampleConfig = {
        workspace: {
          path: "~/.turboclaw/workspaces",
        },
        allowed_users: [123456789],
        providers: {
          anthropic: {
            api_key: "sk-ant-...",
            base_url: "https://...",
          },
          mistral: {
            api_key: "sk-m-...",
            base_url: "https://api.mistral.ai/v1",
          },
        },
        agents: {
          coder: {
            name: "Code Assistant",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "~/.turboclaw/workspaces/coder",
            heartbeat: {
              interval: 10800,
            },
            memory_mode: "isolated",
            telegram: {
              bot_token: "123456:ABC...",
            },
          },
        },
        transcription: {
          enabled: true,
          provider: "mistral",
          model: "voxtral-mini-latest",
          retain_audio: false,
        },
      };

      const result = ConfigSchema.safeParse(exampleConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workspace.path).toBe("~/.turboclaw/workspaces");
        expect(result.data.allowed_users).toEqual([123456789]);
        expect(result.data.agents.coder.telegram?.bot_token).toBe("123456:ABC...");
        expect(result.data.agents.coder.memory_mode).toBe("isolated");
        expect((result.data.transcription as any)?.provider).toBe("mistral");
        expect(result.data.transcription?.model).toBe("voxtral-mini-latest");
      }
    });
  });

  describe("Agent Telegram Config", () => {
    it("should accept telegram config with only bot_token (chat_id removed)", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          test: {
            name: "Test",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/test",
            telegram: {
              bot_token: "token",
            },
          },
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents.test.telegram?.bot_token).toBe("token");
      }
    });

    it("should allow agent without telegram config", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          headless: {
            name: "Headless Agent",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/headless",
            // No telegram config - should be valid for scheduled-only agents
          },
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });

  describe("Provider Config", () => {
    it("should allow provider with api_key only", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {
          anthropic: {
            api_key: "sk-ant-test",
          },
        },
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should allow provider with base_url only", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {
          anthropic: {
            base_url: "https://custom.api.endpoint",
          },
        },
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should allow empty provider config (uses env vars)", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {
          anthropic: {},
        },
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should allow multiple providers", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {
          anthropic: { api_key: "sk-ant" },
          openai: { api_key: "sk-oai", base_url: "https://api.openai.com" },
        },
        agents: {},
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providers.anthropic.api_key).toBe("sk-ant");
        expect(result.data.providers.openai.api_key).toBe("sk-oai");
      }
    });
  });

  describe("Transcription Config", () => {
    it("should validate complete transcription config with provider reference (new format)", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {
          mistral: { api_key: "sk-m", base_url: "https://api.mistral.ai/v1" },
        },
        agents: {},
        transcription: {
          enabled: true,
          provider: "mistral",
          model: "voxtral-mini-latest",
          retain_audio: false,
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should allow transcription to be omitted", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {},
        // transcription omitted
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should reject incomplete transcription config (missing provider)", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {},
        transcription: {
          enabled: true,
          // provider and model missing
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should validate transcription config with provider reference", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {
          mistral: { api_key: "sk-m", base_url: "https://api.mistral.ai/v1" },
        },
        agents: {},
        transcription: {
          enabled: true,
          provider: "mistral",
          model: "voxtral-mini-latest",
          retain_audio: false,
        },
      };
      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should reject transcription config with base_url and api_key (old format)", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {},
        transcription: {
          enabled: true,
          base_url: "https://api.openai.com/v1",
          api_key: "sk-test",
          model: "whisper-1",
          retain_audio: false,
        },
      };
      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(false); // old format rejected
    });
  });

  describe("Config Loader — Phase 13 edge cases", () => {
    it("config with empty agents object {} loads without error", async () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {},
      };

      writeFileSync(TEST_CONFIG_PATH, yaml.stringify(config));

      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.agents).toEqual({});
    });

    it("config with no agents key at all loads without error", async () => {
      // Write raw YAML without agents key
      const rawYaml = `workspace:\n  path: /tmp\nproviders: {}\n`;
      writeFileSync(TEST_CONFIG_PATH, rawYaml);

      // The schema allows agents to be null/absent and transforms it to {}
      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.agents).toEqual({});
    });

    it("config with no providers key loads without error", async () => {
      // Write raw YAML without providers key
      const rawYaml = `workspace:\n  path: /tmp\nagents: {}\n`;
      writeFileSync(TEST_CONFIG_PATH, rawYaml);

      // The schema allows providers to be null/absent and transforms it to {}
      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.providers).toEqual({});
    });

    it("config with null provider value gives a helpful error message (not a crash)", async () => {
      // YAML like: anthropic: null — provider value is null, which fails the record schema
      const rawYaml = `workspace:\n  path: /tmp\nproviders:\n  anthropic: null\nagents: {}\n`;
      writeFileSync(TEST_CONFIG_PATH, rawYaml);

      let errorMessage = "";
      try {
        await loadConfig(TEST_CONFIG_PATH);
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      // Should throw with a helpful error message, not an unhandled crash
      expect(errorMessage.length).toBeGreaterThan(0);
      // Error message should mention something about the config or the path — not be empty or generic
      const isHelpful =
        errorMessage.includes("config") ||
        errorMessage.includes("Invalid") ||
        errorMessage.includes("providers") ||
        errorMessage.includes("anthropic");
      expect(isHelpful).toBe(true);
    });

    it("loadConfig with invalid YAML syntax provides error message containing config path", async () => {
      // Write invalid YAML
      writeFileSync(TEST_CONFIG_PATH, "workspace: {unclosed bracket: [[[");

      let errorMessage = "";
      try {
        await loadConfig(TEST_CONFIG_PATH);
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      // Should contain path information or a descriptive message — not be empty
      expect(errorMessage.length).toBeGreaterThan(0);
      // The error message should be informative, either mentioning the path or "parse"
      const isInformative =
        errorMessage.includes(TEST_CONFIG_PATH) ||
        errorMessage.includes("parse") ||
        errorMessage.includes("Failed") ||
        errorMessage.includes("yaml") ||
        errorMessage.includes("YAML");
      expect(isInformative).toBe(true);
    });
  });

  describe("Heartbeat Config", () => {
    it("should accept heartbeat.interval as number", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          test: {
            name: "Test",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/test",
            heartbeat: { interval: 3600 },
          },
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents.test.heartbeat?.interval).toBe(3600);
      }
    });

    it("should accept heartbeat.interval as false to disable", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          test: {
            name: "Test",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/test",
            heartbeat: { interval: false },
          },
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents.test.heartbeat?.interval).toBe(false);
      }
    });

    it("should allow heartbeat to be omitted", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          test: {
            name: "Test",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/test",
          },
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it("should accept heartbeat with active_hours and telegram_chat_id", () => {
      const config = {
        workspace: { path: "/tmp" },
        providers: {},
        agents: {
          test: {
            name: "Test",
            provider: "anthropic",
            model: "sonnet",
            working_directory: "/tmp/test",
            heartbeat: {
              interval: 10800,
              active_hours: "07:00-22:00",
              telegram_chat_id: 123456789,
            },
          },
        },
      };

      const result = ConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents.test.heartbeat?.active_hours).toBe("07:00-22:00");
        expect(result.data.agents.test.heartbeat?.telegram_chat_id).toBe(123456789);
      }
    });
  });

  describe("resolveTranscriptionConfig", () => {
    // resolveTranscriptionConfig is a Phase 14 function not yet implemented.
    // These tests will fail (red) until it is exported from src/config/index.ts.
    function getResolveTranscriptionConfig(): (
      transcription: { enabled: boolean; provider: string; model: string; retain_audio: boolean },
      providers: Record<string, { api_key?: string; base_url?: string }>
    ) => { enabled: boolean; base_url?: string; api_key?: string; model: string; retain_audio: boolean } {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("../src/config/index");
      if (typeof mod.resolveTranscriptionConfig !== "function") {
        throw new Error("resolveTranscriptionConfig is not exported from src/config/index.ts");
      }
      return mod.resolveTranscriptionConfig;
    }

    it("resolves base_url and api_key from providers map", () => {
      const resolveTranscriptionConfig = getResolveTranscriptionConfig();
      const transcription = {
        enabled: true,
        provider: "mistral",
        model: "voxtral-mini-latest",
        retain_audio: false,
      };
      const providers = {
        mistral: { api_key: "sk-m", base_url: "https://api.mistral.ai/v1" },
      };
      const resolved = resolveTranscriptionConfig(transcription, providers);
      expect(resolved.base_url).toBe("https://api.mistral.ai/v1");
      expect(resolved.api_key).toBe("sk-m");
      expect(resolved.model).toBe("voxtral-mini-latest");
      expect(resolved.enabled).toBe(true);
      expect(resolved.retain_audio).toBe(false);
    });

    it("throws if provider not found in providers map", () => {
      const resolveTranscriptionConfig = getResolveTranscriptionConfig();
      const transcription = {
        enabled: true,
        provider: "unknown",
        model: "m",
        retain_audio: false,
      };
      const providers = {};
      expect(() => resolveTranscriptionConfig(transcription, providers)).toThrow();
    });

    it("returns api_key when provider exists but has no base_url", () => {
      const resolveTranscriptionConfig = getResolveTranscriptionConfig();
      const transcription = {
        enabled: true,
        provider: "anthropic",
        model: "m",
        retain_audio: false,
      };
      const providers = { anthropic: { api_key: "sk-ant" } }; // no base_url
      // Test that it at least returns the api_key when base_url is absent
      const resolved = resolveTranscriptionConfig(transcription, providers);
      expect(resolved.api_key).toBe("sk-ant");
    });
  });

  describe("Old config compatibility", () => {
    it("config with 'channels' key loads successfully (old key stripped)", async () => {
      const rawYaml = `workspace:\n  path: /tmp\nproviders: {}\nagents: {}\nchannels:\n  telegram:\n    enabled: true\n`;
      writeFileSync(TEST_CONFIG_PATH, rawYaml);
      // Should NOT throw
      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect(loaded.workspace.path).toBe("/tmp");
      expect((loaded as any).channels).toBeUndefined();
    });

    it("config with 'files' key loads successfully (old key stripped)", async () => {
      const rawYaml = `workspace:\n  path: /tmp\nproviders: {}\nagents: {}\nfiles:\n  retention_days: 7\n`;
      writeFileSync(TEST_CONFIG_PATH, rawYaml);
      const loaded = await loadConfig(TEST_CONFIG_PATH);
      expect((loaded as any).files).toBeUndefined();
    });
  });
});
