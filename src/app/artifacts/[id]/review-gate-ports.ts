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
import type { ReviewSurfaceModel } from "@/app/artifacts/review/review-surface-model";
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
 * Prepare a caller's review targets against a run's pending gate — the fully
 * bound counterpart of the #1807 fenced `prepareArtifactReviewTargets`. Resolves
 * the kernel actor for the artifact-side reads, binds the run/gate ports, and
 * runs the pure core.
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

/** Map the type-resolved mount to audit provenance (host-authoritative). */
function provenanceFromResolvedMount(resolved: ResolvedRendererMount): ReviewRendererProvenance {
  if (resolved.kind === "build-map") {
    return { kind: "build-map", packageName: resolved.packageName, digest: null };
  }
  if (resolved.kind === "runtime") {
    return { kind: "runtime", packageName: resolved.packageName, digest: resolved.descriptor.tuple.digest };
  }
  return { kind: "floor", packageName: resolved.packageName, digest: null };
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
// (cinatra#1795 S12 item 4; spec design@30a0f9c9 §I–VI). Composes the run/gate
// ports into the discriminated `ReviewSurfaceModel` the page renders: reads the
// pinned gate, prepares EVERY pinned target (the host reviews the whole gate —
// the reviewer never supplies targets), and resolves the terminal/comment
// permission axis (§V). Keeps the agents-store coupling in this one module.
// ---------------------------------------------------------------------------

/**
 * Load the review surface for a run's pending gate. Order is security-load-
 * bearing (§V): read access FIRST (a viewer with none never reaches the
 * targets), then the gate must still be pending (else a single blocked state,
 * gate existence never leaked), then prepare the pinned set, then the decision
 * permissions. Never throws for an authorization/gate-state outcome — those are
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

  // 2. Gate must be a PENDING gate on this run (§V). resolved / unavailable
  //    (absent, folded) ⇒ blocked "no-longer-pending"; the pinned set is read
  //    from the gate, so the client never supplies targets.
  const gate = await readReviewGateState(runId, reviewTaskId);
  if (gate.status !== "pending") {
    return { kind: "blocked", reason: "no-longer-pending" };
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
  return {
    kind: "ready",
    runId,
    reviewTaskId,
    targets,
    // The producing agent's one-line summary (§I/II) is rendered "when present";
    // no gate/run column carries it in this slice, so it is absent (the chrome
    // renders nothing rather than an empty summary).
    agentSummary: null,
    permissions: { canDecide: decide.ok, canComment: comment.ok },
  };
}
