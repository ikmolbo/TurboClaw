---
name: turboclaw-schedule
description: "Create, list, enable, disable, and remove scheduled (cron) tasks for TurboClaw agents and shell commands. Use when the user wants to: schedule a recurring task for an agent, set up a cron job, run periodic shell commands, list existing scheduled tasks, enable/disable tasks, or automate periodic work (reports, checks, backups, reminders, syncs)."
---

# Schedule Skill

Manage cron-based scheduled tasks using the TurboClaw CLI. Tasks are stored as YAML files and automatically processed by the daemon's built-in scheduler (every 30 seconds). Supports multiple action types including agent messages, heartbeats, cleanup operations, and shell commands.

**No system cron setup required** - the daemon handles everything!

## Commands

Use the TurboClaw CLI `turboclaw schedule` for all operations.

### Create a schedule

**Interactive mode** (guided prompts):

```bash
turboclaw schedule add
```

This launches an interactive wizard that prompts for:
- **Task name** — Descriptive name for the task
- **Cron schedule** — 5-field cron expression (minute hour day month weekday)
- **Action type** — Choose from:
  - `agent-message` — Send a message to an agent
  - `heartbeat` — Trigger an agent heartbeat
  - `cleanup` — Run cleanup tasks (files or chats)
  - `command` — Run a shell command (like traditional cron)
- **Agent ID** — Target agent (for agent-message and heartbeat)
- **Message** — Task context/prompt (for agent-message only)
- **Command** — Shell command to execute (for command only)

**Non-interactive mode** (all flags, no prompts — use this in scripts and automation):

```bash
turboclaw schedule add --name <name> --cron <expr> --action <type> [options]
```

Flags:
- `--name <name>` — Task name
- `--cron <expr>` — 5-field cron expression
- `--action <type>` — One of: `agent-message`, `heartbeat`, `cleanup`, `command`
- `--agent <id>` — Target agent ID (for `agent-message`, `heartbeat`)
- `--message <text>` — Message text (for `agent-message`)
- `--command <cmd>` — Shell command to run (for `command`)
- `--condition <cmd>` — Optional shell command; task only runs if exit code is 0

Examples:

```bash
# Send a daily report message to an agent
turboclaw schedule add --name "Daily Report" --cron "0 9 * * *" --action agent-message --agent coder --message "Generate report"

# Run a backup command only if a flag file exists
turboclaw schedule add --name "Backup" --cron "0 2 * * *" --action command --command "bun run backup.ts" --condition "test -f /tmp/backup-ok"

# Weekly heartbeat
turboclaw schedule add --name "Weekly Heartbeat" --cron "0 10 * * 1" --action heartbeat --agent coder
```

The task is saved as a YAML file in `~/.turboclaw/tasks/`.

### List schedules

```bash
turboclaw schedule list
# or simply
turboclaw schedule
```

Lists all scheduled tasks with:
- Name, status (enabled/disabled)
- Cron schedule
- Action type
- Last run time
- Next run time

### Enable a schedule

```bash
turboclaw schedule enable <task-name>
```

Enable a previously disabled task.

### Disable a schedule

```bash
turboclaw schedule disable <task-name>
```

Temporarily disable a task without deleting it.

### Remove a schedule

```bash
turboclaw schedule remove <task-name>
```

Permanently delete a scheduled task.

## How it works

**Tasks are automatically processed by the daemon** — no system cron setup needed! The daemon has a built-in scheduler that checks tasks every 30 seconds.

## Workflow

1. Verify the daemon is running: `turboclaw status`
2. Determine the cron expression from user's description (e.g., "every morning" → `0 9 * * *`)
3. Run `turboclaw schedule add` and follow the interactive prompts
4. Verify with `turboclaw schedule list`
5. Tasks will run automatically when the daemon is running

## Cron expression quick reference

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

| Pattern           | Meaning                    |
|-------------------|----------------------------|
| `0 9 * * *`       | Daily at 9:00 AM           |
| `0 9 * * 1-5`     | Weekdays at 9:00 AM        |
| `*/15 * * * *`    | Every 15 minutes           |
| `0 */2 * * *`     | Every 2 hours              |
| `0 0 * * 0`       | Weekly on Sunday midnight  |
| `0 0 1 * *`       | Monthly on the 1st         |
| `30 8 * * 1`      | Monday at 8:30 AM          |

## Examples

### Daily report

```bash
turboclaw schedule add
# When prompted:
# Task name: Daily Report
# Schedule: 0 9 * * *
# Action type: agent-message
# Agent ID: analyst
# Message: Generate the daily metrics report and post a summary
```

### Periodic health check

```bash
turboclaw schedule add
# When prompted:
# Task name: Health Check
# Schedule: */30 * * * *
# Action type: agent-message
# Agent ID: devops
# Message: Run health checks on all services and report any issues
```

### Weekly heartbeat

```bash
turboclaw schedule add
# When prompted:
# Task name: Weekly Heartbeat
# Schedule: 0 10 * * 1
# Action type: heartbeat
# Agent ID: coder
```

### Nightly database backup

```bash
turboclaw schedule add
# When prompted:
# Task name: Nightly Backup
# Schedule: 0 2 * * *
# Action type: command
# Command: bun run scripts/backup-db.ts
```

### Daily log cleanup

```bash
turboclaw schedule add
# When prompted:
# Task name: Log Cleanup
# Schedule: 0 3 * * *
# Action type: cleanup
# Cleanup type: files
```

### List and manage

```bash
# See all schedules
turboclaw schedule list

# Disable one temporarily
turboclaw schedule disable "Health Check"

# Re-enable it later
turboclaw schedule enable "Health Check"

# Remove permanently
turboclaw schedule remove "Daily Report"
```

## How it works

- Schedules are stored as YAML files in `~/.turboclaw/tasks/`
- A system cron job runs `tick.ts` every minute to check for due tasks
- When a task is due, the action is executed:
  - `agent-message` — sends message to the specified agent
  - `heartbeat` — triggers agent heartbeat
  - `cleanup` — runs cleanup operations
  - `command` — executes the shell command
- Tasks track their last run time and can be enabled/disabled
- The scheduler validates all tasks using Zod schemas

## Task File Format

Tasks are stored in YAML format:

```yaml
name: Daily Report
schedule: 0 9 * * *
action:
  type: agent-message
  agent: analyst
  message: Generate the daily metrics report
enabled: true
lastRun: '2026-02-17T09:00:00.000Z'
```

```yaml
name: Nightly Backup
schedule: 0 2 * * *
action:
  type: command
  command: bun run scripts/backup-db.ts
enabled: true
lastRun: '2026-02-17T02:00:00.000Z'
```

Action types:
- `agent-message` — requires `agent` and `message` fields
- `heartbeat` — requires `agent` field
- `cleanup` — requires `cleanupType` field (`files` or `chats`)
- `command` — requires `command` field (shell command string)
