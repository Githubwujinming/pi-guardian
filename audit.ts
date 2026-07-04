/**
 * audit.ts — JSONL audit logging for guardian events.
 *
 * Follows rpiv-workflow/state/writes.ts fault-safe pattern:
 * mkdirSync + appendFileSync + try/catch + console.warn.
 * Never throws — returns false on failure.
 *
 * @module audit
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardianRow {
  eventNumber: number;
  ts: string;
  eventType: "ask_user_question" | "pattern_match" | "stall_detect" | "state_change";
  paneRef: { paneId: string; alias?: string };
  triggerContext: string;
  responseSent?: string;
  analysisChain?: string;
}

// ---------------------------------------------------------------------------
// Module-level counter
// ---------------------------------------------------------------------------

let eventCounter = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append one JSONL row to .guardian/audit.jsonl.
 *
 * Fail-soft: returns false on error, console.warn, never throws.
 * Creates the .guardian/ directory if it doesn't exist.
 *
 * @param cwd - Project root directory (where .guardian/ lives)
 * @param row - Event data (eventNumber/ts are auto-populated)
 * @returns true if write succeeded, false otherwise
 */
export function tryAppendGuardianJsonl(
  cwd: string,
  row: Omit<GuardianRow, "eventNumber" | "ts">,
): boolean {
  try {
    const dir = join(cwd, ".guardian");
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, "audit.jsonl");
    const entry: GuardianRow = {
      eventNumber: ++eventCounter,
      ts: new Date().toISOString(),
      ...row,
    };

    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    return true;
  } catch (e) {
    console.warn(
      `[pi-guardian] audit write failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

/**
 * Read all guardian events from the audit log.
 *
 * @param cwd - Project root directory
 * @returns Array of parsed GuardianRow entries (empty if no log exists)
 */
export async function readGuardianEvents(cwd: string): Promise<GuardianRow[]> {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const filePath = join(cwd, ".guardian", "audit.jsonl");

    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as GuardianRow);
  } catch {
    return [];
  }
}
