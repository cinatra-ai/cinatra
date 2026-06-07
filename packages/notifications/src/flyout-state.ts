import type { AppNotification } from "./types";

// ---------------------------------------------------------------------------
// Pure helpers for the notifications flyout state.
//
// Extracted from src/components/app-shell.tsx so:
//   1. The multi-tab SSE dedupe contract can be tested without mounting the
//      component, which lets the test target the production code rather than a
//      copy of the logic.
//   2. The flyout and `<NotificationsFlyout>` reuse the same contract.
//   3. `collapseByJobId` + per-tab filter helpers merge running + terminal rows
//      by `sourceJobId` and produce the per-tab slices for the All / Unread /
//      In progress tabs.
//
// **Browser-safe** — this module has no `server-only` import. It is consumed
// by client components.
// ---------------------------------------------------------------------------

/**
 * Append a notification arriving via SSE push to the current flyout state,
 * dropping it as a no-op when an entry with the same id is already present.
 *
 * Semantics:
 *
 * - When the incoming id is NOT in `current`: return a new array with the
 *   incoming entry **prepended** (newest-first ordering).
 * - When the incoming id IS in `current`: return the **same array reference**
 *   — React state stability optimization, avoids a re-render when SSE
 *   delivers a notification a poll snapshot has already loaded.
 * - **Never mutates the input array.** A non-deduping return path always
 *   produces a fresh array. This is the cross-tab independence invariant —
 *   two tabs running through the same operations on separate state
 *   containers cannot leak through a shared mutable array.
 *
 * Race ordering (multi-tab):
 *
 * - **SSE-first, then poll**: SSE prepends, then `loadNotifications` does a
 *   full-replace with the server snapshot (which also contains the row).
 *   Both tabs converge to length-1.
 * - **Poll-first, then SSE**: poll loads the snapshot, then SSE sees the id
 *   already present and short-circuits. Both tabs converge to length-1.
 */
export function applySseNotification(
  current: AppNotification[],
  incoming: AppNotification,
): AppNotification[] {
  if (current.some((n) => n.id === incoming.id)) return current;
  return [incoming, ...current];
}

// ---------------------------------------------------------------------------
// Background-process running-row helpers.
// ---------------------------------------------------------------------------

/**
 * Returns true when the notification represents a still-running
 * background-process row (`kind === "info"` plus
 * `metadata.progress.status === "running"`).
 *
 * The two checks together — kind plus metadata — defend against any
 * `info`-kind notification that isn't a background-process row from being
 * misclassified as in-progress.
 */
export function isRunningProgressNotification(n: AppNotification): boolean {
  if (n.kind !== "info") return false;
  const md = n.metadata as
    | { category?: unknown; progress?: { status?: unknown } }
    | undefined;
  if (!md || md.category !== "background_process") return false;
  return md.progress?.status === "running";
}

/**
 * Collapse running + terminal rows for the same `sourceJobId` into one row.
 *
 * Rules:
 * - Items without `sourceJobId` pass through unchanged.
 * - For each `sourceJobId` group:
 *   - If a terminal row (kind ∈ {success, error, warning}) exists, return
 *     it and drop the running rows. **Terminal wins over running EVEN when
 *     the running row's `createdAt` is newer**. This defends against clock
 *     skew and fast-job races. This is the only inversion of the otherwise
 *     newest-first ordering, and it's intentional: a terminal event is a
 *     stronger signal than its delayed running counterpart.
 *   - If only running rows exist (or only one kind), pick the newest by
 *     `createdAt` desc.
 *   - If multiple terminals exist for one job, pick the newest by
 *     `createdAt` desc.
 *
 * Output ordering: sorted by the **selected** row's `createdAt` desc,
 * NOT the discarded row's timestamp (a small but important nuance — sorting
 * by a row that won't be displayed misleads the viewer when terminal wins
 * over a newer running row).
 *
 * Pure. Never mutates inputs.
 */
export function collapseByJobId(
  items: AppNotification[],
): AppNotification[] {
  const TERMINAL_KINDS = new Set<AppNotification["kind"]>([
    "success",
    "error",
    "warning",
  ]);
  const isTerminal = (n: AppNotification) => TERMINAL_KINDS.has(n.kind);
  const standalone: AppNotification[] = [];
  const groups = new Map<string, AppNotification[]>();
  for (const item of items) {
    const jobId = item.sourceJobId;
    if (!jobId) {
      standalone.push(item);
      continue;
    }
    const bucket = groups.get(jobId);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(jobId, [item]);
    }
  }
  const winners: AppNotification[] = [];
  for (const bucket of groups.values()) {
    const terminals = bucket.filter(isTerminal);
    const pool = terminals.length > 0 ? terminals : bucket;
    // Newest first within the chosen pool.
    let winner = pool[0]!;
    for (let i = 1; i < pool.length; i += 1) {
      const candidate = pool[i]!;
      if (candidate.createdAt.localeCompare(winner.createdAt) > 0) {
        winner = candidate;
      }
    }
    winners.push(winner);
  }
  return [...standalone, ...winners].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

/**
 * Slice for the In-progress tab: rows whose `sourceJobId` has NO terminal
 * counterpart in the current list. A terminal row preempts the running row
 * via `collapseByJobId`; this helper is the complementary view that surfaces
 * "still running" jobs to the user.
 *
 * Pure. Never mutates inputs.
 */
export function getInProgressItems(
  items: AppNotification[],
): AppNotification[] {
  const terminalJobIds = new Set<string>();
  for (const n of items) {
    if (!n.sourceJobId) continue;
    if (n.kind === "info") continue;
    terminalJobIds.add(n.sourceJobId);
  }
  return items
    .filter(
      (n) =>
        isRunningProgressNotification(n) &&
        !!n.sourceJobId &&
        !terminalJobIds.has(n.sourceJobId),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Slice for the Unread tab.
 *
 * Excludes:
 * - Rows already marked read (`readAt` truthy).
 * - In-progress rows (they are auto-read at INSERT time; the In-progress tab
 *   is their home).
 * - Rows whose `href` matches `currentPathname` (the user is already
 *   looking at the target page; current app-shell behavior already
 *   auto-marks these read — this helper keeps the count consistent during
 *   the mark-as-read RTT).
 *
 * Pure. Never mutates inputs.
 */
export function getUnreadItems(
  items: AppNotification[],
  currentPathname?: string,
): AppNotification[] {
  return items.filter((n) => {
    if (n.readAt) return false;
    if (isRunningProgressNotification(n)) return false;
    if (currentPathname && n.href) {
      if (
        n.href === currentPathname ||
        currentPathname.startsWith(`${n.href}/`)
      ) {
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Agent-creation progress timeline filter.
//
// Append-only progress rows are tagged via `metadata.category ===
// "agent_creation_progress"` and grouped by `metadata.progress.runId`.
// They are NOT collapsed by collapseByJobId — every progress event is its own
// row in the timeline, ordered ASCENDING by createdAt (oldest first;
// "queued" at the top, "review_done" at the bottom).
//
// Pure. Never mutates inputs.
// ---------------------------------------------------------------------------
export function filterAgentCreationProgressByRunId(
  items: AppNotification[],
  runId: string,
): AppNotification[] {
  if (!runId) return [];
  return items
    .filter((n) => {
      if (n.kind !== "info") return false;
      const md = n.metadata as
        | {
            category?: unknown;
            progress?: { runId?: unknown };
          }
        | undefined;
      if (!md || md.category !== "agent_creation_progress") return false;
      return md.progress?.runId === runId;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
