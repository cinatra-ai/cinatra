import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-policy-store (cinatra#2038, epic #2037 S0)
//
// The persistence half of the policy LATTICE's outermost layer — the org-scoped
// BOUNDS (`required`/`forbidden`). The absence of a row IS `silent`
// (unconstrained) — never stored — so `resolveOrgPolicyRule` returns `silent`
// when no bound matches, which is exactly the input the PURE evaluator
// (`evaluatePolicy`, src/lib/lifecycle/lifecycle-policy.ts) treats as the
// unconstrained region.
//
// The lattice's inner layers are NOT stored here: core defaults are code
// (`coreDefault`), the manifest declarations are compiled onto
// `agent_templates.lifecycle_config`, and per-run elevation is a run input.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

import { db } from "./db";
import {
  agentRuns,
  agentTemplates,
  artifactProducedOutbox,
  lifecyclePolicyRules,
} from "./schema";
import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import type {
  CompiledManifestLifecycle,
  DestinationClass,
  LifecycleCheckpoint,
  LifecycleOriginKind,
  OrgPolicyRule,
  PolicyDecision,
  PolicyOutcome,
  PolicyRuleKey,
} from "@/lib/lifecycle/lifecycle-policy";

/** A wildcard artifact-type match. `artifact_type` is free text, so `*` is a
 * legal stored value (needs no CHECK relaxation) and lets an org express a bound
 * over ALL artifact types for a (checkpoint, destination, origin) tuple. An EXACT
 * type match always beats the wildcard. */
export const POLICY_ARTIFACT_TYPE_WILDCARD = "*";

export interface UpsertPolicyRuleInput {
  orgId: string;
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
  bound: "required" | "forbidden";
  selfApprovalOptIn?: boolean;
}

/**
 * Upsert an org bound. Keyed by the full (org, checkpoint, artifactType,
 * destinationClass, originKind) tuple — a re-upsert of the same key updates the
 * bound + opt-in in place (idempotent). `silent` is NOT storable: to remove a
 * bound, call `deleteLifecyclePolicyRule`.
 */
export async function upsertLifecyclePolicyRule(
  input: UpsertPolicyRuleInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(lifecyclePolicyRules)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      checkpoint: input.checkpoint,
      artifactType: input.artifactType,
      destinationClass: input.destinationClass,
      originKind: input.originKind,
      bound: input.bound,
      selfApprovalOptIn: input.selfApprovalOptIn ?? false,
    })
    .onConflictDoUpdate({
      target: [
        lifecyclePolicyRules.orgId,
        lifecyclePolicyRules.checkpoint,
        lifecyclePolicyRules.artifactType,
        lifecyclePolicyRules.destinationClass,
        lifecyclePolicyRules.originKind,
      ],
      set: {
        bound: input.bound,
        selfApprovalOptIn: input.selfApprovalOptIn ?? false,
        updatedAt: new Date(),
      },
    })
    .returning({ id: lifecyclePolicyRules.id });
  return { id: row.id };
}

export async function deleteLifecyclePolicyRule(input: {
  orgId: string;
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
}): Promise<void> {
  await db
    .delete(lifecyclePolicyRules)
    .where(
      and(
        eq(lifecyclePolicyRules.orgId, input.orgId),
        eq(lifecyclePolicyRules.checkpoint, input.checkpoint),
        eq(lifecyclePolicyRules.artifactType, input.artifactType),
        eq(lifecyclePolicyRules.destinationClass, input.destinationClass),
        eq(lifecyclePolicyRules.originKind, input.originKind),
      ),
    );
}

/**
 * Resolve the org bound for a policy key — the injected lookup the evaluator
 * consumes. Specificity: an EXACT `artifactType` match beats the `*` wildcard
 * over the same (checkpoint, destinationClass, originKind); no match returns
 * `silent` (the unconstrained signal). Never throws.
 */
