---
name: turboclaw-memory
description: "Memory management skill: save conversation highlights to daily logs, consolidate to long-term memory, and recall past context. Use for logging throughout the day, daily consolidation, or searching past memories."
---

# memory

Complete memory management skill with three modes:
1. **Log mode** (default): Append highlights to today's daily log
2. **Consolidate mode** (`--consolidate`): Summarize all daily logs to MEMORY.md and reset conversation
3. **Recall mode** (`--recall <query>`): Search and retrieve past memories

## When to use this skill

### Log mode (throughout the day)
- **Heartbeat invocations** - Log interesting events/decisions as they happen
- **After completing significant tasks** - Record outcomes and learnings
- **Capture user preferences** - Save newly discovered preferences or patterns
- **Document decisions** - Note why you chose a particular approach

### Consolidate mode (end of day)
- **Daily memory consolidation** - Automatically scheduled at 2am when agent is created
- **Before major context switches** - Transitioning between different projects
- **Conversation getting too long** - When history is becoming unwieldy

### Clear context mode (regular intervals)
- **Context clearing** - Automatically scheduled every 6 hours when agent is created
- **Prevent context bloat** - Keeps conversation history manageable
- **Combined with consolidation** - Consolidation preserves important info, clearing removes clutter

### Recall mode (anytime)
- **User asks about past work** - "What did we decide about X?"
- **Reference previous decisions** - Looking up architectural choices
- **Find user preferences** - "How does the user like Y formatted?"
- **Lookup past context** - "When did we implement Z?"

## What this skill does

### Mode 1: Log to daily file (default)

When invoked WITHOUT `--consolidate`:

1. **Generate brief highlights** (2-5 entries max)
   - Focus on new information from THIS invocation
   - Don't repeat what's already in today's log
   - Keep it concise - these accumulate throughout the day
   - Tag each entry with `[type]` prefix for easy filtering

2. **Append to today's log**
   - File: `memory/YYYY-MM-DD.md` relative to memory root (see File structure below)
   - Format: `## HH:MM @agent-id - [tag] entry text`
   - One line per entry for easy grep filtering
   - No conversation reset

3. **Respond briefly**
   - "✓ Logged to memory/2026-02-16.md"
   - Keep it to one line

**Example daily log entry (single-line format):**
```markdown
## 18:45 @coder - [decision] Implemented memory skill with dual modes
## 18:46 @coder - [preference] User prefers visible `memory/` folder over hidden `.memory/`
## 18:47 @support - [note] User confused by error messages in login flow
## 18:52 @coder - [task] Added better validation feedback per @support note
```

**Format:** `## HH:MM @agent-id - [tag] entry text`

**Common tags:**
- `[decision]` - Architectural/design choices made
- `[preference]` - User preferences learned
- `[task]` - Work completed or next steps
- `[context]` - Project/domain context
- `[bug]` - Issues discovered
- `[note]` - General observations

**Filtering examples:**
```bash
grep "@coder" memory/*.md              # All coder entries
grep "\[decision\]" memory/*.md        # All decisions
grep "@coder.*\[decision\]" memory/*.md  # Coder's decisions
grep "18:4" memory/*.md                # Entries at 18:40-18:49
```

### Mode 2: Consolidate and reset

When invoked WITH `--consolidate`:

1. **Read all daily logs** in `memory/`
   - Find all `YYYY-MM-DD.md` files
   - Extract key information across all days

2. **Generate consolidated summary**
   - **Important decisions** with lasting impact
   - **User preferences** learned over time
   - **Project context** that persists across days
   - **Ongoing work** and next steps
   - Format as clean bullet points (10-15 items max)

3. **Append to MEMORY.md**
   - File: `memory/MEMORY.md`
   - Add date range header
   - Include consolidated summary
   - This becomes your persistent long-term memory

4. **Archive daily logs**
   - Move `YYYY-MM-DD.md` files to `memory/archive/`
   - Keeps `memory/` clean for new daily logs

5. **Reset conversation**
   ```bash
   turboclaw reset-context <agent-id>
   ```

6. **Respond to user**
   - "✓ Consolidated X days to MEMORY.md and reset conversation"
   - Brief, 1-2 sentences max

### Mode 3: Recall from memory

When invoked WITH `--recall <query>`:

