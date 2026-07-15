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

// ---------------------------------------------------------------------------
// Agent post-install "needs configuration" flyout entry (cinatra #1057 ruling
// (c)). ONE entry per affected agent: an installed AGENT whose REQUIRED
// connector dependencies are not yet configured. The entry names the agent
// (displayName) and lists each required connector's displayName linking to its
// setup page. It is written by the server reconciler
// (`syncAgentConfigurationNeedsNotifications`) from the SAME per-connector
// readiness derivation the Extensions-page card strip uses, so the bell entry
// and the card strip stay in lock-step, and it is DELETED the moment the agent
// becomes runnable (every required connection configured).
//
// The metadata SHAPE lives here (browser-safe, zero deps) so the writer and the
// flyout renderer share ONE definition and cannot drift.
// ---------------------------------------------------------------------------

/** `metadata.category` tag identifying a config-needs flyout entry. */
export const AGENT_CONFIGURATION_NEEDS_CATEGORY =
  "agent_configuration_needs" as const;

// ---------------------------------------------------------------------------
// Run "awaiting human" notification (cinatra #1559 / notifications epic E9).
//
// A run parked on a genuine human gate (`pending_approval`, or the stop-run-hitl
// `pending_input` reason) mints a durable actionable notification to its
// initiator, hard-deleted when the wait resolves (the #1057 config-needs
// lifecycle applied to runs). The row renders through the unified feed as a
// standard notification: its `href` deep-links to the run's approval surface, so
// the row-shell's inline "Open" action routes the viewer straight to the gate.
//
// The category tag + payload SHAPE live here (browser-safe, zero deps) so the
// host writer and the feed renderer share ONE definition and cannot drift. The
// dedupeKey helper + input builder are host-side (see
// `src/lib/agent-run-wait-notifications.ts`), exactly as with config-needs.
// ---------------------------------------------------------------------------

/** `metadata.category` tag identifying a run-awaiting-human notification. */
export const RUN_AWAITING_HUMAN_CATEGORY = "run_awaiting_human" as const;

/** The `metadata.runAwaitingHuman` payload carried by the notification. */
export type RunAwaitingHumanMetadata = {
  /** The run parked on the human gate (also the dedupeKey discriminator). */
  runId: string;
  /** Which flavour of human gate the run is parked on. */
  reason: "pending_approval" | "pending_input";
};

/**
 * True when the notification is a run-awaiting-human entry
 * (`metadata.category === RUN_AWAITING_HUMAN_CATEGORY`). Pure.
 */
export function isRunAwaitingHumanNotification(n: AppNotification): boolean {
  const md = n.metadata as { category?: unknown } | undefined;
  return Boolean(md) && md?.category === RUN_AWAITING_HUMAN_CATEGORY;
}

/**
 * Extract + validate the `runAwaitingHuman` payload, returning `null` for any
 * non-matching or malformed row. Defensive — the feed renderer must never throw
 * on a hand-crafted / legacy metadata blob. Pure — never mutates the input.
 */
export function getRunAwaitingHumanMetadata(
  n: AppNotification,
): RunAwaitingHumanMetadata | null {
  const md = n.metadata as
    | { category?: unknown; runAwaitingHuman?: unknown }
    | undefined;
  if (!md || md.category !== RUN_AWAITING_HUMAN_CATEGORY) return null;
  const ra = md.runAwaitingHuman as
    | { runId?: unknown; reason?: unknown }
    | undefined;
  if (!ra || typeof ra !== "object") return null;
  const runId = typeof ra.runId === "string" ? ra.runId : "";
  const reason =
    ra.reason === "pending_approval" || ra.reason === "pending_input"
      ? ra.reason
      : null;
  if (!runId || !reason) return null;
  return { runId, reason };
}

/** One required connector the affected agent still needs configured. */
export type ConfigurationNeedsConnector = {
  /** Human-readable manifest displayName — the primary rendered link label. */
  displayName: string;
  /** The connector's canonical package id (stable identity / signature). */
  packageName: string;
  /** Deep-link to the connector's setup surface, or null when unresolved. */
  settingsHref: string | null;
};

/** The `metadata.configurationNeeds` payload carried by a config-needs entry. */
export type ConfigurationNeedsMetadata = {
  agentPackageName: string;
  agentDisplayName: string;
  connectors: ConfigurationNeedsConnector[];
};

/**
 * True when the notification is an agent post-install configuration-needs
 * entry (`metadata.category === AGENT_CONFIGURATION_NEEDS_CATEGORY`). Pure.
 */
export function isConfigurationNeedsNotification(n: AppNotification): boolean {
  const md = n.metadata as { category?: unknown } | undefined;
  return Boolean(md) && md?.category === AGENT_CONFIGURATION_NEEDS_CATEGORY;
}

/**
 * Extract + validate the `configurationNeeds` payload from a notification,
 * returning `null` for any non-config-needs or malformed row. Defensive: the
 * flyout renderer must never throw on a hand-crafted / legacy metadata blob.
 * Pure — never mutates the input.
 */
export function getConfigurationNeedsMetadata(
  n: AppNotification,
): ConfigurationNeedsMetadata | null {
  const md = n.metadata as
    | { category?: unknown; configurationNeeds?: unknown }
    | undefined;
  if (!md || md.category !== AGENT_CONFIGURATION_NEEDS_CATEGORY) return null;
  const cn = md.configurationNeeds as
    | {
        agentPackageName?: unknown;
        agentDisplayName?: unknown;
        connectors?: unknown;
      }
    | undefined;
  if (!cn || typeof cn !== "object") return null;
  const agentPackageName =
    typeof cn.agentPackageName === "string" ? cn.agentPackageName : "";
  const agentDisplayName =
    typeof cn.agentDisplayName === "string" ? cn.agentDisplayName : "";
  if (!agentPackageName || !agentDisplayName) return null;
  if (!Array.isArray(cn.connectors)) return null;
  const connectors: ConfigurationNeedsConnector[] = [];
  for (const raw of cn.connectors) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as {
      displayName?: unknown;
      packageName?: unknown;
      settingsHref?: unknown;
    };
    if (typeof c.displayName !== "string" || typeof c.packageName !== "string") {
      continue;
    }
    connectors.push({
      displayName: c.displayName,
      packageName: c.packageName,
      settingsHref:
        typeof c.settingsHref === "string" ? c.settingsHref : null,
    });
  }
  if (connectors.length === 0) return null;
  return { agentPackageName, agentDisplayName, connectors };
}
