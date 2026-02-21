import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as yaml from "yaml";
import {
  listSchedules,
  addSchedule,
  removeSchedule,
  toggleSchedule,
} from "../../src/cli/commands/schedule";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "turboclaw-schedule-test-"));
}

function writeTask(tasksDir: string, filename: string, data: object): void {
  writeFileSync(join(tasksDir, filename), yaml.stringify(data), "utf-8");
}

// ----------------------------------------------------------------------------
// Non-interactive addSchedule args format
// ["--name", "Daily Report", "--cron", "0 9 * * *", "--action", "agent-message",
//  "--agent", "coder", "--message", "Generate report"]
// ----------------------------------------------------------------------------

const nonInteractiveArgs = [
  "--name", "Daily Report",
  "--cron", "0 9 * * *",
  "--action", "agent-message",
  "--agent", "coder",
  "--message", "Generate report",
];

const nonInteractiveArgsWithCondition = [
  "--name", "Conditional Report",
  "--cron", "0 9 * * *",
  "--action", "agent-message",
  "--agent", "coder",
  "--message", "Generate report",
  "--condition", "test -f /tmp/ok",
];

// ----------------------------------------------------------------------------
// listSchedules
// ----------------------------------------------------------------------------

describe("listSchedules(tasksDir)", () => {
  let tasksDir: string;

  beforeEach(() => {
    tasksDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
  });

  it("completes without error when tasks directory is empty", async () => {
    await expect(listSchedules(tasksDir)).resolves.not.toThrow();
  });

  it("completes without error when tasks directory does not exist", async () => {
    const nonExistentDir = join(tasksDir, "does-not-exist");
    await expect(listSchedules(nonExistentDir)).resolves.not.toThrow();
  });

  it("completes without error when valid task files exist", async () => {
    writeTask(tasksDir, "daily-report.yaml", {
      name: "Daily Report",
      schedule: "0 9 * * *",
      action: {
        type: "agent-message",
        agent: "coder",
        message: "Generate report",
      },
      enabled: true,
    });

    await expect(listSchedules(tasksDir)).resolves.not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// addSchedule (non-interactive mode via args)
// ----------------------------------------------------------------------------

describe("addSchedule(tasksDir, args) — non-interactive mode", () => {
  let tasksDir: string;

  beforeEach(() => {
    tasksDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
  });

  it("creates a YAML file in tasksDir when all flags are provided", async () => {
    await addSchedule(tasksDir, nonInteractiveArgs);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("the created YAML file contains correct name field", async () => {
    await addSchedule(tasksDir, nonInteractiveArgs);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const filepath = join(tasksDir, files[0]);
    const content = yaml.parse(await Bun.file(filepath).text());

    expect(content.name).toBe("Daily Report");
  });

  it("the created YAML file contains correct schedule field", async () => {
    await addSchedule(tasksDir, nonInteractiveArgs);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const filepath = join(tasksDir, files[0]);
    const content = yaml.parse(await Bun.file(filepath).text());

    expect(content.schedule).toBe("0 9 * * *");
  });

  it("the created YAML file contains correct action object", async () => {
    await addSchedule(tasksDir, nonInteractiveArgs);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const filepath = join(tasksDir, files[0]);
    const content = yaml.parse(await Bun.file(filepath).text());

    expect(content.action.type).toBe("agent-message");
    expect(content.action.agent).toBe("coder");
    expect(content.action.message).toBe("Generate report");
  });

  it("stores condition in action when --condition flag is provided", async () => {
    await addSchedule(tasksDir, nonInteractiveArgsWithCondition);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const filepath = join(tasksDir, files[0]);
    const content = yaml.parse(await Bun.file(filepath).text());

    expect(content.action.condition).toBe("test -f /tmp/ok");
  });

  it("creates task without condition field when --condition is not provided", async () => {
    await addSchedule(tasksDir, nonInteractiveArgs);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const filepath = join(tasksDir, files[0]);
    const content = yaml.parse(await Bun.file(filepath).text());

    expect(content.action.condition).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// removeSchedule
// ----------------------------------------------------------------------------

describe("removeSchedule(taskName, tasksDir)", () => {
  let tasksDir: string;

  beforeEach(() => {
    tasksDir = makeTempDir();

    // Pre-populate with a task
    writeTask(tasksDir, "coder-daily-report.yaml", {
      name: "Daily Report",
      schedule: "0 9 * * *",
      action: {
        type: "agent-message",
        agent: "coder",
        message: "Generate report",
      },
      enabled: true,
    });
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
  });

  it("deletes the task file matching the given name", async () => {
    await removeSchedule("Daily Report", tasksDir);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    expect(files.length).toBe(0);
  });

  it("does not error when removing an existing task", async () => {
    await expect(removeSchedule("Daily Report", tasksDir)).resolves.not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// toggleSchedule
// ----------------------------------------------------------------------------

describe("toggleSchedule(taskName, enabled, tasksDir)", () => {
  let tasksDir: string;

  beforeEach(() => {
    tasksDir = makeTempDir();

    // Pre-populate with an enabled task
    writeTask(tasksDir, "coder-daily-report.yaml", {
      name: "Daily Report",
      schedule: "0 9 * * *",
      action: {
        type: "agent-message",
        agent: "coder",
        message: "Generate report",
      },
      enabled: true,
    });
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
  });

  it("sets enabled=false in the YAML file when toggling off", async () => {
    await toggleSchedule("Daily Report", false, tasksDir);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const filepath = join(tasksDir, files[0]);
    const content = yaml.parse(await Bun.file(filepath).text());

    expect(content.enabled).toBe(false);
  });

  it("sets enabled=true in the YAML file when toggling on", async () => {
    // First disable it
    writeTask(tasksDir, "coder-daily-report.yaml", {
      name: "Daily Report",
      schedule: "0 9 * * *",
      action: {
        type: "agent-message",
        agent: "coder",
        message: "Generate report",
      },
      enabled: false,
    });

    await toggleSchedule("Daily Report", true, tasksDir);

    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const filepath = join(tasksDir, files[0]);
    const content = yaml.parse(await Bun.file(filepath).text());

    expect(content.enabled).toBe(true);
  });

  it("does not error when toggling an existing task", async () => {
    await expect(toggleSchedule("Daily Report", false, tasksDir)).resolves.not.toThrow();
  });
});
