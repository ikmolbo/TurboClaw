import fs from "fs";
import path from "path";
import os from "os";

const DEFAULT_INTERRUPT_DIR = path.join(os.homedir(), ".turboclaw", "interrupt");

// noop is used as a return value for resolves.not.toThrow() in Bun 1.3.9
const noop = () => {};

/**
 * Write an interrupt signal file for the given agent.
 * The daemon checks for these files each poll cycle and kills the running
 * Claude process if the signal matches the active session.
 */
export async function interruptCommand(args: string[], interruptDir: string = DEFAULT_INTERRUPT_DIR): Promise<() => void> {
  const agentId = args[0];

  if (!agentId) {
    console.error("Error: agent ID is required");
    console.error("Usage: turboclaw interrupt <agent-id>");
    process.exit(1);
  }

  // Create directory if it doesn't exist
  if (!fs.existsSync(interruptDir)) {
    fs.mkdirSync(interruptDir, { recursive: true });
  }

  // Write signal file with empty content (interrupt any session)
  const signalFile = path.join(interruptDir, agentId);
  await Bun.write(signalFile, "");

  console.log(`Interrupt signal written for agent: ${agentId}`);
  return noop;
}
