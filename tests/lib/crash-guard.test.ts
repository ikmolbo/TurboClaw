import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs";
import { CrashGuard, createDaemonCrashGuard } from "../../src/lib/crash-guard";

const TEST_DIR = path.join(os.tmpdir(), "turboclaw-test-crash-guard");

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ============================================================================
// recordCrash() TESTS
// ============================================================================

describe("recordCrash()", () => {
  test("creates crash log file on first crash", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    await guard.recordCrash();

    expect(fs.existsSync(path.join(TEST_DIR, "crash.log"))).toBe(true);
  });

  test("persists crash timestamp to JSON file", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    const before = Date.now();
    await guard.recordCrash();
    const after = Date.now();

    const content = JSON.parse(fs.readFileSync(crashLogPath, "utf-8"));
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(1);
    expect(content[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(content[0].timestamp).toBeLessThanOrEqual(after);
  });

  test("appends crash records on subsequent calls", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    await guard.recordCrash();
    await guard.recordCrash();
    await guard.recordCrash();

    const content = JSON.parse(fs.readFileSync(crashLogPath, "utf-8"));
    expect(content.length).toBe(3);
  });

  test("stores optional reason string in crash record", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    await guard.recordCrash("process exited with code 1");

    const content = JSON.parse(fs.readFileSync(crashLogPath, "utf-8"));
    expect(content[0].reason).toBe("process exited with code 1");
  });

  test("crash record without reason does not error", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    await guard.recordCrash();
  });
});

// ============================================================================
// shouldAllowRestart() TESTS
// ============================================================================

describe("shouldAllowRestart()", () => {
  test("returns { allowed: true } with no crashes recorded", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("returns { allowed: true } when crashes are below threshold", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    await guard.recordCrash();
    await guard.recordCrash();
    await guard.recordCrash();
    await guard.recordCrash();

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("returns { allowed: false, reason: string } after 5 crashes within window", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    await guard.recordCrash();
    await guard.recordCrash();
    await guard.recordCrash();
    await guard.recordCrash();
    await guard.recordCrash();

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  test("reason string mentions crash count when blocked", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    for (let i = 0; i < 5; i++) await guard.recordCrash();

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("5");
  });

  test("reason string mentions window duration when blocked", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    for (let i = 0; i < 5; i++) await guard.recordCrash();

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("15");
  });

  test("crashes outside the time window do NOT count toward threshold", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    // Write 5 crashes that are 20 minutes old (outside the 15-minute window)
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const oldCrashes = Array.from({ length: 5 }, (_, i) => ({
      timestamp: twentyMinutesAgo + i * 1000,
      reason: "old crash",
    }));
    fs.writeFileSync(crashLogPath, JSON.stringify(oldCrashes, null, 2), "utf-8");

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("only recent crashes count — mix of old and new", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    // 4 old crashes (outside window) + 4 recent crashes = 4 recent, still under threshold
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const mixed = [
      { timestamp: twentyMinutesAgo, reason: "old" },
      { timestamp: twentyMinutesAgo + 1000, reason: "old" },
      { timestamp: twentyMinutesAgo + 2000, reason: "old" },
      { timestamp: twentyMinutesAgo + 3000, reason: "old" },
    ];
    fs.writeFileSync(crashLogPath, JSON.stringify(mixed, null, 2), "utf-8");

    await guard.recordCrash("recent");
    await guard.recordCrash("recent");
    await guard.recordCrash("recent");
    await guard.recordCrash("recent");

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("handles missing crash log file gracefully (fresh start)", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "nonexistent.log"),
    });

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("handles empty crash log file gracefully", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    fs.writeFileSync(crashLogPath, "[]", "utf-8");

    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("exactly 5 crashes triggers the block (boundary condition)", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    for (let i = 0; i < 5; i++) await guard.recordCrash();

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(false);
  });

  test("4 crashes does NOT trigger the block (boundary condition)", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    for (let i = 0; i < 4; i++) await guard.recordCrash();

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });
});

// ============================================================================
// clearCrashes() TESTS
// ============================================================================

describe("clearCrashes()", () => {
  test("resets crash log so shouldAllowRestart returns true again", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    for (let i = 0; i < 5; i++) await guard.recordCrash();

    const blocked = await guard.shouldAllowRestart();
    expect(blocked.allowed).toBe(false);

    await guard.clearCrashes();

    const allowed = await guard.shouldAllowRestart();
    expect(allowed.allowed).toBe(true);
  });

  test("persists empty state to crash log file", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    await guard.recordCrash();
    await guard.recordCrash();
    await guard.clearCrashes();

    const content = JSON.parse(fs.readFileSync(crashLogPath, "utf-8"));
    expect(content).toEqual([]);
  });

  test("subsequent crashes after clear start fresh", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    for (let i = 0; i < 5; i++) await guard.recordCrash();
    await guard.clearCrashes();

    // Record 4 crashes after clear — should still be allowed
    for (let i = 0; i < 4; i++) await guard.recordCrash();

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("does not error when crash log does not exist yet", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "no-file-yet.log"),
    });

    await guard.clearCrashes();
  });
});

// ============================================================================
// getStats() TESTS
// ============================================================================