export async function resolveOrgPolicyRule(
  orgId: string,
  key: PolicyRuleKey,
): Promise<OrgPolicyRule> {
  const rows = await db
    .select({
      artifactType: lifecyclePolicyRules.artifactType,
      bound: lifecyclePolicyRules.bound,
      selfApprovalOptIn: lifecyclePolicyRules.selfApprovalOptIn,
    })
    .from(lifecyclePolicyRules)
    .where(
      and(
        eq(lifecyclePolicyRules.orgId, orgId),
        eq(lifecyclePolicyRules.checkpoint, key.checkpoint),
        eq(lifecyclePolicyRules.destinationClass, key.destinationClass),
        eq(lifecyclePolicyRules.originKind, key.originKind),
      ),
    );

  // Prefer an exact artifact-type match; fall back to the wildcard.
  const exact = rows.find((r) => r.artifactType === key.artifactType);
  const wildcard = rows.find((r) => r.artifactType === POLICY_ARTIFACT_TYPE_WILDCARD);
  const chosen = exact ?? wildcard;
  if (!chosen) return { bound: "silent" };
  return {
    bound: chosen.bound === "required" ? "required" : "forbidden",
    selfApprovalOptIn: chosen.selfApprovalOptIn,
  };
}

// ---------------------------------------------------------------------------
// Run-timeline projection of the lifecycle POLICY DECISIONS (cinatra#2047 D-5).
//
// S0 (#2038) deliverable: "Every fired/skipped decision recorded on the run
// timeline." A FIRED decision has always been visible — it opens a gate, and the
// run rail weaves gates in (#2066 C1). A SKIPPED decision left NOTHING a user can
// see: the outbox row simply reaches `status='processed'` with a NULL
// `continuation_address`, so a deliberately-skipped review is indistinguishable
// from no lifecycle machinery running at all.
//
// This reader is the missing run-scoped projection. Its source is the RUN'S OWN
// OUTBOX ROWS — the durable record of the production:
//
//   pending                          → the decision has not been made yet
//   processed + continuation_address → FIRED (that gate id)
//   processed + NULL address         → the checkpoint did NOT fire
//
// The last case is NOT unconditionally "the policy skipped it": the orchestration
// consumer ALSO marks an event processed with no address when it cannot classify
// the artifact at all (the `objects` row is gone or tombstoned — see
// `resolveReviewContext`'s `not-classifiable` path). Those two are distinguished
// here by whether the artifact is resolvable at read time, and reported as
// distinct outcomes (`skipped` vs `not_classifiable`), because rendering "Review
// skipped" for an event where no policy decision was ever taken would be a lie
// (Codex convergence).
//
// The lattice REASON is not persisted anywhere (the outbox has no reason column
// and this lane ships no migration), so what this reader reports is the CURRENT
// lattice verdict re-derived from the SAME axes the consumer used — a live
// re-derivation, NOT a historical record of the reason. Where that re-derivation
// contradicts the durable fired/skipped outcome the disagreement is reported
// (`reasonStale`) instead of attributing a reason that plainly did not produce it.
// A policy change that preserves the outcome is NOT detectable this way, which is
// exactly why the field is documented as the current verdict rather than the
// recorded one.
//
// WHY IT LIVES IN THE POLICY STORE. It is a policy read ("what did policy decide
// for this run?"), and it is deliberately kept OFF the review-orchestration store:
// the run screen consumes it, and a static edge from the run screen into the
// orchestration store drags that store's whole drive-side subtree (repair,
// verification, advisory, batch — 12 modules) into five ratcheted route graphs.
// The context resolution below therefore mirrors the orchestration store's own
// `resolveReviewContext` rather than importing it; the D-5 integration cases pin
// the two against each other by driving REAL orchestration and asserting this
// projection reproduces its verdict.
// ---------------------------------------------------------------------------

/** How a produced event's REVIEW checkpoint resolved for the run timeline.
 * `not_classifiable` is the orchestration consumer's own third outcome: the
 * artifact was gone/tombstoned by the time the event drained, so no policy
 * decision was taken at all. */
