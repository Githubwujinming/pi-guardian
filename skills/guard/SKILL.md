---
name: guard
description: >
  Monitor a herdr pane and auto-respond to questions and prompts.
  Deploy in one pane to watch another — the agent runs a continuous
  guard loop: monitor → detect → escalate → decide → respond → repeat.
allowed-tools: Agent, ask_user_question, Write, herdr, guard_pane, respond
---

# Guard

Monitor a herdr pane and auto-respond to questions and prompts during
development workflows. Run `/skill:guard --pane <id>` in one pane to
watch another pane.

## Input

`$ARGUMENTS` — parameters in `--key value` format.

- `--pane <id>` (required) — Pane ID or alias to monitor
- `--plan <path>` (optional) — Plan document path for context (the agent references it)
- `--interval <ms>` (optional) — Polling interval in ms (default 500)
- `--patterns <regex>` (optional) — Additional regex patterns (comma-separated)
- `--timeout <ms>` (optional) — Stop monitoring after this many ms

## Steps

### Step 1: Parse Parameters

Extract `--pane`, `--plan`, `--interval`, `--patterns`, `--timeout` from `$ARGUMENTS`.

### Step 2: Start Guard Loop

Call `guard_pane(pane=<pane>, plan=<plan>, interval=<interval>, patterns=<patterns>, timeout=<timeout>)`.

This tool blocks and monitors the target pane. It will:
- **Auto-respond** to simple confirmation prompts (Enter)
- **Return** detected events to you when LLM decision is needed
- **Stall-detect** when the pane has no output for 30s
- **Subagent-detect** and extend stall threshold when agent delegates to subagents

### Step 3: Analyze and Respond

When `guard_pane` returns an event:

1. **Analyze `details.event`** — see the detected pattern and `details.context` for recent output
2. **Consult the plan** (if provided) — read `details.planPath` to determine next action
3. **Decide and use `respond`**:
   - Single option: `respond(pane=<pane>, optionIndex=N)`
   - Multiple options: `respond(pane=<pane>, options=[0, 2])`
   - Text input: `respond(pane=<pane>, text="your input")`

### Step 4: Resume Monitoring

After responding, call `guard_pane(…)` again with the same parameters to continue.

Repeat Steps 3-4. Stop when:
- The user tells you to stop
- The monitored pane's task is complete
- You determine no further action is needed

### Step 5: Stopping

To stop, simply stop calling `guard_pane`. The loop ends when the tool
returns a `stopped: true` event (timeout, pane unreachable, or abort).

If the user requested an explicit stop, acknowledge it and explain that
no further monitoring is active.

## Important Notes

- **Minimal auto-respond**: Only Enter for confirmations; everything else
  needs your LLM judgment. This avoids infinite response loops.
- **Subagent awareness**: When the monitored agent dispatches a subagent,
  stall detection extends to 5 minutes automatically.
- **Event dedup**: The same pattern won't retrigger within 15 seconds.
- **Pane disappearance**: After 5 consecutive read failures, the watch
  stops and returns a stopped event.
- **Never modify files** in the monitored pane — only send responses.
- **Always resume monitoring** after responding unless the task is done.
