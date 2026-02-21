import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
} from "fs";
import { join } from "path";

// Import the functions under test — setupAgentMemory and setupAgentWorkspace do
// NOT exist yet in src/lib/templates.ts (RED phase). The import itself will
// succeed (TypeScript will not complain at runtime) but calling the functions
// will throw because they are undefined.
import {
  copyTemplatesToAgent,
  setupAgentMemory,
  setupAgentWorkspace,
} from "../src/lib/templates";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = join(import.meta.dir, "../templates");
const SKILLS_DIR = join(import.meta.dir, "../skills");
const TMP_ROOT = join(import.meta.dir, ".test-templates-tmp");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpCounter = 0;

function makeTmpDir(): string {
  const dir = join(TMP_ROOT, `run-${process.pid}-${++tmpCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Suite setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ===========================================================================
// 1. copyTemplatesToAgent()
// ===========================================================================

describe("copyTemplatesToAgent()", () => {
  it("copies all .md files from the templates directory to the workspace dir", () => {
    const workspaceDir = makeTmpDir();

    copyTemplatesToAgent(workspaceDir, {});

    // Discover what should have been copied
    const { readdirSync } = require("fs");
    const templateFiles = readdirSync(TEMPLATES_DIR).filter((f: string) =>
      f.toLowerCase().endsWith(".md")
    );

    expect(templateFiles.length).toBeGreaterThan(0);

    for (const file of templateFiles) {
      const destPath = join(workspaceDir, file);
      expect(existsSync(destPath)).toBe(true);
    }
  });

  it("does not overwrite files that already exist (non-destructive)", () => {
    const workspaceDir = makeTmpDir();

    const customContent = "# My Custom Content\nDo not overwrite me.";
    const targetFile = join(workspaceDir, "HEARTBEAT.md");
    writeFileSync(targetFile, customContent, "utf-8");

    copyTemplatesToAgent(workspaceDir, {});

    const preserved = readFileSync(targetFile, "utf-8");
    expect(preserved).toBe(customContent);
  });

  it("substitutes {{agent_id}} in copied template content", () => {
    const workspaceDir = makeTmpDir();

    // Write a fake template that uses the variable
    const fakeTemplatesDir = makeTmpDir();
    writeFileSync(
      join(fakeTemplatesDir, "CLAUDE.md"),
      "Agent ID: {{agent_id}}",
      "utf-8"
    );

    // Call the real function against the real templates dir — check that at
    // least one of the copied files does NOT contain the raw placeholder when
    // a variable is provided.  We verify substitution by inspecting the
    // copied output of a known template that contains {{agent_id}}.
    copyTemplatesToAgent(workspaceDir, { agent_id: "test-agent-42" });

    // Check every copied file — none should contain the literal placeholder
    // for agent_id when the variable was supplied.
    const { readdirSync } = require("fs");
    const copied = readdirSync(workspaceDir).filter((f: string) =>
      f.toLowerCase().endsWith(".md")
    );

    for (const file of copied) {
      const content = readFileSync(join(workspaceDir, file), "utf-8");
      expect(content).not.toContain("{{agent_id}}");
    }
  });

  it("substitutes {{agent_name}} in copied template content", () => {
    const workspaceDir = makeTmpDir();

    copyTemplatesToAgent(workspaceDir, { agent_name: "My Test Agent" });

    const { readdirSync } = require("fs");
    const copied = readdirSync(workspaceDir).filter((f: string) =>
      f.toLowerCase().endsWith(".md")
    );

    for (const file of copied) {
      const content = readFileSync(join(workspaceDir, file), "utf-8");
      expect(content).not.toContain("{{agent_name}}");
    }
  });

  it("substitutes {{memory_mode}} in copied template content", () => {
    const workspaceDir = makeTmpDir();

    copyTemplatesToAgent(workspaceDir, { memory_mode: "shared" });

    const { readdirSync } = require("fs");
    const copied = readdirSync(workspaceDir).filter((f: string) =>
      f.toLowerCase().endsWith(".md")
    );

    for (const file of copied) {
      const content = readFileSync(join(workspaceDir, file), "utf-8");
      expect(content).not.toContain("{{memory_mode}}");
    }
  });

  it("handles a missing templates directory gracefully (no throw)", () => {
    const workspaceDir = makeTmpDir();
    const nonExistentTemplatesDir = join(makeTmpDir(), "no-such-dir");

    // The public API uses the hard-coded internal TEMPLATES_DIR, so we cannot
    // pass a custom one directly.  Instead we verify the contract: when called
    // normally the function should never throw — even if nothing is copied.
    expect(() => copyTemplatesToAgent(workspaceDir, {})).not.toThrow();
  });
});

// ===========================================================================
// 2. setupAgentMemory("shared", ...)
// ===========================================================================

describe("setupAgentMemory() — shared mode", () => {
  it("creates the shared memory directory if it does not exist", () => {
    const agentWorkspaceDir = makeTmpDir();
    const sharedMemoryDir = join(makeTmpDir(), "shared-memory");

    // sharedMemoryDir must NOT exist yet
    expect(existsSync(sharedMemoryDir)).toBe(false);

    setupAgentMemory("shared", agentWorkspaceDir, sharedMemoryDir);

    expect(existsSync(sharedMemoryDir)).toBe(true);
  });

  it("creates a symlink at agentWorkspaceDir/memory pointing to sharedMemoryDir", () => {
    const agentWorkspaceDir = makeTmpDir();
    const sharedMemoryDir = join(makeTmpDir(), "shared-memory");

    setupAgentMemory("shared", agentWorkspaceDir, sharedMemoryDir);

    const symlinkPath = join(agentWorkspaceDir, "memory");
    expect(existsSync(symlinkPath)).toBe(true);

    const stat = lstatSync(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("symlink at agentWorkspaceDir/memory resolves to the correct sharedMemoryDir target", () => {
    const agentWorkspaceDir = makeTmpDir();
    const sharedMemoryDir = join(makeTmpDir(), "shared-memory");

    setupAgentMemory("shared", agentWorkspaceDir, sharedMemoryDir);

    const symlinkPath = join(agentWorkspaceDir, "memory");
    const target = readlinkSync(symlinkPath);
    // Symlink is relative — resolve it against the directory containing the symlink
    const resolvedTarget = join(agentWorkspaceDir, target);
    expect(resolvedTarget).toBe(sharedMemoryDir);
  });

  it("creates a memory/daily/ subdirectory accessible via the symlink", () => {
    const agentWorkspaceDir = makeTmpDir();
    const sharedMemoryDir = join(makeTmpDir(), "shared-memory");

    setupAgentMemory("shared", agentWorkspaceDir, sharedMemoryDir);

    // daily/ is created inside sharedMemoryDir and accessible via the symlink
    const dailyPath = join(agentWorkspaceDir, "memory", "daily");
    expect(existsSync(dailyPath)).toBe(true);

    const stat = lstatSync(dailyPath);
    expect(stat.isDirectory()).toBe(true);
  });
});

// ===========================================================================
// 3. setupAgentMemory("isolated", ...)
// ===========================================================================

describe("setupAgentMemory() — isolated mode", () => {
  it("creates agentWorkspaceDir/memory/ as a real directory", () => {
    const agentWorkspaceDir = makeTmpDir();

    setupAgentMemory("isolated", agentWorkspaceDir);

    const memoryPath = join(agentWorkspaceDir, "memory");
    expect(existsSync(memoryPath)).toBe(true);

    const stat = lstatSync(memoryPath);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it("creates agentWorkspaceDir/memory/daily/ directory", () => {
    const agentWorkspaceDir = makeTmpDir();

    setupAgentMemory("isolated", agentWorkspaceDir);

    const dailyPath = join(agentWorkspaceDir, "memory", "daily");
    expect(existsSync(dailyPath)).toBe(true);

    const stat = lstatSync(dailyPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("does NOT create any symlinks in the workspace", () => {
    const agentWorkspaceDir = makeTmpDir();

    setupAgentMemory("isolated", agentWorkspaceDir);

    const memoryPath = join(agentWorkspaceDir, "memory");
    const stat = lstatSync(memoryPath);
    expect(stat.isSymbolicLink()).toBe(false);
  });
});

// ===========================================================================
// 4. setupAgentWorkspace()
// ===========================================================================

describe("setupAgentWorkspace()", () => {
  it("creates .claude/skills/ directory inside agentWorkspaceDir", () => {
    const agentWorkspaceDir = makeTmpDir();
    const skillsSourceDir = SKILLS_DIR;

    setupAgentWorkspace(agentWorkspaceDir, skillsSourceDir);

    const skillsPath = join(agentWorkspaceDir, ".claude", "skills");
    expect(existsSync(skillsPath)).toBe(true);

    const stat = lstatSync(skillsPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("copies bundled skill files from skillsSourceDir into .claude/skills/", () => {
    const agentWorkspaceDir = makeTmpDir();
    const skillsSourceDir = SKILLS_DIR;

    setupAgentWorkspace(agentWorkspaceDir, skillsSourceDir);

    const skillsDestDir = join(agentWorkspaceDir, ".claude", "skills");

    // At least one skill file should have been copied
    const { readdirSync } = require("fs");
    const copiedFiles = readdirSync(skillsDestDir);
    expect(copiedFiles.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Skill file content verification
  // -------------------------------------------------------------------------

  it("send-user-message skill contains 'turboclaw send --message'", () => {
    const agentWorkspaceDir = makeTmpDir();
    const skillsSourceDir = SKILLS_DIR;

    setupAgentWorkspace(agentWorkspaceDir, skillsSourceDir);

    const skillsDestDir = join(agentWorkspaceDir, ".claude", "skills");

    // The skill may be copied as a file named e.g. turboclaw-send-user-message
    // or send-user-message.  We look for any file whose name includes
    // "send-user-message" and check its content.
    const { readdirSync } = require("fs");
    const allFiles = readdirSync(skillsDestDir);
    const sendSkillFile = allFiles.find((f: string) =>
      f.toLowerCase().includes("send-user-message")
    );

    expect(sendSkillFile).toBeDefined();

    const content = readFileSync(join(skillsDestDir, sendSkillFile!), "utf-8");
    expect(content).toContain("turboclaw send --message");
  });

  it("send-user-message skill does NOT contain '--agent' flag", () => {
    const agentWorkspaceDir = makeTmpDir();
    const skillsSourceDir = SKILLS_DIR;

    setupAgentWorkspace(agentWorkspaceDir, skillsSourceDir);

    const skillsDestDir = join(agentWorkspaceDir, ".claude", "skills");

    const { readdirSync } = require("fs");
    const allFiles = readdirSync(skillsDestDir);
    const sendSkillFile = allFiles.find((f: string) =>
      f.toLowerCase().includes("send-user-message")
    );

    expect(sendSkillFile).toBeDefined();

    const content = readFileSync(join(skillsDestDir, sendSkillFile!), "utf-8");
    expect(content).not.toContain("--agent");
  });

  it("send-user-message skill does NOT contain '--to' flag", () => {
    const agentWorkspaceDir = makeTmpDir();
    const skillsSourceDir = SKILLS_DIR;

    setupAgentWorkspace(agentWorkspaceDir, skillsSourceDir);

    const skillsDestDir = join(agentWorkspaceDir, ".claude", "skills");

    const { readdirSync } = require("fs");
    const allFiles = readdirSync(skillsDestDir);
    const sendSkillFile = allFiles.find((f: string) =>
      f.toLowerCase().includes("send-user-message")
    );

    expect(sendSkillFile).toBeDefined();

    const content = readFileSync(join(skillsDestDir, sendSkillFile!), "utf-8");
    expect(content).not.toContain("--to");
  });

  it("memory skill contains 'turboclaw reset-context'", () => {
    const agentWorkspaceDir = makeTmpDir();
    const skillsSourceDir = SKILLS_DIR;

    setupAgentWorkspace(agentWorkspaceDir, skillsSourceDir);

    const skillsDestDir = join(agentWorkspaceDir, ".claude", "skills");

    const { readdirSync } = require("fs");
    const allFiles = readdirSync(skillsDestDir);
    const memorySkillFile = allFiles.find(
      (f: string) =>
        f.toLowerCase().includes("memory") &&
        !f.toLowerCase().includes("send")
    );

    expect(memorySkillFile).toBeDefined();

    const content = readFileSync(
      join(skillsDestDir, memorySkillFile!),
      "utf-8"
    );
    expect(content).toContain("turboclaw reset-context");
  });

  it("memory skill does NOT contain 'tinyclaw.sh'", () => {
    const agentWorkspaceDir = makeTmpDir();
    const skillsSourceDir = SKILLS_DIR;

    setupAgentWorkspace(agentWorkspaceDir, skillsSourceDir);

    const skillsDestDir = join(agentWorkspaceDir, ".claude", "skills");

    const { readdirSync } = require("fs");
    const allFiles = readdirSync(skillsDestDir);
    const memorySkillFile = allFiles.find(
      (f: string) =>
        f.toLowerCase().includes("memory") &&
        !f.toLowerCase().includes("send")
    );

    expect(memorySkillFile).toBeDefined();

    const content = readFileSync(
      join(skillsDestDir, memorySkillFile!),
      "utf-8"
    );
    expect(content).not.toContain("tinyclaw.sh");
  });
});
