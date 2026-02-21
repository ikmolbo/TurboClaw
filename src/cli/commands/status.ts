/**
 * Status command - show system status
 */
import os from "os";
import path from "path";
import fs from "fs";

const DEFAULT_PID_FILE = path.join(os.homedir(), ".turboclaw", "turboclaw.pid");

export async function statusCommand(): Promise<void> {
  console.log("TurboClaw Status");
  console.log("-".repeat(50));

  // Check if daemon is running via PID file
  let running = false;
  let pid: number | null = null;

  if (fs.existsSync(DEFAULT_PID_FILE)) {
    const pidStr = fs.readFileSync(DEFAULT_PID_FILE, "utf-8").trim();
    const parsedPid = parseInt(pidStr, 10);
    if (!isNaN(parsedPid)) {
      try {
        process.kill(parsedPid, 0); // throws if process doesn't exist
        running = true;
        pid = parsedPid;
      } catch {
        // Process not running, stale PID file
      }
    }
  }

  if (running && pid !== null) {
    console.log(`Daemon:  Running (PID ${pid})`);
  } else {
    console.log(`Daemon:  Not running`);
  }

  console.log("-".repeat(50));

  // Config file
  const configPath = path.join(os.homedir(), ".turboclaw", "config.yaml");
  const configExists = await Bun.file(configPath).exists();
  console.log(`Config:  ${configExists ? "OK" : "Missing"}  ${configPath}`);

  // Log directory
  const logDir = path.join(os.homedir(), ".turboclaw", "logs");
  const logDirExists = await Bun.file(logDir).exists();
  console.log(`Logs:    ${logDirExists ? "OK" : "Missing"}  ${logDir}`);

  console.log("-".repeat(50));

  // Helpful commands
  if (running) {
    console.log("\nCommands:");
    console.log("   turboclaw stop              - Stop daemon");
  } else {
    console.log("\nCommands:");
    console.log("   turboclaw start             - Start daemon");
  }
}
