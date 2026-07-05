---
name: guard
description: Monitor a herdr pane and auto-respond to questions during workflows
allowed-tools: guard, respond, herdr, ask_user_question
---

# Guard

## Instructions

### 1. Start monitoring

**推荐直接传 pane ID（最可靠）：**

`/skill:guard w1:p1` → 立即调用 `guard(pane="w1:p1")`

**也支持自然语言（尽量使用 ID）：**

如果描述像 "右边的 pane"、"第2个 pane"：

1. 用 `herdr list` 列出当前标签页的所有 pane
2. 按描述尽量匹配（注：列表顺序可能不反映视觉布局）
3. 匹配到就调用 `guard(pane=<id>)`
4. 匹配不到或不确定 → 提示用 pane ID 重试

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
