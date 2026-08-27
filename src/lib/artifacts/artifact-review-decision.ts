/**
 * The generic artifact-review DECISION core (cinatra#1795, epic #1620 S12,
 * items 4 + 5): the versioned decision payload, submit-time re-validation, the
 * atomic multi-target commit plan, server-authoritative audit + disposition
 * capture, and true (sequential + concurrent) idempotency.
 *
 * SUBMIT-TIME RE-VALIDATION (never trust the prepared snapshot): the reviewer's
 * decision is re-checked against the LIVE gate at submit — the target set still
 * belongs to the pending gate (no substitution; a terminal decision covers the
 * whole gate), every reviewed revision is still a live member, and the gate is
 * still pending. A stale prepare cannot commit a decision the gate no longer
 * authorizes.
 *
 * SERVER-AUTHORITATIVE PROVENANCE (never client-supplied): the client decision
 * names only WHAT is reviewed (the immutable targets) + the disposition. The
 * renderer PROVENANCE recorded on each audit row is RE-DERIVED by the host from
 * the artifact's TYPE at submit time (the `deriveProvenance` port, the same
 * type-resolution the preparation surface uses) — a client cannot forge the
 * "what rendered" audit field, and a renderer that became unbuilt between prepare
 * and submit is recorded as it now resolves.
 *
 * ATOMICITY + EXACTLY-ONCE RESUME (the AC-3 invariant, corrected): a decision
 * over N targets is all-or-nothing. If ANY target fails re-validation the core
 * aborts BEFORE producing a commit plan. The workflow resume is NOT a separate
 * post-commit side effect (which could fail and strand a resolved-but-unresumed
 * workflow) — the terminal resume INTENT is part of the plan and the `commit`
 * port persists it TRANSACTIONALLY with the gate CAS + audit rows + dispositions
 * (a durable outbox — the intent is persisted EXACTLY ONCE, and the binder's
 * delivery worker drains it AT-LEAST-ONCE, so the downstream resume consumer must
 * be idempotent per gate). So a persistence failure rolls back every effect
 * INCLUDING the resume, and a committed decision's resume can never be lost.
 *
 * IDEMPOTENCY (sequential AND concurrent): the decision carries a stable
 * FINGERPRINT (run + gate + disposition + sorted targets + comment + — since
 * #2571 — the sorted accepted/dismissed SUGGESTION partition). A gate
 * resolved by a MATCHING fingerprint — whether discovered at read time (a normal
 * response-lost retry) or at commit time (a concurrent race) — is an idempotent
 * success; a DIFFERENT fingerprint is a conflict. The outbox makes the resume
 * safe to have already been (or still be about to be) delivered.
 *
 * SUGGESTION DECISIONS RIDE THE ONE DECISION (cinatra#2571, epic #2564 S6b).
 * Accepting or dismissing an auditor suggestion is never its own submit: the
 * per-item choices are local UI state until the reviewer takes the ONE terminal
 * decision, which carries them as a canonical partition. The partition is
 * validated `accepted ∪ dismissed ⊆ surfaced` against the gate's PINNED snapshot
 * BEFORE the CAS (a forged or replayed id never reaches a write), it is folded
 * into the fingerprint (so two submissions that differ only in which suggestions
 * they accept are two DIFFERENT decisions, and the second is a conflict rather
 * than a silent overwrite), and the accepted set is persisted — ledger rows plus
 * a durable APPLICATION-INTENT outbox — inside the same transaction as the gate
 * CAS. A decision that carries NO partition fingerprints exactly as it did
 * before this slice, so deploying it cannot turn an in-flight retry into a
 * conflict.
 *
 * DISPOSITION (AC-3): a REJECT records a TOMBSTONE disposition on the reviewed
 * artifacts (the `ReviewDispositionOp` union does not admit a hard delete).
 *
 * PURE (no React / DB / server-only): every seam is an injected port. The live
 * binder (the single-transaction commit + the outbox resume-delivery worker + the
 * type-resolution `deriveProvenance`) is the decision-chrome surface's job —
 * fenced until the review-surface design spec — and MUST honor the
 * single-transaction + exactly-once-PERSISTENCE / at-least-once-delivery
 * (idempotent-consumer) contract this core assumes.
 */
import { createHash } from "node:crypto";

import {
  normalizeReviewTargets,
  partitionAgainstPinnedTargets,
  reviewTargetKey,
  reviewTargetKeySet,
  type ArtifactReviewTarget,
} from "./artifact-review-target";
import type { RevisionMemberOutcome, RunAccessOutcome, ReviewTargetMount } from "./artifact-review-preparation";
import { buildReviewResumeText } from "./artifact-review-rejection";

