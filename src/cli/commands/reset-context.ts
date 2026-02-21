import fs from "fs";
import path from "path";
import os from "os";

const DEFAULT_RESET_DIR = path.join(os.homedir(), ".turboclaw", "reset");

// noop is used as a return value for resolves.not.toThrow() in Bun 1.3.9
const noop = () => {};

export async function resetContextCommand(args: string[], resetDir: string = DEFAULT_RESET_DIR): Promise<() => void> {
  const agentId = args[0];

  if (!agentId) {
    console.error("Error: agent ID is required");
    console.error("Usage: turboclaw reset-context <agent-id>");
    process.exit(1);
  }

  // Create directory if it doesn't exist
  if (!fs.existsSync(resetDir)) {
    fs.mkdirSync(resetDir, { recursive: true });
  }

  // Write signal file
  const signalFile = path.join(resetDir, agentId);
  await Bun.write(signalFile, "");

  console.log(`Reset context signal written for agent: ${agentId}`);
  return noop;
}
