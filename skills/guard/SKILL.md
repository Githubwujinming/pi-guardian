---
name: guard
description: Call the guard tool to monitor a herdr pane and auto-respond
allowed-tools: guard, respond
---

# Guard

## Instructions

1. `$ARGUMENTS` is the pane ID. Call `guard(pane="$ARGUMENTS")` immediately.
2. When guard returns an event: analyze `details.event` and `details.context`, then call `respond(...)` to respond, then call `guard(pane="$ARGUMENTS")` again.
3. Do NOT list panes. Do NOT ask which pane. Do NOT explain. Just call guard.
