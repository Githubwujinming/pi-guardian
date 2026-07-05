---
name: guard
description: Monitor a herdr pane and auto-respond to questions during workflows
allowed-tools: guard, respond, herdr, ask_user_question
---

# Guard

## Instructions

### 1. Start monitoring

`$ARGUMENTS` is the pane ID. Call `guard(pane="$ARGUMENTS")` immediately.

### 2. Handle events

When `guard` returns an event:

- `details.event` — what was detected
- `details.context` — last 4000 chars of worker output
- `details.elapsed` — seconds elapsed

**Decision rules:**

| Pattern | Action |
| --------- | -------- |
| `generic-question`, `choice-prompt`, `prompt-input`, `chinese-question` | Worker is asking a question. Read `details.context`, find options, call `respond(pane=..., optionIndex=N)` or `respond(pane=..., text="...")` to answer |
| `stall-fallback` | 30s no output. Read `details.context` — if worker is waiting for input, answer it. If just thinking, resume monitoring |
| other patterns | Already auto-handled by guard tool. Just resume monitoring |

### 3. When uncertain

If `details.context` doesn't have enough information to decide:

1. **Explore**: Use `herdr read <pane>` to read more of the worker's output, or `herdr list` to check pane status
2. **Ask the worker**: If you need the worker to do something specific, call `respond(pane=<pane>, text="your message")` — the worker agent will see it as user input
3. **Ask the user**: Only if truly blocked, use `ask_user_question` with clear options

### 4. Resume

After responding, immediately call `guard(pane="$ARGUMENTS")` again. Keep the loop going.

## Notes

- Never modify files in the monitored pane
- Auto-respond handles: next-step execution, Enter confirmations, routine status events
- You only see events that need LLM judgment
