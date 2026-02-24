/**
 * HAN-31: Session ID persistence tests
 *
 * RED phase — written before src/lib/sessions.ts exists.
 * All tests are expected to FAIL until the implementation is written.
 *
 * Tests cover:
 *   - readSessionId(agentId, sessionsFile?)
 *   - writeSessionId(agentId, sessionId, sessionsFile?)
 *   - getOrCreateSessionId(agentId, sessionsFile?)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Module under test
// Note: this import will fail at runtime until src/lib/sessions.ts is created.
// That IS the expected red-phase failure.
// ---------------------------------------------------------------------------

import {
  readSessionId,
  writeSessionId,
  getOrCreateSessionId,
} from "../../src/lib/sessions";

// ---------------------------------------------------------------------------
// UUID regex — standard 8-4-4-4-12 hex format
// ---------------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh unique temp directory for each test. */
function makeTmpSessionsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sessions-"));
  return path.join(dir, "sessions.yaml");
}

// ---------------------------------------------------------------------------
// Shared temp path — reset per test
// ---------------------------------------------------------------------------

let sessionsFile: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sessions-"));
  sessionsFile = path.join(tmpDir, "sessions.yaml");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// readSessionId
// ============================================================================

describe("readSessionId", () => {
  test("returns null when the sessions file does not exist", () => {
    // sessionsFile does not exist yet
    const result = readSessionId("coder", sessionsFile);
    expect(result).toBeNull();
  });

  test("returns the stored UUID for an agent that is in the file", () => {
    const uuid = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";
    const yaml = `coder: ${uuid}\nsupport: 8341c70a-f680-4ef2-96ac-cb055c51d94b\n`;
    fs.writeFileSync(sessionsFile, yaml, "utf-8");

    const result = readSessionId("coder", sessionsFile);
    expect(result).toBe(uuid);
  });

  test("returns null for an agent that is not in the file", () => {
    const yaml = `coder: c0fb47e4-1f0f-47f1-917d-5b4714f3a156\n`;
    fs.writeFileSync(sessionsFile, yaml, "utf-8");

    const result = readSessionId("support", sessionsFile);
    expect(result).toBeNull();
  });

  test("returns null when the sessions file is empty", () => {
    fs.writeFileSync(sessionsFile, "", "utf-8");

    const result = readSessionId("coder", sessionsFile);
    expect(result).toBeNull();
  });

  test("reads a session ID regardless of other agents present", () => {
    const supportUuid = "8341c70a-f680-4ef2-96ac-cb055c51d94b";
    const yaml = [
      `coder: c0fb47e4-1f0f-47f1-917d-5b4714f3a156`,
      `support: ${supportUuid}`,
      `reviewer: aaaabbbb-cccc-dddd-eeee-ffff00001111`,
    ].join("\n") + "\n";
    fs.writeFileSync(sessionsFile, yaml, "utf-8");

    expect(readSessionId("support", sessionsFile)).toBe(supportUuid);
  });
});

// ============================================================================
// writeSessionId
// ============================================================================

describe("writeSessionId", () => {
  test("creates the sessions file when it does not exist", () => {
    const uuid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
    writeSessionId("coder", uuid, sessionsFile);

    expect(fs.existsSync(sessionsFile)).toBe(true);
  });

  test("the newly created file contains the agent and UUID", () => {
    const uuid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
    writeSessionId("coder", uuid, sessionsFile);

    const content = fs.readFileSync(sessionsFile, "utf-8");
    expect(content).toContain("coder");
    expect(content).toContain(uuid);
  });

  test("adds a new agent entry without overwriting existing entries", () => {
    const existingUuid = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";
    const newUuid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

    fs.writeFileSync(sessionsFile, `coder: ${existingUuid}\n`, "utf-8");

    writeSessionId("support", newUuid, sessionsFile);

    // Original entry must still be readable
    const coderResult = readSessionId("coder", sessionsFile);
    expect(coderResult).toBe(existingUuid);

    // New entry must be present
    const supportResult = readSessionId("support", sessionsFile);
    expect(supportResult).toBe(newUuid);
  });

  test("updates an existing agent's session ID", () => {
    const originalUuid = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";
    const updatedUuid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

    fs.writeFileSync(sessionsFile, `coder: ${originalUuid}\n`, "utf-8");

    writeSessionId("coder", updatedUuid, sessionsFile);

    const result = readSessionId("coder", sessionsFile);
    expect(result).toBe(updatedUuid);
  });

  test("updating one agent does not affect other agents", () => {
    const coderUuid = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";
    const supportUuid = "8341c70a-f680-4ef2-96ac-cb055c51d94b";
    const updatedCoderUuid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

    const yaml = `coder: ${coderUuid}\nsupport: ${supportUuid}\n`;
    fs.writeFileSync(sessionsFile, yaml, "utf-8");

    writeSessionId("coder", updatedCoderUuid, sessionsFile);

    // Support must be unchanged
    expect(readSessionId("support", sessionsFile)).toBe(supportUuid);
  });

  test("creates parent directory if it does not exist", () => {
    const nestedFile = path.join(tmpDir, "nested", "dir", "sessions.yaml");
    const uuid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

    writeSessionId("coder", uuid, nestedFile);

    expect(fs.existsSync(nestedFile)).toBe(true);
    expect(readSessionId("coder", nestedFile)).toBe(uuid);
  });
});

