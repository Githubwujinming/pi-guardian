/**
 * respond.ts — respond tool for sending responses to a monitored pane.
 *
 * Three modes:
 * - Single-select: navigate via Down N times then Enter
 * - Multi-select: navigate to each target, Space to toggle, then Next + Enter
 * - Text input: use herdr run for atomic text+Enter delivery
 *
 * @module respond
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

// ---------------------------------------------------------------------------
// TypeBox parameter schema
// ---------------------------------------------------------------------------

const respondParams = Type.Object({
  /** Pane ID or alias to respond to. */
  pane: Type.String(),

  /** Option index for single-select (0-based). */
  optionIndex: Type.Optional(Type.Number()),

  /** Option indices for multi-select (0-based, toggled via Space). */
  options: Type.Optional(Type.Array(Type.Number())),

  /** Text to type and submit. Use for "Type something." or command input. */
  text: Type.Optional(Type.String()),
});

type RespondArgs = Static<typeof respondParams>;

export interface RespondDetails {
  pane: string;
  mode: "select" | "multi-select" | "text";
  optionIndex?: number;
  options?: number[];
  text?: string;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerRespondTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "respond",
    label: "Respond to Pane",
    description:
      "Send a response to a monitored pane. Supports option selection " +
      "(single-select via optionIndex, multi-select via options array) " +
      "and text input via text parameter.",
    parameters: respondParams,

    execute: async (
      _toolCallId: string,
      params: RespondArgs,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<RespondDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<RespondDetails>> => {
      const paneRef = params.pane;

      onUpdate?.({
        content: [{ type: "text", text: `Responding to ${paneRef}...` }],
        details: { pane: paneRef, mode: "text" },
      });

      // --- Single-select: navigate ↓N then Enter ---
      if (params.optionIndex != null) {
        const idx = params.optionIndex;
        for (let i = 0; i < idx; i++) {
          if (signal?.aborted) throw new Error("Canceled");
          await pi.exec("herdr", ["pane", "send-keys", paneRef, "Down"], { signal });
        }
        if (signal?.aborted) throw new Error("Canceled");
        await pi.exec("herdr", ["pane", "send-keys", paneRef, "Enter"], { signal });

        return {
          content: [{ type: "text", text: `Selected option ${idx} in ${paneRef}` }],
          details: { pane: paneRef, mode: "select", optionIndex: idx },
        };
      }

      // --- Multi-select: navigate, Space toggle, then Next + Enter ---
      if (params.options != null && params.options.length > 0) {
        const sorted = [...params.options].sort((a, b) => a - b);
        let currentPos = 0;

        for (const target of sorted) {
          const steps = target - currentPos;
          for (let i = 0; i < steps; i++) {
            if (signal?.aborted) throw new Error("Canceled");
            await pi.exec("herdr", ["pane", "send-keys", paneRef, "Down"], { signal });
          }
          currentPos = target;
          if (signal?.aborted) throw new Error("Canceled");
          await pi.exec("herdr", ["pane", "send-keys", paneRef, "Space"], { signal });
        }

        // Navigate past last option to "Next / 下一步"
        const last = Math.max(...sorted);
        const nextSteps = (last + 1) - currentPos;
        for (let i = 0; i < nextSteps; i++) {
          if (signal?.aborted) throw new Error("Canceled");
          await pi.exec("herdr", ["pane", "send-keys", paneRef, "Down"], { signal });
        }
        if (signal?.aborted) throw new Error("Canceled");
        await pi.exec("herdr", ["pane", "send-keys", paneRef, "Enter"], { signal });

        return {
          content: [{ type: "text", text: `Toggled options [${sorted.join(", ")}] in ${paneRef}` }],
          details: { pane: paneRef, mode: "multi-select", options: sorted },
        };
      }

      // --- Text input: herdr run (atomic text + Enter) ---
      if (params.text != null) {
        await pi.exec("herdr", ["pane", "run", paneRef, params.text], { signal });

        return {
          content: [{ type: "text", text: `Sent "${params.text}" to ${paneRef}` }],
          details: { pane: paneRef, mode: "text", text: params.text },
        };
      }

      throw new Error("respond requires one of: optionIndex, options[], or text");
    },

    // -----------------------------------------------------------------------
    // renderCall
    // -----------------------------------------------------------------------
    renderCall: (args: RespondArgs, theme) => {
      const parts = [theme.bold("respond")];
      parts.push(`  pane: ${args.pane}`);
      if (args.optionIndex != null) parts.push(`  optionIndex: ${args.optionIndex}`);
      if (args.options?.length) parts.push(`  options: [${args.options.join(", ")}]`);
      if (args.text) parts.push(`  text: "${args.text.slice(0, 60)}"`);
      return new Text(parts.join("\n"));
    },

    // -----------------------------------------------------------------------
    // renderResult
    // -----------------------------------------------------------------------
    renderResult: (result: AgentToolResult<RespondDetails>, _options: ToolRenderResultOptions, theme) => {
      const d = result.details;
      if (!d) return new Text("respond completed");

      switch (d.mode) {
        case "select":
          return new Text(
            theme.fg("success", `\u2713 ${d.pane}`) +
            theme.fg("dim", ` \u203A option ${d.optionIndex}`)
          );
        case "multi-select":
          return new Text(
            theme.fg("success", `\u2713 ${d.pane}`) +
            theme.fg("dim", ` \u203A [${(d.options ?? []).join(",")}]`)
          );
        case "text":
          return new Text(
            theme.fg("success", `\u2713 ${d.pane}`) +
            theme.fg("dim", ` \u203A "${(d.text ?? "").slice(0, 40)}"`)
          );
        default:
          return new Text(theme.fg("success", `\u2713 ${d.pane}`));
      }
    },
  });
}
