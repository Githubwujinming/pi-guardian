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
development workflows. Supports natural language input — you can say
"监控左边的 pane" or "监控第 2 个 pane" and the agent will resolve
it to the correct pane ID automatically.

## Input

`$ARGUMENTS` — natural language description or `--key value` parameters.

When using natural language, describe which pane to monitor:
- **按位置**: `左边的 pane`, `右边的 pane`, `上面的`, `下面的`
- **按顺序**: `第1个 pane`, `第2个 pane`, `最后一个 pane`
- **按别名**: `监控 w1:p1`, `监控 server-pane`
- **按用途**: `监控正在运行 implement 的 pane`, `监控右边的那个 pane`

Explicit `--key value` parameters (for scripting / precise control):

- `--pane <id>` (required) — Pane ID or alias to monitor
- `--plan <path>` (optional) — Plan document path for context (the agent references it)
- `--interval <ms>` (optional) — Polling interval in ms (default 500)
- `--patterns <regex>` (optional) — Additional regex patterns (comma-separated)
- `--timeout <ms>` (optional) — Stop monitoring after this many ms

## Steps

### Step 1: Resolve Pane Reference

If `$ARGUMENTS` contains `--pane`, parse it directly (see Input section above).

Otherwise, interpret `$ARGUMENTS` as natural language and resolve the target pane:

1. **List available panes**: run `herdr list` to get all panes with their IDs,
   aliases, workspace/tab positions, and agent statuses.
2. **Map descriptions to pane IDs**:
   - `左边的` / `右边的`: Use the list ordering — panes are typically ordered
     left-to-right. The first pane is "左边的", the second is "右边的".
   - `第N个`: The Nth pane in the `herdr list` output (1-based).
   - `正在运行 X 的`: Filter by alias, agent status, or tab context.
   - `别名/ID`: Direct match against pane alias or ID.
3. **Ask the user if ambiguous**: If multiple panes match or you can't determine
   which pane is meant, use `ask_user_question` to clarify.

Once resolved, set `<pane>` to the pane ID.

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
