/**
 * guard.ts — Integrated guard tool.
 *
 * 一个封装了完整值守循环的工具，通过 TypeBox 参数校验解决
 * SKILL.md 方式中 flag 参数解析不可靠的问题。
 *
 * 工作流：
 * 1. 用户/agent 调用 guard(pane="w1:pX")
 * 2. 工具内部运行监控循环
 * 3. 可自动处理的事件在工具内部处理并继续监控
 * 4. 需要 LLM 决策的事件返回给 agent
 * 5. agent 调用 respond() 后再次调用 guard() 恢复循环
 *
 * @module guard
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { matchBuiltinPatterns } from "./patterns.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Map<patternName, expireAt> for dedup
const patternCooldowns = new Map<string, number>();
const PATTERN_COOLDOWN_MS = 15_000;

// ---------------------------------------------------------------------------
// TypeBox schema — 参数校验（可靠，不走自然语言解析）
// ---------------------------------------------------------------------------

const guardParams = Type.Object({
	/** 要监控的 pane ID */
	pane: Type.String({ description: "Pane ID to monitor (e.g. w1:p1)" }),
	/** 可选的计划文档路径 */
	plan: Type.Optional(
		Type.String({ description: "Plan document path for auto-respond context" }),
	),
	/** 自定义正则模式 */
	patterns: Type.Optional(
		Type.Array(Type.String(), { description: "Additional regex patterns" }),
	),
	/** 轮询间隔（ms） */
	interval: Type.Optional(
		Type.Number({ default: 500, description: "Polling interval in ms" }),
	),
	/** 超时（ms） */
	timeout: Type.Optional(Type.Number({ description: "Watch timeout in ms" })),
});

type GuardArgs = Static<typeof guardParams>;

export interface GuardEvent {
	type: "pattern_match" | "stall_detected";
	patternName?: string;
	matchedText?: string;
}

export interface GuardResult {
	event?: GuardEvent;
	context?: string;
	elapsed: number;
	info: string;
}

// ---------------------------------------------------------------------------
// Auto-respond 逻辑
// ---------------------------------------------------------------------------

async function tryAutoRespond(
	pi: ExtensionAPI,
	paneId: string,
	matchName: string,
	matchedText: string | undefined,
): Promise<string | undefined> {
	// 安全确认 → 发 Enter
	if (["confirm-prompt", "press-enter", "yes-no"].includes(matchName)) {
		await pi.exec("herdr", ["pane", "send-keys", paneId, "Enter"], {
			timeout: 5000,
		});
		return "sent Enter";
	}

	// next-step / rpiv-chain-forward → 提取 /skill:xxx 命令并执行
	// 注意：执行后加 LONG_COOLDOWN（5min），防止同一命令反复触发
	if (matchName === "next-step" || matchName === "rpiv-chain-forward") {
		// 先尝试提取完整命令（含路径参数）
		const fullMatch = matchedText?.match(/\/skill:\S+\s+\S+/i);
		if (fullMatch) {
			await pi.exec("herdr", ["pane", "run", paneId, fullMatch[0]], {
				timeout: 10000,
			});
			markPatternCooldown(matchName);
			return `executed ${fullMatch[0]}`;
		}
		// 回退：只提取 /skill:xxx 本身
		const cmdMatch = matchedText?.match(/\/skill:\S+/i);
		if (cmdMatch) {
			await pi.exec("herdr", ["pane", "run", paneId, cmdMatch[0]], {
				timeout: 10000,
			});
			markPatternCooldown(matchName);
			return `executed ${cmdMatch[0]}`;
		}
	}

	// implement-done / completion-summary / implement-phase-result → 静默确认，继续值守
	if (
		[
			"implement-done",
			"completion-summary",
			"follow-up",
			"implement-complete",
			"implement-verdict",
			"implement-phase-result",
		].includes(matchName)
	) {
		return "acknowledged";
	}

	// 其他模式 → 需要 LLM 决策，返回给 agent
	return undefined;
}

function isPatternOnCooldown(patternName: string): boolean {
	const expireAt = patternCooldowns.get(patternName);
	if (!expireAt) return false;
	return Date.now() < expireAt;
}

