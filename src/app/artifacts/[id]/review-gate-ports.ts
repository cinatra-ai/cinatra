import "server-only";

// The SERVER BINDERS that wire the #1795/#1807 PURE review cores (preparation +
// decision) to the LIVE artifact-review GATE store (cinatra#1796, epic #1620
// S13). #1807's `review-target-prepare.ts` supplies the artifact-SIDE ports and
// deliberately leaves the run/gate ports to "the caller (the review surface / the
// reviewer-generalization slice #1796 that owns the emitting gate)". This module
// is that caller: it composes the artifact-side binder with the agents-domain
// run/gate ports (run access via `enforceReviewRunAccess`; the pinned-gate /
// gate-state / atomic commit via the gate store), so the review surface can
// PREPARE and DECIDE against a real pinned gate.
//
// TRUST GUARANTEES preserved from the cores (this module adds no shortcut):
//   - run access is enforced against the ACTUAL reviewing actor for the op
//     (read on prepare; approveHitl on approve/reject; respondToHitl on comment);
//   - the pinned target set is read from the gate (frozen at emission), so a
//     client cannot substitute a target the gate never pinned;
//   - the renderer PROVENANCE recorded on each audit row is RE-DERIVED here from
//     the artifact TYPE (the same S2 dispatch the preparation surface uses) —
//     never a client claim; a renderer that became unbuilt between prepare and
//     submit is recorded as it now resolves.

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// Imported via the dedicated SUBPATH (not the @cinatra-ai/agents barrel) so the
// store's host-core imports (@/lib/artifacts/artifact-review-*) never widen the
// reachable graph of routes that import the agents barrel (the route-graph
// ratchet) — the auditor-snapshot-store precedent.
import {
  readGatePinnedTargets,
  readReviewGate,
  readReviewGateState,
  commitReviewDecision,
  enforceReviewRunAccess,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import {
  recordReviewSurfaceChangesRequested,
  type RecordChangesRequestedResult,
} from "@cinatra-ai/agents/lifecycle-review-changes-requested";
// cinatra#2286 S10 (PR1) — the ONE new cross-package subpath this slice adds
// (packages/agents/package.json's `exports`), precedented six times over by the
// imports above it. Read-only: this port only CALLS the existing repair store,
// never writes to it.
import { readRepairBySuccessorGateId } from "@cinatra-ai/agents/lifecycle-repair-store";
import {
  buildActorContextFromPrimitive,
  type ActorRoleHints,
} from "@/lib/authz/build-actor-context";

import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import {
  type PrepareReviewInput,
  type PrepareReviewResult,
  type ResolvedRendererMount,
  type PreparedReviewTarget,
  type RunAccessOutcome,
} from "@/lib/artifacts/artifact-review-preparation";
import {
  pinnedCaptureKey,
  type ReviewSurfaceModel,
} from "@/lib/artifacts/review-surface-model";
import { readPinnedPreviewCaptures } from "@/lib/artifacts/cms-preview-capture-store";
import {
  buildPinnedCaptureViews,
  buildPinnedCapturePair,
  buildPinnedRepairPair,
  type PinnedCapturePairKind,
  type PinnedCapturePairView,
} from "@/lib/artifacts/cms-preview-capture-view";
import { isRepairSuccessorTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import {
  submitReviewDecisionCore,
  type ArtifactReviewDecision,
  type ReviewRendererProvenance,
  type ReviewRunAccessOp,
  type SubmitDecisionPorts,
  type SubmitDecisionResult,
} from "@/lib/artifacts/artifact-review-decision";

import {
  bindArtifactReviewPorts,
  prepareArtifactReviewTargets,
  type ReviewRunGatePorts,
} from "./review-target-prepare";

/** The reviewing principal + org + role hints threaded to every port. */
export interface ReviewActorContext {
  /** The verified reviewing actor (session or A2A carrier). Used for run access. */
  actor: PrimitiveActorContext;
  orgId: string;
  roleHints?: ActorRoleHints;
}

// ---------------------------------------------------------------------------
// PREPARE — the run/gate ports the preparation core consumes.
// ---------------------------------------------------------------------------

/** Bind the run/gate ports (agents-domain) for the preparation core. */
export function bindReviewRunGatePorts(ctx: ReviewActorContext): ReviewRunGatePorts {
  return {
    verifyRunAccess: (runId: string) =>
      enforceReviewRunAccess(runId, ctx.actor, "read", ctx.roleHints),
    readGatePinnedTargets: (runId: string, reviewTaskId: string) =>
      readGatePinnedTargets(runId, reviewTaskId),
  };
}

/**
 * Prepare a caller's review targets against a run's gate — the fully bound
 * counterpart of the #1807 fenced `prepareArtifactReviewTargets`. Resolves the
 * kernel actor for the artifact-side reads, binds the run/gate ports, and runs
 * the pure core.
 *
 * A PENDING gate by default. The read-only history reading passes
 * `acceptResolvedGate` on the input to prepare a DECIDED gate's frozen set as
 * well (`loadReviewGateSurface`'s settled answer, and nowhere else); every
 * decision path leaves it unset and is refused on a gate that is no longer
 * pending, exactly as before.
 */
export async function prepareReviewTargets(args: {
  input: PrepareReviewInput;
  actorCtx: ReviewActorContext;
}): Promise<PrepareReviewResult> {
  const { actorCtx } = args;
  const kernelActor = buildActorContextFromPrimitive(
    actorCtx.actor,
    actorCtx.orgId,
    actorCtx.roleHints,
  );
  return prepareArtifactReviewTargets({
    input: args.input,
    orgId: actorCtx.orgId,
    actor: kernelActor,
    runGatePorts: bindReviewRunGatePorts(actorCtx),
  });
}

// ---------------------------------------------------------------------------
// DECIDE — the full SubmitDecisionPorts the decision core consumes.
// ---------------------------------------------------------------------------

/** Map the type-resolved mount to audit provenance (host-authoritative).
 * Exported for its own unit test — the submit-time port that calls it needs a
 * database, and the mapping is exactly what must not drift when a mount kind is
 * added (cinatra#2931 W4). */
export function provenanceFromResolvedMount(resolved: ResolvedRendererMount): ReviewRendererProvenance {
  switch (resolved.kind) {
    case "build-map":
      return { kind: "build-map", packageName: resolved.packageName, digest: null };
    case "runtime":
      return {
        kind: "runtime",
        packageName: resolved.packageName,
        digest: resolved.descriptor.tuple.digest,
      };
    // The FORM RUNG, re-resolved at submit time like every other kind, so a
    // rendered text target is recorded as RENDERED. Recording it as a floor
    // would put a fallback on the audit row of a review the reader read in full.
    case "form":
      return { kind: "first-party", packageName: null, digest: null };
    case "floor":
      return { kind: "floor", packageName: resolved.packageName, digest: null };
  }
}

/** Bind every decision port (run access + gate state + submit-time membership +
 * host-derived provenance + the atomic commit) for the decision core. */
export function bindSubmitDecisionPorts(ctx: ReviewActorContext): SubmitDecisionPorts {
  const kernelActor = buildActorContextFromPrimitive(ctx.actor, ctx.orgId, ctx.roleHints);
  const artifactPorts = bindArtifactReviewPorts({ orgId: ctx.orgId, actor: kernelActor });

  const deriveProvenance = async (
    target: ArtifactReviewTarget,
  ): Promise<ReviewRendererProvenance> => {
    // Re-resolve the renderer FROM THE ARTIFACT TYPE at submit time. The decision
    // core only calls this for a target that already passed `revisionMember`, but
    // the artifact read can still degrade (denied/absent between prepare and
    // submit) → a floor provenance, never a fabricated renderer.
    const read = await artifactPorts.readArtifact(target.artifactId);
    if (read.kind !== "ok") return { kind: "floor", packageName: null, digest: null };
    const member = await artifactPorts.revisionMember(
      target.artifactId,
      target.representationRevisionId,
    );
    if (!member) return { kind: "floor", packageName: null, digest: null };
    const props = artifactPorts.buildProps({
      artifact: read.artifact,
      representationRevisionId: target.representationRevisionId,
      mime: member.mime,
    });
    const resolved = await artifactPorts.resolveMount({
      artifact: read.artifact,
      mime: member.mime,
      propsApiVersion: props.propsApiVersion,
    });
    return provenanceFromResolvedMount(resolved);
  };

  return {
    verifyRunAccess: (runId, op) => enforceReviewRunAccess(runId, ctx.actor, op, ctx.roleHints),
    readGateState: (runId, reviewTaskId) => readReviewGateState(runId, reviewTaskId),
    revisionMember: (artifactId, representationRevisionId) =>
      artifactPorts.revisionMember(artifactId, representationRevisionId),
    deriveProvenance,
    // The DECIDING actor (cinatra#2047 D-2) — taken from the SAME verified actor
    // context run access was just enforced against, never from the request body.
    // A carrier with no user id (an A2A/system principal) yields null, and the
    // gate then records no decider rather than a fabricated one.
    actingActorId: () => ctx.actor.userId ?? null,
    // The gate's PINNED suggestion snapshot (cinatra#2571) — the set the core
    // validates `accepted ∪ dismissed ⊆ surfaced` against, BEFORE the CAS.
    //
    // DYNAMIC import on purpose, the `artifact-review-resume-delivery` posture:
    // the suggestion store reaches the snapshot store and, through it, the
    // producer's payload verifier. Every route that decides a review would carry
    // that whole lane statically for a port most decisions never call (a gate with
    // no snapshot surfaces nothing). Dynamic keeps the static route graph exactly
    // where it was, and the port is called at most once per submit.
    readSurfacedSuggestions: async (runId, reviewTaskId) => {
      const { readSurfacedSuggestionsForGate } = await import(
        "@cinatra-ai/agents/suggestion-decision-store"
      );
      return readSurfacedSuggestionsForGate(runId, reviewTaskId);
    },
    commit: (plan) => commitReviewDecision(plan),
  };
}

/**
 * Submit a review decision against the live pinned gate — the fully bound
 * counterpart of the #1807 fenced decision core. Re-validates (run access +
 * pinned-set membership + revision membership + gate CAS), records the audit +
 * reject-tombstone disposition, and enqueues the exactly-once-persisted resume intent (at-least-once delivery), all
 * transactionally. Idempotent under a response-lost retry.
 */
export async function submitReviewDecision(args: {
  decision: ArtifactReviewDecision;
  actorCtx: ReviewActorContext;
}): Promise<SubmitDecisionResult> {
  return submitReviewDecisionCore(args.decision, bindSubmitDecisionPorts(args.actorCtx));
}

/**
 * The op-appropriate run-access check for a decision (approve/reject →
 * approveHitl; comment → respondToHitl), enforced against the ACTUAL reviewing
 * actor. The decision action calls this FIRST — before it reads the gate — so an
 * unauthorized caller receives a uniform denial regardless of whether the gate is
 * pending, resolved, or absent (no pending-gate existence oracle; the read=view
 * boundary is not side-channeled through the decision endpoint).
 */
export async function enforceReviewDecisionAccess(args: {
  runId: string;
  op: ReviewRunAccessOp;
  actorCtx: ReviewActorContext;
}): Promise<RunAccessOutcome> {
  return enforceReviewRunAccess(args.runId, args.actorCtx.actor, args.op, args.actorCtx.roleHints);
}

/**
 * The LIFECYCLE `changes_requested` binder (cinatra#2063; owner ruling 2026-07-25).
 * The review surface's prompt-window feedback (the existing Comment path) drives a
 * `changes_requested` decision on a LIFECYCLE review gate: the base gate closes and
 * a repair opens through the S2 store's `recordChangesRequested` entry point (via
 * the surface composer) — no parallel write path.
 *
 * The ONE fact the composer needs that the surface holds is the base-revision CAS
 * witness (`currentBaseRevisionId`). It is resolved HERE through the SAME
 * `revisionMember` (liveOnly) port the preparation core uses: the reviewer decides
 * on the exact pinned revision, so the witness is that revision WHEN it is still a
 * live member, and null when it was tombstoned between prepare and submit (a
 * fail-closed `tombstoned-base`). No new artifact read path is introduced.
 *
 * Authorization is the CALLER's job and is UNCHANGED from the base Comment
 * decision: the action enforces `respondToHitl` on the run for the comment op
 * BEFORE this binder is reached, exactly as it does for a plain comment.
 */
export async function submitReviewSurfaceChangesRequested(args: {
  runId: string;
  reviewTaskId: string;
  baseTarget: ArtifactReviewTarget;
  /** The reviewer's typed prompt-window feedback (trimmed, non-empty). */
  feedback: string;
  actorCtx: ReviewActorContext;
}): Promise<RecordChangesRequestedResult> {
  const kernelActor = buildActorContextFromPrimitive(
    args.actorCtx.actor,
    args.actorCtx.orgId,
    args.actorCtx.roleHints,
  );
  const artifactPorts = bindArtifactReviewPorts({ orgId: args.actorCtx.orgId, actor: kernelActor });
  const member = await artifactPorts.revisionMember(
    args.baseTarget.artifactId,
    args.baseTarget.representationRevisionId,
  );
  const currentBaseRevisionId = member ? args.baseTarget.representationRevisionId : null;

  return recordReviewSurfaceChangesRequested({
    runId: args.runId,
    reviewTaskId: args.reviewTaskId,
    baseTarget: {
      artifactId: args.baseTarget.artifactId,
      representationRevisionId: args.baseTarget.representationRevisionId,
    },
    currentBaseRevisionId,
    feedback: args.feedback,
    // The DECIDING actor (cinatra#2047 D-2) — the same verified session actor the
    // approve/reject commit stamps, from the context run access was enforced against.
    decidedBy: args.actorCtx.actor.userId ?? null,
  });
}

/**
 * Read a gate's FROZEN pinned target set (the whole gate) — the host reviews
 * every pinned target, so a terminal decision covers them all (§IV). Returns the
 * pinned set for ANY existing gate (pending OR resolved), null only when the gate
 * is ABSENT. Returning the (immutable) set for a RESOLVED gate is load-bearing for
 * IDEMPOTENCY: a response-lost retry can reconstruct the identical decision and
 * reach the #1807 core's fingerprint comparison (a matching decision → idempotent
 * success; a different one → conflict), instead of being short-circuited to a
 * false "blocked" before the core ever runs. Used by the decision action to
 * assemble the whole-gate decision — ONLY AFTER the caller passes
 * `enforceReviewDecisionAccess`.
 */
export async function readReviewGatePinnedTargets(
  runId: string,
  reviewTaskId: string,
): Promise<ArtifactReviewTarget[] | null> {
  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) return null;
  return gate.pinnedTargets.map((t) => ({
    artifactId: t.artifactId,
    representationRevisionId: t.representationRevisionId,
  }));
}

// ---------------------------------------------------------------------------
// SURFACE LOADER — the host decision-chrome page's single server entrypoint
// (cinatra#1795 S12 item 4; spec design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f §I–VI). Composes the run/gate
// ports into the discriminated `ReviewSurfaceModel` the page renders: reads the
// pinned gate, prepares EVERY pinned target (the host reviews the whole gate —
// the reviewer never supplies targets), and resolves the terminal/comment
// permission axis (§V). Keeps the agents-store coupling in this one module.
// ---------------------------------------------------------------------------

/**
 * Load the review surface for a run's gate. Order is security-load-bearing
 * (§V): read access FIRST (a viewer with none never reaches the targets), then
 * the gate's own state — a DECIDED gate is `settled` (the card draws its
 * recorded reading over the reviewed target(s), kept read-only) and an
 * unavailable one is a single blocked state, gate existence never leaked — then
 * prepare the pinned set, then the decision permissions. Never throws for an authorization/gate-state outcome — those are
 * modelled states, not errors.
 */
export async function loadReviewGateSurface(args: {
  runId: string;
  reviewTaskId: string;
  actorCtx: ReviewActorContext;
}): Promise<ReviewSurfaceModel> {
  const { runId, reviewTaskId, actorCtx } = args;

  // 1. Read access (§V) — no run read ⇒ never reach the surface.
  const readAccess = await enforceReviewRunAccess(runId, actorCtx.actor, "read", actorCtx.roleHints);
  if (!readAccess.ok) return { kind: "not-authorized" };

  // 2. Gate must be a PENDING gate on this run (§V) for the DECISION surface;
  //    the pinned set is read from the gate, so the client never supplies
  //    targets. A non-pending gate is not one outcome but TWO, and they are held
  //    apart here exactly as the card's own resolver holds them apart
  //    (`lifecycle-card-refetch`: `resolved` → `settled`, `unavailable` →
  //    `absent`; cinatra#2904):
  //
  //      `resolved`    → `settled`. The gate exists, this reader may read the
  //                      run, and it has been decided. That is a review this
  //                      surface CAN show — the card draws the recorded outcome,
  //                      its decider where one can be named, and the recorded
  //                      suggestion chips — so the surface says "mount the card"
  //                      rather than blocking before the card exists. Plan §4.4
  //                      step 7: everyone looking at that run, in any channel,
  //                      sees the same settled card. And that card is not a
  //                      decision line over an empty box: "A resolved gate opens
  //                      read-only: what was decided, and the reviewed
  //                      target(s), kept for the run's audit trail" — so this
  //                      answer prepares the gate's OWN frozen pinned set,
  //                      read-only, exactly as the pending answer prepares it.
  //
  //      `unavailable` → `blocked`, unchanged. A gate that never existed and a
  //                      row too corrupt to read are not a decided review, and
  //                      widening the settled reading over them would let a
  //                      replayed or garbage ref produce settled-card DOM for
  //                      nothing at all. Gate existence is still not leaked: the
  //                      blocked panel is the same panel a stale view draws.
  const gate = await readReviewGateState(runId, reviewTaskId);
  if (gate.status === "unavailable") {
    return { kind: "blocked", reason: "no-longer-pending" };
  }
  if (gate.status !== "pending") {
    // The decided reading KEEPS THE REVIEWED WORK. The set is read from the gate
    // itself — the frozen one it pinned, so the reader sees the revision the
    // decision was taken on and never a later re-materialization ("You approve
    // exactly what you saw") — and prepared through the SAME never-blank ladder
    // the pending reading uses. `acceptResolvedGate` is opened HERE and nowhere
    // a decision is taken; nothing on this path can decide anything, because the
    // decision floor is the card's and the decided card draws none.
    const pinned = await readReviewGatePinnedTargets(runId, reviewTaskId);
    // The gate answered `resolved` a line ago; a set that is gone underneath is
    // a row that can no longer be read, which is blocked, not decided.
    if (!pinned) return { kind: "blocked", reason: "no-longer-pending" };
    const history = await prepareReviewTargets({
      input: { runId, reviewTaskId, targets: pinned, acceptResolvedGate: true },
      actorCtx,
    });
    if (!history.ok) {
      return history.error.kind === "run-access-denied"
        ? { kind: "not-authorized" }
        : { kind: "blocked", reason: "no-longer-pending" };
    }
    return {
      kind: "settled",
      targets: history.prepared,
      pinnedCapturePairs: await loadPinnedCapturePairsForTargets(
        actorCtx.orgId,
        history.prepared,
        isRepairSuccessorTaskId(reviewTaskId)
          ? ((await readReviewGate(runId, reviewTaskId))?.id ?? null)
          : null,
      ),
      // As on the ready path: no gate/run column carries a producer summary in
      // this slice, so the chrome renders nothing rather than an empty summary.
      agentSummary: null,
    };
  }

  // 3. Prepare EVERY pinned target through the fully-bound core (never-blank
  //    floor per target; a substituted/absent gate races to a blocked state).
  const prepared = await prepareReviewTargets({
    input: { runId, reviewTaskId, targets: gate.targets },
    actorCtx,
  });
  if (!prepared.ok) {
    switch (prepared.error.kind) {
      case "run-access-denied":
        return { kind: "not-authorized" };
      case "gate-not-pending":
        // The gate moved between step 2 and here. It stays BLOCKED rather than
        // becoming `settled`: `prepareReviewTargets` folds "no such gate" into
        // this same error (`artifact-review-preparation`), so this answer cannot
        // tell a gate decided under the reviewer from one that was never there,
        // and only a read that KNOWS it saw a resolved row may mount the settled
        // card. The reader's Refresh re-enters at step 2, which does know.
        return { kind: "blocked", reason: "no-longer-pending" };
      case "target-substitution":
        return { kind: "blocked", reason: "targets-mismatch" };
      case "invalid-targets":
        // The gate pinned an invalid set — treat as a stale/mismatched view
        // rather than crashing the surface.
        return { kind: "blocked", reason: "targets-mismatch" };
    }
  }

  // 4. Decision permissions (§V): terminal Approve/Reject need approve access;
  //    Comment needs respond access. Resolved against the ACTUAL reviewing actor.
  const [decide, comment] = await Promise.all([
    enforceReviewRunAccess(runId, actorCtx.actor, "approveHitl", actorCtx.roleHints),
    enforceReviewRunAccess(runId, actorCtx.actor, "respondToHitl", actorCtx.roleHints),
  ]);

  const targets: PreparedReviewTarget[] = prepared.prepared;

  // cinatra#2286 S10 (PR1) — a REPAIR-SUCCESSOR gate's pinned pair is the
  // repair comparison (reviewed vs repaired), never the generic "review" pair
  // off its own single target (the wiring gap DESIGN identifies: this loader
  // previously hardcoded "review" for every gate with no awareness of
  // `isRepairSuccessorTaskId`). `readRepairBySuccessorGateId` is keyed on the
  // gate's own row id, not its `reviewTaskId` string, so that id is resolved
  // here — only for a repair-successor task — via one extra `readReviewGate`
  // read (the gate row was already confirmed pending above; this re-read is
  // for its id alone).
  const repairSuccessorGateId = isRepairSuccessorTaskId(reviewTaskId)
    ? ((await readReviewGate(runId, reviewTaskId))?.id ?? null)
    : null;

  const pinnedCapturePairs = await loadPinnedCapturePairsForTargets(
    actorCtx.orgId,
    targets,
    repairSuccessorGateId,
  );

  return {
    kind: "ready",
    runId,
    reviewTaskId,
    targets,
    // S6 (#2044 L-B + L-D) — the PINNED before/after PAIR for each pinned
    // target. A STORE read
    // only: the surface shows the picture taken at gate creation and performs no
    // network fetch at view time (the inert-by-contract rule, asserted by
    // `cms-preview-capture-view.test.ts`). A target with no capture yields an
    // empty list and renders nothing.
    pinnedCapturePairs,
    // The producing agent's one-line summary (§I/II) is rendered "when present";
    // no gate/run column carries it in this slice, so it is absent (the chrome
    // renders nothing rather than an empty summary).
    agentSummary: null,
    permissions: { canDecide: decide.ok, canComment: comment.ok },
  };
}

// ---------------------------------------------------------------------------
// PINNED CAPTURES (cinatra#2044 S6, sub-lane L-B).
//
// The whole point of the capture pipeline is that the reviewer sees the page as
// it was WHEN THE GATE WAS CREATED. This read is therefore deliberately dumb: a
// single store lookup per pinned target and a pure projection — no fetch, no
// resolver, no remote URL anywhere in the produced model. The only URL it emits
// is the host's own version-pinned artifact byte route for the stored PNG, which
// applies the same session/actor/tenant/tombstone gating as every other artifact
// and serves under the host's sandbox CSP.
//
// A store failure degrades to "no capture" rather than failing the surface: a
// reviewer must always be able to decide the DATA even when the context picture
// is unavailable (#2044's honest-fallback rule).
// ---------------------------------------------------------------------------

/**
 * Read one pinned target's captures and project ONE comparison out of them.
 * Shared by the gate surface (`review` — live page vs proposal) and the S4
 * verification view (`verification` — reviewed vs applied), so both pairs are
 * built by exactly the same store read + pure projection.
 */
export function loadPinnedCapturePair(
  orgId: string,
  target: { artifactId: string; representationRevisionId: string },
  kind: PinnedCapturePairKind,
  driftedRegions: readonly string[] = [],
): PinnedCapturePairView | null {
  try {
    const stored = readPinnedPreviewCaptures({
      orgId,
      boundArtifactId: target.artifactId,
      boundSnapshotRevisionId: target.representationRevisionId,
    });
    if (stored.length === 0) return null;
    return buildPinnedCapturePair(buildPinnedCaptureViews(stored), kind, driftedRegions);
  } catch (err) {
    console.warn(
      "[review-gate-ports] pinned capture lookup failed (the review is unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * cinatra#2286 S10 (PR1) — the REPAIR comparison for a repair-successor gate:
 * the repair's BASE target's own `current` capture (what was reviewed) vs its
 * SUCCESSOR target's own `repaired` capture (the producer's fix).
 *
 * SECURITY SHAPE (matches the issue's acceptance criteria exactly):
 *   - The BASE target is DERIVED from the repair row keyed on the successor
 *     gate id — never supplied by the caller.
 *   - The repair row's own `orgId` is the only org this pair may ever be built
 *     for; a caller-supplied `orgId` that disagrees refuses (never trusted).
 *   - The `successorTarget` argument is checked against the SAME row's
 *     `successorArtifactId` / `successorRepresentationRevisionId` before
 *     either read runs — a hand-supplied or mismatched successor target
 *     refuses, rather than silently pairing an unrelated capture.
 *   - Two independent, single-target `readPinnedPreviewCaptures` calls (never
 *     a new/widened query shape) — mirrors `loadPinnedCapturePair`'s
 *     degrade-to-null-on-failure contract.
 */
export async function loadPinnedRepairPair(
  orgId: string,
  successorGateId: string,
  successorTarget: { artifactId: string; representationRevisionId: string },
  driftedRegions: readonly string[] = [],
): Promise<PinnedCapturePairView | null> {
  try {
    const repair = await readRepairBySuccessorGateId(successorGateId);
    // Never trust a caller-supplied org — the repair row's own orgId is the
    // only org this pair may ever be built for.
    if (!repair || repair.orgId !== orgId) return null;
    // Refuse a hand-supplied / mismatched successor target: this pair may
    // only be built for the EXACT successor the repair row itself recorded
    // (which is also, by construction, the same lineage as the base — both
    // come off this one row).
    if (
      repair.successorArtifactId !== successorTarget.artifactId ||
      repair.successorRepresentationRevisionId !== successorTarget.representationRevisionId
    ) {
      return null;
    }

    const baseCaptures = readPinnedPreviewCaptures({
      orgId,
      boundArtifactId: repair.baseArtifactId,
      boundSnapshotRevisionId: repair.baseRepresentationRevisionId,
    });
    const successorCaptures = readPinnedPreviewCaptures({
      orgId,
      boundArtifactId: successorTarget.artifactId,
      boundSnapshotRevisionId: successorTarget.representationRevisionId,
    });
    if (baseCaptures.length === 0 && successorCaptures.length === 0) return null;

    return buildPinnedRepairPair(
      buildPinnedCaptureViews(baseCaptures),
      buildPinnedCaptureViews(successorCaptures),
      driftedRegions,
    );
  } catch (err) {
    console.warn(
      "[review-gate-ports] pinned repair-pair lookup failed (the review is unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function loadPinnedCapturePairsForTargets(
  orgId: string,
  targets: readonly PreparedReviewTarget[],
  repairSuccessorGateId: string | null,
): Promise<Record<string, PinnedCapturePairView>> {
  const out: Record<string, PinnedCapturePairView> = {};
  for (const prepared of targets) {
    const pair = repairSuccessorGateId
      ? await loadPinnedRepairPair(orgId, repairSuccessorGateId, prepared.target)
      : loadPinnedCapturePair(orgId, prepared.target, "review");
    if (pair) out[pinnedCaptureKey(prepared.target)] = pair;
  }
  return out;
}
