/**
 * The `changes_requested` + REPAIR-PROTOCOL contract (cinatra#2038, epic #2037
 * S0) — FEATURE-FENCED (unselectable) until S2.
 *
 * The existing review decision core (`src/lib/artifacts/artifact-review-decision.ts`)
 * admits only `approve` / `reject` / `comment` — it has NO way to express "make
 * these changes". This slice DECIDES the `changes_requested` disposition and the
 * typed repair round-trip (structured findings, base-revision CAS,
 * successor-revision pinning, continuation), and lands them as CONTRACTS — but
 * `changes_requested` is deliberately NOT SELECTABLE until S2 wires the repair
 * loop. The fence is a first-class, testable invariant: the disposition EXISTS in
 * the vocabulary yet `isSelectableDisposition` returns false for it, so a decision
 * surface that (wrongly) offered it would be caught by the fence test.
 *
 * PURE (no DB): contracts + the fence predicate + finding-id validation. The live
 * repair dispatch is S2.
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
 * The FENCE. `changes_requested` is present in the vocabulary but UNSELECTABLE
 * until S2 ships the repair loop. Every other disposition is selectable today.
 * The decision-submit surface (S2) checks this before admitting a disposition;
 * the S0 fence test asserts the exact membership: the disposition is in the
 * vocabulary AND not selectable.
 */
const SELECTABLE_DISPOSITIONS: ReadonlySet<LifecycleReviewDisposition> = new Set<LifecycleReviewDisposition>([
  "approve",
  "reject",
  "comment",
  // "changes_requested" — FENCED until S2 (deliberately excluded).
]);

export function isSelectableDisposition(d: LifecycleReviewDisposition): boolean {
  return SELECTABLE_DISPOSITIONS.has(d);
}

/** True iff `changes_requested` remains fenced (unselectable). The fence test
 * asserts this; S2 flips the membership above and this returns false. */
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
