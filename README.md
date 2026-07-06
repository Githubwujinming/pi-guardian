# @githubwujinming/pi-guardian

Pi extension + skill for monitoring herdr panes — watches a worker pane,
auto-responds to questions, and autonomously continues multi-step workflows.

## Architecture

```
┌────────────────────┐     ┌────────────────────┐
│   Guard Pane       │     │   Working Pane     │
│  (pi instance)     │     │  (pi instance)     │
│                    │     │                    │
│  guard(pane=...) ──┼────>│  executes workflow │
│  polls output      │     │  asks questions    │
│  detects events    │<────┼── outputs progress │
│  auto-responds     │     │                    │
│  calls respond() ──┼────>│  receives response │
└────────────────────┘     └────────────────────┘
```

## How it works

1. User calls `guard(pane="w1:pN")` or `/skill:guard w1:pN`
2. Guard tool polls the worker pane output every 500ms
3. **Pattern detection**: Matches worker output against built-in regex patterns
4. **Auto-respond**: Handles known patterns automatically:
   - `next-step` → extracts `/skill:xxx` command and executes it in the worker
   - `confirm-prompt` / `press-enter` / `yes-no` → sends Enter
   - Routine events → silently acknowledges, continues monitoring
5. **LLM escalation**: For questions and stalls, returns event + 4K context to agent
6. **Agent decides**: Analyzes context, calls `respond()`, resumes `guard()`

### Key design decisions

| Decision | Rationale |
| ---------- | ----------- |
| **Delta output matching** | Only new content is matched, preventing old patterns from re-triggering |
| **TypeBox parameters** | `guard` tool uses TypeBox schema, no natural language parsing ambiguity |
| **Minimal skill** | `/skill:guard` just calls `guard(pane=...)` directly, no pane selection flow |
| **Agent in the loop** | Non-trivial decisions (questions, stalls) always return to agent with full context |
| **No hardcoded limits** | No max execution count or idle timeout — suitable for multi-day workflows |

## Installation

```bash
# Install directly from GitHub:
pi install git:github.com/Githubwujinming/pi-guardian

# Or install to a specific pi environment with pis:
pis pkgs install git:github.com/Githubwujinming/pi-guardian vibe-rpiv
```

### Local development

```bash
git clone git@github.com:Githubwujinming/pi-guardian.git
cd pi-guardian
npm install
pi install .
```

Requires `@ogulcancelik/pi-herdr` (peer dependency).

## Usage

### Start guarding

```bash
# Via skill (recommended):
/skill:guard                    # 不指定 → 列 pane 让用户选
/skill:guard plan.md            # 只传文档 → 列 pane + 带文档值守
/skill:guard w1:p1              # 指定 pane ID，直接值守
/skill:guard w1:p1 plan.md,design.md  # pane + 参考文档

# Or directly via tool:
guard(pane="w1:p1")
guard(pane="w1:p1", context="plan.md,design.md")
guard(pane="别名")
```

The guard will:

1. Monitor the worker pane continuously
2. Auto-execute next-step suggestions (`/skill:validate`, `/skill:commit`, etc.)
3. Auto-confirm prompts (Enter for Y/N, confirmations)
4. Escalate questions to you for LLM-based decision
5. Resume monitoring automatically after each event

### Respond to a question

When `guard` returns a question event, use `respond`:

```
respond(pane="w1:p1", optionIndex=0)     # select first option
respond(pane="w1:p1", text="你的输入")    # send text
respond(pane="w1:p1", options=[0, 2])    # multi-select
```

Then call `guard(pane="w1:p1")` again to resume.

### Stop

```bash
# Set a timeout:
guard(pane="w1:p1", timeout=3600000)    # auto-stop after 1 hour

# Or simply stop calling guard() — the loop ends naturally.
```

## Tools

### `guard` (primary)

Long-running monitor with auto-respond. Parameters:

| Parameter | Type | Default | Description |
| ----------- | ------ | --------- | ------------- |
| `pane` | string | required | Pane ID to monitor |
| `interval` | number | 500 | Polling interval in ms |
| `timeout` | number | — | Auto-stop after N ms |
| `patterns` | string[] | — | Custom regex patterns |
| `plan` | string | — | Plan path for context |

Detection strategies:

| Strategy | Threshold | Description |
|----------|-----------|-------------|
| Pattern matching (delta) | Instant | Regex patterns against new output only |
| Stall detection | 30s | No output change → check for unanswered questions |

### `respond`

Send response to a monitored pane:

| Mode | Parameter | Use case |
| ------ | ----------- | ---------- |
| Single-select | `optionIndex` | Pick from numbered options |
| Multi-select | `options[]` | Toggle checkboxes, confirm |
| Text input | `text` | Type message or command |

## Pattern reference

Built-in patterns match both English and Chinese output:

| Pattern | Matches | Auto-handled |
| --------- | --------- | :---: |
| `next-step` | `**Next step:** /skill:xxx` / `下一步： /skill:xxx` | ✅ Auto-executes |
| `confirm-prompt` | `Confirm?`, `Proceed?`, `确认?` | ✅ Enter |
| `press-enter` | `Press Enter to continue`, `按回车继续` | ✅ Enter |
| `yes-no` | `(Y/N)`, `(y/n)` | ✅ Enter |
| `follow-up` | `💬 Follow-up:`, `💬 反馈` | ✅ Acknowledge |
| `implement-verdict` | `Verdict: PASS` | ✅ Acknowledge |
| `generic-question` | Lines ending with `？` or `?` | → Agent |
| `choice-prompt` | `请选择`, `Select option` | → Agent |
| `chinese-question` | `要不要`, `是不是`, `可以吗` | → Agent |

## Safety

- **Delta matching**: Old output never re-triggers patterns
- **Agent in the loop**: Questions, stalls, and uncertainties always return to agent
- **Pattern cooldown**: Same pattern won't re-trigger within 15s
- **Pane disappearance**: After 5 consecutive read failures, auto-stops
- **User override**: `timeout` parameter sets max runtime

## Development

```bash
npm install
npx tsc --noEmit   # type-check
```

## Project structure

```
index.ts          # Extension entry — registers all tools
guard.ts          # Guard tool — main monitoring loop with TypeBox params
guard-pane.ts     # Legacy guard_pane tool (kept for compatibility)
respond.ts        # Respond tool — sends keys/text to panes
patterns.ts       # Pattern definitions (17+ built-in patterns)
state.ts          # Shared state management
audit.ts          # Audit logging to .guardian/audit.jsonl
sleep.ts          # AbortSignal-safe sleep helpers
skills/guard/     # /skill:guard skill definition
```

## License

MIT
