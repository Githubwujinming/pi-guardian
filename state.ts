export interface ActiveWatch {
  watchId: string;
  paneId: string;
  workspaceId: string;
  alias?: string;
  planPath?: string;
  patterns: string[];
  autoRespond: boolean;
  pollingInterval: number;
  abortController: AbortController;
  startedAt: number;
  status: "running" | "stopped";
}

export interface WatchSnapshot {
  watchId: string;
  paneId: string;
  workspaceId: string;
  alias?: string;
  planPath?: string;
  patterns: string[];
  autoRespond: boolean;
  pollingInterval: number;
  startedAt: number;
  status: "running" | "stopped";
}

// Module-level state — shared between guard_pane and respond tools
const activeWatches = new Map<string, ActiveWatch>();
const recoveredWatches = new Map<string, ActiveWatch>();

export function getActiveWatches(): Map<string, ActiveWatch> {
  return activeWatches;
}

export function setActiveWatch(watchId: string, watch: ActiveWatch): void {
  activeWatches.set(watchId, watch);
}

export function removeActiveWatch(watchId: string): void {
  activeWatches.delete(watchId);
}

export function snapshotWatches(): Record<string, WatchSnapshot> {
  const snapshot: Record<string, WatchSnapshot> = {};
  for (const [watchId, watch] of activeWatches) {
    snapshot[watchId] = {
      watchId: watch.watchId,
      paneId: watch.paneId,
      workspaceId: watch.workspaceId,
      alias: watch.alias,
      planPath: watch.planPath,
      patterns: watch.patterns,
      autoRespond: watch.autoRespond,
      pollingInterval: watch.pollingInterval,
      startedAt: watch.startedAt,
      status: watch.status,
    };
  }
  return snapshot;
}

/**
 * Get watches that were recovered from session history (stopped state).
 */
export function getRecoveredWatches(): Map<string, ActiveWatch> {
  return recoveredWatches;
}

/**
 * Reconstruct activeWatches from session branch on session_start/session_tree.
 * Iterates toolResult messages for guard_pane/respond and restores
 * the last-known watch snapshots into recoveredWatches.
 * AbortController is NOT persisted — reconstructed watches are marked as "stopped"
 * and stored separately to avoid ID collision with active watches.
 */
export function reconstructState(ctx: {
  sessionManager: { getBranch(): Iterable<unknown> };
}): void {
  recoveredWatches.clear();
  for (const entry of ctx.sessionManager.getBranch()) {
    const e = entry as {
      type?: string;
      message?: { role?: string; toolName?: string; details?: Record<string, unknown> };
    };
    if (e.type !== "message") continue;
    const msg = e.message;
    if (!msg || msg.role !== "toolResult") continue;
    if (msg.toolName !== "guard_pane" && msg.toolName !== "respond") continue;
    const details = msg.details;
    if (!details?.watches) continue;
    const watches = details.watches as Record<string, WatchSnapshot>;
    for (const [id, snap] of Object.entries(watches)) {
      recoveredWatches.set(id, {
        ...snap,
        abortController: new AbortController(),
        status: "stopped",
      });
    }
  }
}