function markPatternCooldown(patternName: string): void {
	patternCooldowns.set(patternName, Date.now() + PATTERN_COOLDOWN_MS);
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

export function registerGuardTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "guard",
		label: "Guard Pane (Auto)",
		description:
			"Monitor a herdr pane and auto-respond autonomously. " +
			"Handles next-step (auto-executes /skill:xxx), confirmations (Enter), " +
			"and routine events internally. Only escalates to the calling agent " +
			"when LLM judgment is needed (questions, stalls). " +
			"After handling an escalated event, call guard() again to resume.",
		parameters: guardParams,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const startedAt = Date.now();
			const interval = params.interval ?? 500;
			const watchTimeout = params.timeout;

			// 状态
			let lastOutput = "";
			let stallStart: number | null = null;
			let readFailCount = 0;
			const MAX_READ_FAILURES = 5;

			onUpdate?.({
				content: [
					{ type: "text", text: `[guard] Monitoring ${params.pane}...` },
				],
				details: { action: "guard_start", pane: params.pane },
			});

			while (true) {
				if (signal?.aborted) throw new Error("Canceled");

				const now = Date.now();
				const elapsed = now - startedAt;

				// 超时
				if (watchTimeout && elapsed > watchTimeout) {
					return {
						content: [
							{
								type: "text",
								text: `[guard] Timeout after ${watchTimeout}ms on ${params.pane}`,
							},
						],
						details: {
							info: `timeout ${Math.floor(elapsed / 1000)}s`,
							elapsed: Math.floor(elapsed / 1000),
						},
					};
				}

				// 读取 pane 输出
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
							signal,
							timeout: Math.min(interval + 2000, 10000),
						},
					);
					output = readResult.stdout || "";
					readFailCount = 0;
				} catch {
					if (signal?.aborted) throw new Error("Canceled");
					readFailCount++;
					if (readFailCount >= MAX_READ_FAILURES) {
						return {
							content: [
								{
									type: "text",
									text: `[guard] Pane ${params.pane} unreachable after ${MAX_READ_FAILURES} failures`,
								},
							],
							details: {
								info: "pane_unreachable",
								elapsed: Math.floor(elapsed / 1000),
							},
						};
					}
					await new Promise((r) => setTimeout(r, interval));
					continue;
				}

				const hasChanged = output !== lastOutput && output.length > 0;

				if (hasChanged) {
					// 只对新追加的内容做模式匹配（避免旧内容反复触发）
					const deltaOutput =
						lastOutput.length > 0 && output.startsWith(lastOutput)
							? output.slice(lastOutput.length)
							: output;
					lastOutput = output;
					stallStart = null;

					// 模式匹配（只针对增量内容）
					const match = matchBuiltinPatterns(
						deltaOutput,
						params.patterns ?? [],
					);
					if (match && !isPatternOnCooldown(match.patternName)) {
						markPatternCooldown(match.patternName);

						// 尝试自动响应
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
											text: `[guard] ${responseMsg} on ${params.pane}`,
										},
									],
									details: {
										action: "auto_respond",
										pane: params.pane,
										pattern: match.patternName,
									},
								});
							}
							continue; // 继续值守
						}

						// 需要 LLM 决策 → 返回给 agent
						return {
							content: [
								{
									type: "text",
									text: `[guard] Event: "${match.patternName}" = "${match.matchedText}" in ${params.pane}`,
								},
							],
							details: {
								event: {
									type: "pattern_match",
									patternName: match.patternName,
									matchedText: match.matchedText,
								} as GuardEvent,
								context: output.slice(-4000),
								elapsed: Math.floor(elapsed / 1000),
								info: "needs_llm",
							},
						};
					}
				}

				// Stall 检测（30s 无变化）
				if (!hasChanged && lastOutput.length > 0) {
					if (stallStart === null) {
						stallStart = now;
					} else if (now - stallStart > 30_000) {
						return {
							content: [
								{
									type: "text",
									text: `[guard] Stall on ${params.pane}: 30s no output`,
								},
							],
							details: {
								event: {
									type: "stall_detected",
									patternName: "stall-fallback",
									matchedText: "30s no output",
								} as GuardEvent,
								context: output.slice(-4000),
								elapsed: Math.floor(elapsed / 1000),
								info: "stall",
							},
						};
					}
				}

				// 心跳（每 10s）
				if (onUpdate && elapsed % 10000 < interval) {
					onUpdate({
						content: [
							{
								type: "text",
								text: `[guard] Monitoring ${params.pane} (${Math.floor(elapsed / 1000)}s)`,
							},
						],
						details: {
							action: "heartbeat",
							pane: params.pane,
							elapsed: Math.floor(elapsed / 1000),
						},
					});
				}

				await new Promise((r) => setTimeout(r, interval));
			}
		},

		renderCall(args: GuardArgs, theme) {
			const parts = [theme.bold("guard")];
			parts.push(`  pane: ${args.pane}`);
			if (args.plan) parts.push(`  plan: ${args.plan}`);
			if (args.interval) parts.push(`  interval: ${args.interval}ms`);
			return new Text(parts.join("\n"));
		},

		renderResult(result, options, theme) {
			const d = result.details as GuardResult | undefined;
			if (!d) return new Text("guard completed");

			if (options.isPartial) {
				return new Text(
					theme.fg(
						"warning",
						`\u25CC guard ${result.content?.[0]?.type === "text" ? result.content[0].text.slice(0, 40) : "..."}`,
					),
				);
			}

			if (d.event) {
				return new Text(
					theme.fg("warning", `? ${d.event.patternName ?? d.event.type}`) +
						theme.fg(
							"dim",
							` \u203A ${(d.event.matchedText ?? "").slice(0, 60)}`,
						),
				);
			}

			return new Text(theme.fg("muted", `\u2713 ${d.info ?? "done"}`));
		},
	});
}
