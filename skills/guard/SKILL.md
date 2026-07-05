---
name: guard
description: Monitor a herdr pane and auto-respond to questions during workflows
allowed-tools: guard, respond, herdr, ask_user_question
---

# Guard

## Instructions

### 1. Start monitoring

**如果 $ARGUMENTS 为空（没指定 pane）：**

用 `herdr list` 列出当前标签页的所有 pane（ID、别名、目录），让用户选择。

**如果 $ARGUMENTS 是 pane ID 或别名：**

直接调用 `guard(pane="$ARGUMENTS")`，不要列列表、不要确认、不要解释。

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

### 3. When uncertain (MUST try before asking the user)

**禁止直接问用户。必须先尝试以下步骤：**

1. **Explore**: Use `herdr read <pane>` to read more of the worker's output
2. **Analyze**: The worker's output usually contains the answer — read it carefully
3. **Act**: If you understand what needs to be done, call `respond(pane=<pane>, text="<command>")` to send the appropriate command to the worker
4. **Ask the worker**: Call `respond(pane=<pane>, text="what should I do?")` — the worker agent will respond with instructions
5. **Ask the user**: If ALL of the above failed and you're truly unable to determine the correct action, then ask the user

**Remember:** You are an autonomous guard. Your job is to keep the workflow moving without user intervention. Every time you ask the user, you've failed your primary purpose.

### 4. Resume

After responding, immediately call `guard(pane="$ARGUMENTS")` again. Keep the loop going.

## Notes

- Never modify files in the monitored pane
- Auto-respond handles: next-step execution, Enter confirmations, routine status events
- You only see events that need LLM judgment
