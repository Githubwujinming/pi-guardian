---
name: guard
description: Monitor a herdr pane and auto-respond to questions during workflows
allowed-tools: guard, respond, herdr, ask_user_question
---

# Guard

## ⚠️ 硬性规则

- **`$ARGUMENTS` 是 pane ID** → 直接调 `guard(pane="$ARGUMENTS")`
- **`$ARGUMENTS` 是 pane ID + 文档路径** → 调 `guard(pane="paneId", context="doc1.md,doc2.md")`
- **`$ARGUMENTS` 是文档路径（不含 pane ID）** → 先用 `ask_user_question` 让用户选 pane，再调 `guard(pane=..., context="docs")`
- **`$ARGUMENTS` 为空** → 先用 `ask_user_question` 让用户选 pane
- 禁止自己分析/决定 pane
- **禁止关闭被监控的 pane** — 任何时候都不要用 `herdr stop` 或 `pane close` 关闭 worker 的 pane
- **禁止修改 worker 的任何文件** — 包括代码、文档、配置文件等。只通过 `respond` 发送指令
- **补充参考文档**：值守期间用户提到的文档路径记下来，并在下次调 `guard()` 时传回 `context` 参数，所有累计文档都会显示在界面上

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
$ARGUMENTS = ""?                         → 列 pane 让用户选 → guard(pane=...)
$ARGUMENTS = "plan.md"?                    → 先列 pane 让用户选, 再 guard(pane=..., context="plan.md")
$ARGUMENTS = "w1:p1"?                     → guard(pane="w1:p1")
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

- **选项选择** → 分析选项，调 `respond(pane=..., optionIndex=N)`，**注意 N 是 0-based**（显示为 `1. 选项A` → index=0，显示为 `2. 选项B` → index=1，以此类推）
- **文本输入提示**（匹配 `prompt-input` 模式，如"请输入""请提供""请告诉我""输入文件路径"等）→ 分析 worker 需要什么内容，从上下文/历史对话/现有文件中提取，调 `respond(pane=..., text="...")` 发送文本，**不要使用 `optionIndex`**
- **worker 任务失败但 agent 仍在运行**（检测到 `Error:`、`failed`、`stopping workflow` 等关键字段，但 pane 仍有 pi 提示符/光标）→ 分析失败原因，通过 `respond(pane=..., text="<正确指令>")` 向 worker 发送新指令重新执行
- stall → `herdr read` 探索后决策。用语义理解分析 worker 输出中是否有下一步工作指令：

  1. **语义强度判断** — 识别是否以执行为目的的明确指令（如"下一步执行""接下来请运行"等），排除可选语气/限定语气的表述（如"可以考虑""建议……如果你愿意""从新会话开始"）
  2. **上下文一致性判断** — 将识别到的指令与 `context` 参数传入的文档（plan.md、FRD 等）进行对比，确认该指令是当前工作目标的延续而非无关建议
  3. **语义存疑时** — 调 `respond(pane=..., text="what should I do next?")` 先问 worker，而不是直接问用户

  只有以上三步都无法确定时才问用户。
- **参考文档**：启动时 `context` 参数传入的文档 + 值守期间用户补充的文档，都需要时用 `read` 读取分析
- 其他 → 恢复值守

### 3. 不确定时

按顺序尝试，禁止跳过：

1. **探索** — `herdr read <pane>` 读取更多输出
2. **分析** — 输出通常包含答案
3. **行动** — `respond()` 发送命令
4. **问 worker** — `respond(pane=..., text="what should I do?")`
5. **问用户** — 仅当以上都失败。注意：worker 在等输入、或 worker 任务失败但 agent 还在运行时，不属于"以上都失败"——应参考决策规则中的文本输入/任务恢复规则处理

### 4. 恢复值守

调完 respond 后，立即调 `guard(pane=..., context="所有已累计的文档路径")` 继续。把所有已知的参考文档路径（启动时传入 + 运行时补充）都传回 `context`，工具会更新显示。

### 5. 任务完成时输出报告

当 worker 长时间空闲（stall 后无新任务）、或用户明确要求停止时：

用 `bash` 在 `.guardian/` 目录下创建值守报告：

```bash
cat > .guardian/report-<日期时间>.md << 'EOF'
# 值守报告
...
EOF
```

报告内容：

- 值守起止时间、监控的 pane
- 自动执行了哪些命令（next-step）
- 检测到了哪些事件（auto-respond、agent 决策）
- 回答了什么问题
- 最终状态

报告文件使用 markdown 格式，方便查看。