// ---------------------------------------------------------------------------
// The SUGGESTION PARTITION (cinatra#2571, epic #2564 S6b) — the reviewer's
// per-item accept/dismiss choices, and the only place their identity is defined.
//
// CO-LOCATED IN THE DECISION CORE, not a sibling module, for two reasons. The
// partition is not a thing a decision HAS, it is part of what a decision IS: it
// changes the fingerprint, so it changes the gate CAS. And this core is reachable
// from the locked dev-perf routes, where a new first-party module is a
// route-graph-ratchet cost paid on every one of them for ~150 lines of pure
// normalization. Both point the same way.
//
// WHY THIS IS NOT A SECOND APPROVAL PATHWAY. Per-item Accept/Dismiss is local UI
// state until the reviewer takes ONE review decision that carries it. Two
// reviewers who disagree about which suggestions to accept do not both "win a
// little": the second submit is a fingerprint CONFLICT against a resolved gate,
// exactly as two different dispositions already are. #2047 row 8's ban on an
// independent per-item server action is the structural half of the same rule.
//
// THE IDENTITY IS ORDER-FREE AND DUPLICATE-FREE. Both lists are deduped and
// sorted before anything hashes them, so a reviewer who clicked the same chip
// twice, or whose client sent the ids in click order, produces the byte-identical
// decision. That matters because the fingerprint is an IDEMPOTENCY key: a
// response-lost retry has to re-derive the same hash or it reads as a conflict.
//
// AN EMPTY PARTITION IS NO PARTITION. `{accepted: [], dismissed: []}` asserts
// nothing about any suggestion, so it normalizes to `null` and the decision
// fingerprints exactly as it did before this slice existed.
//
// Membership (`accepted ⊆ surfaced`) is NOT checked here: it needs the gate's
// pinned snapshot, so it runs against a port, before the CAS.
// ---------------------------------------------------------------------------

/**
 * The partition contract version, hashed INTO the decision material. Bumping it
 * deliberately re-identifies every decision that carries a partition (and no
 * decision that does not) — that is what "a versioned change to the decision
 * identity" means operationally.
 */
export const SUGGESTION_PARTITION_VERSION = 1;

/**
 * Hard bound per list. A snapshot carries at most `MAX_GATE_SUGGESTIONS` (50)
 * suggestions, so a well-formed partition can never exceed that; the bound is
 * here so a forged body is rejected on SHAPE, before it reaches a store read.
 */
export const MAX_SUGGESTION_PARTITION_IDS = 50;

/** Hard bound on one suggestion id (`sug_` + 24 hex today, with headroom). */
export const MAX_SUGGESTION_ID_CHARS = 128;

/**
 * The reviewer's terminal per-item choices. Both lists hold SUGGESTION IDS from
 * the gate's pinned snapshot — never patch content: what is applied is read from
 * the immutable snapshot at apply time, so a client can choose only WHICH
 * suggestions, never WHAT they do.
 */
export interface SuggestionDecisionPartition {
  accepted: string[];
  dismissed: string[];
}

export type NormalizeSuggestionPartitionResult =
  | { ok: true; partition: SuggestionDecisionPartition | null }
  | { ok: false; error: string };

/**
 * Canonicalize a client-supplied partition: both lists deduped and sorted, every
 * id shape-checked, no id in both lists, and an all-empty partition collapsed to
 * `null`.
 *
 * The overlap check is a real rule, not tidiness: an id in both lists is a
 * decision that says "apply this" and "do not apply this" at once. Silently
 * preferring one would let a caller pick the applied set out of an ambiguous
 * body; refusing makes the reviewer's client fix it.
 */
export function normalizeSuggestionPartition(
  raw: unknown,
): NormalizeSuggestionPartitionResult {
  if (raw === null || raw === undefined) return { ok: true, partition: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "`suggestionDecisions` must be an object with `accepted` + `dismissed`." };
  }
  const candidate = raw as { accepted?: unknown; dismissed?: unknown };
  const accepted = normalizeIdList(candidate.accepted, "accepted");
  if (!accepted.ok) return { ok: false, error: accepted.error };
  const dismissed = normalizeIdList(candidate.dismissed, "dismissed");
  if (!dismissed.ok) return { ok: false, error: dismissed.error };

  const acceptedSet = new Set(accepted.ids);
  const overlap = dismissed.ids.filter((id) => acceptedSet.has(id));
  if (overlap.length > 0) {
    return {
      ok: false,
      error: `A suggestion cannot be both accepted and dismissed (${overlap.length} such id(s)).`,
    };
  }
  if (accepted.ids.length === 0 && dismissed.ids.length === 0) {
    // Asserts nothing — the decision keeps its pre-S6b identity.
    return { ok: true, partition: null };
  }
  return { ok: true, partition: { accepted: accepted.ids, dismissed: dismissed.ids } };
}

