// ---------------------------------------------------------------------------
// lifecycle-verification (cinatra#2042, epic #2037 — S4 "post-change verification",
// re-anchored 2026-07-25 onto the run-embedded review surface).
//
// The PURE verdict core for post-change verification. Given the reviewed (base)
// revision's projected field map, the repaired (successor) revision's projected
// field map, the accepted findings (each optionally scoped to a field `path`),
// and the review's SCOPE MANIFEST (the set of paths the review authorized changes
// to), it computes:
//
//   - fieldDiff        — the before/after field-level diff (the `content_change_
//                        proposal` shape: {field, before, after}) over every
//                        changed path (the UI's "Core analysis" before/after view).
//   - unmetFindingIds  — an accepted, field-scoped finding whose field was NOT
//                        changed by the repair (an IN-SCOPE finding left unapplied).
//   - outOfScopePaths  — a changed field OUTSIDE the scope manifest (OUT-OF-SCOPE
//                        drift the repair introduced beyond what the review asked).
//   - outcome          — verified | drifted | unmet (drift takes precedence: an
//                        unexpected change is a safety concern surfaced first).
//
// This module is PURE (no DB, no React, no I/O) so the verdict is fixture-pinned
// and independently unit-provable. The store half (lifecycle-verification-store)
// projects the two revisions into field maps, calls this, persists the record,
// and — on a non-`verified` verdict — reopens exactly ONE bounded gate.
//
// INDEPENDENCE: the verdict NEVER trusts the producer's self-reported
// `findingOutcomes.applied` — it re-derives applied/unapplied from the actual
// field change, so a producer that claims a finding applied but changed nothing
// is caught (`unmet`). The producer's claim is provenance only.
// ---------------------------------------------------------------------------

/** The scope manifest: the closed set of field paths the review authorized the
 * repair to change. A change to any path outside this set is out-of-scope drift. */
export interface VerificationScopeManifest {
  paths: string[];
}

/** An accepted finding, narrowed to what verification reads (from RepairFinding). */
export interface VerificationFinding {
  id: string;
  /** The field/region path the finding is scoped to; a path-less finding cannot be
   * field-verified (advisory-only — it never forces an `unmet`). */
  path?: string | null;
}

/** One before/after field change — the `content_change_proposal` shape, so the
 * before/after UI renders it through the established diff precedent. */
export interface VerificationFieldDiffEntry {
  field: string;
  before?: string;
  after?: string;
}

export type VerificationOutcome = "verified" | "drifted" | "unmet";

export interface VerificationInput {
  /** The accepted findings the repair was asked to implement. */
  acceptedFindings: readonly VerificationFinding[];
  /** The closed set of authorized field paths. */
  scopeManifest: VerificationScopeManifest;
  /** The reviewed (base) revision projected to a flat field map {path -> value}. */
  baseFields: Readonly<Record<string, string>>;
  /** The repaired (successor) revision projected to a flat field map. */
  repairedFields: Readonly<Record<string, string>>;
  /** Type/skill validator failures the caller ran against the repaired revision
   * (empty ⇒ validators pass). A non-empty set forces a non-`verified` verdict. */
  validatorFailures?: readonly string[];
  /** Whether the rendered representation corresponds to the repaired revision
   * (the caller resolves this; defaults true). false forces a non-`verified`. */
  representationMatches?: boolean;
}

export interface VerificationVerdict {
  outcome: VerificationOutcome;
  /** Before/after over every changed field (sorted by path — deterministic). */
  fieldDiff: VerificationFieldDiffEntry[];
  /** Every path whose value changed base → repaired (sorted). */
  changedPaths: string[];
  /** Accepted, field-scoped findings whose field did NOT change (in-scope unapplied). */
  unmetFindingIds: string[];
  /** Changed paths outside the scope manifest (out-of-scope drift). */
  outOfScopePaths: string[];
  /** Validator failures carried through (empty ⇒ validators passed). */
  validatorFailures: string[];
  /** Whether the rendered representation corresponds to the repaired revision. */
  representationMatches: boolean;
}

function normalize(v: string | undefined): string {
  return v ?? "";
}

/**
 * Compute the post-change verification verdict over {base, repaired} field maps.
 * Pure and deterministic. See the module header for the outcome semantics.
 */
export function computeVerificationVerdict(input: VerificationInput): VerificationVerdict {
  const scope = new Set(input.scopeManifest.paths);
  const base = input.baseFields;
  const repaired = input.repairedFields;

  // Union of every path present on either side, in a stable order.
  const allPaths = [...new Set([...Object.keys(base), ...Object.keys(repaired)])].sort();

  const fieldDiff: VerificationFieldDiffEntry[] = [];
  const changed = new Set<string>();
  for (const path of allPaths) {
    const before = base[path];
    const after = repaired[path];
    if (normalize(before) !== normalize(after)) {
      changed.add(path);
      fieldDiff.push({ field: path, before, after });
    }
  }

  // An accepted, field-scoped finding whose field was PROJECTED (present on either
  // side) but did NOT change = in-scope unapplied. A finding whose field is ABSENT
  // from the projection is NOT asserted unapplied — verification only judges what it
  // could actually see (the provenance principle: no output implies broader
  // inspection than occurred). A type-aware projector that exposes the finding's
  // field is what makes such a finding verifiable.
  const present = new Set([...Object.keys(base), ...Object.keys(repaired)]);
  const unmetFindingIds = input.acceptedFindings
    .filter((f) => f.path != null && f.path !== "" && present.has(f.path) && !changed.has(f.path))
    .map((f) => f.id)
    .sort();

  // A changed field outside the scope manifest = out-of-scope drift.
  const outOfScopePaths = [...changed].filter((p) => !scope.has(p)).sort();

  const validatorFailures = [...(input.validatorFailures ?? [])];
  const representationMatches = input.representationMatches ?? true;

  // Outcome precedence: out-of-scope drift is surfaced first (an unexpected change
  // is a safety concern); then an unmet finding / failed validator / mismatched
  // representation; otherwise verified.
  let outcome: VerificationOutcome;
  if (outOfScopePaths.length > 0) {
    outcome = "drifted";
  } else if (unmetFindingIds.length > 0 || validatorFailures.length > 0 || !representationMatches) {
    outcome = "unmet";
  } else {
    outcome = "verified";
  }

  return {
    outcome,
    fieldDiff,
    changedPaths: [...changed].sort(),
    unmetFindingIds,
    outOfScopePaths,
    validatorFailures,
    representationMatches,
  };
}

/**
 * Derive the scope manifest from the accepted findings — the review authorized
 * changes to exactly the fields its findings named. A finding with no `path` does
 * not widen the scope (it is advisory). This is the default manifest the store
 * uses when the review carried no explicit manifest.
 */
export function scopeManifestFromFindings(
  findings: readonly VerificationFinding[],
): VerificationScopeManifest {
  const paths = [...new Set(findings.map((f) => f.path).filter((p): p is string => p != null && p !== ""))].sort();
  return { paths };
}
