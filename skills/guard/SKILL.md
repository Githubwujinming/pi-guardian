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

#### 情况 A：$ARGUMENTS 包含 `--pane`（显式指定）

**直接解析，不做任何额外操作：**

1. 从 `$ARGUMENTS` 中提取 `--pane <value>` 作为 pane ID
2. 同样提取 `--plan`、`--interval`、`--patterns`、`--timeout`（如果有）
3. **直接跳到 Step 2**，调用 `guard_pane(pane=<value>, ...)`
4. **禁止：** 列 pane 列表、确认 pane 是否存在、问用户、查布局。**直接调用。**

#### 情况 B：用户说"继续"或"resume"

1. 从会话历史中查找上一次 `guard_pane` 工具调用的参数（pane, plan, interval 等）
2. 如果用户指定了不同的 pane（如"继续值守右边的 pane"），用情况 C 的方法解析
3. 直接调用 `guard_pane(pane=<pane>, plan=<plan>, ...)`——不需要问用户

#### 情况 C：自然语言描述

1. 用 `herdr list` 获取所有 pane
2. 按以下规则匹配：
   - `左边的` / `右边的` → pane 列表中的第 1/2 个
   - `第N个` → 列表中的第 N 个（1-based）
   - `正在运行 X 的` → 按别名/状态过滤
   - `别名/ID` → 直接匹配
3. 如果无法确定，用 `ask_user_question` 澄清。**但仅限自然语言模式。**

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
