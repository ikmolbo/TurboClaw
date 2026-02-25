/**
 * Start daemon command
 *
 * Default: launches the daemon inside a tmux session for non-blocking operation.
 * --foreground: runs the daemon directly in the current process (used inside
 *               the tmux session and for debugging).
 */
import { runDaemon } from "../../daemon/index";
import os from "os";
import path from "path";
import fs from "fs";

const DEFAULT_PID_FILE = path.join(os.homedir(), ".turboclaw", "daemon.pid");
const TMUX_SESSION = "turboclaw";

/**
 * Check whether a tmux session with the given name exists.
 */
function tmuxSessionExists(name: string): boolean {
  try {
    const result = Bun.spawnSync(["tmux", "has-session", "-t", name]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function startCommand(args: string[] = []): Promise<void> {
  const foreground = args.includes("--foreground");

  if (foreground) {
    // Foreground mode — run daemon directly (used inside tmux session)
    console.log("Starting TurboClaw daemon...");
    console.log("Press Ctrl+C to stop.");
    await runDaemon();
    return;
  }

  // Check tmux is installed
  const tmuxCheck = Bun.spawnSync(["which", "tmux"]);
  if (tmuxCheck.exitCode !== 0) {
    console.error("tmux is not installed.");
    console.error("Install it with: brew install tmux (macOS) or sudo apt-get install tmux (Linux)");
    process.exit(1);
  }

  // Check if already running via PID file
  if (fs.existsSync(DEFAULT_PID_FILE)) {
    const pidStr = fs.readFileSync(DEFAULT_PID_FILE, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    try {
      process.kill(pid, 0); // throws if process doesn't exist
      console.log(`TurboClaw daemon is already running (PID ${pid})`);
      console.log("Use 'turboclaw stop' to stop it, or 'turboclaw restart' to restart.");
      return;
    } catch {
      // Process not running, stale PID file — continue
    }
  }

  // Check if tmux session already exists (belt-and-suspenders)
  if (tmuxSessionExists(TMUX_SESSION)) {
    console.log(`TurboClaw is already running in tmux session '${TMUX_SESSION}'.`);
    console.log(`Attach with: tmux attach -t ${TMUX_SESSION}`);
    return;
  }

  // Launch daemon in a tmux session
  const proc = Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", TMUX_SESSION, "--",
    "turboclaw", "start", "--foreground",
  ]);

  if (proc.exitCode !== 0) {
    console.error("Failed to start tmux session:", proc.stderr.toString().trim());
    process.exit(1);
  }

  console.log(`Started TurboClaw in tmux session '${TMUX_SESSION}'.`);
  console.log(`  View live logs:  tmux attach -t ${TMUX_SESSION}`);
  console.log(`  Detach:          Ctrl-B then d`);
  process.exit(0);
}
