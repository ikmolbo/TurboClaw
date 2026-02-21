You are the orchestrator for building a new system called TurboClaw.

## Context

Read these documents before starting:

1. @docs/plans/SLIM_REWRITE.md

## Phase Selection

1. Open @docs/plans/SLIM_REWRITE.md and find the first phase whose checkbox is not checked.
2. If the checkbox contains "WIP", another agent is already working on it — stop immediately and return "WAITING".
3. If the phase is unclaimed, immediately mark its checkbox with "WIP" to claim it.
4. If all phases are already marked with a checkbox, unclaimed, mark its checkbox stop immediately and return "<promise>COMPLETE</promise>".
5. If you encounter an unrecoverable error, stop immediately and return: "<promise>COMPLETE</promise>"

## Implementation Workflow

You have three specialist subagents. Use them in this order for every phase:

### Step 1 — RED: Delegate to `test-writer` subagent
- Pass the acceptance criteria and requirements for the current phase.
- The test-writer will create comprehensive failing tests covering every acceptance criterion.
- Confirm the tests fail (red) before proceeding.

### Step 2 — GREEN: Delegate to `code-writer` subagent
- Pass the failing tests and acceptance criteria.
- The code-writer will implement the minimum production code to make all tests pass.
- Confirm the full test suite is green before proceeding (you must ensure *all* tests pass, even if any failing tests come from work outside the scope of this phase).

### Step 3 — REVIEW: Delegate to `code-reviewer` subagent
- The code-reviewer will verify that every acceptance criterion is met, check code quality, spot bugs, and review test coverage. Aim for concise code.
- If the reviewer flags **critical** issues, delegate back to the appropriate agent (test-writer or code-writer) to fix them, then re-review.
- Only proceed once the reviewer returns APPROVED.

## Completion

1. Mark the phase's checkbox with an X to indicate it is complete.
2. Commit all changes with a descriptive commit message.
3. Report a summary of what was done.