/** Every id the partition names, sorted — the set checked against the snapshot. */
export function suggestionPartitionIds(
  partition: SuggestionDecisionPartition,
): string[] {
  return [...partition.accepted, ...partition.dismissed].sort();
}

/**
 * The fingerprint material for a partition. Versioned, and byte-stable for a
 * given set of choices regardless of how the client ordered them.
 */
export function suggestionPartitionMaterial(partition: SuggestionDecisionPartition): {
  v: number;
  accepted: string[];
  dismissed: string[];
} {
  return {
    v: SUGGESTION_PARTITION_VERSION,
    accepted: [...partition.accepted].sort(),
    dismissed: [...partition.dismissed].sort(),
  };
}

type IdListResult = { ok: true; ids: string[] } | { ok: false; error: string };

function normalizeIdList(raw: unknown, label: string): IdListResult {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: `\`suggestionDecisions.${label}\` must be an array of suggestion ids.` };
  }
  if (raw.length > MAX_SUGGESTION_PARTITION_IDS) {
    return {
      ok: false,
      error: `\`suggestionDecisions.${label}\` carries more than ${MAX_SUGGESTION_PARTITION_IDS} ids.`,
    };
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, error: `\`suggestionDecisions.${label}\` holds a non-string or empty id.` };
    }
    if (entry.length > MAX_SUGGESTION_ID_CHARS) {
      return { ok: false, error: `\`suggestionDecisions.${label}\` holds an over-long id.` };
    }
    // An id is an OPAQUE token minted by the producer. It is never trimmed or
    // case-folded here: a padded id is a DIFFERENT id, and normalizing it would
    // silently map a forged token onto a real one. The `⊆ surfaced` check the
    // decision core runs against the pinned snapshot is what rejects it.
    ids.push(entry);
  }
  return { ok: true, ids: [...new Set(ids)].sort() };
}

// ---------------------------------------------------------------------------
// The versioned decision payload (client-supplied WHAT + disposition only).
// ---------------------------------------------------------------------------

/**
 * The CURRENT decision payload version. `2` (cinatra#2571) is the version that
 * may carry a suggestion partition; `1` is still accepted and may not.
 *
 * The version is NOT simply hashed into every fingerprint — see
 * `reviewDecisionFingerprint`. A v2 payload with no partition is the same
 * DECISION as the v1 payload it upgraded from, and must fingerprint identically,
 * or every in-flight retry across the deploy boundary would read as a conflict.
 */
export const ARTIFACT_REVIEW_DECISION_API_VERSION = 2;

/** Payload versions this build accepts. A v1 body predates the partition and is
 * refused if it carries one, so an old client can never smuggle per-item choices
 * past the version that defines their identity. */
export const SUPPORTED_DECISION_API_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/** The fingerprint identity a decision WITHOUT a suggestion partition keeps,
 * forever. Pinned as its own constant so no later version bump can silently
 * re-identify the decisions this slice promised not to touch. */
export const DECISION_IDENTITY_VERSION_WITHOUT_PARTITION = 1;

/** The fingerprint identity of a decision that CARRIES a suggestion partition. */
export const DECISION_IDENTITY_VERSION_WITH_PARTITION = 2;

export type ReviewDisposition = "approve" | "reject" | "comment";

/** The renderer that the host resolved for a reviewed revision, captured on the
 * audit row (AC-3 "renderer provenance"). Derived SERVER-SIDE from the artifact
 * type — never accepted from the client. `digest` is set only for a runtime
 * (main-realm dynamic) load — the exact package + content digest. */
export interface ReviewRendererProvenance {
  /** `first-party` is the FORM RUNG (plan (B) §5): the host's own renderer for a
   * declared text form. It is recorded as its own kind and never as `floor`,
   * because a rendered draft is not a review that fell through — and the floor
   * gate counts `floor` rows. */
  kind: "build-map" | "runtime" | "first-party" | "floor";
  packageName: string | null;
  digest: string | null;
}

