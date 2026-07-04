---
date: 2026-07-04T21:05:46+0800
author: unknown
commit: no-commit
branch: no-branch
repository: unknown
topic: "herdr pane 值守代理"
tags: [research, codebase, herdr, guardian, rpiv, pi-extension]
status: ready
last_updated: 2026-07-04T21:05:46+0800
last_updated_by: unknown
---

# Research: herdr pane 值守代理

## Research Question

如何构建一个 pi 扩展 + skill 组合的「值守代理」系统，使其能持续监控 herdr pane 输出，检测 `ask_user_question` 和自然语言等待提示，自动捕获上下文并调用 LLM 决策，然后通过 herdr CLI 响应。

## Summary

研究覆盖 20+ 个关键文件，跨越 5 层：pi-herdr 工具的长轮询/AbortSignal 模式、ask_user_question 的 TUI 渲染与事件契约、rpiv-workflow 的 JSONL 审计日志模式、rpiv-pi 的扩展注册与 sibling 系统、以及项目结构约定。核心结论：值守代理可使用 pi-herdr 的 `watch`/`wait_agent` 模式作为模板，复用 `tryAppendJsonl` 故障安全写入协议，通过解析 pane 输出中的工具调用参数来重建 ask_user_question 选项（因为 TUI overlay 文本不可见），并使用 `herdr send-keys` 导航 + `herdr send-text` 输入来实现响应。

## Detailed Findings

### pi-herdr 长轮询模式（核心模板）

`pi-herdr/index.ts` 注册了一个单块 `herdr` 工具，含 15 个 action（list/run/read/watch/wait_agent/send/stop 等）。最关键的两个模式：

**watch action** (`index.ts:524-589`)：通过 `execHerdrJson(["wait", "output", ...], signal)` 调用 herdr CLI 的 `wait output` 子命令，使用 `onUpdate` + `setInterval(publishWatchUpdate, 1000)` 发布心跳进度，`try/finally` 确保定时器清理。`signal`（AbortSignal） 贯穿 `execHerdr()` → `pi.exec("herdr", args, { signal })`，当并发 tool call 触发 abort 时，子进程被杀死并抛出 `"Aborted"`。

**wait_agent action** (`index.ts:596-677`)：纯 JS 轮询循环 `while(true)`，每 250ms 通过 `getPaneInfo()` 检查 agent 状态。关键守卫点：`throwIfAborted(signal, ...)` 在每次迭代顶部；`sleepWithSignal(250, signal)` 安装 abort 监听器以立即中断 sleep。

**AbortSignal 三层守卫机制** (`index.ts:419-441`)：

1. `throwIfAborted()` — 同步检查，快速退出
2. `sleepWithSignal()` — 异步 abort 监听器，清除 setTimeout 并 reject
3. `execHerdr()` 的 `signal?.aborted || result.killed` 检查 — 子进程级别的 abort

**renderCall/renderResult 渲染模式** (`index.ts:752-952`)：使用 `Text` 组件 + `theme.fg(colorName, text)` + `theme.bold()`。`isPartial` 标志驱动心跳状态行（如 `◌ watching server-pane (12s)`），`expanded` 标志驱动详情展开。`statusDot()` 函数 (`index.ts:445-457`) 将 AgentStatus 映射为主题色 Unicode 字符。

### ask_user_question 的事件与渲染

**事件契约** (`events.ts:22-48`)：`ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt"`，payload 包含 `questions[]`（每个有 `question`/`header`/`multiSelect`/`options[]`）。事件通过 `pi.events.emit()` 分发，**不跨 pane 传播**。

**TUI overlay 渲染** (`ask-user-question.ts:73-87`)：`ctx.ui.custom()` 创建一个全屏覆盖层，选项列表通过 `WrappingSelect` 渲染。关键是：**overlay 文本不写入 pane 的 scrollback/转录输出** — `herdr read` 看不到选项编号和选中状态。

**结果包络** (`tool/response-envelope.ts:21-31`)：`buildQuestionnaireResponse()` 产出 `"User has answered your questions: \"Q1\"=\"A1\"..."` 或 `"User declined to answer questions"`。这个文本会出现在 pane 输出中。

**检测策略**：guardian 必须从 agent 转录中解析 `ask_user_question` 工具调用的 JSON 参数（包括 `questions[]` 和 `options[]`），而非从事件或 UI 读取。关键识别模式是工具名称 `ask_user_question` 在转录中作为独立的工具调用标记出现。

### 跨 pane 键盘导航

`ask_user_question` 的键盘绑定 (`key-router.ts:4-7`)：

- `↑/↓` — 导航选项
- `Enter` — 确认选择
- `Space` — 多选切换
- `Esc` — 取消

导航模型 (`key-router.ts:98-108`)：

