---
name: turboclaw-send-user-message
description: "Send a proactive message to a user via Telegram using the 'turboclaw send' command. Use when you need to notify, alert, or reach out to a user without them sending you a message first - especially during heartbeat checks, scheduled tasks, or automated workflows."
---

# Send User Message

Proactively send messages to users via Telegram using the `turboclaw send` CLI command. The daemon automatically identifies which agent is sending based on the `TURBOCLAW_AGENT_ID` environment variable.

## When to use

- **Heartbeat notifications** - Proactively check in with users during heartbeat tasks
- **Task completion alerts** - Notify users when background tasks finish
- **Status updates** - Send progress reports or status changes
- **Scheduled reminders** - Automated notifications from scheduled tasks
- **Error alerts** - Notify users of issues that need attention

## How it works

1. You run `turboclaw send --message` with your message text
2. TurboClaw reads `TURBOCLAW_AGENT_ID` from the environment to identify the sending agent
3. The message is safely encoded and written to the outgoing queue
4. The Telegram sender picks up the message and sends it via the appropriate bot
5. User receives the message in their existing chat with your agent

## Sending a message

```bash
turboclaw send --message "Your task is complete!"
```

The daemon uses `TURBOCLAW_AGENT_ID` to route the message to the correct user automatically.

## Common patterns

### Agent heartbeat

```bash
turboclaw send --message "Heartbeat check - All systems operational!"
```

### Task completion

```bash
turboclaw send --message "Code review completed! 3 PRs reviewed, all tests passing."
```

### Scheduled reminder

```bash
turboclaw send --message "Daily reminder: Review open pull requests"
```

## Important notes

- The `TURBOCLAW_AGENT_ID` environment variable is set by the daemon when launching your agent
- JSON encoding is handled automatically - no need to escape special characters
- Messages are processed every ~1 second by the Telegram sender

## Troubleshooting

**Message not delivered?**
```bash
# Check if message is stuck in queue
ls ~/.turboclaw/queue/outgoing/

# Check Telegram logs for errors
turboclaw logs telegram -f

# Verify daemon is running
turboclaw status
```

**Command not found?**
- Make sure TurboClaw is installed: `which turboclaw`
- Reinstall if needed: `cd ~/TurboClaw && ./install.sh`