/** Map a host mount descriptor to audit provenance. The `deriveProvenance` port
 * binder uses this against the mount it RE-RESOLVES at submit time (from the
 * type), so the provenance is authoritative, not a client claim. */
export function rendererProvenanceFromMount(mount: ReviewTargetMount): ReviewRendererProvenance {
  switch (mount.kind) {
    case "build-map":
      return { kind: "build-map", packageName: mount.packageName, digest: null };
    case "runtime":
      return {
        kind: "runtime",
        packageName: mount.packageName,
        digest: mount.descriptor.tuple.digest,
      };
    case "form":
      return { kind: "first-party", packageName: null, digest: null };
    case "floor":
      return { kind: "floor", packageName: mount.packageName, digest: null };
  }
}

/** The client decision: WHAT is reviewed + the disposition + an optional comment.
 * Carries NO renderer identity and NO provenance — both are host-authoritative. */
export interface ArtifactReviewDecision {
  decisionApiVersion: number;
  runId: string;
  reviewTaskId: string;
  disposition: ReviewDisposition;
  comment: string | null;
  reviewedTargets: ArtifactReviewTarget[];
  /**
   * The reviewer's per-item suggestion choices (cinatra#2571), or null/absent for
   * a decision that makes none. TERMINAL decisions only, and never on a reject —
   * both refused below. Ids only: what an accepted suggestion DOES is read from
   * the immutable pinned snapshot at apply time.
   */
  suggestionDecisions?: SuggestionDecisionPartition | null;
}

/**
 * The stable idempotency fingerprint of a decision: a hash over run + gate +
 * disposition + the SORTED target key set + the comment + (when present) the
 * SORTED accepted/dismissed suggestion partition. Order-independent in both the
 * targets and the partition, so two submits of the same decision with reordered
 * inputs fingerprint identically. The binder stamps this on the resolved gate; a
 * retry or race that matches is idempotent, a mismatch is a conflict.
 *
 * THE PARTITION KEY IS OMITTED WHEN THERE IS NO PARTITION, and the identity
 * version stays at 1 in that case, so the material is BYTE-IDENTICAL to what
 * this function hashed before #2571. Every decision that makes no per-item
 * choice — every decision taken before this slice, every decision on a gate with
 * no suggestion snapshot — keeps its fingerprint. A decision that DOES carry a
 * partition is deliberately a new identity (version 2): "approve, accepting s1"
 * and "approve, accepting s2" are two different decisions and the gate CAS
 * treats the second as a conflict, which is precisely the property #2571 asks
 * for.
 */
export function reviewDecisionFingerprint(decision: {
  runId: string;
  reviewTaskId: string;
  disposition: ReviewDisposition;
  comment: string | null;
  reviewedTargets: ReadonlyArray<ArtifactReviewTarget>;
  suggestionDecisions?: SuggestionDecisionPartition | null;
}): string {
  const targetKeys = decision.reviewedTargets.map(reviewTargetKey).sort();
  const partition = decision.suggestionDecisions ?? null;
  const carriesPartition =
    partition !== null &&
    (partition.accepted.length > 0 || partition.dismissed.length > 0);
  const material = JSON.stringify({
    v: carriesPartition
      ? DECISION_IDENTITY_VERSION_WITH_PARTITION
      : DECISION_IDENTITY_VERSION_WITHOUT_PARTITION,
    runId: decision.runId,
    reviewTaskId: decision.reviewTaskId,
    disposition: decision.disposition,
    comment: decision.comment,
    targetKeys,
    // Key ABSENT (not null) when there is no partition — an added-with-null key
    // would change the legacy bytes just as much as an added-with-value one.
    ...(carriesPartition ? { suggestions: suggestionPartitionMaterial(partition) } : {}),
  });
  return createHash("sha256").update(material).digest("hex");
}

// ---------------------------------------------------------------------------
// The atomic commit plan (what the binder persists in ONE transaction).
// ---------------------------------------------------------------------------

export interface ReviewAuditRow {
  artifactId: string;
  representationRevisionId: string;
  disposition: ReviewDisposition;
  /** Host-derived — the renderer the artifact's type resolves to at submit time. */
  rendererProvenance: ReviewRendererProvenance;
}

/** A reject disposition op. The union admits ONLY `tombstone` — a review can
 * never hard-delete a durable artifact. */
export interface ReviewDispositionOp {
  artifactId: string;
  representationRevisionId: string;
  kind: "tombstone";
}

