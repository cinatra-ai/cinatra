import { eq } from "drizzle-orm";

import { betterAuthDb, betterAuthOrganizations } from "@/lib/better-auth-db";
import { entityId } from "@/lib/id-policy";

const DEFAULT_ORGANIZATION_SLUG = "default";
const DEFAULT_ORGANIZATION_NAME = "Default";

// Idempotent: returns the id of the row with slug="default" in
// public."organization". Safe under concurrent callers — uses
// ON CONFLICT (slug) DO NOTHING + RETURNING id, falling back to a
// re-SELECT when this caller loses the race. Replaces the previous
// SELECT-then-INSERT pattern in ensureInitialAdminBootstrap +
// ensureDefaultOrganizationMembership that tripped the unique
// constraint `organization_slug_key` (pg error 23505) when two
// concurrent root-layout renders on a fresh DB both reached the
// INSERT step.
// cinatra#2619 — the SECOND arm of the owning-org reconcile.
//
// The boot phase (`agent-template-org-reconcile`) heals every ALREADY-damaged
// instance on its next boot. It cannot help a FRESH one: the bundled agents are
// imported during that same boot, and the org only comes into existence later,
// when the wizard's first admin is created. Between those two events every
// bundled template is ownerless and every Run is refused with `unknown_scope` —
// and no further boot happens before the user presses Run.
//
// So the reconcile is re-run HERE, at the one chokepoint where "an organization
// now exists" becomes true.
//
// WHY AN INJECTED SEAM AND NOT AN IMPORT.
//
//   This module is reachable from EVERY route (it sits under auth), so importing
//   `@cinatra-ai/agents/…` from it — even dynamically — pulls the reconcile module
//   into all five route graphs the `route-graph-ratchet` gate locks, which it
//   caught as `+1` on each. The dependency is therefore INVERTED: the slot lives
//   here, and the boot phase (which is not a route entry) registers the real
//   implementation into it. Same shape as `setAgentRunEnqueueContract`. Net new
//   modules on any route graph: zero.
//
//   Unregistered — a process that never booted, a unit test — this is a silent
//   no-op, and the boot phase remains the arm that heals on the next boot.
//
// THE BUDGET, because this function is on the session-bootstrap path.
//
//   The pass costs one scan of `agent_templates` (one row per installed agent —
//   no index covers the predicate; the reconcile module says so plainly). That is
//   cheap but not free, so this arm is bounded on BOTH axes:
//     • at most one pass per `RECONCILE_MIN_INTERVAL_MS`, and
//     • at most `RECONCILE_MAX_PASSES` passes for the life of the process.
//   Together those cap the arm at a fixed, small amount of work covering roughly
//   the first half hour after start — the window in which a fresh instance runs
//   its wizard — after which it is inert and the boot phase is the only arm.
//
//   It is NOT a one-shot memo: the very first call happens BEFORE the bundled
//   agents finish importing (zero candidates then), so a memo armed on that pass
//   would retire the arm before it ever had anything to heal.
//
//   Concurrent callers SHARE the in-flight pass rather than racing past it, and
//   the interval clock starts when a pass FINISHES, so a slow or failing pass
//   neither stampedes nor suppresses the next attempt for its own duration.
//
// Soft-failing by construction: this heals rows, it never gates org bootstrap.
const RECONCILE_MIN_INTERVAL_MS = 15_000;
const RECONCILE_MAX_PASSES = 120;
let lastReconcileFinishedAt = 0;
let reconcilePasses = 0;
let reconcileInFlight: Promise<void> | null = null;

/** What the boot phase registers: one idempotent heal pass. */
export type OwnerlessAgentTemplateHealer = () => Promise<void>;

let registeredHealer: OwnerlessAgentTemplateHealer | undefined;

/**
 * Register the heal the org-bootstrap chokepoint should run once an organization
 * exists (cinatra#2619). Called by the `agent-template-org-reconcile` boot phase,
 * which owns the agents-package dependency this module must not carry.
 */
export function setOwnerlessAgentTemplateHealer(
  healer: OwnerlessAgentTemplateHealer,
): void {
  registeredHealer = healer;
}

async function runReconcilePass(healer: OwnerlessAgentTemplateHealer): Promise<void> {
  try {
    await healer();
  } catch (err) {
    console.warn(
      "[agents/org-reconcile] (org bootstrap) pass failed (non-fatal; boot phase retries):",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    // Clock the interval from COMPLETION, and only then release the gate.
    lastReconcileFinishedAt = Date.now();
    reconcileInFlight = null;
  }
}

async function healOwnerlessAgentTemplates(): Promise<void> {
  const healer = registeredHealer;
  if (!healer) return;
  if (reconcileInFlight) return reconcileInFlight;
  if (reconcilePasses >= RECONCILE_MAX_PASSES) return;
  if (Date.now() - lastReconcileFinishedAt < RECONCILE_MIN_INTERVAL_MS) return;
  reconcilePasses += 1;
  reconcileInFlight = runReconcilePass(healer);
  return reconcileInFlight;
}

export async function ensureDefaultOrganizationRow(): Promise<string> {
  const candidateId = entityId();

  const inserted = await betterAuthDb
    .insert(betterAuthOrganizations)
    .values({
      id: candidateId,
      name: DEFAULT_ORGANIZATION_NAME,
      slug: DEFAULT_ORGANIZATION_SLUG,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: betterAuthOrganizations.slug })
    .returning({ id: betterAuthOrganizations.id });

  if (inserted.length > 0) {
    await healOwnerlessAgentTemplates();
    return inserted[0].id;
  }

  const existing = await betterAuthDb
    .select({ id: betterAuthOrganizations.id })
    .from(betterAuthOrganizations)
    .where(eq(betterAuthOrganizations.slug, DEFAULT_ORGANIZATION_SLUG))
    .limit(1);

  if (existing.length === 0) {
    throw new Error(
      `ensureDefaultOrganizationRow: row for slug=${DEFAULT_ORGANIZATION_SLUG} disappeared after ON CONFLICT DO NOTHING (concurrent DELETE?)`,
    );
  }

  await healOwnerlessAgentTemplates();
  return existing[0].id;
}
