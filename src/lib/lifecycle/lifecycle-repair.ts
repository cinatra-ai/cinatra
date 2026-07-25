/**
 * The `changes_requested` + REPAIR-PROTOCOL contract (cinatra#2038 S0 →
 * cinatra#2040 S2, epic #2037).
 *
 * The existing review decision core (`src/lib/artifacts/artifact-review-decision.ts`)
 * admits only `approve` / `reject` / `comment` — it has NO way to express "make
 * these changes". S0 DECIDED the `changes_requested` disposition and the typed
 * repair round-trip (structured findings, base-revision CAS, successor-revision
 * pinning, continuation) and landed them as CONTRACTS, deliberately FENCED
 * (unselectable). **S2 (cinatra#2040) UNFENCES `changes_requested`** — it is now a
 * first-class, selectable disposition (`isSelectableDisposition` returns true for
 * it) that closes the immutable review attempt and opens a repair; `reject` stays
 * a tombstone, `comment` stays non-terminal.
 *
 * PURE (no DB): the contracts + the (now-open) selectability predicate + finding
 * validation + the S2 repair-loop total functions the repair store drives — the
 * cycle guard, `changes_requested` routing (repairing producer vs human/org
 * route), and the lineage/base-revision-CAS validation of a repair response. The
 * live repair dispatch + successor-gate pinning is the store's job
 * (`packages/agents/src/lifecycle-repair-store.ts`).
 */

// ---------------------------------------------------------------------------
// The FULL disposition vocabulary (the S0 superset of the existing core).
// ---------------------------------------------------------------------------

/**
 * The full lifecycle-review disposition vocabulary. `changes_requested` is the
 * NEW member this slice decides; `approve`/`reject`/`comment` mirror the existing
 * decision core (reject stays a tombstone; this contract does NOT change reject
 * semantics). This type is the FUTURE vocabulary S2 selects from — the existing
 * `ReviewDisposition` in the decision core is untouched by S0.
 */
export type LifecycleReviewDisposition =
  | "approve"
  | "reject"
  | "comment"
  | "changes_requested";

export const LIFECYCLE_REVIEW_DISPOSITIONS: readonly LifecycleReviewDisposition[] = [
  "approve",
  "reject",
  "comment",
  "changes_requested",
] as const;

/**
 * The selectable disposition set. S0 FENCED `changes_requested` (excluded here);
 * **S2 (cinatra#2040) UNFENCES it** — it is now selectable alongside
 * approve/reject/comment. The decision-submit surface checks this before admitting
 * a disposition; the S2 unfence test asserts `changes_requested` is now a member
 * (and `isChangesRequestedFenced()` is false).
 */
const SELECTABLE_DISPOSITIONS: ReadonlySet<LifecycleReviewDisposition> = new Set<LifecycleReviewDisposition>([
  "approve",
  "reject",
  "comment",
  "changes_requested", // UNFENCED by S2 (cinatra#2040) — the repair loop is live.
]);

export function isSelectableDisposition(d: LifecycleReviewDisposition): boolean {
  return SELECTABLE_DISPOSITIONS.has(d);
}

/** True iff `changes_requested` remains fenced (unselectable). S2 flipped the
 * membership above, so this now returns FALSE — the repair loop is live. Kept so
 * the fence-history test can assert the flip explicitly. */
export function isChangesRequestedFenced(): boolean {
  return !SELECTABLE_DISPOSITIONS.has("changes_requested");
}

// ---------------------------------------------------------------------------
// Structured findings.
// ---------------------------------------------------------------------------

/** A single change request against a reviewed target. `id` is STABLE across the
 * repair round-trip so the successor's per-finding applied/skipped map keys back
 * to it. `path` optionally narrows the finding to a field/region (S4/S5 use it
 * for field-level + region-level verification). */
export interface RepairFinding {
  id: string;
  message: string;
  /** Optional field/region path the finding is scoped to (dot/segment path). */
  path?: string | null;
}

/** The immutable target a repair is anchored to — the exact reviewed revision. */
export interface RepairTargetRef {
  artifactId: string;
  representationRevisionId: string;
}

// ---------------------------------------------------------------------------
// changes_requested REQUEST (reviewer → producer).
// ---------------------------------------------------------------------------

/**
 * A `changes_requested` decision. Carries the gate/decision identity + an
 * idempotency key, the EXACT base target, the structured findings, the
 * continuation mode+address, and the EXPECTED BASE REVISION (a CAS witness — the
 * repair must apply against the revision the reviewer saw, never a moved target).
 * FENCED: constructing one is legal (S2 tests build them), but no S0 surface may
 * SELECT the disposition.
 */
export interface ChangesRequestedRequest {
  gateId: string;
  decisionId: string;
  idempotencyKey: string;
  baseTarget: RepairTargetRef;
  /** The reviewer's CAS witness: the base target MUST still be this revision when
   * the repair lands, or the repair is rejected (a moved target). */
  expectedBaseRevisionId: string;
  findings: RepairFinding[];
  continuationMode: "checkpointed" | "async_effects_gated";
  continuationAddress: string | null;
}

