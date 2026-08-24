/**
 * THE REVIEW CORE (cinatra#2929, epic #2926 W2b).
 *
 * ONE CORE, TWO INPUTS. A review can be asked for in two ways, and until this
 * module existed the two ways answered to nothing in common:
 *
 *   DECLARED  — a template step that NAMES the artifacts it reviews. They are
 *               inputs to that step, and the marker on the gate says which
 *               input carries them.
 *   PRODUCED  — an output the agent DECLARED artifact-bound (the typed output
 *               declaration on its package), CONFIRMED by the recorded artifact
 *               write.
 *
 * Both prove a BINDING first, and then — and only then — go through the same
 * policy. The declared kind keeps its own checks that a decision has exactly
 * one path; those live at its call site, because they are about the gate it
 * emits and the legacy gate it must not emit beside it, not about the decision.
 *
 * A REVIEW EXISTS ONLY FOR ARTIFACT-BOUND WORK. That sentence is this module's
 * whole reason to exist: an agent whose outputs are bound to no artifact, and
 * whose template names no review step, never reaches a review — no card on any
 * host, and no organization rule needed to say so. Before this, the produced
 * side asked only whether an artifact write had been RECORDED, which is one
 * half of the binding: any write on any run reached the policy, and the policy's
 * own default fires for durable agent-produced work. The declared side asked
 * neither half — a marked gate pinned and routed unconditionally, so the policy
 * table had no say over the one review kind an agent author states outright.
 *
 * PURE — no React, no database, no server-only. The two call sites resolve the
 * facts that do not live on their inputs (the artifact's type, the organization
 * bound, the producing agent's declarations) and inject them, exactly as the
 * orchestration pure core already required. That is what lets the same decision
 * be unit-tested against both inputs without a database, and what lets the run
 * executor reach it without growing its reachable module graph.
 */

import {
  normalizeReviewTargets,
  type ArtifactReviewTarget,
} from "@/lib/artifacts/artifact-review-target";

import {
  evaluatePolicy,
  type CompiledManifestLifecycle,
  type DestinationClass,
  type LifecycleOriginKind,
  type OrgPolicyRule,
  type PolicyDecision,
  type RunElevation,
} from "./lifecycle-policy";
import type { ProducedEventAxes } from "./lifecycle-orchestration";

// ---------------------------------------------------------------------------
// The one input, discriminated
// ---------------------------------------------------------------------------

/**
 * The typed output declaration on the producing agent's package, as the host
 * persists it.
 *
 * THREE-VALUED, and the third value is the point. `hasArtifactBindings` is the
 * compiler's answer to "does this agent's flow declare an artifact-bound
 * output": true and false are answers, and NULL is the absence of one — a
 * template compiled before the column existed. Treating null as false would
 * silently stop reviewing every agent installed before that compile, which is
 * the opposite of what "a review exists only for artifact-bound work" asks for:
 * the sentence removes reviews for work PROVED unbound, not for work nothing
 * has been asked about yet.
 */
export type ProducedOutputDeclaration = {
  /** Does the agent declare an artifact-bound output? Null = never compiled. */
  readonly hasArtifactBindings: boolean | null;
};

export type ReviewCoreInput =
  | {
      readonly kind: "declared-targets";
      /** The raw value of the flow input the gate's marker names. */
      readonly targets: unknown;
    }
  | {
      readonly kind: "produced-output";
      readonly produces: ProducedOutputDeclaration;
      /** The RECORDED write. Its existence is the second half of the binding. */
      readonly writeEvent: ProducedEventAxes;
    };

// ---------------------------------------------------------------------------
// Step 1 — prove the binding
// ---------------------------------------------------------------------------

/** What the binding proof answers with. `bound: false` ends the decision. */
export type ReviewBinding =
  | {
      readonly bound: true;
      readonly kind: "declared-targets";
      /** Validated, deduped and bounded — the set a gate would pin. */
      readonly targets: readonly ArtifactReviewTarget[];
    }
  | {
      readonly bound: true;
      readonly kind: "produced-output";
      readonly target: ArtifactReviewTarget;
      readonly writeEvent: ProducedEventAxes;
    }
  | { readonly bound: false; readonly why: string };

