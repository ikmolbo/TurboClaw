/**
 * Stop daemon command
 */
import os from "os";
import path from "path";
import fs from "fs";

const DEFAULT_PID_FILE = path.join(os.homedir(), ".turboclaw", "turboclaw.pid");

export async function stopCommand(pidFile: string = DEFAULT_PID_FILE): Promise<void> {
  if (!fs.existsSync(pidFile)) {
    console.log("TurboClaw daemon is not running (no PID file found).");
    return;
  }

  const pidStr = fs.readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    console.error("Invalid PID file.");
    process.exit(1);
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to PID ${pid}.`);
  } catch (error) {
    console.error(`Failed to stop daemon (PID ${pid}):`, error);
    process.exit(1);
  }
}