// ---------------------------------------------------------------------------
// Repair RESPONSE (producer → new gate).
// ---------------------------------------------------------------------------

/** Per-finding outcome the producer reports. */
export interface RepairFindingOutcome {
  findingId: string;
  applied: boolean;
  /** Present when `applied` is false — why the finding was skipped. */
  skipReason?: string | null;
}

/**
 * The producer's repair response: the base + the SUCCESSOR target (a new pinned
 * revision), the per-finding applied/skipped map, a change summary, and the
 * producer provenance. S2 pins the successor into a NEW gate for verification
 * (Point A). FENCED until S2.
 */
export interface RepairResponse {
  gateId: string;
  baseTarget: RepairTargetRef;
  successorTarget: RepairTargetRef;
  findingOutcomes: RepairFindingOutcome[];
  changeSummary: string;
  producerProvenance: { runId: string | null; agentId: string | null };
}

export type ValidateChangesRequestedResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a `changes_requested` request's SHAPE (not its selectability — the
 * fence is a separate concern the surface enforces). Findings must be non-empty
 * with UNIQUE, non-empty ids; the base target + expected base revision +
 * idempotency key must be present. Pure.
 */
export function validateChangesRequested(req: ChangesRequestedRequest): ValidateChangesRequestedResult {
  if (!req.gateId) return { ok: false, error: "gateId is required" };
  if (!req.decisionId) return { ok: false, error: "decisionId is required" };
  if (!req.idempotencyKey) return { ok: false, error: "idempotencyKey is required" };
  if (!req.baseTarget?.artifactId || !req.baseTarget?.representationRevisionId) {
    return { ok: false, error: "baseTarget must name an artifact + revision" };
  }
  if (!req.expectedBaseRevisionId) {
    return { ok: false, error: "expectedBaseRevisionId (the CAS witness) is required" };
  }
  if (!Array.isArray(req.findings) || req.findings.length === 0) {
    return { ok: false, error: "at least one structured finding is required" };
  }
  const seen = new Set<string>();
  for (const f of req.findings) {
    if (!f.id) return { ok: false, error: "every finding must carry a stable id" };
    if (seen.has(f.id)) return { ok: false, error: `duplicate finding id "${f.id}"` };
    seen.add(f.id);
    if (!f.message) return { ok: false, error: `finding "${f.id}" must carry a message` };
  }
  return { ok: true };
}

// ===========================================================================
// S2 (cinatra#2040) — the repair-loop total functions the store drives.
// ===========================================================================

// ---------------------------------------------------------------------------
// Cycle guard — a lineage attempt counter with a hard bound (never loop).
// ---------------------------------------------------------------------------

/** The maximum number of repair ROUND-TRIPS a single review lineage may take
 * before core escalates to a human instead of dispatching another repair. A
 * `changes_requested` → repair → `changes_requested` chain that reaches this bound
 * escalates rather than reopening indefinitely (the AC's "cycle guard trips at the
 * bound and escalates; no unbounded reopen"). */
export const MAX_REPAIR_CYCLES = 5;

export interface RepairCycleVerdict {
  /** This attempt's 1-based ordinal in the lineage. */
  attempt: number;
  /** Whether this attempt is within the bound (may dispatch a repair). */
  withinBound: boolean;
  /** Whether the bound is exceeded (escalate to a human; never dispatch). */
  escalate: boolean;
}

/**
 * Evaluate the repair cycle guard. `priorAttempts` is the number of repair
 * round-trips this lineage has ALREADY taken (0 for the first `changes_requested`).
 * The NEXT attempt is `priorAttempts + 1`; it is within bound iff it does not
 * exceed `max`. Total + deterministic; the store persists the counter on the
 * lineage and calls this before opening each repair.
 */
export function evaluateRepairCycle(
  priorAttempts: number,
  max: number = MAX_REPAIR_CYCLES,
): RepairCycleVerdict {
  const prior = Number.isFinite(priorAttempts) && priorAttempts > 0 ? Math.floor(priorAttempts) : 0;
  const bound = Math.max(1, Math.floor(max));
  const attempt = prior + 1;
  const withinBound = attempt <= bound;
  return { attempt, withinBound, escalate: !withinBound };
}

// ---------------------------------------------------------------------------
// Routing — where a `changes_requested` decision goes.
// ---------------------------------------------------------------------------

/** How core routes a `changes_requested` decision. A repair-capable producer
 * implements it (resume for a checkpointed flow, a dispatched repair run for a
 * completed one); a non-repairing producer routes to an org-designated repair
 * route, or — absent one — escalates to a human. Nothing silently drops. */