/** The terminal resume INTENT — persisted transactionally with the resolution
 * (exactly once) and drained at-least-once by the binder's delivery worker (an
 * idempotent consumer makes redelivery safe). Discriminated so a reject can never
 * be delivered down the approve wire. Null for a non-terminal (comment)
 * decision. */
export type ReviewResumeIntent =
  | { kind: "approve"; userResponse: string }
  | { kind: "reject"; rejectResponse: string };

/**
 * The suggestion half of the commit (cinatra#2571). Persisted in the SAME
 * transaction as the gate CAS: one ledger row per decided suggestion, plus — iff
 * anything was accepted — ONE application-intent outbox row for the gate.
 *
 * `snapshotId` binds the whole plan to the exact pinned snapshot the ids were
 * validated against, so a snapshot that changed underneath the reviewer cannot
 * have its ids re-interpreted at apply time.
 */
export interface SuggestionDecisionPlan {
  snapshotId: string;
  /** Sorted, deduped, and proven ⊆ the pinned snapshot's surfaced set. */
  accepted: string[];
  dismissed: string[];
}

export interface ReviewDecisionCommitPlan {
  runId: string;
  reviewTaskId: string;
  disposition: ReviewDisposition;
  /** approve/reject resolve the gate (CAS + resume intent); comment is a
   * non-terminal annotation (audit only, gate stays pending, no resume). */
  terminal: boolean;
  /** The idempotency fingerprint the binder stamps on the resolved gate. */
  fingerprint: string;
  comment: string | null;
  auditRows: ReviewAuditRow[];
  dispositionOps: ReviewDispositionOp[];
  /** The exactly-once-persisted resume outbox intent (terminal only). */
  resumeIntent: ReviewResumeIntent | null;
  /**
   * The suggestion ledger + application-intent half (cinatra#2571). Null when the
   * decision made no per-item choices — which is every decision on a gate that
   * has no suggestion snapshot.
   */
  suggestionPlan: SuggestionDecisionPlan | null;
  /**
   * The DECIDING actor (cinatra#2047 defect D-2) — SERVER-resolved from the live
   * session at submit through the `actingActorId` port, exactly like renderer
   * provenance, and never a client claim. The binder stamps it on the resolved
   * gate (`artifact_review_gates.resolved_by`, a column declared and READ since
   * #1796 and until now never written), which is what finally gives a resolved
   * gate an accountable decider of record. Null only where the host cannot
   * resolve an actor id (a non-human carrier); the gate then records no decider
   * rather than a fabricated one.
   */
  decidedBy: string | null;
}

/** The outcome of the atomic commit CAS. */
export type ReviewCommitOutcome =
  | { status: "committed" }
  /** The gate was already resolved by a MATCHING-fingerprint decision (a
   * concurrent race committed the same decision first) — idempotent. */
  | { status: "already-resolved" }
  /** The gate moved to a state a matching decision cannot resolve (a different
   * decision, or a terminal-other state). */
  | { status: "conflict" };

// ---------------------------------------------------------------------------
// Gate state at read time.
// ---------------------------------------------------------------------------

/** What a gate's pinned snapshot surfaced to the reviewer (cinatra#2571). */
export interface SurfacedSuggestionSet {
  snapshotId: string;
  suggestionIds: string[];
}

export type ReviewGateState =
  /** Pending review gate carrying its frozen pinned target set. */
  | { status: "pending"; targets: ArtifactReviewTarget[] }
  /** Already resolved by a review decision, carrying that decision's fingerprint
   * (for sequential-retry idempotency). */
  | { status: "resolved"; fingerprint: string }
  /** Absent, or in a terminal-other state (failed/cancelled) no review decision
   * can resolve. Folded together so gate existence is not leaked. */
  | { status: "unavailable" };

// ---------------------------------------------------------------------------
// Ports.
// ---------------------------------------------------------------------------

export type ReviewRunAccessOp = "approveHitl" | "respondToHitl";

