import "server-only";

// Agent post-install "needs configuration" BELL FLYOUT entry (cinatra #1057
// ruling (c)).
//
// This is the NOTIFICATION half of the post-install configuration-needs
// behaviour. The Extensions-page card renders the greyed archived treatment +
// the needs-review strip (the on-page half); the run gate blocks execution (the
// enforcement half); this module keeps the BELL flyout in sync with the SAME
// derivation so the operator sees `Set up connections for "<name>":` the
// moment an installed agent is gated on an unconfigured required connector, and
// the entry DISAPPEARS the moment the agent becomes runnable.
//
// ONE entry per affected agent (ruling (c)). The entry names the agent by its
// human-readable displayName and lists each required connector's displayName as
// a link to that connector's setup page — never the bare package id.
//
// LOCK-STEP with the card: the reconciler is fed the exact per-connector
// readiness derivation the Extensions screen already computes for the current
// viewer (`resolveConfigurationNeedsForAgents`), so the bell entry and the card
// strip can never disagree.
//
// Idempotent + self-healing: keyed on a stable per-agent `dedupeKey`, the
// reconciler CREATEs an entry for a newly-gated agent, DELETEs it when the agent
// becomes runnable, and RECREATEs it (delete + insert) when the set of still-
// unconfigured connectors changes so the listed links stay accurate as the
// operator configures them one at a time. Best-effort: a notification write
// failure never blocks the page render.

import {
  AGENT_CONFIGURATION_NEEDS_CATEGORY,
  isConfigurationNeedsNotification,
  getConfigurationNeedsMetadata,
  type ConfigurationNeedsConnector,
} from "@cinatra-ai/notifications/flyout-state";
import type {
  AppNotification,
  NotificationInput,
} from "@cinatra-ai/notifications/types";

// NOTE: the notifications host adapters (postgres concerns) are registered
// LAZILY inside `syncAgentConfigurationNeedsNotifications` — the pure builder /
// reconciler below need no DB, so keeping the host-adapter side-effect import
// off this module's cold graph makes them trivially unit-testable and avoids
// widening any importer's server graph.

/**
 * One agent that is currently GATED: an installed agent with at least one
 * REQUIRED connector dependency that is not yet configured. Built by the
 * caller from the per-connector readiness derivation.
 */
export type GatedAgent = {
  agentPackageName: string;
  agentDisplayName: string;
  /** The still-unconfigured required connectors (order preserved for display). */
  connectors: ConfigurationNeedsConnector[];
};

/**
 * dedupeKey prefix shared by EVERY agent config-needs entry. The reconciler
 * reads the complete family by this prefix (uncapped) so a stale entry can
 * never hide past the paged notifications window.
 */
export const CONFIGURATION_NEEDS_DEDUPE_PREFIX = "agent-config-needs:";

/** Stable per-user idempotency key for one agent's config-needs entry. */
export function configurationNeedsDedupeKey(agentPackageName: string): string {
  return `${CONFIGURATION_NEEDS_DEDUPE_PREFIX}${agentPackageName}`;
}

/**
 * The plain-text body used for the archive list + the copy-to-clipboard button
 * (the flyout row itself renders the connector LINKS from metadata). Names the
 * connectors in displayName order.
 */
function configurationNeedsBody(agent: GatedAgent): string {
  const names = agent.connectors.map((c) => c.displayName).join(", ");
  return names
    ? `Configure ${names} before this agent can run.`
    : "Configure the required connections before this agent can run.";
}

/**
 * PURE: build the notification input for one gated agent. Title is the ruling
 * (c) copy `Set up connections for "<displayName>":` (the human-readable agent
 * name in quotation marks, followed by a colon); the connector links
 * ride in `metadata.configurationNeeds` (rendered by the flyout row); `warning`
 * kind puts it in the Unread tab + bell badge as an actionable reminder.
 */
export function buildConfigurationNeedsNotificationInput(
  agent: GatedAgent,
): NotificationInput {
  return {
    title: `Set up connections for "${agent.agentDisplayName}":`,
    body: configurationNeedsBody(agent),
    kind: "warning",
    dedupeKey: configurationNeedsDedupeKey(agent.agentPackageName),
    metadata: {
      category: AGENT_CONFIGURATION_NEEDS_CATEGORY,
      configurationNeeds: {
        agentPackageName: agent.agentPackageName,
        agentDisplayName: agent.agentDisplayName,
        connectors: agent.connectors.map((c) => ({
          displayName: c.displayName,
          packageName: c.packageName,
          settingsHref: c.settingsHref,
        })),
      },
    },
  };
}

/**
 * A content signature over a gated agent's unconfigured connector set. Two
 * entries with the same signature are interchangeable; a change means the
 * listed links are stale and the entry must be recreated. Order-independent so
 * a mere reordering does not churn the entry.
 */
function connectorSignature(connectors: readonly ConfigurationNeedsConnector[]): string {
  return connectors
    .map((c) => c.packageName)
    .slice()
    .sort()
    .join("|");
}