/**
 * Is this work bound to an artifact?
 *
 * ONE PREDICATE, BOTH KINDS, and the two halves it asks for differ only in
 * where they are read from:
 *
 *   declared — the marker names an input, and the value that input carries must
 *     be a usable review-target set. An unusable one is not a policy question:
 *     nothing has been named, so there is nothing to review. This is the SAME
 *     validation the gate emitter applies before it pins, hoisted ahead of the
 *     decision so the two sides cannot disagree about what a target is.
 *
 *   produced — the agent's own declaration must not PROVE the absence of an
 *     artifact-bound output, and the write must have been recorded. The write is
 *     the input's own `writeEvent`, so its presence is structural; the
 *     declaration is the half that was missing.
 *
 * Total and pure: an adversarial value answers `bound: false`, never a throw.
 */
export function proveReviewBinding(input: ReviewCoreInput): ReviewBinding {
  if (input.kind === "declared-targets") {
    const normalized = normalizeReviewTargets(input.targets);
    if (!normalized.ok) {
      return {
        bound: false,
        why: `the review step names no usable artifact: ${normalized.error}`,
      };
    }
    return { bound: true, kind: "declared-targets", targets: normalized.targets };
  }

  // PROVED UNBOUND is the only refusal here. `false` is the compiler saying it
  // looked and found no artifact-bound output; `null` is nobody having looked.
  if (input.produces.hasArtifactBindings === false) {
    return {
      bound: false,
      why: "the producing agent declares no artifact-bound output — a review exists only for artifact-bound work",
    };
  }
  const target: ArtifactReviewTarget = {
    artifactId: input.writeEvent.artifactId,
    representationRevisionId: input.writeEvent.representationRevisionId,
  };
  // The write must name a real revision. A row that cannot say WHAT was written
  // is not a confirmation of anything, so it proves no binding either.
  if (
    target.artifactId.length === 0 ||
    target.representationRevisionId.length === 0
  ) {
    return {
      bound: false,
      why: "the recorded write names no artifact revision, so it confirms no binding",
    };
  }
  return {
    bound: true,
    kind: "produced-output",
    target,
    writeEvent: input.writeEvent,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — the shared policy
// ---------------------------------------------------------------------------

/** The axes the review checkpoint is evaluated on, whichever kind asked. */
export type ReviewPolicyInput = {
  readonly artifactType: string;
  readonly destinationClass: DestinationClass;
  readonly originKind: LifecycleOriginKind;
  readonly humanPresent: boolean;
  readonly orgRule: OrgPolicyRule;
  readonly manifest?: CompiledManifestLifecycle;
  readonly elevation?: RunElevation;
};

/**
 * Evaluate the REVIEW checkpoint. The one lattice call both kinds make.
 *
 * The policy table itself is UNCHANGED — the organization's rules first, the
 * product's defaults next, the skips an agent may declare, what a run may
 * strengthen, failing closed for work that leaves the app. What changes is who
 * asks it: the produced side always did, through `planReviewForEvent`, which now
 * asks through here; the declared side never did, and now does.
 *
 * Named rather than left as a bare `evaluatePolicy` call at two sites, because
 * "the same policy" is the claim this slice makes and a claim that lives in two
 * places is two claims.
 */
export function decideReviewPolicy(input: ReviewPolicyInput): PolicyDecision {
  return evaluatePolicy({
    checkpoint: "review",
    artifactType: input.artifactType,
    destinationClass: input.destinationClass,
    originKind: input.originKind,
    humanPresent: input.humanPresent,
    orgRule: input.orgRule,
    manifest: input.manifest,
    elevation: input.elevation,
  });
}

// ---------------------------------------------------------------------------
// The declared kind's axes
// ---------------------------------------------------------------------------

/**
 * The axes a DECLARED review is evaluated on.
 *
 * `originKind` is `agent_produced`: the work under a template's review step is
 * what the agent made, which is exactly the provenance the lattice means by it.
 *
 * `destinationClass` is `none`, and that is a statement about what this path
 * KNOWS rather than a claim about the artifact. The destination classes above
 * `none` are typed EFFECTS the produced-event pipeline records at the write —
 * a publish, a visibility promotion, a hand-off. A declared review step names
 * artifacts it reviews and records no effect at all, so there is none to carry
 * here. It matters because `none` is the class an organization rule can be
 * SILENT on and a manifest skip may then apply to, while an external class can
 * neither be skipped nor fail open — reading a declared step as external would
 * invent an effect nobody declared.
 *
 * The consequence, stated plainly so it is not discovered later: with these axes
 * the core default for review FIRES, so a marked review step keeps opening its
 * review exactly as it did before this slice. What the policy adds is the ability
 * of an organization to FORBID one, and of an agent to declare the checkpoint
 * skipped — the two things the table exists for and the declared kind was
 * outside of.
 *
 * WHAT THIS IS NOT, so nobody reads it as more than it is. These are the facts
 * THIS PATH KNOWS, not resolved axes for the artifacts themselves. A declared
 * target could in truth be user-provided, or carry an external effect, and this
 * path has no record of either: the produced pipeline learns both AT THE WRITE,
 * and a review step names artifacts without recording anything. Two costs follow
 * and are accepted rather than hidden: an organization rule keyed to a target's
 * real provenance or effect class is not matched here, and `none` lets an agent's
 * declared skip apply where an external class would have refused it. Resolving
 * the real axes needs the declared path to carry the same recorded facts the
 * produced path has, which is a change to what a review step records — not to
 * how the decision is made.
 */
export const DECLARED_REVIEW_ORIGIN_KIND: LifecycleOriginKind = "agent_produced";
export const DECLARED_REVIEW_DESTINATION_CLASS: DestinationClass = "none";

/** What the core answers a declared review with. */
export type DeclaredReviewDecision =
  /**
   * Bound, and the policy fired for these targets. `targets` is the set the gate
   * PINS — never the caller's raw value, and never a target the policy refused.
   */
  | {
      readonly review: true;
      readonly targets: readonly ArtifactReviewTarget[];
      readonly reason: string;
    }
  /**
   * No review. The caller falls open to its ordinary human gate — the run is a
   * template step that asked for a person either way, and a declined review must
   * never dead-end it.
   */
  | { readonly review: false; readonly why: string };

/**
 * Decide a declared review from a proved binding and one policy answer per
 * target.
 *
 * ONE ANSWER PER TARGET, AND THE SET IS FILTERED BY IT. A review step may name
 * artifacts of several types, and the organization's rules are keyed by type — so
 * the set can disagree with itself, and the decision cannot be a single verdict
 * over the whole set without breaking something.
 *
 * A FORBIDDEN BOUND IS ABSOLUTE. That is the policy table's own first rule:
 * nothing below an org bound can fire a gate the organization barred. So a
 * refused target is REMOVED from what the gate pins rather than carried along
 * inside a gate that fired for one of its neighbours — which is what "any fire
 * wins over the whole set" would have done, and would have put an artifact under
 * a review its organization forbade.
 *
 * The gate opens for whatever survives; nothing surviving is no review at all,
 * and the caller falls open to its ordinary human gate. The filtering matters
 * only where the set disagrees with itself, which is the case the aggregate
 * verdict got wrong: a set whose members all fire pins exactly what it named.
 */
export function decideDeclaredReview(input: {
  readonly binding: ReviewBinding;
  /** One policy answer per proved target, in the same order. */
  readonly perTarget: readonly PolicyDecision[];
}): DeclaredReviewDecision {
  const { binding } = input;
  if (!binding.bound) return { review: false, why: binding.why };
  if (binding.kind !== "declared-targets") {
    return {
      review: false,
      why: "a produced-output binding is decided through the produced path's own plan",
    };
  }
  const firing: ArtifactReviewTarget[] = [];
  let firedReason: string | null = null;
  binding.targets.forEach((target, i) => {
    const decision = input.perTarget[i];
    // NO ANSWER IS NOT A REFUSAL. A caller that resolved fewer answers than
    // targets has failed to decide, not decided against — and dropping a target
    // for a resolver fault would quietly narrow what a person reviews. The
    // per-target answers are total in practice; this keeps the failure visible
    // as an unfiltered target rather than an invisible omission.
    if (decision === undefined || decision.fired) {
      firing.push(target);
      if (decision?.fired && firedReason === null) firedReason = decision.reason;
    }
  });
  if (firing.length === 0) {
    const first = input.perTarget[0];
    return {
      review: false,
      why: first
        ? `the policy opens no review for this work: ${first.reason}`
        : "no policy answer was resolved for the named artifacts",
    };
  }
  return {
    review: true,
    targets: firing,
    reason: firedReason ?? "the policy opens a review for this work",
  };
}