export interface SubmitDecisionPorts {
  /** Access-check the run for the decision op (approve/reject → approveHitl;
   * comment → respondToHitl). */
  verifyRunAccess(runId: string, op: ReviewRunAccessOp): Promise<RunAccessOutcome> | RunAccessOutcome;
  /** The gate's live state: pending (+ frozen pinned set), resolved (+ the
   * resolving fingerprint), or unavailable. */
  readGateState(runId: string, reviewTaskId: string): Promise<ReviewGateState> | ReviewGateState;
  /** Re-confirm a reviewed revision is STILL a live member at submit time. */
  revisionMember(
    artifactId: string,
    representationRevisionId: string,
  ): Promise<RevisionMemberOutcome> | RevisionMemberOutcome;
  /** SERVER-derive the renderer provenance for a reviewed target from its type
   * (the same host mount resolution the preparation surface uses). Never accepts
   * a client provenance claim. */
  deriveProvenance(
    target: ArtifactReviewTarget,
  ): Promise<ReviewRendererProvenance> | ReviewRendererProvenance;
  /** The LIVE acting actor's id (cinatra#2047 D-2) — resolved server-side from
   * the verified session/carrier the run-access check just ran against. Returns
   * null when the host cannot name an actor id. Never a client input. */
  actingActorId(): string | null;
  /**
   * The gate's PINNED suggestion snapshot (cinatra#2571): its row id and the
   * exact set of suggestion ids it surfaced. `null` for a gate with no snapshot,
   * and for a snapshot whose stored bytes no longer verify — a tampered row must
   * read as "nothing was surfaced" so every id in the partition is refused,
   * never as a wider set.
   *
   * Required ONLY when a decision carries a partition; a host that never
   * surfaces suggestions may bind it to a constant null.
   */
  readSurfacedSuggestions(
    runId: string,
    reviewTaskId: string,
  ): Promise<SurfacedSuggestionSet | null> | SurfacedSuggestionSet | null;
  /** Persist the plan ATOMICALLY (gate CAS stamping `fingerprint` + audit rows +
   * dispositions + the resume outbox intent, in ONE transaction). Returns
   * committed / already-resolved (matching-fingerprint race) / conflict; MUST
   * throw on a persistence failure so the core aborts with nothing committed. */
  commit(plan: ReviewDecisionCommitPlan): Promise<ReviewCommitOutcome>;
}

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

export type SubmitDecisionError =
  | { kind: "invalid-decision"; message: string }
  | { kind: "run-access-denied"; status: number }
  | { kind: "gate-not-pending" }
  | { kind: "target-substitution"; substituted: ArtifactReviewTarget[] }
  | { kind: "incomplete-coverage"; missing: ArtifactReviewTarget[] }
  | { kind: "revision-not-member"; targets: ArtifactReviewTarget[] }
  /**
   * The decision named suggestion ids the gate's pinned snapshot did not surface
   * (cinatra#2571) — a forged id, an id from a DIFFERENT gate, or a replay of a
   * snapshot that has since been re-bound. Raised BEFORE the CAS, so no such
   * decision ever reaches a write. The offending ids are carried for the server's
   * own logs; the surfaces that answer a remote caller collapse this to their
   * uniform refusal exactly as they do the other pre-CAS errors.
   */
  | { kind: "suggestion-not-surfaced"; suggestionIds: string[] }
  | { kind: "gate-conflict" }
  | { kind: "commit-failed"; message: string };

export type SubmitDecisionResult =
  | { ok: true; idempotent: boolean; fingerprint: string; plan: ReviewDecisionCommitPlan | null }
  | { ok: false; error: SubmitDecisionError };

// ---------------------------------------------------------------------------
// The pure core.
// ---------------------------------------------------------------------------

const VALID_DISPOSITIONS: ReadonlySet<ReviewDisposition> = new Set([
  "approve",
  "reject",
  "comment",
]);

