/**
 * Session ID persistence for TurboClaw agents.
 *
 * Reads and writes agent session IDs to ~/.turboclaw/sessions.yaml using
 * the `yaml` package for serialisation. Each agent gets a UUID that persists
 * across daemon restarts so Claude can resume the same conversation.
 */

import { parse, stringify } from "yaml";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const DEFAULT_SESSIONS_FILE = path.join(os.homedir(), ".turboclaw", "sessions.yaml");

/**
 * Read the session ID for a given agent from the sessions YAML file.
 *
 * @param agentId - The agent identifier to look up.
 * @param sessionsFile - Path to the sessions YAML file. Defaults to ~/.turboclaw/sessions.yaml.
 * @returns The stored UUID string, or null if the file does not exist or the agent has no entry.
 */
export function readSessionId(agentId: string, sessionsFile = DEFAULT_SESSIONS_FILE): string | null {
  if (!fs.existsSync(sessionsFile)) {
    return null;
  }

  const raw = fs.readFileSync(sessionsFile, "utf-8");
  const data = parse(raw);

  if (!data || typeof data !== "object") {
    return null;
  }

  const value = (data as Record<string, unknown>)[agentId];
  return typeof value === "string" ? value : null;
}

/**
 * Write or update the session ID for a given agent in the sessions YAML file.
 * Creates parent directories and the file if they do not already exist.
 * Preserves existing entries for other agents.
 *
 * @param agentId - The agent identifier whose session ID should be persisted.
 * @param sessionId - The UUID to store.
 * @param sessionsFile - Path to the sessions YAML file. Defaults to ~/.turboclaw/sessions.yaml.
 * @returns void
 */
export function writeSessionId(agentId: string, sessionId: string, sessionsFile = DEFAULT_SESSIONS_FILE): void {
  const dir = path.dirname(sessionsFile);
  fs.mkdirSync(dir, { recursive: true });

  let data: Record<string, string> = {};

  if (fs.existsSync(sessionsFile)) {
    const raw = fs.readFileSync(sessionsFile, "utf-8");
    const parsed = parse(raw);
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, string>;
    }
  }

  data[agentId] = sessionId;

  fs.writeFileSync(sessionsFile, stringify(data), "utf-8");
}

/**
 * Return the existing session ID for an agent, or generate and persist a new
 * UUID v4 if none exists yet.
 *
 * @param agentId - The agent identifier to look up or create.
 * @param sessionsFile - Path to the sessions YAML file. Defaults to ~/.turboclaw/sessions.yaml.
 * @returns The UUID string for the agent.
 */
export function getOrCreateSessionId(agentId: string, sessionsFile = DEFAULT_SESSIONS_FILE): string {
  const existing = readSessionId(agentId, sessionsFile);
  if (existing !== null) {
    return existing;
  }

  const newId = randomUUID();
  writeSessionId(agentId, newId, sessionsFile);
  return newId;
}
