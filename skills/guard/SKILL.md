---
name: guard
description: Monitor a herdr pane and auto-respond to questions during workflows
allowed-tools: guard, respond, herdr, ask_user_question
---

# Guard

## ⚠️ 硬性规则：不许自己选 pane

- **`$ARGUMENTS` 是 pane ID → 直接调 `guard(pane="$ARGUMENTS")`**
- **`$ARGUMENTS` 为空 → 必须先用 `ask_user_question` 让用户选择**
- 禁止分析、禁止决定、禁止先调 guard 再问

违反规则就是 bug。

## Steps

### 1. 确定 pane

```
$ARGUMENTS = ""?   → ask_user_question(列出所有 pane) → 用户选 → guard(pane=...)
$ARGUMENTS = ID?   → guard(pane="$ARGUMENTS")
```

### 2. 处理事件

见前文。

### 3. 不确定时

见前文。

### 4. 恢复

调完 respond 后立即调 `guard(pane=...)`。
