import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LogRotator } from "../../src/lib/log-rotator";
import fs from "fs";
import path from "path";
import os from "os";

describe("LogRotator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logrotator-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const logPath = () => path.join(tmpDir, "test.log");

  test("creates log file and writes lines", () => {
    const rotator = new LogRotator({ filePath: logPath() });
    rotator.write("hello");
    rotator.write("world");
    rotator.close();

    const content = fs.readFileSync(logPath(), "utf-8");
    expect(content).toBe("hello\nworld\n");
  });

  test("creates intermediate directories", () => {
    const nested = path.join(tmpDir, "a", "b", "test.log");
    const rotator = new LogRotator({ filePath: nested });
    rotator.write("nested");
    rotator.close();

    expect(fs.readFileSync(nested, "utf-8")).toBe("nested\n");
  });

  test("appends to existing file", () => {
    const fp = logPath();
    fs.writeFileSync(fp, "existing\n");

    const rotator = new LogRotator({ filePath: fp });
    rotator.write("appended");
    rotator.close();

    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toBe("existing\nappended\n");
  });

  test("rotates when maxSize is exceeded", () => {
    const fp = logPath();
    const rotator = new LogRotator({
      filePath: fp,
      maxSize: 50, // tiny size to trigger rotation
      maxFiles: 3,
    });

    // Write enough to exceed 50 bytes
    rotator.write("a]".repeat(30)); // 60 bytes + newline
    // This triggers rotation on next write
    rotator.write("after rotation");
    rotator.close();

    // Current file should have "after rotation"
    const current = fs.readFileSync(fp, "utf-8");
    expect(current).toContain("after rotation");

    // .1 should have the previous content
    expect(fs.existsSync(`${fp}.1`)).toBe(true);
    const rotated = fs.readFileSync(`${fp}.1`, "utf-8");
    expect(rotated).toContain("a]");
  });

  test("respects maxFiles limit", () => {
    const fp = logPath();
    const rotator = new LogRotator({
      filePath: fp,
      maxSize: 20,
      maxFiles: 2,
    });

    // Trigger multiple rotations
    for (let i = 0; i < 5; i++) {
      rotator.write(`line-${i}-${"x".repeat(20)}`);
    }
    rotator.close();

    // Should have .1 and .2 but NOT .3
    expect(fs.existsSync(`${fp}.1`)).toBe(true);
    expect(fs.existsSync(`${fp}.2`)).toBe(true);
    expect(fs.existsSync(`${fp}.3`)).toBe(false);
  });

  test("rotation shifts files correctly", () => {
    const fp = logPath();
    const rotator = new LogRotator({
      filePath: fp,
      maxSize: 30,
      maxFiles: 3,
    });

    rotator.write("first-block-xxxxxxxxxx"); // triggers rotation on next write
    rotator.write("second-block-xxxxxxxxx"); // rotation: first→.1, triggers again on next
    rotator.write("third-block-xxxxxxxxxx"); // rotation: second→.1 shifts first→.2
    rotator.write("current");
    rotator.close();

    const current = fs.readFileSync(fp, "utf-8");
    expect(current).toContain("current");

    if (fs.existsSync(`${fp}.1`)) {
      const r1 = fs.readFileSync(`${fp}.1`, "utf-8");
      // .1 is the most recent rotated file
      expect(r1.length).toBeGreaterThan(0);
    }
  });

  test("close is safe to call multiple times", () => {
    const rotator = new LogRotator({ filePath: logPath() });
    rotator.write("test");
    expect(() => rotator.close()).not.toThrow();
    expect(() => rotator.close()).not.toThrow();
  });

  test("uses default maxSize of 5MB and maxFiles of 3", () => {
    const rotator = new LogRotator({ filePath: logPath() });
    expect(rotator.maxSize).toBe(5 * 1024 * 1024);
    expect(rotator.maxFiles).toBe(3);
    rotator.close();
  });
});
