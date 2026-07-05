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

`$ARGUMENTS` — pane ID 或自然语言描述。

示例：`w1:p1`、`左边的 pane`、`第2个 pane`、`--pane w1:p1 --plan plan.md`

参数格式（用于 Step 1 规则 A）：
`--pane <id>` 或 `--pane <id> --plan <path> --interval <ms>`

## Steps

### Step 1: Parse $ARGUMENTS

**一次检查，先命中的规则直接执行，不再检查后面的规则。**

---

**规则 1：$ARGUMENTS 是 pane ID（如 `w1:p1`）或包含 `--pane`**

检查方法：

- 如果 `$ARGUMENTS` 整个就是一个 pane ID（匹配 `w1:p` 或 `w1p` 模式）→ 直接作为 pane
- 如果 `$ARGUMENTS` 包含 `--pane` → 提取 `--pane` 后面的单词作为 pane

执行：

```
1. 提取 pane ID
2. 调用 guard_pane(pane=提取到的paneId)
3. 直接跳到 Step 2，禁止任何额外操作
```

**禁止：** 列 pane 列表、用 herdr list、问用户、查布局、输出使用说明。
**即使 paneId 不存在也直接传——tool 自己会报错。**

---

**规则 2：用户说"继续"或"resume"（恢复模式）**

从会话历史找上次 `guard_pane` 调用的参数，直接调用。
如果用户同时指定了不同 pane（如"继续值守右边的"），先按规则 3 解析。

---

**规则 3：自然语言描述**

1. 用 herdr list 获取所有 pane
2. 匹配描述：左边的/右边的/第N个/别名/用途
3. 无法确定才问用户

### Step 2: Start Guard Loop

Call `guard_pane(pane=<pane>, plan=<plan>, interval=<interval>, patterns=<patterns>, timeout=<timeout>)`.

This tool blocks and monitors the target pane. It will:

- **Auto-respond** to simple confirmation prompts (Enter)
- **Return** detected events to you when LLM decision is needed
- **Stall-detect** when the pane has no output for 30s
- **Subagent-detect** and extend stall threshold when agent delegates to subagents

### Step 3: Analyze and Auto-Respond (IMPERATIVE — DO NOT ASK)

**黄金法则：值守 agent 必须自动响应。永远不要问用户"做什么"。**

当 `guard_pane` 返回事件时，按以下规则自动处理：

| 事件类型 | 你的动作 |
| --- | --- |
| `next-step` / `rpiv-chain-forward` | 从 `details.context` 中提取 `/skill:xxx` 命令，调用 `respond(pane=<pane>, text="<command>")` 自动执行下一步 |
| `question-end` / `chinese-question` / `choice-prompt` | 工作 agent 在问问题。从 `details.context` 中读取选项，选择最合适的，调用 `respond(pane=<pane>, optionIndex=N)` 回答。如需文本输入则用 `respond(pane=<pane>, text="...")` |
| `stall_detected` | 30s 无输出变化。读取 `details.context`，判断 agent 是否在等待输入。如果是则分析并响应；如果只是在思考则继续值守 |
| `follow-up` / `implement-done` / `implement-complete` / `completion-summary` | 例行摘要——无需操作。继续值守 |

**绝对禁止：**

- ❌ 问"需要我做什么"或"是否需要我..."
- ❌ 列出选项让用户选择（"1.继续值守 2.停止值守"）
- ❌ 总结情况后等待用户命令
- ❌ 任何形式的请示

**必须的行为是：** 检测 → 响应 → 恢复值守。不问问题。

### Step 4: Resume Monitoring (AUTOMATIC)

调用 `respond()` 后，**立即**再次调用 `guard_pane(…)` 恢复值守。

形成自主循环：监控 → 检测 → 响应 → 恢复 → 监控...

**停止值守的条件（仅限）：**

- 用户明确要求停止
- 被监控的 pane 已关闭或不可达
- `stall_detected` 且 agent 确实已空转（检查上下文后确认）

**不要在单个任务完成后停止。不要问用户任何问题。**

### Step 5: Stopping

To stop, simply stop calling `guard_pane`. The loop ends when the tool
returns a `stopped: true` event (timeout, pane unreachable, or abort).

If the user requested an explicit stop, acknowledge it and explain that
no further monitoring is active.

## Important Notes

- **Auto-respond (tool level)**: confirm-prompt/press-enter/yes-no → Enter; next-step/rpiv-chain-forward → auto-executes the suggested `/skill:xxx` command in the worker pane. These are handled without involving you.
- **Agent auto-continue**: For events that reach you, automatically proceed with the next step (call `respond`). Do NOT ask "what should I do" unless truly blocked.
- **Subagent awareness**: When the monitored agent dispatches a subagent,
  stall detection extends to 5 minutes automatically.
- **Event dedup**: The same pattern won't retrigger within 15 seconds.
- **Pane disappearance**: After 5 consecutive read failures, the watch
  stops and returns a stopped event.
- **Never modify files** in the monitored pane — only send responses.
- **Always resume monitoring** after responding unless the task is done.
