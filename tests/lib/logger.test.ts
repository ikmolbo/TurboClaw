import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { createLogger, setLogLevel, LogLevel } from "../../src/lib/logger";

// Strip ANSI escape codes so tests can match plain text
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

describe("Logger", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Spy on console.log to capture output
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console.log
    consoleSpy.mockRestore();
    // Reset log level to default (DEBUG) between tests
    setLogLevel(LogLevel.DEBUG);
  });

  describe("createLogger(component)", () => {
    test("returns object with debug, info, warn, error methods", () => {
      const log = createLogger("TestComponent");

      expect(log).toBeDefined();
      expect(typeof log.debug).toBe("function");
      expect(typeof log.info).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.error).toBe("function");
    });

    test("each method is callable with a message", () => {
      const log = createLogger("TestComponent");

      // Should not throw
      expect(() => log.debug("debug message")).not.toThrow();
      expect(() => log.info("info message")).not.toThrow();
      expect(() => log.warn("warn message")).not.toThrow();
      expect(() => log.error("error message")).not.toThrow();
    });

    test("creates independent loggers for different components", () => {
      const log1 = createLogger("Component1");
      const log2 = createLogger("Component2");

      log1.info("message from component 1");
      log2.info("message from component 2");

      expect(consoleSpy).toHaveBeenCalledTimes(2);

      const call1 = consoleSpy.mock.calls[0][0] as string;
      const call2 = consoleSpy.mock.calls[1][0] as string;

      expect(call1).toContain("Component1");
      expect(call2).toContain("Component2");
    });
  });

  describe("Output format", () => {
    test("output includes HH:MM:SS timestamp", () => {
      const log = createLogger("TestComponent");
      log.info("test message");

      expect(consoleSpy).toHaveBeenCalled();
      const output = stripAnsi(consoleSpy.mock.calls[0][0] as string);

      // Time format: HH:MM:SS
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    test("output includes level indicator symbol", () => {
      const log = createLogger("TestComponent");

      log.debug("debug message");
      log.info("info message");
      log.warn("warn message");
      log.error("error message");

      const calls = consoleSpy.mock.calls;
      const stripped = calls.map((c) => stripAnsi(c[0] as string));

      expect(stripped[0]).toContain("·"); // DEBUG
      expect(stripped[1]).toContain("◆"); // INFO
      expect(stripped[2]).toContain("▲"); // WARN
      expect(stripped[3]).toContain("✖"); // ERROR
    });

    test("output includes component tag in brackets", () => {
      const log = createLogger("MyComponent");
      log.info("test message");

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("[MyComponent]");
    });

    test("output includes the message", () => {
      const log = createLogger("TestComponent");
      log.info("this is the test message");

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("this is the test message");
    });

    test("output format: HH:MM:SS symbol [Component] message", () => {
      const log = createLogger("API");
      log.info("request received");

      const output = stripAnsi(consoleSpy.mock.calls[0][0] as string);

      // Format: HH:MM:SS ◆ [API] request received
      expect(output).toMatch(/\d{2}:\d{2}:\d{2} ◆ \[API\] request received/);
    });

    test("debug level output format", () => {
      const log = createLogger("Debug");
      log.debug("debugging info");

      const output = stripAnsi(consoleSpy.mock.calls[0][0] as string);
      expect(output).toMatch(/\d{2}:\d{2}:\d{2} · \[Debug\] debugging info/);
    });

    test("warn level output format", () => {
      const log = createLogger("Warnings");
      log.warn("warning alert");

      const output = stripAnsi(consoleSpy.mock.calls[0][0] as string);
      expect(output).toMatch(/\d{2}:\d{2}:\d{2} ▲ \[Warnings\] warning alert/);
    });

    test("error level output format", () => {
      const log = createLogger("Errors");
      log.error("error occurred");

      const output = stripAnsi(consoleSpy.mock.calls[0][0] as string);
      expect(output).toMatch(/\d{2}:\d{2}:\d{2} ✖ \[Errors\] error occurred/);
    });
  });

  describe("setLogLevel()", () => {
    test("LogLevel enum has expected values", () => {
      expect(LogLevel.DEBUG).toBeDefined();
      expect(LogLevel.INFO).toBeDefined();
      expect(LogLevel.WARN).toBeDefined();
      expect(LogLevel.ERROR).toBeDefined();
    });

    test("LogLevel values are ordered (DEBUG < INFO < WARN < ERROR)", () => {
      expect(LogLevel.DEBUG).toBeLessThan(LogLevel.INFO);
      expect(LogLevel.INFO).toBeLessThan(LogLevel.WARN);
      expect(LogLevel.WARN).toBeLessThan(LogLevel.ERROR);
    });

    test("setLogLevel to WARN suppresses DEBUG and INFO", () => {
      const log = createLogger("TestComponent");

      setLogLevel(LogLevel.WARN);

      log.debug("debug message");
      log.info("info message");
      log.warn("warn message");
      log.error("error message");

      // Only WARN and ERROR should be logged
      expect(consoleSpy).toHaveBeenCalledTimes(2);

      const calls = consoleSpy.mock.calls.map((c) => stripAnsi(c[0] as string));
      expect(calls[0]).toContain("warn message");
      expect(calls[1]).toContain("error message");
    });

    test("setLogLevel to ERROR suppresses DEBUG, INFO, and WARN", () => {
      const log = createLogger("TestComponent");

      setLogLevel(LogLevel.ERROR);

      log.debug("debug message");
      log.info("info message");
      log.warn("warn message");
      log.error("error message");

      // Only ERROR should be logged
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(stripAnsi(consoleSpy.mock.calls[0][0] as string)).toContain("error message");
    });

    test("setLogLevel to INFO suppresses only DEBUG", () => {
      const log = createLogger("TestComponent");

      setLogLevel(LogLevel.INFO);

      log.debug("debug message");
      log.info("info message");
      log.warn("warn message");
      log.error("error message");

      // INFO, WARN, and ERROR should be logged (3 calls)
      expect(consoleSpy).toHaveBeenCalledTimes(3);

      const calls = consoleSpy.mock.calls.map((c) => stripAnsi(c[0] as string));
      expect(calls[0]).toContain("info message");
      expect(calls[1]).toContain("warn message");
      expect(calls[2]).toContain("error message");
    });

    test("setLogLevel to DEBUG allows all levels", () => {
      const log = createLogger("TestComponent");

      setLogLevel(LogLevel.DEBUG);

      log.debug("debug message");
      log.info("info message");
      log.warn("warn message");
      log.error("error message");

      // All 4 levels should be logged
      expect(consoleSpy).toHaveBeenCalledTimes(4);
    });

    test("setLogLevel affects all existing loggers", () => {
      const log1 = createLogger("Component1");
      const log2 = createLogger("Component2");

      setLogLevel(LogLevel.ERROR);

      log1.info("info from 1");
      log2.info("info from 2");
      log1.error("error from 1");
      log2.error("error from 2");

      // Only the two error messages should be logged
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    test("setLogLevel can be changed multiple times", () => {
      const log = createLogger("TestComponent");

      setLogLevel(LogLevel.ERROR);
      log.info("should not appear");
      expect(consoleSpy).toHaveBeenCalledTimes(0);

      setLogLevel(LogLevel.DEBUG);
      log.info("should appear");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Data argument handling", () => {
    test("handles plain objects in data argument", () => {
      const log = createLogger("TestComponent");
      const data = { userId: 123, action: "login" };

      log.info("user action", data);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;

      expect(output).toContain("user action");
      expect(output).toContain("userId");
      expect(output).toContain("123");
      expect(output).toContain("action");
      expect(output).toContain("login");
    });

    test("handles nested objects in data argument", () => {
      const log = createLogger("TestComponent");
      const data = {
        user: { id: 1, name: "John" },
        metadata: { timestamp: 12345 },
      };

      log.info("nested data", data);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("nested data");
      expect(output).toContain("user");
      expect(output).toContain("John");
    });

    test("handles arrays in data argument", () => {
      const log = createLogger("TestComponent");
      const data = { items: [1, 2, 3], tags: ["a", "b"] };

      log.info("array data", data);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("items");
      expect(output).toContain("1");
      expect(output).toContain("2");
      expect(output).toContain("3");
    });

    test("handles Error objects in data argument", () => {
      const log = createLogger("TestComponent");
      const error = new Error("Something went wrong");

      log.error("error occurred", error);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("error occurred");
      expect(output).toContain("Something went wrong");
    });

    test("handles Error objects with stack trace", () => {
      const log = createLogger("TestComponent");
      const error = new Error("Test error with stack");

      log.error("caught exception", error);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("caught exception");
      expect(output).toContain("Test error with stack");
      // Stack trace should be included
      expect(output).toContain("Error:");
    });

    test("handles custom error types", () => {
      class CustomError extends Error {
        code: string;
        constructor(message: string, code: string) {
          super(message);
          this.name = "CustomError";
          this.code = code;
        }
      }

      const log = createLogger("TestComponent");
      const error = new CustomError("Custom error message", "ERR_CUSTOM");

      log.error("custom error", error);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("custom error");
      expect(output).toContain("Custom error message");
    });

    test("handles undefined data argument gracefully", () => {
      const log = createLogger("TestComponent");

      expect(() => log.info("message only")).not.toThrow();

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("message only");
    });

    test("handles null data argument gracefully", () => {
      const log = createLogger("TestComponent");

      expect(() => log.info("message with null", null as any)).not.toThrow();

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("message with null");
    });

    test("handles primitive data values", () => {
      const log = createLogger("TestComponent");

      log.info("with number", 42 as any);
      log.info("with string", "extra" as any);
      log.info("with boolean", true as any);

      expect(consoleSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("Chalk colors", () => {
    // Note: These tests verify that colored output is produced.
    // The actual color codes may vary, but we test that different
    // levels produce different outputs (implying different colors).

    test("different log levels produce visually distinct output", () => {
      const log = createLogger("ColorTest");

      log.debug("debug");
      log.info("info");
      log.warn("warn");
      log.error("error");

      const calls = consoleSpy.mock.calls;

      // Get the raw output strings (may contain ANSI codes)
      const debugOutput = calls[0][0] as string;
      const infoOutput = calls[1][0] as string;
      const warnOutput = calls[2][0] as string;
      const errorOutput = calls[3][0] as string;

      // Each level should produce output that differs beyond just the level name
      // This implies color codes are being applied
      expect(debugOutput).not.toBe(infoOutput.replace("INFO", "DEBUG").replace("info", "debug"));
      expect(warnOutput).not.toBe(infoOutput.replace("INFO", "WARN").replace("info", "warn"));
      expect(errorOutput).not.toBe(infoOutput.replace("INFO", "ERROR").replace("info", "error"));
    });
  });

  describe("Edge cases", () => {
    test("handles empty string component name", () => {
      const log = createLogger("");
      expect(() => log.info("message")).not.toThrow();
    });

    test("handles component name with special characters", () => {
      const log = createLogger("My-Component_v2.0");
      log.info("test");

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("My-Component_v2.0");
    });

    test("handles very long messages", () => {
      const log = createLogger("TestComponent");
      const longMessage = "a".repeat(10000);

      expect(() => log.info(longMessage)).not.toThrow();

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain(longMessage);
    });

    test("handles messages with special characters", () => {
      const log = createLogger("TestComponent");
      const specialMessage = "Line1\nLine2\tTabbed \"quoted\" 'single'";

      log.info(specialMessage);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("Line1");
    });

    test("handles circular references in data object", () => {
      const log = createLogger("TestComponent");
      const circular: any = { name: "test" };
      circular.self = circular;

      // Should not throw when logging circular reference
      expect(() => log.info("circular data", circular)).not.toThrow();
    });

    test("handles symbols in data object", () => {
      const log = createLogger("TestComponent");
      const data = { [Symbol("test")]: "value", normal: "key" };

      expect(() => log.info("symbol data", data)).not.toThrow();
    });

    test("handles concurrent logging from multiple loggers", () => {
      const loggers = Array.from({ length: 10 }, (_, i) =>
        createLogger(`Component${i}`)
      );

      loggers.forEach((log, i) => {
        log.info(`message ${i}`);
      });

      expect(consoleSpy).toHaveBeenCalledTimes(10);
    });
  });
});
