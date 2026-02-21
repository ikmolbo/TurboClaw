/**
 * Start daemon command
 */
import { runDaemon } from "../../daemon/index";
import os from "os";
import path from "path";
import fs from "fs";

const DEFAULT_PID_FILE = path.join(os.homedir(), ".turboclaw", "turboclaw.pid");

export async function startCommand(): Promise<void> {
  // Check if already running via PID file
  if (fs.existsSync(DEFAULT_PID_FILE)) {
    const pidStr = fs.readFileSync(DEFAULT_PID_FILE, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    try {
      process.kill(pid, 0); // throws if process doesn't exist
      console.log(`TurboClaw daemon is already running (PID ${pid})`);
      console.log("Use 'turboclaw stop' to stop it.");
      return;
    } catch {
      // Process not running, stale PID file — continue
    }
  }

  console.log("Starting TurboClaw daemon...");
  console.log("Press Ctrl+C to stop.");
  await runDaemon();
}
