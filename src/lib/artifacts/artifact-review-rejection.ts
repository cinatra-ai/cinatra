/**
 * WayFlow REVIEW-REJECTION semantics (cinatra#1795, epic #1620 S12, item 6).
 *
 * DECISION (recorded in the boundary ADR
 * `docs/internals/artifacts/artifact-review-rejection-semantics.md`): a review
 * rejection resumes the workflow with a TYPED REJECT payload the workflow branches
 * on — NOT an implicit success, and NEVER travelling the approve path. The
 * alternative (an authorized terminal-reject that fails the run outright) is kept
 * ONLY as the fallback for a gate with no resumable workflow context (a `setup-`
 * gate, or a WayFlow gate whose A2A context is gone): a run that cannot branch on
 * a reject is failed rather than left pending forever.
 *
 * WHY typed-resume over terminal-reject as the primary: the epic boundary is
 * "core owns dispatch/shell/floor; the claiming extension ships the type's view"
 * — and, symmetrically, the workflow owns what a rejection MEANS for its domain
 * (compensation, re-draft, alternate branch). Core must therefore hand the
 * workflow a first-class, structurally-distinct reject signal and let the
 * workflow decide, exactly as an approval hands it the operator's userResponse.
 *
 * THE LOAD-BEARING INVARIANT: a reject payload is STRUCTURALLY DISTINCT from an
 * approve payload and can NEVER be produced by (or mistaken for) the approve
 * builder. The approve builders (`hitl-gate-submit.ts::buildChatGateSubmitPayload`)
 * stamp `approved: true` + `approvedAt` + a bare `userResponse`; a reject stamps
 * `review.decision === "rejected"` and carries NO `approved` key. A downstream
 * `InputMessageNode` that only looks for `approved` sees a falsy/absent value and
 * a workflow that branches on `review.decision` routes to its reject arm. The two
 * payloads share no truthy approval marker, so a reject affordance cannot ride
 * the approve wire even if mis-wired.
 *
 * PURE (no React / DB / server-only): the payload builders are unit-testable and
 * carry no side effects. The live A2A resume SEND (into `run.a2aContextId`) is
 * the reject counterpart of the approve path in
 * `packages/agents/src/review-task-actions.ts`; wiring it to a workflow whose
 * reject BRANCH exists to receive the typed payload rides the reviewer-
 * generalization slice (#1796) that owns the emitting gate — this module fixes
 * the WIRE CONTRACT that slice and every reviewer type conform to.
 */

/** The wire-format version of the typed review-resume envelope. Bumped only on a
 * breaking shape change; a workflow branch pins the version it understands. */
export const ARTIFACT_REVIEW_RESUME_ENVELOPE_VERSION = 1;

/** The dispositions that RESUME a workflow. `comment` never resumes (it is a
 * non-terminal annotation), so it is not part of this union. */
export type ResumingReviewDisposition = "approve" | "reject";

/** A reviewed target as it appears in the typed resume envelope — the immutable
 * `{artifactId, representationRevisionId}` pair, no renderer identity. */
export interface ResumeEnvelopeTarget {
  artifactId: string;
  representationRevisionId: string;
}

/**
 * The APPROVE resume envelope — the review-surface analog of a WayFlow approval's
 * `userResponse`. Carries the approval marker the existing approve wire expects
 * (`approved: true`) PLUS the typed `review` block so a review-aware workflow can
 * branch uniformly on `review.decision`.
 */
export interface ReviewApproveEnvelope {
  approved: true;
  review: {
    envelopeVersion: number;
    decision: "approved";
    reviewTaskId: string;
    comment: string | null;
    targets: ResumeEnvelopeTarget[];
  };
}

/**
 * The REJECT resume envelope — structurally distinct from approve: NO `approved`
 * key, `review.decision === "rejected"`. A workflow's reject branch keys on
 * `review.decision`; a legacy node that only checks `approved` sees it absent
 * and does NOT treat the reject as an approval.
 */
export interface ReviewRejectEnvelope {
  review: {
    envelopeVersion: number;
    decision: "rejected";
    reviewTaskId: string;
    comment: string | null;
    targets: ResumeEnvelopeTarget[];
  };
}

export type ReviewResumeEnvelope = ReviewApproveEnvelope | ReviewRejectEnvelope;

function toEnvelopeTargets(
  targets: ReadonlyArray<ResumeEnvelopeTarget>,
): ResumeEnvelopeTarget[] {
  return targets.map((t) => ({
    artifactId: t.artifactId,
    representationRevisionId: t.representationRevisionId,
  }));
}

/** Build the typed APPROVE resume envelope object (not yet serialized). */
export function buildReviewApproveEnvelope(args: {
  reviewTaskId: string;
  comment: string | null;
  targets: ReadonlyArray<ResumeEnvelopeTarget>;
}): ReviewApproveEnvelope {
  return {
    approved: true,
    review: {
      envelopeVersion: ARTIFACT_REVIEW_RESUME_ENVELOPE_VERSION,
      decision: "approved",
      reviewTaskId: args.reviewTaskId,
      comment: args.comment,
      targets: toEnvelopeTargets(args.targets),
    },
  };
}

/** Build the typed REJECT resume envelope object (not yet serialized). Carries no
 * `approved` marker by construction — the reject can never read as an approval. */
export function buildReviewRejectEnvelope(args: {
  reviewTaskId: string;
  comment: string | null;
  targets: ReadonlyArray<ResumeEnvelopeTarget>;
}): ReviewRejectEnvelope {
  return {
    review: {
      envelopeVersion: ARTIFACT_REVIEW_RESUME_ENVELOPE_VERSION,
      decision: "rejected",
      reviewTaskId: args.reviewTaskId,
      comment: args.comment,
      targets: toEnvelopeTargets(args.targets),
    },
  };
}

export type ReviewResumeText =
  | { kind: "approve"; userResponse: string }
  | { kind: "reject"; rejectResponse: string };

/**
 * Serialize a decision into its WayFlow resume TEXT, discriminated by kind so a
 * caller physically cannot feed a reject down the approve path: the approve
 * branch yields `{ kind: "approve", userResponse }` (the WayFlow resume-text
 * contract's field) and the reject branch yields `{ kind: "reject",
 * rejectResponse }` — a DIFFERENT field name, so the approve resume site (which
 * reads `userResponse`) never receives reject text, and the reject resume site
 * reads `rejectResponse`.
 */
export function buildReviewResumeText(args: {
  disposition: ResumingReviewDisposition;
  reviewTaskId: string;
  comment: string | null;
  targets: ReadonlyArray<ResumeEnvelopeTarget>;
}): ReviewResumeText {
  if (args.disposition === "approve") {
    return {
      kind: "approve",
      userResponse: JSON.stringify(
        buildReviewApproveEnvelope({
          reviewTaskId: args.reviewTaskId,
          comment: args.comment,
          targets: args.targets,
        }),
      ),
    };
  }
  return {
    kind: "reject",
    rejectResponse: JSON.stringify(
      buildReviewRejectEnvelope({
        reviewTaskId: args.reviewTaskId,
        comment: args.comment,
        targets: args.targets,
      }),
    ),
  };
}

/**
 * Guard: does a parsed resume payload carry an approval marker? Used by tests
 * (and any defensive consumer) to PROVE a reject envelope never reads as an
 * approval. True only when the object structurally asserts approval — an
 * `approved === true` marker OR `review.decision === "approved"`.
 */
export function payloadAssertsApproval(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { approved?: unknown; review?: { decision?: unknown } };
  if (p.approved === true) return true;
  if (p.review && typeof p.review === "object" && p.review.decision === "approved") return true;
  return false;
}
