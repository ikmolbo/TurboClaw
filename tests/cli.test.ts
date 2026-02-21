import { describe, it, expect } from "bun:test";
import { parseArgs, type CLICommand } from "../src/cli/index";

describe("CLI", () => {
  describe("Argument Parsing — basic commands", () => {
    it("should parse start command", () => {
      const result = parseArgs(["start"]);
      expect(result.command).toBe("start");
      expect(result.args).toEqual([]);
    });

    it("should parse stop command", () => {
      const result = parseArgs(["stop"]);
      expect(result.command).toBe("stop");
      expect(result.args).toEqual([]);
    });

    it("should parse status command", () => {
      const result = parseArgs(["status"]);
      expect(result.command).toBe("status");
      expect(result.args).toEqual([]);
    });

    it("should parse agents command with no subcommand", () => {
      const result = parseArgs(["agents"]);
      expect(result.command).toBe("agents");
      expect(result.args).toEqual([]);
    });

    it("should parse agents command with list subcommand", () => {
      const result = parseArgs(["agents", "list"]);
      expect(result.command).toBe("agents");
      expect(result.args).toEqual(["list"]);
    });

    it("should parse schedule command with no subcommand", () => {
      const result = parseArgs(["schedule"]);
      expect(result.command).toBe("schedule");
      expect(result.args).toEqual([]);
    });

    it("should parse schedule command with add and flags", () => {
      const result = parseArgs(["schedule", "add", "--name", "foo"]);
      expect(result.command).toBe("schedule");
      expect(result.args).toEqual(["add", "--name", "foo"]);
    });

    it("should parse send command with no arguments", () => {
      const result = parseArgs(["send"]);
      expect(result.command).toBe("send");
      expect(result.args).toEqual([]);
    });

    it("should parse send command with --message flag", () => {
      const result = parseArgs(["send", "--message", "hello"]);
      expect(result.command).toBe("send");
      expect(result.args).toEqual(["--message", "hello"]);
    });

    it("should parse reset-context command with no arguments", () => {
      const result = parseArgs(["reset-context"]);
      expect(result.command).toBe("reset-context");
      expect(result.args).toEqual([]);
    });

    it("should parse reset-context command with agent ID", () => {
      const result = parseArgs(["reset-context", "coder"]);
      expect(result.command).toBe("reset-context");
      expect(result.args).toEqual(["coder"]);
    });

    it("should parse reset-crashes command", () => {
      const result = parseArgs(["reset-crashes"]);
      expect(result.command).toBe("reset-crashes");
      expect(result.args).toEqual([]);
    });
  });

  describe("Argument Parsing — flags", () => {
    it("should parse --help flag", () => {
      const result = parseArgs(["--help"]);
      expect(result.command).toBe("help");
    });

    it("should parse -h flag", () => {
      const result = parseArgs(["-h"]);
      expect(result.command).toBe("help");
    });

    it("should parse --version flag", () => {
      const result = parseArgs(["--version"]);
      expect(result.command).toBe("version");
    });

    it("should parse -v flag", () => {
      const result = parseArgs(["-v"]);
      expect(result.command).toBe("version");
    });

    it("should default to menu when no args provided", () => {
      const result = parseArgs([]);
      expect(result.command).toBe("menu");
      expect(result.args).toEqual([]);
    });
  });

  describe("Command Validation — unknown and removed commands", () => {
    it("should return unknown for an invalid command", () => {
      const result = parseArgs(["invalid-command"]);
      expect(result.command).toBe("unknown");
    });

    it("should return unknown for 'logs' (removed command)", () => {
      // 'logs' was present in old CLI but has been removed in Phase 11
      const result = parseArgs(["logs"]);
      expect(result.command).toBe("unknown");
    });

    it("should not include 'logs' in the valid command set", () => {
      // Passing 'logs' as a CLICommand should not be recognized
      const result = parseArgs(["logs", "telegram"]);
      expect(result.command).toBe("unknown");
    });

    it("should return unknown for removed 'restart' command", () => {
      const result = parseArgs(["restart"]);
      expect(result.command).toBe("unknown");
    });

    it("should return unknown for removed 'pairing' command", () => {
      const result = parseArgs(["pairing"]);
      expect(result.command).toBe("unknown");
    });

    it("should return unknown for removed 'service' command", () => {
      const result = parseArgs(["service"]);
      expect(result.command).toBe("unknown");
    });

    it("should return unknown for removed 'skills' command", () => {
      const result = parseArgs(["skills"]);
      expect(result.command).toBe("unknown");
    });
  });

  describe("CLICommand type — valid commands", () => {
    it("should accept all new valid commands without throwing", () => {
      const validCommands = [
        "start",
        "stop",
        "status",
        "agents",
        "schedule",
        "send",
        "reset-context",
        "reset-crashes",
        "help",
        "version",
        "menu",
      ] as const;

      validCommands.forEach((cmd) => {
        expect(() => parseArgs([cmd])).not.toThrow();
      });
    });
  });

  describe("Phase 13 — Setup command", () => {
    it("parseArgs(['setup']) returns { command: 'setup', args: [] }", () => {
      const result = parseArgs(["setup"]);
      expect(result.command).toBe("setup");
      expect(result.args).toEqual([]);
    });
  });
});