export type LifecycleRunDecisionOutcome = "fired" | "skipped" | "pending" | "not_classifiable";

export interface LifecycleRunDecision {
  eventId: string;
  artifactId: string;
  representationRevisionId: string;
  emitter: string;
  /** Point V. The other two checkpoints project through their own surfaces (the
   * run-start recommendation chip row; the rail's "Core analysis" verification
   * entry), so the outbox projection is review-only by construction. */
  checkpoint: "review";
  outcome: LifecycleRunDecisionOutcome;
  /** The gate a FIRED decision opened (the rail already renders it) — null for a
   * skipped/pending decision. */
  gateId: string | null;
  /** The CURRENT lattice verdict, re-derived at read time (`skip` / `forbidden` /
   * `fire` / `required`) — not a historical record. Null when the artifact is no
   * longer resolvable. */
  latticeOutcome: PolicyOutcome | null;
  /** Which lattice layer produced that verdict — the run timeline's answer to
   * "WHY was this skipped": `org-bound` (org-forbidden), `core-default`
   * (default-skip), `manifest` (manifest-skip), `elevation`, `fail-closed`. */
  decidedBy: PolicyDecision["decidedBy"] | null;
  /** Human-readable reason for the timeline entry — the CURRENT verdict's reason.
   * */
  reason: string;
  /** TRUE when the re-derived verdict CONTRADICTS the durable outcome (the policy
   * changed after the decision was made in a way that flips fired/skipped). The
   * timeline then shows the durable outcome and says so. A policy change that
   * preserves the outcome is not detectable without a persisted reason. */
  reasonStale: boolean;
  /** When the artifact was PRODUCED (the outbox row's `created_at`) — the
   * timeline's ordering key. Not the time the decision was applied. */
  createdAt: Date;
}

/** A minimal read-only projection of `objects` — the artifact TYPE + liveness the
 * lattice needs. A local pgSchema instance over the SAME app schema (the same
 * device the orchestration store uses) so this agents-package store reads
 * `objects.type` without depending on the host objects-store table. */
const policyObjectsSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const policyObjectsRef = policyObjectsSchema.table("objects", {
  id: text("id").primaryKey(),
  orgId: text("org_id"),
  type: text("type").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** Parse the JSON-as-text `agent_templates.lifecycle_config`. Fail-soft: a
 * malformed/absent value yields `undefined` (the lattice then uses core
 * defaults), never a throw. */
function parseManifestLifecycle(raw: string | null): CompiledManifestLifecycle | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const skips = Array.isArray(parsed.requestedSkips)
      ? (parsed.requestedSkips.filter((v) => typeof v === "string") as LifecycleCheckpoint[])
      : undefined;
    return skips ? { requestedSkips: skips } : {};
  } catch {
    return undefined;
  }
}

/**
 * The lifecycle REVIEW decisions recorded for `runId`, oldest-first — fired,
 * skipped, not-classifiable, and not-yet-decided. Plain run-scoped read
 * (`producer_run_id`); the caller owns access enforcement (the run-detail
 * aggregate's door, or the run screen's own run-access check).
 *
 * BOUNDED: `limit` (default 200, hard cap 500). A run that produces more
 * artifacts than that renders its first `limit` decisions — the projection makes
 * no pretence of unbounded history, and the bound is the ordinary run-surface
 * read budget, not a claim about the data.
 */
