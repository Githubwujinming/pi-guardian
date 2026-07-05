/**
 * patterns.ts — Built-in pattern definitions and matching for pane output monitoring.
 *
 * Provides a catalogue of regex patterns matching common rpiv workflow prompts
 * (phase transitions, confirmations, questions) and the `matchBuiltinPatterns()`
 * function used by the guard_pane tool's pattern-matching detection strategy.
 */

export interface PatternMatch {
	type: "pattern_match";
	matchedText: string;
	patternName: string;
}

export interface BuiltinPattern {
	name: string;
	regex: RegExp;
}

/**
 * Built-in regex patterns covering common rpiv toolchain prompts.
 * Each entry has a descriptive name and a regex tested against pane output lines.
 */
export const BUILTIN_PATTERNS: BuiltinPattern[] = [
	// ===== rpiv workflow phase transitions =====
	// **Next step:** `/skill:...` — implement/blueprint/plan 等技能的下一步建议
	{
		name: "next-step",
		// 匹配所有格式的下一步提示，后跟 /skill:xxx 路径
		// 注意冒号在关闭 ** 之前：**Next step:** `/skill:xxx
		// 支持格式：
		//   **Next step:** `/skill:xxx  （英+加粗+反引号）
		//   **下一步：** `/skill:xxx     （中+全角冒号+加粗）
		//   下一步： /skill:xxx        （中+全角冒号+无加粗）
		//   Next step: /skill:xxx      （英+无加粗）
		regex:
			/(?:\*\*)?(?:Next step|下一步)[：:]?(?:\*\*)?\s*[`'"\s]*\/skill:\S+/i,
	},
	// 💬 Follow-up: — 技能结束时的后续提示
	{
		name: "follow-up",
		regex: /💬\s*Follow-up:/i,
	},
	// Implementation complete/paused at Phase N — 实施完成
	{
		name: "implement-complete",
		regex:
			/Implementation\s*(complete|paused)\s*(at|for)?\s*(Phase|phase)?\s*\d*/i,
	},
	// Implementation complete (简短形式)
	{
		name: "implement-done",
		regex: /implement.*(complete|finished|done)|implementation.*result/i,
	},
	// Phase N Results — 阶段结果摘要
	{
		name: "implement-phase-result",
		regex: /Phase\s*\d+.*(complete|done|finished|result|summary)/i,
	},
	// Verdict: pass/warn/fail — 验证结果
	{
		name: "implement-verdict",
		regex: /Verdict:\s*(pass|warn|fail)/i,
	},
	// /skill:xxx .rpiv/artifacts/... — 链式技能调用
	{
		name: "rpiv-chain-forward",
		regex:
			/\/skill:(implement|plan|design|research|validate|commit|revise|blueprint)\s+\.rpiv\/artifacts/i,
	},

	// ===== ask_user_question 英文模式 =====
	// Shall I / Would you / Do you / Can I / Should I ... ?
	{
		name: "question-end",
		regex:
			/(Shall\s+I|Would\s+you|Do\s+you|Can\s+I|Should\s+I|Could\s+you|Will\s+you).*\?/i,
	},

	// ===== ask_user_question 中文模式 =====
	{
		name: "chinese-question",
		regex:
			/(要不要|是不是|能不能|会不会|可不可以|是否|需不需要|有没有|可以.*吗|要.*吗|需要.*吗)/i,
	},
	{
		name: "chinese-choice",
		regex: /(选择|确认|继续|开始|执行|下一步|提交|确定).*[？?]/i,
	},
	{
		name: "chinese-question-end",
		regex: /(吗|呢|吧|么)\s*[？?]?\s*$/m,
	},

	// ===== 输入提示 =====
	{
		name: "prompt-input",
		regex: /(请输入|请选择|请确认|请决定|请回答|输入.*内容|选择.*选项)/i,
	},
	{
		name: "choice-prompt",
		regex: /(请选择|选择.*项|Select.*option|choose|pick|Choice|Option)[:\s]*/i,
	},

	// ===== 确认模式 =====
	// 注意顺序：更具体的模式（yes-no、press-enter）放在通用 confirm-prompt 前面
	{
		name: "yes-no",
		// (Y/N) (y/n) [Y/N] yes/no 等——明确的是非选择
		regex: /[（(]?[Yy]es\/[Nn]o[)）]?|\(Y\/N\)|\(y\/n\)|\[Y\/N\]|\[y\/n\]/i,
	},
	{
		name: "press-enter",
		// Press Enter / 按回车——明确的按键提示
		regex:
			/[Pp]ress\s+(Enter|any\s+key)\s+to\s+(continue|proceed|confirm)|按.*回车|按下.*Enter/i,
	},
	{
		name: "confirm-prompt",
		// 通用确认——放在 yes-no 和 press-enter 后面，避免误匹配
		// 注意：去掉 .* 避免过度匹配，改用 \s* 和可选问号
		regex: /(Confirm|Continue|Proceed|Abort|Retry)\s*[?？]?/i,
	},

	// ===== subagent 调度 =====
	{
		name: "subagent-start",
		// 注意：\"Background agent started\" 中末尾没有 \"background\"，所以去掉 .*background
		regex: /(Background|New)\s+agent\s+(started|created|dispatched|launched)/i,
	},
	{
		name: "subagent-complete",
		regex:
			/Background\s+agent.*completed|subagent.*result|task-notification.*completed/i,
	},

	// ===== 完成摘要 =====
	{
		name: "completion-summary",
		regex: /(complete|done|finished|完成|结束)\s*[。.!！]?\s*$/im,
	},

	// ===== 兜底：行尾问号 =====
	{
		name: "generic-question",
		regex: /[?？]\s*$/m,
	},
];

/**
 * Match pane output against user-provided patterns first, then against
 * the full catalogue of builtin patterns. Returns the first match found,
 * or null when no pattern matches.
 *
 * User patterns are treated as case-insensitive regexes. Invalid regex
 * strings are silently skipped.
 */
export function matchBuiltinPatterns(
	output: string,
	userPatterns: string[],
): PatternMatch | null {
	// Check user custom patterns first (higher priority)
	for (const raw of userPatterns) {
		try {
			const re = new RegExp(raw, "mi");
			const match = output.match(re);
			if (match) {
				return {
					type: "pattern_match",
					matchedText: match[0],
					patternName: `custom:${raw}`,
				};
			}
		} catch {
			// Skip invalid regex patterns supplied by the user
		}
	}

	// Check builtin patterns
	for (const bp of BUILTIN_PATTERNS) {
		const match = output.match(bp.regex);
		if (match) {
			return {
				type: "pattern_match",
				matchedText: match[0],
				patternName: bp.name,
			};
		}
	}

	return null;
}
