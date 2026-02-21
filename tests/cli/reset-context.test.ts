import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// This import will fail if the file doesn't exist — intentionally RED
import { resetContextCommand } from "../../src/cli/commands/reset-context";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "turboclaw-reset-ctx-test-"));
}

// ----------------------------------------------------------------------------
// resetContextCommand tests
// ----------------------------------------------------------------------------

describe("resetContextCommand(args)", () => {
  let tmpDir: string;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir();

    // Spy on process.exit to prevent the test runner from actually exiting
    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a signal file at <resetDir>/<agentId> when agent ID is provided", async () => {
    const resetDir = join(tmpDir, "reset");

    await resetContextCommand(["coder"], resetDir);

    const signalFile = join(resetDir, "coder");
    expect(existsSync(signalFile)).toBe(true);
  });

  it("creates the reset directory if it does not exist", async () => {
    const resetDir = join(tmpDir, "new-reset-dir");

    // Directory should NOT exist before calling the command
    expect(existsSync(resetDir)).toBe(false);

    await resetContextCommand(["coder"], resetDir);

    expect(existsSync(resetDir)).toBe(true);
  });

  it("creates signal file for a different agent ID", async () => {
    const resetDir = join(tmpDir, "reset");

    await resetContextCommand(["writer"], resetDir);

    const signalFile = join(resetDir, "writer");
    expect(existsSync(signalFile)).toBe(true);
  });

  it("exits with code 1 when no agent ID is provided", async () => {
    const resetDir = join(tmpDir, "reset");

    await expect(resetContextCommand([], resetDir)).rejects.toThrow();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("does not create signal file when no agent ID is provided", async () => {
    const resetDir = join(tmpDir, "reset");

    try {
      await resetContextCommand([], resetDir);
    } catch {
      // expected — process.exit throws in our spy
    }

    // resetDir may or may not exist, but the signal file should not
    if (existsSync(resetDir)) {
      const { readdirSync } = await import("fs");
      const files = readdirSync(resetDir);
      expect(files.length).toBe(0);
    }
  });

  it("overwrites an existing signal file without error (idempotent)", async () => {
    const resetDir = join(tmpDir, "reset");

    // Call twice — should not throw
    await resetContextCommand(["coder"], resetDir);
    await expect(resetContextCommand(["coder"], resetDir)).resolves.not.toThrow();

    expect(existsSync(join(resetDir, "coder"))).toBe(true);
  });
});
