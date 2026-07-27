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
//
// This module is ALSO the lifecycle ADMIN leaf (cinatra#2047 defect D-3 + row 9):
// the org bounds an operator writes, the listing that shows what the org has
// expressed, AND the org-scoped review-gate VOLUME rollup those bounds should be
// tuned against. The co-location is deliberate and narrow: the admin console
// needs exactly these reads/writes and must NOT drag the orchestration runtime
// (`lifecycle-review-orchestration-store.ts` — gate emit, parks, sweepers,
// notifications) onto its module graph. Nothing here decides, emits or resolves a
// gate; every function is a plain org-scoped read/write over two tables.
//
// AUTHORIZATION IS THE CALLER'S JOB (the `listReviewGatesForRun` precedent): these
// are plain store ports. The host gates them in
// `src/lib/artifacts/lifecycle-policy-access.ts` — `settings.update` to write a
// bound, `settings.read` to read the volume — and the org id is always resolved
// from the caller's session, never accepted from a client.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

import { db } from "./db";
import {
  agentRuns,
  agentTemplates,
  artifactProducedOutbox,
  artifactReviewGates,
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

// ---------------------------------------------------------------------------
// The WRITE path's read half (cinatra#2047 defect D-3): what has this org
// actually expressed? The upsert/delete pair above is keyed by the full tuple, so
// an operator surface needs the tuple listing to edit or retract a bound.
// ---------------------------------------------------------------------------

export interface LifecyclePolicyRuleRow {
  id: string;
  orgId: string;
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
  bound: "required" | "forbidden";
  selfApprovalOptIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Every bound one org has expressed, ordered so the listing reads like the
 * lattice key: checkpoint → artifact type → destination class → origin kind.
 * ORG-SCOPED BY CONSTRUCTION — `orgId` is a required equality predicate, so no
 * caller can widen this to a cross-org read.
 */
export async function listLifecyclePolicyRules(orgId: string): Promise<LifecyclePolicyRuleRow[]> {
  const rows = await db
    .select()
    .from(lifecyclePolicyRules)
    .where(eq(lifecyclePolicyRules.orgId, orgId))
    .orderBy(
      asc(lifecyclePolicyRules.checkpoint),
      asc(lifecyclePolicyRules.artifactType),
      asc(lifecyclePolicyRules.destinationClass),
      asc(lifecyclePolicyRules.originKind),
    );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    checkpoint: r.checkpoint as LifecycleCheckpoint,
    artifactType: r.artifactType,
    destinationClass: r.destinationClass as DestinationClass,
    originKind: r.originKind as LifecycleOriginKind,
    bound: r.bound === "required" ? "required" : "forbidden",
    selfApprovalOptIn: r.selfApprovalOptIn,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GATE VOLUME (cinatra#2047 row 9 — fatigue/scale).
//
// Before this, the ONLY gate listing that shipped was `listReviewGatesForRun`
// (strictly run-scoped): a reviewer could not see how many gates were open, and
// an administrator could not see whether the core defaults + the org's bounds
// were generating a survivable volume. This is that read — org-scoped, and
// rolled up along EXACTLY the axes the policy key is written in (artifact type ·
// destination class · origin kind), so the volume a bound would change is legible
// next to the bound itself.
//
// The dimensions do not live on the gate row: they live on the produced event(s)
// that opened it (`artifact_produced_outbox.continuation_address = gate.id`) plus
// each artifact's own `objects.type`. Three properties this read holds:
//
//  1. TENANT-ANCHORED JOINS. Every joined table is filtered on the SAME `org_id`,
//     not merely on an id equality. A cross-linked or corrupt event/run can then
//     never contribute another tenant's artifact type, policy axes or package
//     name to this org's rollup.
//  2. THE CAP IS A CAP ON GATES. The scan reads a bounded page of GATES first and
//     fetches their linked events second, so a wide batch fan-out shrinks neither
//     the rollup's gate coverage nor the listing (a single joined query with a row
//     limit would have). `totalOpen` is a separate exact aggregate, so truncation
//     degrades only rollup fidelity — never the headline number.
//  3. A HETEROGENEOUS BATCH IS LABELLED, NEVER GUESSED. Production coalesces a
//     batch by `(orgId, producerRunId)`, NOT by artifact type / destination /
//     origin, so one gate may legitimately cover several values on an axis.
//     Picking one event's value would be arbitrary AND nondeterministic (SQL
//     gives no order within a gate); such a gate is reported as `mixed` on that
//     axis. A gate with no linked event at all is reported as `—` and still
//     COUNTS — under-reporting the backlog on a backlog surface would be the
//     worst possible failure.
//
// SNAPSHOT: the exact total and the scanned page are separate statements, so a
// gate created or resolved between them can make the rollup lag the total by one
// cycle. That is acceptable for a volume surface and is why the total is the
// authoritative number on screen.
// ---------------------------------------------------------------------------

/** A minimal read-only projection of `objects` — the artifact TYPE + tenancy.
 * Defined LOCALLY (a second pgSchema instance over the SAME app schema, the
 * `lifecycle-review-orchestration-store` precedent) so this narrow admin leaf
 * reads `objects.type` without depending on the host objects store. */
const appSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const objectsTypeRef = appSchema.table("objects", {
  id: text("id").primaryKey(),
  orgId: text("org_id"),
  type: text("type").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** How many OPEN gates one scan reads before it reports itself truncated. The
 * total is counted exactly by a separate aggregate, so truncation degrades only
 * the ROLLUP fidelity — never the headline number. */
export const GATE_VOLUME_SCAN_CAP = 2000;
/** Default size of the open-gate listing (the backlog head, oldest first). */
export const GATE_VOLUME_LISTING_DEFAULT = 25;
const GATE_VOLUME_LISTING_MAX = 200;

/** The value reported for an axis when a gate carries no linked produced event. */
export const GATE_VOLUME_UNSET_AXIS = "—";
/** The value reported for an axis when ONE gate's linked events disagree on it
 * (a legitimately heterogeneous batch). */
export const GATE_VOLUME_MIXED_AXIS = "mixed";

export interface OpenReviewGateRow {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  /** From the linked produced event(s) via `objects.type`; `—` when the gate
   * carries no linked produced event, `mixed` when its events disagree. */
  artifactType: string;
  destinationClass: string;
  originKind: string;
  targetCount: number;
  createdAt: Date;
  expiresAt: Date | null;
  ageMs: number;
  /** The producing run's template package name (e.g. `@cinatra-ai/blog-draft-writer-agent`),
   * used to build the run-embedded review link. Null for an orphan gate. */
  runPackageName: string | null;
}

export interface GateVolumeBucket {
  key: string;
  open: number;
}

export interface OrgReviewGateVolume {
  orgId: string;
  /** EXACT count of this org's pending gates (an aggregate, never the scan). */
  totalOpen: number;
  /** Oldest pending gate's creation time — the backlog head. */
  oldestOpenAt: Date | null;
  /** Aging of the SCANNED set, oldest-first, so the head is always represented. */
  aging: { under24h: number; under7d: number; over7d: number };
  byArtifactType: GateVolumeBucket[];
  byDestinationClass: GateVolumeBucket[];
  byOriginKind: GateVolumeBucket[];
  /** The backlog head, oldest first — each row deep-linkable to its gate. */
  openGates: OpenReviewGateRow[];
  /** How many gates the rollup actually describes (≤ `totalOpen`). */
  rollupScanned: number;
  /** True when the org has more open gates than one scan reads: the headline
   * `totalOpen` stays exact, the rollups describe the oldest `GATE_VOLUME_SCAN_CAP`. */
  rollupTruncated: boolean;
}

function bucketize(values: readonly string[]): GateVolumeBucket[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, open]) => ({ key, open }))
    // Biggest first (the fatigue question is "what is flooding me?"); ties by key
    // so the surface is deterministic across renders.
    .sort((a, b) => b.open - a.open || a.key.localeCompare(b.key));
}

/** Collapse one gate's linked-event values on a single axis: no value ⇒ `—`,
 * one distinct value ⇒ that value, several ⇒ `mixed`. Deterministic regardless
 * of the row order the database returns. */
function collapseAxis(values: readonly (string | null)[]): string {
  const distinct = new Set(values.filter((v): v is string => typeof v === "string" && v !== ""));
  if (distinct.size === 0) return GATE_VOLUME_UNSET_AXIS;
  if (distinct.size === 1) return [...distinct][0];
  return GATE_VOLUME_MIXED_AXIS;
}

/**
 * Org-scoped open-review-gate volume + the backlog head.
 *
 * ORG-SCOPED BY CONSTRUCTION: `orgId` is a required equality predicate on the
 * gate table (which carries its own `org_id` + index) AND on every joined table,
 * so no caller — and no corrupt cross-link — can widen it. Never throws on a
 * missing dimension; an unlinked gate is counted under `—`.
 */
export async function readOrgReviewGateVolume(input: {
  orgId: string;
  listingLimit?: number;
}): Promise<OrgReviewGateVolume> {
  const listingLimit = Math.max(
    1,
    Math.min(input.listingLimit ?? GATE_VOLUME_LISTING_DEFAULT, GATE_VOLUME_LISTING_MAX),
  );
  const pending = and(
    eq(artifactReviewGates.orgId, input.orgId),
    eq(artifactReviewGates.status, "pending"),
  );

  const [totalRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(artifactReviewGates)
    .where(pending);
  const totalOpen = totalRow?.n ?? 0;

  // PHASE 1 — a bounded page of GATES (never of join rows), oldest first. The
  // producing run's package rides along for the review deep-link; that join is
  // org-anchored too, so a cross-linked run cannot leak another tenant's package.
  const gateRows = await db
    .select({
      gateId: artifactReviewGates.id,
      runId: artifactReviewGates.runId,
      reviewTaskId: artifactReviewGates.reviewTaskId,
      pinnedTargets: artifactReviewGates.pinnedTargets,
      createdAt: artifactReviewGates.createdAt,
      expiresAt: artifactReviewGates.expiresAt,
      runPackageName: agentTemplates.packageName,
    })
    .from(artifactReviewGates)
    .leftJoin(
      agentRuns,
      and(eq(agentRuns.id, artifactReviewGates.runId), eq(agentRuns.orgId, input.orgId)),
    )
    .leftJoin(agentTemplates, eq(agentTemplates.id, agentRuns.templateId))
    .where(pending)
    .orderBy(asc(artifactReviewGates.createdAt), asc(artifactReviewGates.id))
    .limit(GATE_VOLUME_SCAN_CAP);

  // PHASE 2 — the produced events linked to exactly those gates, org-anchored.
  const gateIds = gateRows.map((g) => g.gateId);
  const eventRows = gateIds.length
    ? await db
        .select({
          gateId: artifactProducedOutbox.continuationAddress,
          destinationClass: artifactProducedOutbox.destinationClass,
          originKind: artifactProducedOutbox.originKind,
          artifactType: objectsTypeRef.type,
        })
        .from(artifactProducedOutbox)
        .leftJoin(
          objectsTypeRef,
          and(
            eq(objectsTypeRef.id, artifactProducedOutbox.artifactId),
            eq(objectsTypeRef.orgId, input.orgId),
          ),
        )
        .where(
          and(
            eq(artifactProducedOutbox.orgId, input.orgId),
            inArray(artifactProducedOutbox.continuationAddress, gateIds),
          ),
        )
    : [];

  const axesByGate = new Map<
    string,
    { types: (string | null)[]; destinations: (string | null)[]; origins: (string | null)[] }
  >();
  for (const row of eventRows) {
    const key = row.gateId;
    if (!key) continue;
    let entry = axesByGate.get(key);
    if (!entry) {
      entry = { types: [], destinations: [], origins: [] };
      axesByGate.set(key, entry);
    }
    entry.types.push(row.artifactType);
    entry.destinations.push(row.destinationClass);
    entry.origins.push(row.originKind);
  }

  const now = Date.now();
  const gates: OpenReviewGateRow[] = gateRows.map((row) => {
    const axes = axesByGate.get(row.gateId);
    const targets = Array.isArray(row.pinnedTargets) ? row.pinnedTargets : [];
    return {
      gateId: row.gateId,
      runId: row.runId,
      reviewTaskId: row.reviewTaskId,
      artifactType: collapseAxis(axes?.types ?? []),
      destinationClass: collapseAxis(axes?.destinations ?? []),
      originKind: collapseAxis(axes?.origins ?? []),
      targetCount: targets.length,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ageMs: Math.max(0, now - row.createdAt.getTime()),
      runPackageName: row.runPackageName ?? null,
    };
  });

  const DAY = 24 * 60 * 60 * 1000;
  const aging = { under24h: 0, under7d: 0, over7d: 0 };
  for (const g of gates) {
    if (g.ageMs < DAY) aging.under24h += 1;
    else if (g.ageMs < 7 * DAY) aging.under7d += 1;
    else aging.over7d += 1;
  }

  return {
    orgId: input.orgId,
    totalOpen,
    oldestOpenAt: gates[0]?.createdAt ?? null,
    aging,
    byArtifactType: bucketize(gates.map((g) => g.artifactType)),
    byDestinationClass: bucketize(gates.map((g) => g.destinationClass)),
    byOriginKind: bucketize(gates.map((g) => g.originKind)),
    openGates: gates.slice(0, listingLimit),
    rollupScanned: gates.length,
    rollupTruncated: totalOpen > gates.length,
  };
}