export async function submitReviewDecisionCore(
  decision: ArtifactReviewDecision,
  ports: SubmitDecisionPorts,
): Promise<SubmitDecisionResult> {
  // 1. Validate the decision shape + normalize targets.
  if (!SUPPORTED_DECISION_API_VERSIONS.has(decision.decisionApiVersion)) {
    return invalid(`Unsupported decisionApiVersion ${decision.decisionApiVersion}.`);
  }
  if (!VALID_DISPOSITIONS.has(decision.disposition)) {
    return invalid(`Unknown disposition "${decision.disposition}".`);
  }
  if (decision.comment !== null && typeof decision.comment !== "string") {
    return invalid("`comment` must be a string or null.");
  }
  const normalizedPartition = normalizeSuggestionPartition(decision.suggestionDecisions);
  if (!normalizedPartition.ok) return invalid(normalizedPartition.error);
  const partition = normalizedPartition.partition;
  if (partition && decision.decisionApiVersion < DECISION_IDENTITY_VERSION_WITH_PARTITION) {
    // A v1 body predates the partition. Accepting one here would let a client
    // choose which VERSION defines its decision's identity.
    return invalid(
      `A suggestion partition requires decisionApiVersion ${ARTIFACT_REVIEW_DECISION_API_VERSION}.`,
    );
  }
  const normalized = normalizeReviewTargets(decision.reviewedTargets);
  if (!normalized.ok) return invalid(normalized.error);
  // CANONICAL ORDER: sort the deduped targets by key and drive EVERY plan effect
  // (fingerprint, audit rows, disposition ops, resume intent) from this order. The
  // fingerprint is order-independent (it sorts internally), so the persisted
  // effects must be too — otherwise `[A,B]` and `[B,A]` would share a fingerprint
  // (deemed the same decision) yet emit different outbox/audit bytes. Targets are a
  // SET (the gate pinned a set); order carries no review meaning, so canonicalizing
  // loses nothing and makes idempotency byte-consistent.
  const reviewedTargets = [...normalized.targets].sort(byTargetKey);
  const terminal = decision.disposition !== "comment";
  if (partition && !terminal) {
    // A comment ANNOTATES; it does not resolve the gate, so it cannot carry the
    // terminal per-item choices. Allowing it would create the second approval
    // pathway #2047 row 8 bans: a stream of comments each "accepting" items on a
    // gate that never resolves.
    return invalid("Suggestion decisions require a terminal disposition (approve or reject).");
  }
  if (partition && decision.disposition === "reject" && partition.accepted.length > 0) {
    // A reject TOMBSTONES every reviewed revision. Applying a patch to a revision
    // the same decision is tombstoning is incoherent, and the intent drain would
    // be writing into rejected work. Dismissals on a reject are fine — they
    // record what the reviewer looked at and declined.
    return invalid("A reject decision cannot accept suggestions.");
  }
  const fingerprint = reviewDecisionFingerprint({
    runId: decision.runId,
    reviewTaskId: decision.reviewTaskId,
    disposition: decision.disposition,
    comment: decision.comment,
    reviewedTargets,
    suggestionDecisions: partition,
  });

  // 2. Run access for the decision op.
  const op: ReviewRunAccessOp = terminal ? "approveHitl" : "respondToHitl";
  const access = await ports.verifyRunAccess(decision.runId, op);
  if (!access.ok) {
    return { ok: false, error: { kind: "run-access-denied", status: access.status } };
  }

  // 3. Live gate state. A gate ALREADY resolved by THIS decision (a response-lost
  // sequential retry) is idempotent success; by a DIFFERENT decision, a conflict;
  // unavailable, gate-not-pending. Only a still-pending gate re-validates + commits.
  const gate = await ports.readGateState(decision.runId, decision.reviewTaskId);
  if (gate.status === "resolved") {
    if (gate.fingerprint === fingerprint) {
      // Already committed by an identical prior submit — the resume intent was
      // persisted with it and is delivered (at-least-once) by the outbox to an
      // idempotent consumer, so this retry re-drives nothing.
      return { ok: true, idempotent: true, fingerprint, plan: null };
    }
    return { ok: false, error: { kind: "gate-conflict" } };
  }
  if (gate.status !== "pending") {
    return { ok: false, error: { kind: "gate-not-pending" } };
  }

  // 4. Substitution: every reviewed target must belong to the pinned set.
  const { substituted } = partitionAgainstPinnedTargets(reviewedTargets, gate.targets);
  if (substituted.length > 0) {
    return { ok: false, error: { kind: "target-substitution", substituted } };
  }

  // 4b. Coverage: a TERMINAL decision resolves the whole gate, so it must cover
  // every pinned target; `comment` may annotate a subset.
  if (terminal) {
    const reviewedKeys = reviewTargetKeySet(reviewedTargets);
    const missing = gate.targets.filter((t) => !reviewedKeys.has(reviewTargetKey(t)));
    if (missing.length > 0) {
      return { ok: false, error: { kind: "incomplete-coverage", missing } };
    }
  }

  // 4c. SUGGESTIONS (cinatra#2571): every accepted or dismissed id must be one
  // the gate's PINNED snapshot actually surfaced. Read here, PRE-CAS, and against
  // the live snapshot rather than anything the client sent: a forged id, an id
  // borrowed from another gate, and a replay of a snapshot that has since been
  // re-bound all fail the same way, before any row is written.
  //
  // A gate with NO readable snapshot surfaces nothing — so a partition against it
  // is refused in full. That covers the tampered-row case too: the port drops a
  // row whose bytes no longer verify, which is exactly the posture a decision
  // needs (never widen the set an unreadable row is presumed to have carried).
  let suggestionPlan: SuggestionDecisionPlan | null = null;
  if (partition) {
    const surfaced = await ports.readSurfacedSuggestions(decision.runId, decision.reviewTaskId);
    const surfacedIds = new Set(surfaced?.suggestionIds ?? []);
    const unsurfaced = suggestionPartitionIds(partition).filter((id) => !surfacedIds.has(id));
    if (!surfaced || unsurfaced.length > 0) {
      return {
        ok: false,
        error: {
          kind: "suggestion-not-surfaced",
          suggestionIds: unsurfaced.length > 0 ? unsurfaced : suggestionPartitionIds(partition),
        },
      };
    }
    suggestionPlan = {
      snapshotId: surfaced.snapshotId,
      accepted: [...partition.accepted].sort(),
      dismissed: [...partition.dismissed].sort(),
    };
  }

  // 5. Per target: re-check membership (submit-time TOCTOU) AND derive the
  // server-authoritative renderer provenance from the type. Any vanished revision
  // aborts the WHOLE decision before any effect.
  const notMember: ArtifactReviewTarget[] = [];
  const auditRows: ReviewAuditRow[] = [];
  for (const target of reviewedTargets) {
    const member = await ports.revisionMember(target.artifactId, target.representationRevisionId);
    if (!member) {
      notMember.push(target);
      continue;
    }
    const rendererProvenance = await ports.deriveProvenance(target);
    auditRows.push({
      artifactId: target.artifactId,
      representationRevisionId: target.representationRevisionId,
      disposition: decision.disposition,
      rendererProvenance,
    });
  }
  if (notMember.length > 0) {
    return { ok: false, error: { kind: "revision-not-member", targets: notMember } };
  }

  // 6. Build the atomic commit plan. A reject records a TOMBSTONE per reviewed
  // artifact (never a hard delete — the op union admits none). The terminal
  // resume intent is part of the plan so the commit persists it transactionally.
  const dispositionOps: ReviewDispositionOp[] =
    decision.disposition === "reject"
      ? reviewedTargets.map((t) => ({
          artifactId: t.artifactId,
          representationRevisionId: t.representationRevisionId,
          kind: "tombstone" as const,
        }))
      : [];
  const resumeIntent = terminal ? buildResumeIntent(decision, reviewedTargets) : null;
  const plan: ReviewDecisionCommitPlan = {
    runId: decision.runId,
    reviewTaskId: decision.reviewTaskId,
    disposition: decision.disposition,
    terminal,
    fingerprint,
    comment: decision.comment,
    auditRows,
    dispositionOps,
    resumeIntent,
    suggestionPlan,
    decidedBy: ports.actingActorId(),
  };

  // 7. Atomic commit (gate CAS + audit + dispositions + resume outbox intent).
  let outcome: ReviewCommitOutcome;
  try {
    outcome = await ports.commit(plan);
  } catch (err) {
    // Persistence failed — the binder's transaction rolled back every effect
    // (including the resume intent). Zero partial commit; nothing to resume.
    return {
      ok: false,
      error: { kind: "commit-failed", message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (outcome.status === "conflict") {
    return { ok: false, error: { kind: "gate-conflict" } };
  }
  // committed | already-resolved (a concurrent matching-fingerprint race) are both
  // success; the resume rides the durable outbox either way (never inline here).
  return {
    ok: true,
    idempotent: outcome.status === "already-resolved",
    fingerprint,
    plan,
  };
}

function buildResumeIntent(
  decision: ArtifactReviewDecision,
  reviewedTargets: ReadonlyArray<ArtifactReviewTarget>,
): ReviewResumeIntent {
  const resumeText = buildReviewResumeText({
    disposition: decision.disposition === "reject" ? "reject" : "approve",
    reviewTaskId: decision.reviewTaskId,
    comment: decision.comment,
    targets: reviewedTargets,
  });
  return resumeText.kind === "approve"
    ? { kind: "approve", userResponse: resumeText.userResponse }
    : { kind: "reject", rejectResponse: resumeText.rejectResponse };
}

function invalid(message: string): SubmitDecisionResult {
  return { ok: false, error: { kind: "invalid-decision", message } };
}

/** Total order on targets by their canonical key — the single sort that makes the
 * plan bytes order-independent, matching the order-independent fingerprint. */
function byTargetKey(a: ArtifactReviewTarget, b: ArtifactReviewTarget): number {
  const ka = reviewTargetKey(a);
  const kb = reviewTargetKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
