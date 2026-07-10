/**
 * guard-pane.ts — guard_pane tool for monitoring herdr pane output.
 *
 * Architecture: Agent loop + minimal autoRespond 混合模式。
 * - Auto-respond only for deterministic confirmations (Enter)
 * - All other events RETURN to the calling agent (LLM) with full context
 * - The guardian agent decides whether/how to respond via the `respond` tool
 * - After responding, the agent calls guard_pane again to resume monitoring
 *
 * Detection strategies:
 *   A. State-change: pane agent_status transitions
 *   B. Pattern-matching: regex patterns against output (with dedup + cooldown)
 *   C. Subagent-aware stall: suppresses stall when subagent is active
 *   D. Pane-disappearance: stops after N consecutive read failures
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
import {
	setActiveWatch,
	removeActiveWatch,
	type ActiveWatch,
} from "./state.js";
import { matchBuiltinPatterns } from "./patterns.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let watchCounter = 0;

// Map<patternName, lastTriggeredAt> for dedup
const patternCooldowns = new Map<string, number>();
const PATTERN_COOLDOWN_MS = 15_000; // same pattern won't re-trigger within 15s

// ---------------------------------------------------------------------------
// Types for tool result details and render state
// ---------------------------------------------------------------------------

export interface GuardPaneEvent {
	type: "pattern_match" | "stall_detected";
	patternName?: string;
	matchedText?: string;
}

export interface GuardPaneDetails {
	watchId: string;
	paneId: string;
	event?: GuardPaneEvent;
	context?: string;
	elapsed: number;
	stopped: boolean;
	subagentActive: boolean;
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

	/** Polling interval in ms (default 3000). Entry interval for active output; adapts up to 30s when stable. */
	interval: Type.Optional(Type.Number({ default: 10000 })),

	/**
	 * Overall timeout in ms. When set, the watch stops automatically after
	 * this duration and returns a timeout event to the agent.
	 */
	timeout: Type.Optional(Type.Number()),

	/**
	 * When true (default), automatically sends Enter for simple confirmation patterns.
	 * All non-trivial events are escalated to the calling agent for LLM-based decision.
	 */
	autoRespond: Type.Optional(Type.Boolean({ default: true })),
});

type GuardPaneArgs = Static<typeof guardPaneParams>;

// ---------------------------------------------------------------------------
// Auto-respond logic (minimal — only deterministic confirmations)
// ---------------------------------------------------------------------------

/**
 * Minimal auto-respond: only handles deterministic confirmations.
 *
 * - confirm-prompt / press-enter / yes-no: send Enter (safe, predictable)
 * - All other patterns: return undefined → escalate to LLM
 *
 * This avoids auto-respond loops because Enter is idempotent for
 * confirmation prompts: pressing Enter on an already-confirmed prompt
 * is a no-op rather than a new action.
 */
