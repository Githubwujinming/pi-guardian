---
date: 2026-07-04T20:37:32+0800
author: unknown
commit: no-commit
branch: no-branch
repository: unknown
topic: "herdr pane 值守代理"
tags: [intent, frd, herdr, pane-guardian, rpiv]
status: ready
last_updated: 2026-07-04T20:37:32+0800
last_updated_by: unknown
---

# FRD: herdr pane 值守代理

## Summary

创建一个 pi 扩展 + skill 组合的「值守代理」系统。部署在某个 pi pane 中，持续监控另一个或一组 herdr pane 的输出。当被监控的 pane 需要人工决策或输入时（无论是通过 `ask_user_question` 工具还是自然语言等待提示），值守代理自动捕获上下文、参考预定义计划文档进行分析、调用 LLM 做出决策，然后自动回复到被监控 pane，实现无人值守的持续开发流程。

## Problem & Intent

用户（开发者本人）在多个 herdr pane 中并行工作。一个 pane 执行复杂任务（如 `implement` 蓝图、`blueprint` 设计、`/wf` 工作流），这些任务在执行过程中会多次停下来等待用户决策或指令（如「要开始 Phase 2 吗？请确认」）。用户希望将这些重复性的「确认-继续」工作自动化——让另一个 pane 值守，代替人做决策，用户只需关注更高层的设计和异常情况。

## Goals

- 值守代理能持续监控指定 herdr pane 的输出
- 能检测三类决策事件：`ask_user_question` 结构化问题、自然语言等待提示、agent 状态变化（working → idle 停滞）
- 能自动捕获被监控 pane 的完整上下文（近期输出、状态、计划信息）
- 能参考预定义的开发计划/文档进行多角度分析，自主决策如何响应
- 能自动发送响应到被监控 pane（包括选择选项、输入文本指令等）
- 能记录完整的值守审计日志（事件时间、上下文、分析过程、决策、响应）
- 针对 rpiv 工具套件（wf、discover、implement、blueprint、design、plan）有专门的监听和响应优化

## Non-Goals

- 不涉及用户鉴权、权限管理
- 不提供 Web UI（纯 pi TUI 生态）
- 不构建多用户协作系统
- 不替代用户做架构层面的设计决策（只处理执行层面的确认和选择）
- 不修改被监控 pane 的代码或文件（只通过 herdr send/run 交互）

## Functional Requirements

1. 系统 SHALL 提供一个 `guard_pane` 工具，用于启动对指定 pane 的值守监控
   - 参数 SHALL 包括：目标 pane ID/别名、计划文档路径（可选）、监听模式（可选）、轮询间隔（可选）、LLM 模型（可选）
2. 系统 SHALL 支持三种值守检测模式，可组合使用：
   - a. **状态变化检测**：检测被监控 pane 的 agent 状态从 working → idle
   - b. **输出模式匹配**：使用预定义或自定义的正则/关键词模式匹配 pane 输出
   - c. **输出停滞检测**：检测 pane 输出在一段时间内无变化
3. 系统 SHALL 内置针对 rpiv 工具套件的专用监听模式，至少覆盖：
   - `/implement` — 阶段切换提示（「要开始 Phase X 吗？」）、是否继续确认
   - `/blueprint` / `/design` / `/plan` — 架构决策问题、方案确认
   - `/discover` — `ask_user_question` 结构化问题
   - `/wf` — 工作流阶段切换、技能链执行完成
4. 系统 SHALL 提供 `respond` 工具，用于向被监控 pane 发送响应
   - 支持文本输入（对应「Type something.」）
   - 支持选项选择（对应 `ask_user_question` 的选项编号）
5. 系统 SHALL 在被监控 pane 触发 `ask_user_question` 时，通过 herdr read 捕获问题文本和选项，而非依赖跨 pane 事件（因为事件不跨 pane 传播）
6. 系统 SHALL 在检测到需要决策时，优先参考预定义的开发计划文档进行分析，再结合 LLM 自主判断
7. 系统 SHALL 记录完整审计日志到 `.rpiv/artifacts/guardian/` 目录，使用 JSONL 格式，每条记录包含：
   - 时间戳、事件类型、触发上下文
   - LLM 分析过程（可选级别）、决策结果、发送的响应
8. 系统 SHALL 提供 `/skill:guard` 作为用户入口 skill，用于：
   - 启动值守（`/skill:guard --pane <pane> --plan <path>`）
   - 查看值守状态（`/skill:guard --status`）
   - 停止值守（`/skill:guard --stop`）

## Non-Functional Requirements

- **Performance**: 监听轮询间隔可配置（默认 3 秒）。仅在检测到事件后才调用 LLM，LLM 调用次数受限于事件频率
- **Security**: 值守代理运行在 pi 的 TUI 环境中，不新增外部网络暴露。敏感信息（如计划文档）仅存储在本地
- **UX / Accessibility**:
  - 值守启动后应在 pane 状态栏显示值守指示器
  - 每次值守决策应在 pane 中输出简洁日志，用户可随时了解值守状态
  - 支持通过 `/skill:guard --stop` 随时终止
- **Reliability**:
  - 网络或 LLM 调用失败时重试最多 3 次
  - 检测机制应有防重复触发（dedup）逻辑，避免同一事件多次响应
  - 值守代理异常退出时应在日志中记录最后状态

## Constraints & Assumptions

- 值守代理和被监控 pane 是独立的 pi 实例，运行在同一个 herdr 工作空间内
- 通信只能通过 herdr CLI 进行（read/run/send/watch），事件不跨 pane 传播
- 值守代理依赖 `@ogulcancelik/pi-herdr` 扩展提供的 herdr pane 操作
- 假设用户在被监控 pane 中运行的技能会输出可预测的等待提示模式
- 假设用户提供计划文档时，文档在 `.rpiv/artifacts/plans/` 下遵循标准格式