- 单选无预览：`items = [option_0, ..., option_{M-1}, other("Type something.")]`
- 单选有预览：`items = [option_0, ..., option_{M-1}]`（无 "Type something."）
- 多选：`items = [option_0, ..., option_{M-1}, next("Next")]`

初始状态：`optionIndex: 0`、`chatFocused: false`、`inputMode: false` (`questionnaire-session.ts:17-29`)。

**respond 工具**需通过 `herdr send-keys <paneId> Down` × N + `herdr send-keys <paneId> Enter` 导航到目标选项。对于 text 输入，需先导航到 "Type something." 行（index M），然后 `herdr send-text <paneId> <text>` + `herdr send-keys <paneId> Enter`。

### JSONL 审计日志模式

**故障安全写入协议** (`rpiv-workflow/state/writes.ts:21-31`)：

```typescript
function tryAppendJsonl(cwd, runId, row) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + "\n");
  // try/catch → console.warn → return false
}
```

**SessionRef** (`rpiv-workflow/state/state.ts:55-66`)：通过 `ctx.sessionManager.getSessionId()` 和 `getSessionFile()` 捕获，写入每条审计记录作为会话标识。

**Guardian 的 JSONL 行结构**（建议）：

```
eventNumber (monotonic), ts (ISO-8601), session (SessionRef)
eventType: "ask_user_question" | "pattern_match" | "stall_detect"
triggerContext: { pane: { pane_id, workspace_id, tab_id, alias? }, text }
analysisChain?: string (LLM 推理)
responseSent?: string (发送的响应内容)
```

**恢复机制**：guardian 的 resume 与 rpiv-workflow 的 fold 不同，因为没有 `RunState` 需要重建。恢复策略：

1. 快速路径：从 branch replay 恢复（类似 pi-herdr 的 `reconstructState`）
2. 降级路径：从 JSONL 审计文件中读取最新的 pane 引用

### 扩展架构

**注册模式**：所有 rpiv 扩展使用 `export default function (pi: ExtensionAPI)` + `pi.registerTool()`。guardian 需注册两个工具（`guard_pane`、`respond`），通过模块级 `Map<string, { paneId, abortController }>` 共享状态。

**双工具状态共享**：`guard_pane` 工具创建监控循环并存储 `AbortController`，`respond` 工具读取该映射以定位目标 pane 并发送响应。需类似 pi-herdr 的 `reconstructState` 模式来从会话历史恢复状态。

**Sibling 注册表** (`siblings.ts:31-81`)：所有 `@juicesharp` 包通过此注册表实现缺失检测和 `/rpiv-setup` 安装。建议：

- 将 `@juicesharp/rpiv-guardian` 加入 sibling 列表（PR 到 rpiv-pi）
- 在 guardian 自身扩展中独立检测 `@ogulcancelik/pi-herdr` 是否安装
- `package.json` 中声明 `"peerDependencies": { "@ogulcancelik/pi-herdr": "*" }`

**技能流程** (`skill-contracts-source.ts`)：SKILL.md 通过 `package.json` 的 `"pi"."skills"` 声明。guardian 的 `/skill:guard` 技能无 stage graph（不同于 rpiv-workflow），通过 SKILL.md 正文指示 agent 调用 `guard_pane` 工具。

### 项目结构（rpiv 包模板）

**位置**：`~/projects/rpiv-guardian/`（独立仓库）或 `rpiv-mono/packages/rpiv-guardian/`

**结构模板**（参照 `@juicesharp/rpiv-args`）：

```
rpiv-guardian/
├── index.ts           # 扩展入口
├── guardian.ts        # 核心工具注册
├── respond.ts         # respond 工具
├── config.ts          # 配置/类型
├── events.ts          # 事件契约
├── package.json
├── README.md
└── LICENSE
```

**package.json 关键字段**：`"type": "module"`、`"pi": { "extensions": ["./index.ts"] }`、`"files": ["*.ts", "README.md", "LICENSE"]`、`"scripts": { "test": "vitest run" }`

## Code References