// ============================================================================
// getOrCreateSessionId
// ============================================================================

describe("getOrCreateSessionId", () => {
  test("returns the existing UUID when agent is already in the file", () => {
    const existingUuid = "c0fb47e4-1f0f-47f1-917d-5b4714f3a156";
    fs.writeFileSync(sessionsFile, `coder: ${existingUuid}\n`, "utf-8");

    const result = getOrCreateSessionId("coder", sessionsFile);
    expect(result).toBe(existingUuid);
  });

  test("returns a string when agent is not yet in the file", () => {
    const result = getOrCreateSessionId("newagent", sessionsFile);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("generated UUID matches the standard UUID v4 format", () => {
    const result = getOrCreateSessionId("newagent", sessionsFile);
    expect(result).toMatch(UUID_REGEX);
  });

  test("generated UUID is persisted so subsequent calls return the same value", () => {
    const first = getOrCreateSessionId("newagent", sessionsFile);
    const second = getOrCreateSessionId("newagent", sessionsFile);
    expect(first).toBe(second);
  });

  test("creates the sessions file when it does not exist", () => {
    getOrCreateSessionId("newagent", sessionsFile);
    expect(fs.existsSync(sessionsFile)).toBe(true);
  });

  test("different agents get different UUIDs when created from scratch", () => {
    const id1 = getOrCreateSessionId("agent-alpha", sessionsFile);
    const id2 = getOrCreateSessionId("agent-beta", sessionsFile);
    expect(id1).not.toBe(id2);
  });

  test("works when the sessions file does not exist (no prior file needed)", () => {
    // Confirm there is genuinely no file before the call
    expect(fs.existsSync(sessionsFile)).toBe(false);

    const result = getOrCreateSessionId("fresh-agent", sessionsFile);
    expect(result).toMatch(UUID_REGEX);
    expect(fs.existsSync(sessionsFile)).toBe(true);
  });
});

// ============================================================================
// Multiple-agent coexistence
// ============================================================================

describe("multiple agents in sessions.yaml", () => {
  test("three agents can be written and read back independently", () => {
    const coderUuid = "aaaabbbb-0001-0001-0001-000000000001";
    const supportUuid = "aaaabbbb-0002-0002-0002-000000000002";
    const reviewerUuid = "aaaabbbb-0003-0003-0003-000000000003";

    writeSessionId("coder", coderUuid, sessionsFile);
    writeSessionId("support", supportUuid, sessionsFile);
    writeSessionId("reviewer", reviewerUuid, sessionsFile);

    expect(readSessionId("coder", sessionsFile)).toBe(coderUuid);
    expect(readSessionId("support", sessionsFile)).toBe(supportUuid);
    expect(readSessionId("reviewer", sessionsFile)).toBe(reviewerUuid);
  });

  test("getOrCreateSessionId handles multiple agents without cross-contamination", () => {
    const alpha = getOrCreateSessionId("alpha", sessionsFile);
    const beta = getOrCreateSessionId("beta", sessionsFile);
    const gamma = getOrCreateSessionId("gamma", sessionsFile);

    // All UUIDs must be valid
    expect(alpha).toMatch(UUID_REGEX);
    expect(beta).toMatch(UUID_REGEX);
    expect(gamma).toMatch(UUID_REGEX);

    // All must be unique
    const ids = new Set([alpha, beta, gamma]);
    expect(ids.size).toBe(3);

    // Re-reading must return the same values
    expect(getOrCreateSessionId("alpha", sessionsFile)).toBe(alpha);
    expect(getOrCreateSessionId("beta", sessionsFile)).toBe(beta);
    expect(getOrCreateSessionId("gamma", sessionsFile)).toBe(gamma);
  });
});
