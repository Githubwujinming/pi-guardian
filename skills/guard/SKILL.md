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

当 `guard` 返回事件时，`details` 包含以下字段：

- `event` — 事件类型（pattern_match / stall_detected）
- `context` — 最近 4000 字符的 pane 输出（含完整的问答选项）
- `elapsed` — 值守已运行秒数

**必须的响应逻辑（不要问用户）：**

| `details.event.patternName` | 含义 | 你的动作 |
| --- | --- | --- |
| `generic-question` / `question-end` / `chinese-question` | worker 在问问题 | 从 `details.context` 中读取选项，调用 `respond(pane=..., optionIndex=N)` 选择最合适的选项。如果选项中有`(推荐)`标记的优先选择 |
| `choice-prompt` / `prompt-input` | worker 在等待输入 | 分析上下文，调用 `respond(pane=..., text=...)` 提供合适的输入 |
| `stall-fallback` | 30s 无新输出 | 检查 `details.context` 是否包含未回答的问题。如果有则回答；如果只是等待任务完成则恢复值守 |
| `implement-verdict` / `implement-phase-result` 等 | 例行状态 | 无需操作，恢复值守 |

`details.context` 内容示例（worker 在问问题）：

```
要验证哪个计划？
❯ 1. test-guard-2phase.md (推荐)
  2. test-guard-simple.md
```

→ 应调用 `respond(pane=..., optionIndex=0)` 选择第一个选项

### Step 4: 立即恢复值守

任何时候处理完事件后，立即调用 `guard(pane=<pane>)` 继续监控。不要等用户确认。

### 绝对禁止

- ❌ 问用户"需要我做什么"
- ❌ 列出选项让用户选择
- ❌ 总结情况后等待命令

## Important Notes

- **guard 工具**自动处理 next-step 执行、Enter 确认、例行动作
- **只返回**需要 LLM 判断的事件给 agent
- **Event dedup**: 相同模式 15s 内不会重复触发
- **Pane disappearance**: 连续 5 次读取失败后自动停止
