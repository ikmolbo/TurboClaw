/**
 * Restart daemon command — stop then start
 */
import { stopCommand } from "./stop";
import { startCommand } from "./start";
import os from "os";
import path from "path";
import fs from "fs";

const DEFAULT_PID_FILE = path.join(os.homedir(), ".turboclaw", "daemon.pid");

export async function restartCommand(args: string[] = []): Promise<void> {
  // Stop the daemon (if running)
  await stopCommand();

  // Wait for the PID file to disappear (max ~5 seconds)
  const deadline = Date.now() + 5000;
  while (fs.existsSync(DEFAULT_PID_FILE) && Date.now() < deadline) {
    await Bun.sleep(200);
  }

  // Start the daemon
  await startCommand(args);
}