export type ReconcileConfigurationNeedsResult = {
  /** New notification inputs to insert (newly-gated / content-changed agents). */
  toCreateInputs: NotificationInput[];
  /** dedupeKeys of existing entries to DELETE (now-runnable / content-changed). */
  toClearDedupeKeys: string[];
};

/**
 * PURE lifecycle decision. Given the agents currently GATED and the user's
 * EXISTING config-needs notification rows, decide which entries to create and
 * which to clear:
 *
 *   - a gated agent with NO existing entry (or an existing entry whose connector
 *     set changed) → CREATE;
 *   - an existing entry whose agent is no longer gated (runnable) OR whose
 *     connector set changed → CLEAR (delete).
 *
 * A content change yields BOTH a clear and a create for that agent (delete then
 * re-insert the accurate entry). Non-config-needs existing rows are ignored
 * entirely — a job/progress notification is never touched. No I/O.
 */
export function reconcileConfigurationNeedsNotifications(input: {
  gatedAgents: readonly GatedAgent[];
  existing: readonly AppNotification[];
}): ReconcileConfigurationNeedsResult {
  // Signatures keyed by dedupeKey for the currently-gated set.
  const gatedByKey = new Map<
    string,
    { agent: GatedAgent; signature: string }
  >();
  for (const agent of input.gatedAgents) {
    if (agent.connectors.length === 0) continue; // not actually gated
    const key = configurationNeedsDedupeKey(agent.agentPackageName);
    gatedByKey.set(key, { agent, signature: connectorSignature(agent.connectors) });
  }

  // Signatures keyed by dedupeKey for the user's existing config-needs entries.
  const existingByKey = new Map<string, string>();
  for (const n of input.existing) {
    if (!isConfigurationNeedsNotification(n)) continue;
    const meta = getConfigurationNeedsMetadata(n);
    if (!meta) continue;
    const key = configurationNeedsDedupeKey(meta.agentPackageName);
    existingByKey.set(key, connectorSignature(meta.connectors));
  }

  const toClearDedupeKeys: string[] = [];
  for (const [key, existingSig] of existingByKey) {
    const gated = gatedByKey.get(key);
    // Clear when the agent is no longer gated, or its connector set changed.
    if (!gated || gated.signature !== existingSig) {
      toClearDedupeKeys.push(key);
    }
  }

  const toCreateInputs: NotificationInput[] = [];
  for (const [key, { agent, signature }] of gatedByKey) {
    const existingSig = existingByKey.get(key);
    // Create when there is no existing entry, or the existing one is stale
    // (its content-changed row is being cleared above and re-inserted here).
    if (existingSig === undefined || existingSig !== signature) {
      toCreateInputs.push(buildConfigurationNeedsNotificationInput(agent));
    }
  }

  return { toCreateInputs, toClearDedupeKeys };
}

/**
 * Reconcile the current viewer's agent configuration-needs bell entries against
 * the gated-agent set derived for them. Idempotent + best-effort — safe to call
 * on every Extensions-page render (a re-run with an unchanged gated set is a
 * no-op via the dedupeKey). A no `userId` (unauthenticated / worker) is a no-op.
 */
export async function syncAgentConfigurationNeedsNotifications(input: {
  userId: string | null | undefined;
  gatedAgents: readonly GatedAgent[];
}): Promise<void> {
  const { userId } = input;
  if (!userId) return;
  try {
    // Register the host adapters (postgres concerns) before the first
    // `@cinatra-ai/notifications/server` use on this path — the same side-effect
    // wiring the `@/lib/notifications` facade carries, imported lazily here.
    await import("@/lib/notifications-host");
    const {
      listNotificationsByDedupeKeyPrefixForUser,
      createNotificationForRecipient,
      deleteNotificationsByDedupeKeyForUser,
    } = await import("@cinatra-ai/notifications/server");

    // Read the COMPLETE config-needs family by dedupeKey prefix (uncapped), not
    // the paged 200-newest `listNotificationsForUser` — a stale entry buried
    // past that window would otherwise never be cleared when its agent becomes
    // runnable. The reconciler only reads `.metadata`, so the NotificationRecord
    // rows are used directly as the (structurally compatible) AppNotification set.
    const existing = listNotificationsByDedupeKeyPrefixForUser({
      userId,
      dedupeKeyPrefix: CONFIGURATION_NEEDS_DEDUPE_PREFIX,
    }) as unknown as AppNotification[];
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: input.gatedAgents,
        existing,
      });

    // Clear first so a content-changed entry's slot is free before re-insert.
    for (const dedupeKey of toClearDedupeKeys) {
      deleteNotificationsByDedupeKeyForUser({ userId, dedupeKey });
    }
    for (const notificationInput of toCreateInputs) {
      await createNotificationForRecipient(
        { kind: "user", userId },
        notificationInput,
      );
    }
  } catch (err) {
    console.warn(
      "[agent-config-needs] could not reconcile bell notifications:",
      err instanceof Error ? err.message : err,
    );
  }
}