async function tryAutoRespond(
	pi: ExtensionAPI,
	paneId: string,
	matchName: string,
	matchedText?: string,
): Promise<string | undefined> {
	const safeAuto = new Set(["confirm-prompt", "press-enter", "yes-no"]);

	if (safeAuto.has(matchName)) {
		await pi.exec("herdr", ["pane", "send-keys", paneId, "Enter"], {
			timeout: 5000,
		});
		return "sent Enter (auto-confirm)";
	}

	// next-step / rpiv-chain-forward: 自动执行建议的下一步命令
	// 优先提取完整命令（含路径参数）：/skill:validate .rpiv/artifacts/plan.md
	if (matchName === "next-step" || matchName === "rpiv-chain-forward") {
		// 先尝试提取含路径参数：/skill:xxx .rpiv/artifacts/...
		const pathMatch = matchedText?.match(/\/skill:\S+\s+\.rpiv\/artifacts\S+/i);
		if (pathMatch) {
			await pi.exec("herdr", ["pane", "run", paneId, pathMatch[0]], {
				timeout: 10000,
			});
			markPatternCooldown(matchName);
			return `auto-executed ${pathMatch[0]}`;
		}
		// 回退：只提取 /skill:xxx 本身（不包含后续破折号/说明文字）
		const cmdMatch = matchedText?.match(/\/skill:\S+/i);
		if (cmdMatch) {
			await pi.exec("herdr", ["pane", "run", paneId, cmdMatch[0]], {
				timeout: 10000,
			});
			markPatternCooldown(matchName);
			return `auto-executed ${cmdMatch[0]}`;
		}
	}

	// follow-up: 检查是否包含 /skill:xxx 命令，有则执行
	if (matchName === "follow-up") {
		const cmdMatch = matchedText?.match(/\/skill:\S+/i);
		if (cmdMatch) {
			await pi.exec("herdr", ["pane", "run", paneId, cmdMatch[0]], {
				timeout: 10000,
			});
			return `auto-executed ${cmdMatch[0]}`;
		}
		return "acknowledged (no command)";
	}

	// implement-done / completion-summary: 工作流自然结束，继续值守等待新事件
	if (matchName === "implement-done" || matchName === "completion-summary") {
		return "acknowledged (no action needed)";
	}

	// Everything else → escalate to agent for LLM decision
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
			"Monitor a herdr pane for questions and prompts. " +
			"Auto-responds to simple confirmations (Enter); escalates all other events " +
			"to the calling agent with full context for LLM-based decision. " +
			"After handling an event, call guard_pane again to resume monitoring.",
		parameters: guardPaneParams,

		// -----------------------------------------------------------------------
		// Execute: polling loop that RETURNS on events (does not loop forever)
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
			const interval = params.interval ?? 10000;
			const userPatterns = params.patterns ?? [];
			const autoRespond = params.autoRespond ?? true;
			const watchTimeout = params.timeout;

			// Internal AbortController for clean shutdown
			const abortController = new AbortController();

			// Register active watch
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

			// Merge external signal
			if (signal) {
				if (signal.aborted) {
					abortController.abort();
				} else {
					const onAbort = (): void => {
						abortController.abort();
						signal?.removeEventListener("abort", onAbort);
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}
			const mergedSignal = abortController.signal;

			// State
			let lastOutput = "";
			let stallStart: number | null = null;
			let subagentActive = false;
			let readFailCount = 0;
			let pollInterval = interval;
			const BASE_POLL = interval;
			const SUBAGENT_POLL = 15_000;
			const MAX_POLL = 30_000;
			const BACKOFF_STEP = 3000;
			const BACKOFF_AFTER = 3;
			// Track consecutive unchanged reads for adaptive backoff
			let unchangedCount = 0;
			const MAX_READ_FAILURES = 5;

			try {
				// Initial heartbeat
				if (onUpdate) {
					onUpdate({
						content: [
							{ type: "text", text: `[guardian] Watching ${params.pane}...` },
						],
						details: {
							watchId,
							paneId: params.pane,
							elapsed: 0,
							stopped: false,
							subagentActive: false,
						},
					});
				}

				while (true) {
					throwIfAborted(mergedSignal, "guard_pane");

					const now = Date.now();
					const elapsed = now - startedAt;

					// Timeout check
					if (watchTimeout && elapsed > watchTimeout) {
						return {
							content: [
								{
									type: "text",
									text: `[guardian] Timeout after ${watchTimeout}ms on ${params.pane}`,
								},
							],
							details: {
								watchId,
								paneId: params.pane,
								elapsed: Math.floor(elapsed / 1000),
								stopped: true,
								subagentActive,
							},
						};
					}

					// ---- Read pane output ----
					let output = "";
					try {
						const readResult = await pi.exec(
							"herdr",
							[
								"pane",
								"read",
								params.pane,
								"--source",
								"recent-unwrapped",
								"--lines",
								"200",
							],
							{
								signal: mergedSignal,
								timeout: Math.min(interval + 2000, 10000),
							},
						);
						output = readResult.stdout;
						readFailCount = 0; // reset on success
					} catch (readErr: unknown) {
						if (mergedSignal.aborted) throw readErr;
						readFailCount++;
						console.warn(
							`[guardian] Read error #${readFailCount} on ${params.pane}:`,
							readErr,
						);

						// Pane disappeared detection
						if (readFailCount >= MAX_READ_FAILURES) {
							return {
								content: [
									{
										type: "text",
										text: `[guardian] Pane ${params.pane} unreachable after ${MAX_READ_FAILURES} read failures`,
									},
								],
								details: {
									watchId,
									paneId: params.pane,
									elapsed: Math.floor(elapsed / 1000),
									stopped: true,
									subagentActive,
								},
							};
						}
						await sleepWithSignal(interval, mergedSignal);
						continue;
					}

					const hasChanged = output !== lastOutput && output.length > 0;

					if (!hasChanged && lastOutput.length > 0) {
						unchangedCount++;
					}

					if (hasChanged) {
						// 只对新追加的内容做模式匹配（避免旧内容反复触发）
						const deltaOutput =
							lastOutput.length > 0 && output.startsWith(lastOutput)
								? output.slice(lastOutput.length)
								: output;
						lastOutput = output;
						stallStart = null;

						// ---- Subagent detection ----
						// When main agent dispatches a background subagent, the output stalls
						// until the subagent returns. Detect this and suppress stall detection.
						if (
							output.match(
								/(Background|New)\s+agent\s+(started|created|dispatched|launched).*background/i,
							)
						) {
							subagentActive = true;
							pollInterval = SUBAGENT_POLL;
						}
						if (
							output.match(/Background\s+agent.*completed|subagent.*result/i)
						) {
							subagentActive = false;
							pollInterval = BASE_POLL;
						}

						// ---- Pattern matching ----
						// Check dedup: skip patterns that triggered within COOLDOWN period
						const match = matchBuiltinPatterns(deltaOutput, userPatterns);
						if (match && !isPatternOnCooldown(match.patternName)) {
							markPatternCooldown(match.patternName);

							// Auto-respond (only safe confirmations)
							if (autoRespond) {
								const responseMsg = await tryAutoRespond(
									pi,
									params.pane,
									match.patternName,
									match.matchedText,
								).catch(() => undefined);
								if (responseMsg) {
									if (onUpdate) {
										onUpdate({
											content: [
												{
													type: "text",
													text: `[guardian] ${responseMsg} on ${params.pane}`,
												},
											],
											details: {
												watchId,
												paneId: params.pane,
												elapsed: Math.floor(elapsed / 1000),
												stopped: false,
												subagentActive,
											},
										});
									}
									continue; // keep monitoring
								}
							}

							// Escalate to agent: return event context for LLM decision
							return {
								content: [
									{
										type: "text",
										text: `[guardian] Event in ${params.pane}: "${match.patternName}" = "${match.matchedText}"`,
									},
								],
								details: {
									watchId,
									paneId: params.pane,
									event: {
										type: "pattern_match",
										patternName: match.patternName,
										matchedText: match.matchedText,
									},
									context: output.slice(-3000),
									elapsed: Math.floor(elapsed / 1000),
									stopped: false,
									subagentActive,
								},
							};
						}
					}

					// ---- Stall detection (subagent-aware) ----
					if (subagentActive) {
						// During subagent wait, use a much longer threshold (5min instead of 30s)
						if (stallStart !== null) {
							const stallDuration = now - stallStart;
							if (stallDuration > 300_000) {
								// 5 min
								subagentActive = false;
								return {
									content: [
										{
											type: "text",
											text: `[guardian] Subagent stall on ${params.pane}: ${Math.floor(stallDuration / 1000)}s`,
										},
									],
									details: {
										watchId,
										paneId: params.pane,
										event: {
											type: "stall_detected",
											patternName: "subagent-stall",
											matchedText: `${Math.floor(stallDuration / 1000)}s subagent wait`,
										},
										context: output.slice(-2000),
										elapsed: Math.floor(elapsed / 1000),
										stopped: false,
										subagentActive: true,
									},
								};
							}
						} else if (!hasChanged && lastOutput.length > 0) {
							stallStart = now;
						}
					} else {
						// Normal stall detection (30s)
						if (!hasChanged && lastOutput.length > 0) {
							if (stallStart === null) {
								stallStart = now;
							} else if (now - stallStart > 30_000) {
								const context = output.slice(-2000);
								return {
									content: [
										{
											type: "text",
											text: `[guardian] Stall on ${params.pane}: 30s no output change`,
										},
									],
									details: {
										watchId,
										paneId: params.pane,
										event: {
											type: "stall_detected",
											patternName: "stall-fallback",
											matchedText: "30s no output change",
										},
										context,
										elapsed: Math.floor(elapsed / 1000),
										stopped: false,
										subagentActive: false,
									},
								};
							}
						}
					}

					// Periodic heartbeat
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
								elapsed: Math.floor(elapsed / 1000),
								stopped: false,
								subagentActive,
							},
						});
					}

					// Adaptive polling: lower frequency when output is stable
					if (unchangedCount >= BACKOFF_AFTER) {
						pollInterval = Math.min(pollInterval + BACKOFF_STEP, MAX_POLL);
					} else if (hasChanged) {
						unchangedCount = 0;
						if (!subagentActive) pollInterval = BASE_POLL;
					}

					await sleepWithSignal(pollInterval, mergedSignal);
				}
			} finally {
				watch.status = "stopped";
				removeActiveWatch(watchId);
			}

			// Unreachable — but TypeScript needs a return
			return {
				content: [{ type: "text", text: `[guardian] Stopped ${params.pane}` }],
				details: {
					watchId,
					paneId: params.pane,
					elapsed: Math.floor((Date.now() - startedAt) / 1000),
					stopped: true,
					subagentActive,
				},
			};
		},

		// -----------------------------------------------------------------------
		// renderCall
		// -----------------------------------------------------------------------
		renderCall: (args: GuardPaneArgs, theme) => {
			const parts = [theme.bold("guard_pane")];
			parts.push(`  pane: ${args.pane}`);
			if (args.plan) parts.push(`  plan: ${args.plan}`);
			parts.push(`  interval: ${args.interval ?? 10000}ms`);
			if (args.patterns?.length)
				parts.push(`  patterns: ${args.patterns.join(", ")}`);
			if (args.timeout) parts.push(`  timeout: ${args.timeout}ms`);
			parts.push(`  autoRespond: ${args.autoRespond ?? true}`);
			return new Text(parts.join("\n"));
		},

		// -----------------------------------------------------------------------
		// renderResult
		// -----------------------------------------------------------------------
		renderResult: (
			result: AgentToolResult<GuardPaneDetails>,
			options: ToolRenderResultOptions,
			theme,
		) => {
			const d = result.details;
			if (!d) return new Text("guard_pane completed");

			if (options.isPartial) {
				const parts = [theme.fg("warning", `\u25CC watching ${d.paneId}`)];
				if (d.subagentActive) parts.push(theme.fg("accent", " [subagent]"));
				return new Text(parts.join(""));
			}

			if (d.stopped) {
				return new Text(
					theme.fg(
						"muted",
						`guard_pane ${d.paneId} \u2014 stopped (${d.elapsed}s)`,
					),
				);
			}

			if (d.event) {
				const parts = [theme.fg("warning", `? ${d.paneId}`)];
				parts.push(
					theme.fg("dim", ` \u203A ${d.event.patternName ?? d.event.type}`),
				);
				if (options.expanded && d.context) {
					parts.push("\n" + theme.fg("dim", d.context.slice(0, 1000)));
				}
				return new Text(parts.join(""));
			}

			return new Text(theme.fg("success", `\u2713 ${d.paneId}`));
		},
	});
}

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------

function isPatternOnCooldown(patternName: string): boolean {
	const expireAt = patternCooldowns.get(patternName);
	if (!expireAt) return false;
	return Date.now() < expireAt;
}

function markPatternCooldown(patternName: string): void {
	patternCooldowns.set(patternName, Date.now() + PATTERN_COOLDOWN_MS);
}