describe("getStats()", () => {
  test("returns { total: 0, recent: 0 } when no crashes recorded", () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    const stats = guard.getStats();
    expect(stats.total).toBe(0);
    expect(stats.recent).toBe(0);
  });

  test("total reflects all crashes ever recorded", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    // Write 3 old crashes directly (outside window) and record 2 recent ones
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const old = [
      { timestamp: twentyMinutesAgo },
      { timestamp: twentyMinutesAgo + 1000 },
      { timestamp: twentyMinutesAgo + 2000 },
    ];
    fs.writeFileSync(crashLogPath, JSON.stringify(old, null, 2), "utf-8");

    await guard.recordCrash();
    await guard.recordCrash();

    const stats = guard.getStats();
    expect(stats.total).toBe(5);
  });

  test("recent only counts crashes within the time window", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    // Write 3 old crashes (outside window)
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const old = [
      { timestamp: twentyMinutesAgo },
      { timestamp: twentyMinutesAgo + 1000 },
      { timestamp: twentyMinutesAgo + 2000 },
    ];
    fs.writeFileSync(crashLogPath, JSON.stringify(old, null, 2), "utf-8");

    // Record 2 recent crashes
    await guard.recordCrash();
    await guard.recordCrash();

    const stats = guard.getStats();
    expect(stats.recent).toBe(2);
  });

  test("total and recent match when all crashes are within window", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    await guard.recordCrash();
    await guard.recordCrash();
    await guard.recordCrash();

    const stats = guard.getStats();
    expect(stats.total).toBe(3);
    expect(stats.recent).toBe(3);
  });

  test("total is higher than recent when old crashes exist", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const old = [{ timestamp: twentyMinutesAgo }];
    fs.writeFileSync(crashLogPath, JSON.stringify(old, null, 2), "utf-8");

    await guard.recordCrash();

    const stats = guard.getStats();
    expect(stats.total).toBe(2);
    expect(stats.recent).toBe(1);
    expect(stats.total).toBeGreaterThan(stats.recent);
  });

  test("getStats() returns total 0 and recent 0 after clearCrashes()", async () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "crash.log"),
    });

    await guard.recordCrash();
    await guard.recordCrash();
    await guard.clearCrashes();

    const stats = guard.getStats();
    expect(stats.total).toBe(0);
    expect(stats.recent).toBe(0);
  });

  test("handles missing crash log file (returns zeros)", () => {
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath: path.join(TEST_DIR, "no-file-yet.log"),
    });

    const stats = guard.getStats();
    expect(stats.total).toBe(0);
    expect(stats.recent).toBe(0);
  });
});

// ============================================================================
// createDaemonCrashGuard() TESTS
// ============================================================================

describe("createDaemonCrashGuard()", () => {
  test("creates a CrashGuard instance", () => {
    const guard = createDaemonCrashGuard(TEST_DIR);
    expect(guard).toBeInstanceOf(CrashGuard);
  });

  test("uses default threshold of 5 crashes", async () => {
    const guard = createDaemonCrashGuard(TEST_DIR);

    for (let i = 0; i < 4; i++) await guard.recordCrash();
    const stillOk = await guard.shouldAllowRestart();
    expect(stillOk.allowed).toBe(true);

    await guard.recordCrash();
    const blocked = await guard.shouldAllowRestart();
    expect(blocked.allowed).toBe(false);
  });

  test("uses default window of 15 minutes", async () => {
    const guard = createDaemonCrashGuard(TEST_DIR);

    // Crashes from 20 minutes ago should not count
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const old = Array.from({ length: 5 }, (_, i) => ({
      timestamp: twentyMinutesAgo + i * 1000,
    }));
    fs.writeFileSync(crashLogPath, JSON.stringify(old, null, 2), "utf-8");

    const result = await guard.shouldAllowRestart();
    expect(result.allowed).toBe(true);
  });

  test("writes crash log into the provided base directory", async () => {
    const guard = createDaemonCrashGuard(TEST_DIR);
    await guard.recordCrash();

    // The crash log should be located inside TEST_DIR
    const files = fs.readdirSync(TEST_DIR);
    const logFile = files.find((f) => f.endsWith(".log") || f === "crash.log");
    expect(logFile).toBeDefined();
  });

  test("has working recordCrash, shouldAllowRestart, clearCrashes, getStats methods", async () => {
    const guard = createDaemonCrashGuard(TEST_DIR);

    await guard.recordCrash();
    await expect(guard.shouldAllowRestart()).resolves.toBeDefined();
    await guard.clearCrashes();
    expect(guard.getStats()).toBeDefined();
  });
});

// ============================================================================
// FILE FORMAT TESTS
// ============================================================================

describe("Crash log file format", () => {
  test("crash log is valid JSON array", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    await guard.recordCrash();

    const raw = fs.readFileSync(crashLogPath, "utf-8");
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(raw);
    }).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("each crash record has a numeric timestamp field", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    await guard.recordCrash();

    const content = JSON.parse(fs.readFileSync(crashLogPath, "utf-8"));
    expect(typeof content[0].timestamp).toBe("number");
  });

  test("handles corrupt crash log file gracefully (does not throw)", async () => {
    const crashLogPath = path.join(TEST_DIR, "crash.log");
    fs.writeFileSync(crashLogPath, "{ not valid json }", "utf-8");

    const guard = new CrashGuard({
      maxCrashes: 5,
      windowMs: 15 * 60 * 1000,
      crashLogPath,
    });

    // All operations should degrade gracefully, not throw
    await guard.recordCrash();
    await expect(guard.shouldAllowRestart()).resolves.toBeDefined();
    expect(() => guard.getStats()).not.toThrow();
  });
});
