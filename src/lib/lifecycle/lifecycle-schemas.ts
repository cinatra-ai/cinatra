/**
 * DECIDED SCHEMAS (cinatra#2038, epic #2037 S0) — the record shapes later slices
 * depend on, LANDED here so every downstream slice builds against a fixed
 * contract. Implementations ship in the named slice; S0 lands the TYPES + the
 * backing DDL (see `lifecycle-schema.ts`), fenced.
 *
 *   - VERIFICATION records (S4): `{reviewedTarget, repairedTarget}` + the review's
 *     scope manifest; field-level + visual before/after.
 *   - PER-RUN SELECTED SKILL-REVISION sets (S3): an immutable per-run set of
 *     pinned skill revisions consumed by every delivery path.
 *   - CMS SNAPSHOT-as-target + scope manifest + apply-binding (S5).
 *   - GATE-BOUND immutable SUGGESTION snapshots + a decision-application ledger
 *     (S4 auditor re-home).
 *
 * PURE type contracts only — no behavior lands here.
 */

import type { RepairTargetRef } from "./lifecycle-repair";

// ---------------------------------------------------------------------------
// Verification records (Point A — S4).
// ---------------------------------------------------------------------------

/** The review's SCOPE MANIFEST — what the reviewed decision was allowed to touch
 * (field/region paths). Verification checks the successor stayed within it. */
export interface ReviewScopeManifest {
  /** Field/region paths in scope for the review (empty = whole target). */
  paths: string[];
}

/** A field-level before/after entry. */
export interface FieldDiffEntry {
  path: string;
  before: string | null;
  after: string | null;
}

/** A visual before/after capture pair (S4/S6 populate; S0 fixes the shape). */
export interface VisualDiffCapture {
  beforeCaptureId: string | null;
  afterCaptureId: string | null;
}

export type VerificationOutcome = "verified" | "drifted" | "unmet";

/**
 * A post-change VERIFICATION record: the reviewed target, the repaired successor
 * target, the scope manifest the review carried, the field-level + visual
 * before/after, and the outcome. `drifted`/`unmet` reopen a bounded gate (S4).
 */
export interface VerificationRecord {
  id: string;
  gateId: string;
  reviewedTarget: RepairTargetRef;
  repairedTarget: RepairTargetRef;
  scopeManifest: ReviewScopeManifest;
  fieldDiff: FieldDiffEntry[];
  visualDiff: VisualDiffCapture | null;
  outcome: VerificationOutcome;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Per-run selected skill-revision sets (Point R — S3).
// ---------------------------------------------------------------------------

/** An IMMUTABLE per-run selection of a pinned skill revision. The authoritative
 * per-run set every delivery path consumes (distinct from the telemetry-only
 * `agent_run_skills_used`, which stays untouched). */
export interface SelectedSkillRevision {
  runId: string;
  skillId: string;
  /** The EXACT pinned skill revision selected (immutable). */
  skillRevisionId: string;
  /** How the selection arrived (recommended-and-confirmed, forced, etc.). S3
   * enumerates; S0 fixes the column. */
  selectionSource: string;
  selectedAt: Date;
}

// ---------------------------------------------------------------------------
// CMS snapshot-as-target + apply-binding (S5).
// ---------------------------------------------------------------------------

/**
 * The apply-binding a CMS snapshot target carries — the coordinates the staged
 * remote write is applied against, with the base remote revision (a CAS witness)
 * and the saga `operationId`.
 */
export interface CmsApplyBinding {
  connectorInstance: string;
  resourceType: string;
  resourceId: string | null;
  /** The base remote revision ref OR content hash the apply CAS-checks against. */
  baseRemoteRevisionRef: string | null;
  operationId: string;
}

/**
 * A CMS SNAPSHOT-as-target: a LOCALLY pinned snapshot revision captured from the
 * staged remote write (a CMS artifact is otherwise a pointer, not review-able
 * content), its scope manifest (the content-vs-chrome boundary the adapter
 * declares), and the apply-binding. S5 implements capture/apply; S0 fixes the
 * shape.
 */
export interface CmsSnapshotTarget {
  id: string;
  artifactId: string;
  /** The locally pinned snapshot revision that IS the review target. */
  snapshotRevisionId: string;
  scopeManifest: ReviewScopeManifest;
  applyBinding: CmsApplyBinding;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Gate-bound suggestion snapshots + decision-application ledger (S4 auditor
// re-home).
// ---------------------------------------------------------------------------

/** A gate-bound IMMUTABLE suggestion snapshot — the auditor-loop suggestions,
 * re-homed as a core service, frozen at capture. Decision-free until applied
 * through the ledger. */
export interface SuggestionSnapshot {
  id: string;
  gateId: string;
  /** The immutable frozen suggestion payload (JSON). */
  payload: unknown;
  createdAt: Date;
}

export type SuggestionDecision = "applied" | "dismissed";

/** The decision-application ledger: which gate-bound suggestion was
 * applied/dismissed, by whom, when — the auditor suggestion→personal-skill
 * learning loop's durable record. */
export interface SuggestionDecisionLedgerEntry {
  id: string;
  suggestionId: string;
  gateId: string;
  decision: SuggestionDecision;
  decidedBy: string;
  decidedAt: Date;
}
