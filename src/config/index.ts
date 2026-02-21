import { z } from "zod";
import * as yaml from "yaml";
import { readFileSync } from "fs";
import { extname, join } from "path";
import * as os from "os";

// Model shorthand mapping
const MODEL_SHORTHANDS: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

/**
 * Expand ~ at the start of a path to the home directory
 */
export function expandPath(path: string): string {
  if (path === "~") {
    return os.homedir();
  }
  if (path.startsWith("~/")) {
    return join(os.homedir(), path.slice(2));
  }
  return path;
}

/**
 * Replace the home directory prefix with ~ for portable, readable config storage
 */
export function unexpandPath(path: string): string {
  const home = os.homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~/" + path.slice(home.length + 1);
  return path;
}

/**
 * Expand model shorthand to full model ID
 * Case-insensitive matching for opus, sonnet, haiku
 */
export function expandModelShorthand(model: string): string {
  const lowercased = model.toLowerCase();
  return MODEL_SHORTHANDS[lowercased] ?? model;
}

// Zod Schema for Configuration
export const ConfigSchema = z
  .object({
    workspace: z.object({
      path: z.string(),
    }),
    allowed_users: z.array(z.number()).optional(),
    skill_directories: z
      .array(z.string())
      .optional()
      .transform((val) => val ?? []),
    providers: z
      .record(
        z.string(),
        z.object({
          api_key: z.string().optional(),
          base_url: z.string().optional(),
        })
      )
      .nullable()
      .optional()
      .transform((val) => val ?? {}),
    agents: z
      .record(
        z.string(),
        z.object({
          name: z.string(),
          provider: z.string(),
          model: z.string(),
          working_directory: z.string(),
          heartbeat_interval: z.union([z.number(), z.literal(false)]).optional(),
          memory_mode: z.enum(["shared", "isolated"]).optional(),
          telegram: z
            .object({
              bot_token: z.string(),
              chat_id: z.number().optional(),
            })
            .optional(),
        })
      )
      .nullable()
      .optional()
      .transform((val) => val ?? {}),
    transcription: z
      .object({
        enabled: z.boolean(),
        provider: z.string(),
        model: z.string(),
        retain_audio: z.boolean(),
      })
      .optional(),
  });

export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedTranscriptionConfig {
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
  retain_audio: boolean;
}

/**
 * Resolve transcription config by looking up provider credentials from the providers map.
 * @throws Error if provider not found in providers map
 */
export function resolveTranscriptionConfig(
  transcription: { enabled: boolean; provider: string; model: string; retain_audio: boolean },
  providers: Record<string, { api_key?: string; base_url?: string }>
): ResolvedTranscriptionConfig {
  const providerConfig = providers[transcription.provider];
  if (!providerConfig) {
    throw new Error(`Transcription provider '${transcription.provider}' not found in providers config`);
  }
  return {
    enabled: transcription.enabled,
    base_url: providerConfig.base_url ?? "",
    api_key: providerConfig.api_key ?? "",
    model: transcription.model,
    retain_audio: transcription.retain_audio,
  };
}

/**
 * Load configuration from YAML or JSON file
 * @param configPath Path to config file
 * @returns Validated configuration object with paths expanded
 * @throws Error if file doesn't exist, is invalid YAML/JSON, or fails schema validation
 */
export async function loadConfig(configPath: string): Promise<Config> {
  // Read file content
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read config file: ${configPath}`);
  }

  // Parse based on file extension
  let rawConfig: unknown;
  const ext = extname(configPath);

  try {
    if (ext === ".yaml" || ext === ".yml") {
      rawConfig = yaml.parse(content);
    } else if (ext === ".json") {
      rawConfig = JSON.parse(content);
    } else {
      throw new Error(`Unsupported config file format: ${ext}. Use .yaml or .json`);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse config file: ${error.message}`);
    }
    throw error;
  }

  // Validate against schema
  const result = ConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  const config = result.data;

  // Expand paths and model shorthands
  config.workspace.path = expandPath(config.workspace.path);
  config.skill_directories = config.skill_directories.map(expandPath);

  for (const agentId of Object.keys(config.agents)) {
    const agent = config.agents[agentId];
    agent.working_directory = expandPath(agent.working_directory);
    agent.model = expandModelShorthand(agent.model);
  }

  return config;
}