- `pi-herdr/index.ts:524-589` — watch action（长轮询 + AbortSignal + onUpdate）
- `pi-herdr/index.ts:596-677` — wait_agent action（多 pane 轮询 + sleepWithSignal）
- `pi-herdr/index.ts:419-441` — sleepWithSignal/throwIfAborted 守卫机制
- `pi-herdr/index.ts:445-457` — statusDot() 渲染函数
- `pi-herdr/index.ts:752-800` — renderCall 渲染模式
- `pi-herdr/index.ts:802-952` — renderResult 渲染模式
- `rpiv-ask-user-question/events.ts:22-48` — ASK_USER_PROMPT_EVENT 契约
- `rpiv-ask-user-question/ask-user-question.ts:58-105` — 工具注册 + ctx.ui.custom() overlay
- `rpiv-ask-user-question/state/questionnaire-session.ts:17-29` — initialState()
- `rpiv-ask-user-question/state/key-router.ts:4-7` — 键盘绑定
- `rpiv-ask-user-question/state/key-router.ts:98-108` — 导航循环逻辑
- `rpiv-ask-user-question/tool/response-envelope.ts:21-31` — 结果包络
- `rpiv-ask-user-question/tool/types.ts:5-6` — MIN_OPTIONS=2, MAX_OPTIONS=4
- `rpiv-ask-user-question/state/row-intent.ts:87-120` — sentinel 行定义
- `rpiv-workflow/state/writes.ts:21-31` — tryAppendJsonl 故障安全写入
- `rpiv-workflow/state/state.ts:55-66` — SessionRef 类型
- `rpiv-pi/extensions/rpiv-core/siblings.ts:31-81` — SIBLINGS 注册表
- `rpiv-pi/extensions/rpiv-core/skill-contracts-source.ts` — 技能发现流程
- `rpiv-pi/extensions/rpiv-core/index.ts:27-76` — 扩展入口模式

## Integration Points

### 依赖关系

- `@ogulcancelik/pi-herdr` — 通过 `pi.exec("herdr", args)` 实现 pane 操作
- `@juicesharp/rpiv-ask-user-question` — 被监控 pane 中的 ask_user_question 工具
- `rpiv-pi` sibling 系统 — 安装检测和 `/rpiv-setup` 集成

### 事件线

- Guardian 不能直接接收 `rpiv:ask-user:prompt` 事件（不跨 pane）
- 必须通过 `herdr read` 轮询 pane 输出来检测工具调用

### 状态共享

- `activeWatches: Map<string, { paneId, abortController }>` — guard_pane 和 respond 工具共享
- 类似 pi-herdr 的 `managedPanes` + `reconstructState` 模式

## Architecture Insights

### 值守循环架构

```
guard_pane 工具 execute() 
  → 接收 AbortSignal (来自 Pi 的 tool call 机制)
  → while(true) 轮询:
      1. throwIfAborted(signal)
      2. Promise.all([getPaneInfo, readPane]) 并行轮询
      3. 三种检测策略处理
      4. debounced onUpdate (检测到事件时通知 LLM)
      5. sleepWithSignal(250, signal)
  → try/finally 清理定时器
```

### 跨 pane 响应架构

```
respond 工具 execute()
  → 解析 LLM 决策结果（选项索引或文本）
  → 计算键盘导航序列（↓ × N 到目标选项）
  → herdr send-keys 发送导航
  → herdr send-text + send-keys Enter 发送文本
  → 或 herdr send-keys Enter 确认选项
```

### 审计架构

```
每次检测到事件:
  → 构建 GuardianRow (eventNumber, ts, session, eventType, triggerContext, analysisChain, responseSent)
  → tryAppendJsonl(cwd, runId, row) 写入 .rpiv/artifacts/guardian/<runId>.jsonl
  → 故障安全: 失败仅 console.warn，不中断值守循环
```

## Precedents & Lessons

git history unavailable — 0 past changes analyzed.

## Historical Context (from `.rpiv/artifacts/`)

- `.rpiv/artifacts/discover/2026-07-04_20-37-32_herdr-pane-guardian.md` — 特性需求文档

## Developer Context

**Q (discover: 用户定位):** 值守代理的目标用户是谁？核心使用场景是什么？
A: 我自己的开发助手

**Q (discover: 交付形态):** 功能以什么形式交付？
A: Extension + Skill 组合

**Q (discover: 功能范围):** 核心目标和非目标
A: 包含持久化和历史日志

**Q (discover: 检测策略):** 如何检测被监控 pane 需要人工介入？
A: 综合策略 + rpiv 专用监听

**Q (discover: rpiv 专用监听):** 针对哪些 rpiv 工具做专门监听？
A: wf / discover / implement / blueprint / design / plan

**Q (discover: 决策依据):** 值守代理做出决策的依据是什么？
A: 计划文档 + LLM 自主判断

**Q (discover: 异常处理):** 值守代理遇到不确定的情况怎么办？
A: 多角度分析，根据需求/文档确定响应

**Q (discover: 日志粒度):** 记录到什么粒度的日志？
A: 完整审计日志

**Q (discover: 配置方式):** 值守代理如何配置？
A: 命令行参数

**Q (discover: 性能要求):** 轮询和资源消耗的期望？
A: 灵活可调

**Q (discover: LLM 选择):** 值守决策使用哪个 LLM？
A: 可配置

**Q (discover: Pane 通信方式):** 如何跨 pane 通信？
A: 使用 pi-herdr 的 read/run/send/watch 工具

## Open Questions

（无 — 所有问题已在研究检查点确认）

## Related Research

- `.rpiv/artifacts/discover/2026-07-04_20-37-32_herdr-pane-guardian.md`
