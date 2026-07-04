# @githubwujinming/pi-guardian

Pi extension for monitoring herdr panes — auto-responds to
`ask_user_question` and natural-language prompts during development
workflows.

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│   Guard Pane     │     │   Working Pane   │
│  (pi instance)   │     │  (pi instance)   │
│                  │     │                  │
│  guard_pane ─────┼────>│  executes a      │
│  polls output    │     │  workflow        │
│  detects events  │<────┼── asks questions │
│                  │     │                  │
│  respond ────────┼────>│  receives keys   │
│  sends response  │     │  or text input   │
└──────────────────┘     └──────────────────┘
        │                        │
        └──── both in same herdr workspace ────┘
```

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

Requires `@ogulcancelik/pi-herdr` (peer dependency, auto-installed).

## Usage

### Start guarding a pane

```bash
/skill:guard --pane w1:p1 --plan .rpiv/artifacts/plans/my-plan.md
```

The guardian agent will:

1. Call `guard_pane` to start monitoring
2. Auto-respond to simple confirmation prompts (Enter)
3. Escalate detected events to you for LLM-based decision
4. Wait for you to call `respond` and then resume monitoring

### Respond to a detected event

When `guard_pane` returns an event, use `respond`:

```
respond(pane="w1:p1", optionIndex=2)     # select option 2
respond(pane="w1:p1", text="开始 Phase 2") # send text
respond(pane="w1:p1", options=[0, 3])     # multi-select: toggle 0 and 3
```

### Manual stop

Simply stop calling `guard_pane` in the loop, or set a `timeout`:

```
/skill:guard --pane w1:p1 --timeout 300000
```

## Tools

### `guard_pane`

Long-running monitor for a herdr pane. Three detection strategies:

| Strategy | Description | Threshold |
| --- | --- | --- |
| Pattern matching | Regex patterns against pane output | Instant |
| State change | Pane revision / agent_status changes | Per poll |
| Stall detection | No output change for N seconds | 30s (normal) / 5min (subagent) |

Auto-respond: only for deterministic confirmations (Enter).
All other events escalate to the calling agent for LLM decision.

### `respond`

Send response to a monitored pane:

| Mode | Parameter | Use case |
| --- | --- | --- |
| Single-select | `optionIndex` | `ask_user_question` option |
| Multi-select | `options[]` | Toggle checkboxes, then Next |
| Text input | `text` | "Type something." or commands |

## Events monitored

Built-in patterns cover:

- rpiv workflow phase transitions (implement, blueprint, design, plan)
- `ask_user_question` patterns
- Confirmation prompts (yes/no, continue, press Enter)
- Completion summaries
- Subagent delegation (background agents)
- Generic questions (catch-all)

## Audit log

All events are recorded to `.guardian/audit.jsonl` (project root):

```jsonl
{"eventNumber":1,"ts":"2026-07-04T12:00:00.000Z","eventType":"pattern_match","paneRef":{"paneId":"w1:p1"},"triggerContext":"...","responseSent":"sent Enter"}
```

## Development

```bash
npm install
npx tsc --noEmit   # type-check
```

## Peer Dependencies

- `@earendil-works/pi-coding-agent` (required at runtime)
- `@ogulcancelik/pi-herdr` (required for pane operations)

## License

MIT
