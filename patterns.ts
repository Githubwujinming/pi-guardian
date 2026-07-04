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
  // --- rpiv workflow phase transitions ---
  {
    name: "next-step",
    regex: /(是否|要|需要).*(开始|继续|进行)\s*(Phase|阶段|步骤|step)\s*\d+/i,
  },
  {
    name: "follow-up",
    regex: /(是否|需要|要不要).*继续|下一步|下一阶段|next phase|proceed/i,
  },
  {
    name: "implement-complete",
    regex: /implement.*(complete|finished|done)|implementation.*result|阶段.*完成/i,
  },
  {
    name: "implement-phase-result",
    regex: /Phase\s*\d+.*(complete|done|finished|result|summary)/i,
  },
  {
    name: "implement-verdict",
    regex: /verdict|verifying|validate|success\s*criteria/i,
  },
  {
    name: "rpiv-chain-forward",
    regex: /continue.*chain|chain.*forward|proceed.*next|advance.*phase/i,
  },

  // --- ask_user_question patterns ---
  {
    name: "question-end",
    regex: /[?？](\s*$|\n)/,
  },
  {
    name: "chinese-question",
    regex: /(吗|呢|吧|么)[?？]?\s*$/m,
  },
  {
    name: "chinese-choice",
    regex: /[（(]\d+\s*[）)]|选项\s*\d+|选择\s*\d+/,
  },

  // --- input prompt patterns ---
  {
    name: "prompt-input",
    regex: /^[>»]|输入|请输入|prompt/i,
  },
  {
    name: "choice-prompt",
    regex: /请选择|选择.*项|Select.*option|choose|pick/i,
  },

  // --- confirmation patterns ---
  {
    name: "confirm-prompt",
    regex: /确认|confirm|是否继续|proceed|continue\s*\?/i,
  },
  {
    name: "yes-no",
    regex: /[（(].*[Yy][Ee][Ss]|[Nn][Oo][)）]|\(Y\/N\)|\(y\/n\)|\[Y\/N\]|\[y\/n\]/,
  },
  {
    name: "press-enter",
    regex: /按.*回车|press.*enter|按下.*Enter|hit.*enter/i,
  },

  // --- subagent delegation patterns ---
  {
    name: "subagent-start",
    regex: /(Background|New)\s+agent\s+(started|created|dispatched|launched).*background/i,
  },
  {
    name: "subagent-complete",
    regex: /Background\s+agent.*completed|subagent.*result|task-notification.*completed/i,
  },

  // --- completion / summary ---
  {
    name: "completion-summary",
    regex: /(总结|summary|overview|完成|done!)/im,
  },

  // --- catch-all for any question mark at end of line (LOW priority — checked LAST) ---
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