export async function readLifecycleDecisionsForRun(
  runId: string,
  opts?: { limit?: number },
): Promise<LifecycleRunDecision[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 200, 500));
  const rows = await db
    .select({
      eventId: artifactProducedOutbox.eventId,
      orgId: artifactProducedOutbox.orgId,
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
      emitter: artifactProducedOutbox.emitter,
      originKind: artifactProducedOutbox.originKind,
      destinationClass: artifactProducedOutbox.destinationClass,
      continuationAddress: artifactProducedOutbox.continuationAddress,
      status: artifactProducedOutbox.status,
      createdAt: artifactProducedOutbox.createdAt,
    })
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.producerRunId, runId))
    // The event-id tie-break makes the order TOTAL: two artifacts produced in the
    // same transaction share a `created_at` to the microsecond.
    .orderBy(asc(artifactProducedOutbox.createdAt), asc(artifactProducedOutbox.eventId))
    .limit(limit);
  if (rows.length === 0) return [];

  // The producing run's compiled manifest is per-RUN, so it is resolved ONCE.
  const manifest = await resolveRunManifestLifecycle(runId);

  const out: LifecycleRunDecision[] = [];
  for (const row of rows) {
    const [obj] = await db
      .select({ type: policyObjectsRef.type, deletedAt: policyObjectsRef.deletedAt })
      .from(policyObjectsRef)
      .where(and(eq(policyObjectsRef.id, row.artifactId), eq(policyObjectsRef.orgId, row.orgId)))
      .limit(1);
    const classifiable = obj != null && !obj.deletedAt;

    // A processed event with no gate is a policy SKIP only when the artifact is
    // classifiable; an unclassifiable one took the consumer's `not-classifiable`
    // path and no policy decision was ever taken (Codex convergence).
    const outcome: LifecycleRunDecisionOutcome =
      row.status === "pending"
        ? "pending"
        : row.continuationAddress
          ? "fired"
          : classifiable
            ? "skipped"
            : "not_classifiable";

    let latticeOutcome: PolicyOutcome | null = null;
    let decidedBy: PolicyDecision["decidedBy"] | null = null;
    let reason =
      outcome === "pending"
        ? "awaiting review orchestration"
        : "the artifact was deleted before the review checkpoint could classify it";
    let reasonStale = false;

    if (classifiable) {
      const originKind = row.originKind as LifecycleOriginKind;
      const destinationClass = row.destinationClass as DestinationClass;
      const orgRule = await resolveOrgPolicyRule(row.orgId, {
        checkpoint: "review",
        artifactType: obj.type,
        destinationClass,
        originKind,
      });
      const decision = evaluatePolicy({
        checkpoint: "review",
        artifactType: obj.type,
        destinationClass,
        originKind,
        // Review's core default does NOT branch on humanPresent (only
        // recommendation does) — passed to keep the pure input total, exactly as
        // the orchestration consumer passes it.
        humanPresent: false,
        orgRule,
        manifest,
      });
      latticeOutcome = decision.outcome;
      decidedBy = decision.decidedBy;
      if (outcome !== "pending") {
        reasonStale = decision.fired !== (outcome === "fired");
        reason = reasonStale
          ? `policy has changed since this decision (now: ${decision.reason})`
          : decision.reason;
      }
    }

    out.push({
      eventId: row.eventId,
      artifactId: row.artifactId,
      representationRevisionId: row.representationRevisionId,
      emitter: row.emitter,
      checkpoint: "review",
      outcome,
      gateId: row.continuationAddress,
      latticeOutcome,
      decidedBy,
      reason,
      reasonStale,
      createdAt: row.createdAt,
    });
  }
  return out;
}

/** The producing run's compiled manifest lifecycle block (`agent_templates.
 * lifecycle_config`), or undefined when the run/template no longer resolves.
 * Fail-soft — an unresolvable manifest means the lattice reasons on core
 * defaults, which is exactly what the orchestration consumer does. */
async function resolveRunManifestLifecycle(
  runId: string,
): Promise<CompiledManifestLifecycle | undefined> {
  try {
    const [run] = await db
      .select({ templateId: agentRuns.templateId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (!run?.templateId) return undefined;
    const [tmpl] = await db
      .select({ lifecycleConfig: agentTemplates.lifecycleConfig })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, run.templateId))
      .limit(1);
    return parseManifestLifecycle(tmpl?.lifecycleConfig ?? null);
  } catch {
    return undefined;
  }
}