export type ChangesRequestedRoute =
  | { kind: "producer_repair"; continuationMode: "checkpointed" | "async_effects_gated" }
  | { kind: "org_repair_route"; route: string }
  | { kind: "human_escalation"; reason: string };

/**
 * Route a `changes_requested` decision. A producer that declares the `repairs`
 * capability (`manifest.repairCapable`) implements the repair itself, per its
 * continuation mode. A producer WITHOUT the capability routes to an
 * org-designated repair route when configured, else escalates to a human — the
 * AC's "a producer without declared `repairs` capability routes `changes_requested`
 * to a human or an org-designated repair route; nothing silently drops". Total.
 */
export function routeChangesRequested(input: {
  repairCapable: boolean;
  continuationMode: "checkpointed" | "async_effects_gated";
  orgRepairRoute?: string | null;
}): ChangesRequestedRoute {
  if (input.repairCapable) {
    return { kind: "producer_repair", continuationMode: input.continuationMode };
  }
  if (input.orgRepairRoute && input.orgRepairRoute.trim().length > 0) {
    return { kind: "org_repair_route", route: input.orgRepairRoute };
  }
  return {
    kind: "human_escalation",
    reason: "producer declares no repair capability and no org repair route is configured",
  };
}

// ---------------------------------------------------------------------------
// Lineage + base-revision CAS validation of a repair response.
// ---------------------------------------------------------------------------

export type RepairLineageCode =
  | "base-mismatch"
  | "tombstoned-base"
  | "stale-base"
  | "successor-invalid"
  | "successor-equals-base"
  | "finding-unknown"
  | "finding-duplicate"
  | "finding-unmapped";

export type RepairLineageResult =
  | { ok: true }
  | { ok: false; code: RepairLineageCode; error: string };

/**
 * Validate a producer's repair RESPONSE against the original request + the LIVE
 * base target — the lineage + base-revision CAS the store enforces before pinning
 * the successor in a new gate. Pure; the store resolves `currentBaseRevisionId`
 * (the base artifact's live revision, or null when tombstoned/gone) and calls this.
 *
 *   - `base-mismatch`      — the response anchors to a different base than the request.
 *   - `tombstoned-base`    — the reviewed target was deleted; nothing to repair.
 *   - `stale-base`         — the base moved since the reviewer saw it (CAS witness
 *                            mismatch): the review no longer applies to the live
 *                            artifact, so the repair is rejected (AC: "stale repair
 *                            rejected by CAS").
 *   - `successor-invalid`  — the successor names no artifact/revision.
 *   - `successor-equals-base` — a repair MUST produce a NEW revision.
 *   - `finding-*`          — the per-finding outcome map must key EXACTLY the
 *                            request's findings (no unknown, no duplicate, none
 *                            missing) so the successor's applied/skipped is total.
 */
export function validateRepairLineage(input: {
  request: ChangesRequestedRequest;
  response: RepairResponse;
  currentBaseRevisionId: string | null;
}): RepairLineageResult {
  const { request, response, currentBaseRevisionId } = input;

  if (
    response.baseTarget.artifactId !== request.baseTarget.artifactId ||
    response.baseTarget.representationRevisionId !== request.baseTarget.representationRevisionId
  ) {
    return { ok: false, code: "base-mismatch", error: "repair response base target does not match the requested base" };
  }
  if (currentBaseRevisionId === null) {
    return { ok: false, code: "tombstoned-base", error: "base target tombstoned/absent — repair against a dead target rejected" };
  }
  if (currentBaseRevisionId !== request.expectedBaseRevisionId) {
    return {
      ok: false,
      code: "stale-base",
      error: "base revision moved since the review (CAS witness mismatch) — stale repair rejected",
    };
  }
  if (!response.successorTarget.artifactId || !response.successorTarget.representationRevisionId) {
    return { ok: false, code: "successor-invalid", error: "successor target must name an artifact + revision" };
  }
  if (
    response.successorTarget.artifactId === response.baseTarget.artifactId &&
    response.successorTarget.representationRevisionId === response.baseTarget.representationRevisionId
  ) {
    return {
      ok: false,
      code: "successor-equals-base",
      error: "successor revision must differ from the base (a repair produces a NEW revision)",
    };
  }

  const findingIds = new Set(request.findings.map((f) => f.id));
  const seenOutcomes = new Set<string>();
  for (const o of response.findingOutcomes) {
    if (!findingIds.has(o.findingId)) {
      return { ok: false, code: "finding-unknown", error: `repair reports an outcome for unknown finding "${o.findingId}"` };
    }
    if (seenOutcomes.has(o.findingId)) {
      return { ok: false, code: "finding-duplicate", error: `duplicate outcome for finding "${o.findingId}"` };
    }
    seenOutcomes.add(o.findingId);
  }
  for (const f of request.findings) {
    if (!seenOutcomes.has(f.id)) {
      return { ok: false, code: "finding-unmapped", error: `finding "${f.id}" has no reported outcome` };
    }
  }
  return { ok: true };
}