## Acceptance Criteria

- [ ] 在 pane B 执行 `/skill:guard --pane w1:p1` 后，值守代理开始监控 pane A 的输出
- [ ] 当 pane A 调用 `ask_user_question` 时，值守代理能捕获问题内容并通过 LLM 决策自动选择
- [ ] 当 pane A 输出「要开始 Phase 2 吗？」时，值守代理能根据计划文档自动回复「开始 Phase 2」
- [ ] 值守代理的决策日志写入 `.rpiv/artifacts/guardian/<timestamp>.jsonl`
- [ ] 执行 `/skill:guard --stop` 后值守代理停止监控
- [ ] 值守代理配置不同的轮询间隔（1s / 5s / 10s）生效
- [ ] 值守代理可以指定不同的 LLM 模型进行决策
- [ ] 当计划文档中无法确定响应时，LLM 自主判断并记录原因

## Recommended Approach

Extension（名为 `@juicesharp/rpiv-guardian`）提供 `guard_pane` 和 `respond` 两个核心工具，利用 `pi-herdr` 的底层能力进行 pane 操作，通过 `pi.registerTool()` 注册。监听循环在工具内部实现（类似 `pi-herdr` 的 watch/wait_agent 模式）。同时提供 `/skill:guard` skill 作为用户入口，编排值守循环的启动/停止/状态查询。审计日志写入 `.rpiv/artifacts/guardian/` 目录的 JSONL 文件。整体遵循 rpiv 生态的扩展 + skill 组合模式。

## Decisions

### 1. 用户定位

**Question**: 值守代理的目标用户是谁？核心使用场景是什么？
**Recommended**: 我自己的开发助手 / 团队共享工具 / 运维值守场景
**Chosen**: 我自己的开发助手
**Rationale**: 个人在多个 pane 中并行开发，需要自动化处理重复性确认操作

### 2. 交付形态

**Question**: 功能以什么形式交付？
**Recommended**: Extension + Skill 组合
**Chosen**: Extension + Skill 组合
**Rationale**: Extension 提供底层工具（guard_pane/respond）和后台监听能力，Skill 作为用户入口和流程编排

### 3. 功能范围

**Question**: 核心目标和非目标
**Recommended**: 聚焦核心循环（监控 → 检测 → 决策 → 响应）
**Chosen**: 包含持久化和历史日志
**Rationale**: 需要完整的值守决策审计追踪

### 4. 检测策略

**Question**: 如何检测被监控 pane 需要人工介入？
**Recommended**: 综合策略（状态变化 + 模式匹配 + 停滞检测）
**Chosen**: 综合策略 + rpiv 专用监听
**Rationale**: 覆盖更多场景，特别是 rpiv 工具套件的特有输出模式

### 5. rpiv 专用监听

**Question**: 针对哪些 rpiv 工具做专门监听？
**Recommended**: 基于用户常用工具列表
**Chosen**: wf / discover / implement / blueprint / design / plan
**Rationale**: 用户最常用的技能，其输出模式可预期，适合定制监听逻辑

### 6. 决策依据

**Question**: 值守代理做出决策的依据是什么？
**Recommended**: 给定开发计划文档
**Chosen**: 计划文档 + LLM 自主判断
**Rationale**: 优先按计划执行，计划未覆盖时由 LLM 根据上下文自主决策

### 7. 异常处理

**Question**: 值守代理遇到不确定的情况怎么办？
**Recommended**: 回退给用户
**Chosen**: 多角度分析，根据需求/文档确定响应
**Rationale**: 尽量自主完成，不轻易打断用户工作流

### 8. 日志粒度

**Question**: 记录到什么粒度的日志？
**Recommended**: 完整审计日志
**Chosen**: 完整审计日志
**Rationale**: 便于事后审查和调试，内容包含事件时间、上下文、分析过程、决策、响应

### 9. 配置方式

**Question**: 值守代理如何配置？
**Recommended**: 命令行参数
**Chosen**: 命令行参数
**Rationale**: 简单直接，符合 pi 工具的使用习惯

### 10. 性能要求

**Question**: 轮询和资源消耗的期望？
**Recommended**: 轻量低开销（3-5 秒间隔）
**Chosen**: 灵活可调
**Rationale**: 不同场景需要不同的响应速度

### 11. LLM 选择

**Question**: 值守决策使用哪个 LLM？
**Recommended**: 当前 pane 的模型
**Chosen**: 可配置
**Rationale**: 默认用当前模型，但允许用户通过参数指定其他模型（如更便宜的）

### 12. Pane 通信方式

**Question**: 如何跨 pane 通信？
**Recommended**: 使用 pi-herdr 的 read/run/send/watch 工具
**Chosen**: Confirmed
**Rationale**: 实测可行（herdr read w1:p2, herdr run w1:p2），事件不跨 pane 传播

## Open Questions

（无 — 所有问题已在访谈中确认）

## Suggested Follow-ups

- `pi-herdr` 的 `watch` 工具使用 `herdr wait output` CLI，如果值守代理需要更灵活的模式匹配，可能需要扩展底层 watch 逻辑

## References

- 实测验证：左 pane 监控与响应测试（当前会话）
- `@ogulcancelik/pi-herdr/index.ts` — herdr pane 操作工具
- `@juicesharp/rpiv-ask-user-question/events.ts:22` — rpiv:ask-user:prompt 事件
- `@juicesharp/rpiv-ask-user-question/ask-user-question.ts:58-105` — ask_user_question 工具注册
- `@juicesharp/rpiv-pi/skills/validate/SKILL.md:1-7` — SKILL.md 模板
