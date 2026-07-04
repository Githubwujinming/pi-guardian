/**
 * guard-pane.ts — guard_pane tool for monitoring herdr pane output.
 *
 * The guard_pane tool creates a long-running watch on a target herdr pane,
 * using three detection strategies (state-change, pattern-matching, stall-detection)
 * to identify when the pane is waiting for user input, and optionally auto-responds.
 *
 * Implements a polling loop pattern similar to pi-herdr's watch/wait_agent actions:
 *  - while(true) loop with throwIfAborted at top of each iteration
 *  - Parallel polling via pi.exec("herdr", ...) with signal propagation
 *  - onUpdate heartbeat at configurable intervals
 *  - try/finally cleanup to mark watch status as "stopped"
 *
 * @module guard-pane
 */

import type {
  ExtensionAPI,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { sleepWithSignal, throwIfAborted } from "./sleep.js";
import { setActiveWatch, removeActiveWatch, type ActiveWatch } from "./state.js";
import { matchBuiltinPatterns } from "./patterns.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let watchCounter = 0;

// ---------------------------------------------------------------------------
// Types for tool result details and render state
// ---------------------------------------------------------------------------

export interface GuardPaneDetails {
  watchId: string;
  paneId: string;
  responses: number;
  autoRespond: boolean;
  events: number;
}

interface GuardPaneRenderState {
  startedAt: number;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema
// ---------------------------------------------------------------------------

const guardPaneParams = Type.Object({
  /** Target pane alias or id to monitor. */
  pane: Type.String(),

  /** Optional path to a plan document used by auto-respond logic. */
  plan: Type.Optional(Type.String()),

  /** Optional array of custom regex patterns to match in addition to builtins. */
  patterns: Type.Optional(Type.Array(Type.String())),

  /** Polling interval in ms (default 500). */
  interval: Type.Optional(Type.Number({ default: 500 })),

  /**
   * Overall timeout in ms. When set, the watch stops automatically after
   * this duration, even if no stall is detected.
   */
  timeout: Type.Optional(Type.Number()),

  /**
   * When true (default), automatically responds to known confirmation
   * and proceed patterns.
   */
  autoRespond: Type.Optional(Type.Boolean({ default: true })),
});

type GuardPaneArgs = Static<typeof guardPaneParams>;

// ---------------------------------------------------------------------------
// Auto-respond logic
// ---------------------------------------------------------------------------

/**
 * Auto-respond based on matched pattern type.
 *
 * - confirm-prompt / press-enter / yes-no: send Enter to confirm.
 * - next-step / rpiv-chain-forward: send a proceed command (requires planPath).
 * - All other patterns are logged but not auto-responded.
 *
 * Returns a short description string when a response was sent, or undefined
 * when no action was taken.
 */
async function tryAutoRespond(
  pi: ExtensionAPI,
  watch: ActiveWatch,
  paneId: string,
  _output: string,
  matchName: string,
): Promise<string | undefined> {
  const autoConfirm = new Set(["confirm-prompt", "press-enter", "yes-no"]);
  const autoProceed = new Set(["next-step", "rpiv-chain-forward"]);

  if (autoConfirm.has(matchName)) {
    await pi.exec("herdr", ["send-keys", paneId, "Enter"], { timeout: 5000 });
    return "sent Enter";
  }

  if (autoProceed.has(matchName) && watch.planPath) {
    await pi.exec("herdr", ["run", paneId, `continue with plan: ${watch.planPath}`], {
      timeout: 5000,
    });
    return "sent proceed command";
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGuardPaneTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "guard_pane",
    label: "Guard Pane",
    description:
      "Monitor a herdr pane for questions and prompts during development workflows. " +
      "Detects phase transitions, confirmation prompts, and questions. " +
      "When autoRespond is enabled, automatically sends Enter for confirmations " +
      "and proceed commands for next-step prompts.",
    promptSnippet:
      "guard_pane: monitor a herdr pane for workflow questions and auto-respond",
    promptGuidelines: [
      "Use guard_pane to monitor a pane that is executing a workflow and may wait for user input",
      "Set autoRespond: true to automatically handle common confirmation prompts",
      "Pattern matching detects rpiv workflow phase transitions, questions, and confirmations",
      "Set timeout to automatically stop monitoring after a period of inactivity",
    ],
    parameters: guardPaneParams,

    // -----------------------------------------------------------------------
    // Execute: long-running monitoring loop
    // -----------------------------------------------------------------------
    execute: async (
      _toolCallId: string,
      params: GuardPaneArgs,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<GuardPaneDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<GuardPaneDetails>> => {
      const watchId = `guard-${++watchCounter}`;
      const startedAt = Date.now();
      const interval = params.interval ?? 500;
      const userPatterns = params.patterns ?? [];
      const autoRespond = params.autoRespond ?? true;
      const watchTimeout = params.timeout;

      // Create an internal AbortController so external tools (e.g. respond)
      // can signal this watch to stop. Merge with the pi-provided signal.
      const abortController = new AbortController();

      // Register active watch so respond tool can find it
      const watch: ActiveWatch = {
        watchId,
        paneId: params.pane,
        workspaceId: "",
        planPath: params.plan,
        patterns: userPatterns,
        autoRespond,
        pollingInterval: interval,
        abortController,
        startedAt,
        status: "running",
      };
      setActiveWatch(watchId, watch);

      // Merge external signal with internal abort controller
      if (signal) {
        if (signal.aborted) {
          abortController.abort();
        } else {
          const onExternalAbort = (): void => {
            abortController.abort();
            signal?.removeEventListener("abort", onExternalAbort);
          };
          signal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }

      const mergedSignal = abortController.signal;

      let eventCount = 0;
      let responseCount = 0;
      let lastOutput = "";
      let stallStart: number | null = null;

      try {
        // Initial start notification
        if (onUpdate) {
          onUpdate({
            content: [
              {
                type: "text",
                text:
                  `[guardian] Watch ${watchId} started on pane ` +
                  `${params.pane} (interval=${interval}ms, autoRespond=${autoRespond})`,
              },
            ],
            details: {
              watchId,
              paneId: params.pane,
              responses: 0,
              autoRespond,
              events: 0,
            },
          });
        }

        // ---- Main polling loop ----
        while (true) {
          throwIfAborted(mergedSignal, "guard_pane");

          const now = Date.now();
          const elapsed = now - startedAt;

          // Overall timeout check
          if (watchTimeout && elapsed > watchTimeout) {
            if (onUpdate) {
              onUpdate({
                content: [
                  {
                    type: "text",
                    text: `[guardian] Timeout reached (${watchTimeout}ms) on ${params.pane}`,
                  },
                ],
                details: {
                  watchId,
                  paneId: params.pane,
                  responses: responseCount,
                  autoRespond,
                  events: eventCount,
                },
              });
            }
            break;
          }

          // Attempt to read pane output
          let output = "";
          try {
            const readResult = await pi.exec("herdr", ["read", params.pane], {
              signal: mergedSignal,
              timeout: Math.min(interval + 2000, 10000),
            });
            output = readResult.stdout;
          } catch (readErr: unknown) {
            if (mergedSignal.aborted) throw readErr;
            // Log read errors but keep polling
            console.warn(`[guardian] Read error on ${params.pane}:`, readErr);
          }

          // ---------------------------------------------------------------
          // Detection Strategy 1: State-change
          // ---------------------------------------------------------------
          const hasChanged = output !== lastOutput && output.length > 0;

          if (hasChanged) {
            lastOutput = output;
            stallStart = null; // reset stall timer on new output

            // ---------------------------------------------------------------
            // Detection Strategy 2: Pattern-matching
            // ---------------------------------------------------------------
            const match = matchBuiltinPatterns(output, userPatterns);
            if (match) {
              eventCount++;

              // Auto-respond if applicable
              let responseMsg: string | undefined;
              if (autoRespond) {
                responseMsg = await tryAutoRespond(
                  pi,
                  watch,
                  params.pane,
                  output,
                  match.patternName,
                ).catch(() => undefined);
                if (responseMsg) responseCount++;
              }

              // Notify via onUpdate
              if (onUpdate) {
                const text = responseMsg
                  ? `[guardian] Match "${match.patternName}" on ${params.pane} \u2014 ${responseMsg}`
                  : `[guardian] Match "${match.patternName}" on ${params.pane} (no auto-respond)`;
                onUpdate({
                  content: [{ type: "text", text }],
                  details: {
                    watchId,
                    paneId: params.pane,
                    responses: responseCount,
                    autoRespond,
                    events: eventCount,
                  },
                });
              }
            }
          }

          // ---------------------------------------------------------------
          // Detection Strategy 3: Stall-detection
          // ---------------------------------------------------------------
          if (!hasChanged && output.length === 0 && lastOutput.length > 0) {
            // Output was cleared — treat as state change
            lastOutput = output;
            stallStart = null;
          } else if (!hasChanged && lastOutput.length > 0) {
            // Output hasn't changed — track stall
            if (stallStart === null) {
              stallStart = now;
            } else {
              const stallDuration = now - stallStart;
              // Emit stall warning when unchanged for >30s
              if (stallDuration > 30000 && stallDuration % 10000 < interval) {
                if (onUpdate) {
                  onUpdate({
                    content: [
                      {
                        type: "text",
                        text: `[guardian] Stall detected on ${params.pane} (${Math.floor(stallDuration / 1000)}s no change)`,
                      },
                    ],
                    details: {
                      watchId,
                      paneId: params.pane,
                      responses: responseCount,
                      autoRespond,
                      events: eventCount,
                    },
                  });
                }
              }
            }
          }

          // Heartbeat: emit at least every 10s so the TUI shows progress
          if (onUpdate && elapsed % 10000 < interval) {
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `[guardian] Watching ${params.pane} (${Math.floor(elapsed / 1000)}s)`,
                },
              ],
              details: {
                watchId,
                paneId: params.pane,
                responses: responseCount,
                autoRespond,
                events: eventCount,
              },
            });
          }

          await sleepWithSignal(interval, mergedSignal);
        }
      } catch (err: unknown) {
        if (mergedSignal.aborted) {
          // Expected abort — tool call was cancelled externally
        } else {
          throw err;
        }
      } finally {
        watch.status = "stopped";
        removeActiveWatch(watchId);
      }

      return {
        content: [
          {
            type: "text",
            text:
              `guard_pane ${params.pane} stopped ` +
              `(events: ${eventCount}, responses: ${responseCount})`,
          },
        ],
        details: {
          watchId,
          paneId: params.pane,
          responses: responseCount,
          autoRespond,
          events: eventCount,
        },
      };
    },

    // -----------------------------------------------------------------------
    // renderCall: show the tool call in the TUI
    // -----------------------------------------------------------------------
    renderCall: (
      args: GuardPaneArgs,
      theme,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _context: any,
    ) => {
      const parts: string[] = [theme.bold("guard_pane")];

      parts.push(`  pane: ${args.pane}`);
      if (args.plan) parts.push(`  plan: ${args.plan}`);
      parts.push(`  interval: ${args.interval ?? 500}ms`);
      if (args.patterns && args.patterns.length > 0) {
        parts.push(`  patterns: ${args.patterns.join(", ")}`);
      }
      if (args.timeout) parts.push(`  timeout: ${args.timeout}ms`);
      parts.push(`  autoRespond: ${args.autoRespond ?? true}`);

      return new Text(parts.join("\n"));
    },

    // -----------------------------------------------------------------------
    // renderResult: show the result / live status in the TUI
    // -----------------------------------------------------------------------
    renderResult: (
      result: AgentToolResult<GuardPaneDetails>,
      options: ToolRenderResultOptions,
      theme,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _context: any,
    ) => {
      const d = result.details;
      if (!d) return new Text("guard_pane completed");

      if (options.isPartial) {
        // Partial / streaming view — show live status
        const lines: string[] = [
          theme.fg("warning", `\u25CC watching ${d.paneId}`),
        ];
        if (d.events > 0) lines.push(`  events: ${d.events}`);
        if (d.responses > 0) lines.push(`  responses: ${d.responses}`);
        return new Text(lines.join("\n"));
      }

      // Final result — show summary
      const lines: string[] = [
        theme.fg("muted", `guard_pane ${d.paneId} \u2014 stopped`),
        `  events: ${d.events}`,
        `  responses: ${d.responses}`,
      ];
      return new Text(lines.join("\n"));
    },
  });
}
