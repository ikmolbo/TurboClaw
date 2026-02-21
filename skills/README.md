# TurboClaw Bundled Skills

These skills are automatically installed on every agent created with TurboClaw. They provide essential functionality tightly integrated with the TurboClaw system.

## Bundled Skills

### turboclaw-memory
Complete memory management with three modes:
- **Log mode** - Append highlights to daily logs throughout the day
- **Consolidate mode** - Summarize all daily logs to MEMORY.md and reset conversation
- **Recall mode** - Search and retrieve past memories

When creating an agent, you'll be prompted to set up automatic memory management schedules:
- Daily consolidation (2am)
- Regular context clearing (every 6 hours)

See: [turboclaw-memory/SKILL.md](./turboclaw-memory/SKILL.md)

### turboclaw-send-user-message
Send messages directly to users through TurboClaw's messaging system. Enables agents to proactively communicate with users via configured channels (Telegram, etc.).

See: [turboclaw-send-user-message/SKILL.md](./turboclaw-send-user-message/SKILL.md)

### turboclaw-schedule
View and manage scheduled tasks from within an agent. Allows agents to:
- List their own scheduled tasks
- Check when tasks will run next
- Understand their automated workflows

See: [turboclaw-schedule/SKILL.md](./turboclaw-schedule/SKILL.md)

### turboclaw-skill-creator
Create new Claude Code skills with proper structure and documentation. Helps agents:
- Generate well-formatted SKILL.md files
- Follow skill best practices
- Create skills that integrate with TurboClaw
- Understand skill naming conventions

See: [turboclaw-skill-creator/SKILL.md](./turboclaw-skill-creator/SKILL.md)

### turboclaw-imagegen
Generate images using AI image generation services. Allows agents to:
- Create images from text descriptions
- Generate visuals for users
- Support various image generation backends

See: [turboclaw-imagegen/SKILL.md](./turboclaw-imagegen/SKILL.md)

## Why These Are Bundled

These skills are tightly coupled to TurboClaw's core functionality:
- **Memory** - Essential for long-running agents to maintain context
- **Send User Message** - Core communication infrastructure
- **Schedule** - Integration with TurboClaw's scheduling system

By bundling them, we ensure:
- Every agent has consistent baseline capabilities
- Skills stay in sync with TurboClaw core
- No manual installation or configuration needed
- Version compatibility is guaranteed

## Adding More Skills

Additional skills should be placed in your **workspace skills path**, configured in `config.yaml`:

```yaml
workspace:
  skills_path: ~/.turboclaw/skills  # Your custom skills go here
```

These skills will be:
- Offered as optional additions during agent creation
- Symlinked (not copied) to agents, so updates propagate automatically
- Excluded if they start with `turboclaw-` (reserved for bundled skills)

Bundled skills are only for TurboClaw-essential functionality that every agent needs.