1. **Search across all memory files**
   - Search `memory/MEMORY.md` (consolidated long-term memory)
   - Search `memory/YYYY-MM-DD.md` files (recent daily logs)
   - Search `memory/archive/*.md` if needed for older context

2. **Use multiple search strategies**
   - Keyword search: `grep -i "query" memory/*.md`
   - Tag filtering: `grep "\[preference\]" memory/*.md | grep -i "query"`
   - Date-based: Check specific date files if query mentions timeframes
   - Context search: Look for related terms if direct match fails

3. **Summarize findings**
   - Extract relevant entries found
   - Provide context (which file, when logged)
   - Quote exact log entries with timestamps
   - If nothing found, suggest alternative search terms

4. **Respond with results**
   - Show matching entries in chronological order
   - Format: `[YYYY-MM-DD HH:MM] bullet point text`
   - Keep response concise but complete
   - Mention which memory file(s) contained the results

**Example recall interaction:**
```
User: "What did we decide about the memory folder location?"
Agent: [Use memory --recall "memory folder location"]

Response:
Found in memory/2026-02-16.md:
## 18:32 @coder - [preference] User prefers visible `memory/` folder over hidden `.memory/`
## 18:32 @coder - [decision] Redesigned memory skill with dual modes
```

**Filtering by agent:**
```
User: "What has @support logged recently?"
Agent: [Use memory --recall "@support"]
Response: [List all @support entries]
```

## File structure

**Shared memory (default):**
All agents read/write to a shared `memory/` folder in the workspace root (`~/.turboclaw/workspaces/memory/`).
```
~/.turboclaw/workspaces/memory/
├── MEMORY.md              # Consolidated long-term memory (all agents)
├── 2026-02-16.md          # Today's log (all agents write here)
└── archive/
    └── 2026-02-15.md
```

**Isolated memory (per-agent):**
Each agent reads/writes to `memory/` in their own workspace directory.
```
~/.turboclaw/workspaces/coach/memory/
├── MEMORY.md              # Coach's consolidated memory
├── 2026-02-16.md          # Coach's daily log
└── archive/
    └── 2026-02-15.md
```

**Configuration:** Set `memory_mode: "shared"` or `memory_mode: "isolated"` per agent in settings.json.

**How to determine your memory root:**
1. Check your agent config in `~/.turboclaw/config.yaml` for `memory_mode`
2. If `"isolated"` → use `memory/` in your own working directory
3. If `"shared"` or not set → use `memory/` in the workspace root (parent of your working directory)

## Usage examples

### Log mode (continuous throughout the day)

**In heartbeat or after tasks:**
```
You: Use memory skill to log that we implemented the dual-mode memory system
[Skill appends to memory/2026-02-16.md]
Response: "✓ Logged to memory/2026-02-16.md"
```

**Manual invocation:**
```
User: "Save that preference about using TypeScript"
You: [Use memory skill without --consolidate]
Response: "✓ Logged to memory/2026-02-16.md"
```

### Consolidate mode (automatic scheduling)

**Automatic setup during agent creation:**

When you create a new agent with the memory skill enabled, TurboClaw automatically offers to create two memory management schedules:

1. **Daily consolidation** (2am): `memory --consolidate`
2. **Regular context clearing** (every 6 hours): `memory --clear-context`

These are created as scheduled tasks in `~/.turboclaw/tasks/`:
- `{agent-id}-memory-consolidation.yaml`
- `{agent-id}-memory-context-clearing.yaml`

**View your memory schedules:**
```bash
turboclaw schedule list
```

**Disable a schedule temporarily:**
```bash
turboclaw schedule disable "{agent-id} Memory Consolidation"
turboclaw schedule disable "{agent-id} Memory Context Clearing"
```

**Create schedules manually (if not created during setup):**
```bash
turboclaw schedule add
# When prompted:
# Task name: coder Memory Consolidation
# Schedule: 0 2 * * *
# Action type: agent-message
# Agent ID: coder
# Message: memory --consolidate
```

**Manual consolidation:**
```
User: "Consolidate the week's memory and reset"
You: [Use memory --consolidate]
Response: "✓ Consolidated 7 days to MEMORY.md and reset conversation"
```

### Recall mode (anytime)

**User asks about past decisions:**
```
User: "What did we decide about the memory folder?"
You: [Use memory --recall "memory folder"]
Response:
Found in memory/2026-02-16.md:
[2026-02-16 18:32] [preference] User prefers visible `memory/` folder over hidden `.memory/`
```

