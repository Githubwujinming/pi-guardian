---
name: guard
description: Monitor a herdr pane and auto-respond to questions during workflows
allowed-tools: guard, respond, herdr, ask_user_question, Write
---

# Guard

## ⚠️ 硬性规则

- **`$ARGUMENTS` 是 pane ID → 直接调 `guard(pane="$ARGUMENTS")`**
- **`$ARGUMENTS` 是 pane ID + 文档路径** → 调 `guard(pane="paneId", context="doc1.md,doc2.md")`
- **`$ARGUMENTS` 为空 → 必须先用 `ask_user_question` 让用户选择**
- 禁止自己分析/决定 pane
- **禁止关闭被监控的 pane** — 任何时候都不要用 `herdr stop` 或 `pane close` 关闭 worker 的 pane

## 可用参数

`guard` 工具支持的参数：

| 参数 | 类型 | 默认值 | 说明 |
| ------ | ------ | -------- | ------ |
| `pane` | string | 必填 | 要监控的 pane ID |
| `context` | string | — | 参考文档路径，多个用逗号分隔（如 `plan.md,design.md`）。需要决策时 agent 可用 `read` 工具按需读取 |
| `interval` | number | 500 | 轮询间隔 ms |
| `timeout` | number | — | 自动停止时间 ms |
| `patterns` | string[] | — | 自定义正则模式

## Steps

### 1. 确定 pane

```
$ARGUMENTS = ""?       → ask_user_question(列出所有 pane) → 用户选 → guard(pane=...)
$ARGUMENTS = "w1:p1"?   → guard(pane="w1:p1")
$ARGUMENTS = "w1:p1 plan.md,design.md"?   → guard(pane="w1:p1", context="plan.md,design.md")
```

### 2. 值守循环

调用 `guard(pane=...)` 后，工具会自动处理：

- next-step → 提取 `/skill:xxx` 并执行
- 确认提示（Enter、(Y/N)）→ 自动发 Enter
- 例行动作（verdict、follow-up 无命令）→ 静默确认
- 问句、选择题、stall → 返回给 agent 决策

事件返回时，`details` 包含：

- `details.event` — 事件类型
- `details.context` — 最近 4000 字符输出
- `details.elapsed` — 值守秒数

**决策规则：**

- 问句 → 分析选项，调 `respond(pane=..., optionIndex=N)`
- stall → `herdr read` 探索后决策
- **参考文档**：如果 `context` 中列出了文档路径，需要时可调用 `read <path>` 读取完整内容辅助决策
- 其他 → 恢复值守

### 3. 不确定时

按顺序尝试，禁止跳过：

1. **探索** — `herdr read <pane>` 读取更多输出
2. **分析** — 输出通常包含答案
3. **行动** — `respond()` 发送命令
4. **问 worker** — `respond(pane=..., text="what should I do?")`
5. **问用户** — 仅当以上都失败

### 4. 恢复值守

调完 respond 后，立即调 `guard(pane=...)` 继续。

### 5. 任务完成时输出报告

当 worker 长时间空闲（stall 后无新任务）、或用户明确要求停止时：

用 `Write` 工具在 `.guardian/` 目录下创建值守报告：

```
.guardian/report-<日期时间>.md
```

报告内容：

- 值守起止时间、监控的 pane
- 自动执行了哪些命令（next-step）
- 检测到了哪些事件（auto-respond、agent 决策）
- 回答了什么问题
- 最终状态

报告文件使用 markdown 格式，方便查看。
