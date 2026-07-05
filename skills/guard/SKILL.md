---
name: guard
description: >
  Monitor a herdr pane and auto-respond to questions and prompts.
  Deploy in one pane to watch another — the agent runs a continuous
  guard loop: monitor → detect → respond → resume.
allowed-tools: Agent, ask_user_question, Write, herdr, guard_pane, respond, guard
---

# Guard

Monitor a herdr pane and auto-respond to questions and prompts during
development workflows. Supports natural language input — you can say
"监控左边的 pane" or "监控第 2 个 pane" and the agent will resolve
it to the correct pane ID automatically.

## Input

`$ARGUMENTS` — pane ID 或自然语言描述。

示例：`w1:p1`、`左边的 pane`、`第2个 pane`

## Steps

### Step 1: 确定 pane ID

如果 `$ARGUMENTS` 是 pane ID（`w1:pX` 或 `w1pX` 格式），直接使用。

如果是自然语言，用 `herdr list` 查找匹配的 pane。

如果无法确定，用 `ask_user_question` 澄清。

### Step 2: 启动值守

调用 `guard(pane=<paneId>)`。

工具会自动运行监控循环：

- `next-step` / `rpiv-chain-forward` → 自动执行 `/skill:xxx` 命令
- `confirm-prompt` / `press-enter` / `yes-no` → 自动发 Enter
- `implement-done` / `follow-up` / completion-summary → 静默确认，继续值守
- 需要 LLM 决策的事件（问题、stall）→ 返回给 agent

### Step 3: 处理 LLM 事件

当 `guard` 返回事件时：

1. **分析事件**：查看 `details.event` 和 `details.context`
2. **自动响应**（不要问用户）：
   - 问问题 → `respond(pane=<pane>, optionIndex=N)` 或 `respond(pane=<pane>, text="...")`
   - stall → 检查上下文，判断 agent 是否需要输入
3. **立即恢复值守**：再次调用 `guard(pane=<pane>)`

### 绝对禁止

- ❌ 问用户"需要我做什么"
- ❌ 列出选项让用户选择
- ❌ 总结情况后等待命令

## Important Notes

- **guard 工具**自动处理 next-step 执行、Enter 确认、例行动作
- **只返回**需要 LLM 判断的事件给 agent
- **Event dedup**: 相同模式 15s 内不会重复触发
- **Pane disappearance**: 连续 5 次读取失败后自动停止