**Search by tag:**
```
User: "What preferences have we established?"
You: [Use memory --recall "[preference]"]
Response: [List all preference entries from memory files]
```

**Looking for context from a specific timeframe:**
```
User: "What were we working on last week?"
You: [Use memory --recall "last week" or read memory/2026-02-09.md through 2026-02-15.md]
```

## Implementation steps

### For log mode (default)

1. Determine memory root (see "How to determine your memory root" above)
2. Generate 2-5 concise entries from current context
3. Append single-line entries to `<memory-root>/YYYY-MM-DD.md`: `## HH:MM @agent-id - [tag] entry text`
4. Respond: "✓ Logged to memory/YYYY-MM-DD.md"

### For consolidate mode (--consolidate)

1. Read all `YYYY-MM-DD.md` files in your memory root
2. Generate consolidated summary (10-15 key points)
3. Append to `<memory-root>/MEMORY.md` with date range header
4. Move daily logs to `<memory-root>/archive/`
5. Run: `turboclaw reset-context <agent-id>`
6. Respond: "✓ Consolidated X days to MEMORY.md and reset conversation"

### For recall mode (--recall <query>)

1. Search `MEMORY.md` and `*.md` files in your memory root for query
2. Use `grep -i` for case-insensitive search
3. If query looks like a tag (e.g., "preference"), filter by tag first
4. Extract matching entries with timestamps
5. Format and present results chronologically
6. If no results, suggest alternative search terms or tags

## Detecting mode

Parse the skill invocation:
- If contains `--consolidate` → consolidate mode
- If contains `--recall <query>` → recall mode
- Otherwise → log mode

## Automatic memory management

When you install this skill during agent creation, TurboClaw offers to set up automated memory management:

**What gets created:**
1. **Daily consolidation task** - Runs at 2am every day
   - Consolidates all daily logs to MEMORY.md
   - Archives old daily logs
   - Resets conversation to keep context fresh

2. **Context clearing task** - Runs every 6 hours
   - Sends `memory --clear-context` command
   - Prevents conversation context from growing too large
   - Works in conjunction with consolidation to maintain manageable memory

**Managing your schedules:**
```bash
# View all schedules
turboclaw schedule list

# Temporarily disable consolidation
turboclaw schedule disable "{agent-id} Memory Consolidation"

# Re-enable it later
turboclaw schedule enable "{agent-id} Memory Consolidation"

# Adjust timing by removing and recreating
turboclaw schedule remove "{agent-id} Memory Consolidation"
turboclaw schedule add  # Then enter new timing
```

**Why this matters:**
- **No manual intervention needed** - Memory consolidates automatically
- **Prevents context bloat** - Regular clearing keeps conversations performant
- **Preserves important info** - Consolidation saves key decisions before clearing
- **Hands-off operation** - Set it once during agent creation, forget about it

## Important notes

- **Log mode does NOT reset** - conversation continues
- **Consolidate mode DOES reset** - starts fresh
- **Recall mode does NOT reset** - just searches and returns results
- **MEMORY.md is append-only** - never overwrite
- **Daily logs get archived** - not deleted, just moved
- **Directory creation** - Create your memory root directory as needed
- **Agent ID** - Use correct agent ID for reset command
- **Search is case-insensitive** - recall mode uses `grep -i`
- **Tags are searchable** - Use `[tag]` to filter by entry type
- **Agent filtering** - Use `@agent-id` to filter by agent
- **Single-line format** - Each entry is one complete line for easy grep/awk
- **Memory mode** - Check your agent's `memory_mode` in `~/.turboclaw/config.yaml` to determine your memory root
- **Automatic schedules** - Memory management runs automatically if schedules were created during agent setup

## Viewing past memories

```bash
# Current consolidated memory
cat memory/MEMORY.md

# Today's incremental log
cat memory/2026-02-16.md

# Archived daily logs
ls -lt memory/archive/

# Search all memories
grep -r "keyword" memory/

# Filter by tag
grep "\[preference\]" memory/*.md
grep "\[decision\]" memory/*.md
```

## Why this design?

- **Incremental logging** prevents context loss throughout the day
- **Consolidation** creates clean, high-signal long-term memory
- **No resets during work** - log mode preserves conversation flow
- **Visible folder** - easy to inspect, not hidden
- **Single skill** - one tool, two modes, clear mental model
