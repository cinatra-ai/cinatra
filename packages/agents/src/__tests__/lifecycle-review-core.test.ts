/**
 * THE ONE REVIEW CORE, BOTH INPUTS (cinatra#2929, epic #2926 W2b).
 *
 * The claim under test is the plan's sentence: a review exists only for work
 * bound to an artifact, and the two ways of asking for one — a template step
 * that NAMES what it reviews, and an output the agent DECLARED artifact-bound
 * and then wrote — prove the same binding and go through the same policy.
 *
 * Pure decisions only. The two call sites that resolve the facts and act on the
 * answer are exercised next door, against the produced path and against the run
 * executor's marked gate.
 */
import { describe, expect, it } from "vitest";

import { LIFECYCLE_CARD_HOSTS } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import {
  DECLARED_REVIEW_DESTINATION_CLASS,
  DECLARED_REVIEW_ORIGIN_KIND,
  decideDeclaredReview,
  decideReviewPolicy,
  proveReviewBinding,
  type ReviewCoreInput,
} from "@/lib/lifecycle/lifecycle-review-core";
import { planReviewForEvent } from "@/lib/lifecycle/lifecycle-orchestration";
import type { ProducedEventAxes } from "@/lib/lifecycle/lifecycle-orchestration";

const WRITE: ProducedEventAxes = {
  eventId: "evt-2929",
  artifactId: "art-2929",
  representationRevisionId: "rev-2929",
  originKind: "agent_produced",
  destinationClass: "none",
  continuationMode: "checkpointed",
};

const TARGETS = [
  { artifactId: "art-1", representationRevisionId: "rev-1" },
  { artifactId: "art-2", representationRevisionId: "rev-2" },
];

const SILENT = { bound: "silent" } as const;

describe("the binding, proved before anything else", () => {
  it("an agent that declares NO artifact-bound output is unbound — the write does not save it", () => {
    // The acceptance's first fixture, at the point that decides it. The write is
    // real and recorded; what is missing is the declaration, and a review exists
    // only for work bound to an artifact.
    const binding = proveReviewBinding({
      kind: "produced-output",
      produces: { hasArtifactBindings: false },
      writeEvent: WRITE,
    });
    expect(binding.bound).toBe(false);
    if (binding.bound) throw new Error("unreachable");
    expect(binding.why).toContain("declares no artifact-bound output");
  });

  it("…and NO card is mountable on any of the four hosts, because no review exists", () => {
    // Stated per host rather than once: "no card on any host" is the acceptance's
    // own wording, and a single assertion would not have said it about all four.
    const binding = proveReviewBinding({
      kind: "produced-output",
      produces: { hasArtifactBindings: false },
      writeEvent: WRITE,
    });
    expect(LIFECYCLE_CARD_HOSTS.length).toBe(4);
    for (const host of LIFECYCLE_CARD_HOSTS) {
      expect(
        binding.bound,
        `an unbound output must open no review on ${host}`,
      ).toBe(false);
    }
  });

  it("a DECLARED artifact-bound output that was written IS bound", () => {
    const binding = proveReviewBinding({
      kind: "produced-output",
      produces: { hasArtifactBindings: true },
      writeEvent: WRITE,
    });
    expect(binding.bound).toBe(true);
    if (!binding.bound || binding.kind !== "produced-output") throw new Error("unreachable");
    expect(binding.target).toEqual({ artifactId: "art-2929", representationRevisionId: "rev-2929" });
  });

  it("an UNKNOWN declaration is not a refusal — a template nobody compiled keeps its review", () => {
    // Three-valued on purpose. `false` is the compiler having looked; `null` is
    // nobody having looked, and reading the second as the first would silently
    // stop reviewing every agent installed before the column existed.
    const binding = proveReviewBinding({
      kind: "produced-output",
      produces: { hasArtifactBindings: null },
      writeEvent: WRITE,
    });
    expect(binding.bound).toBe(true);
  });

  it("a review step that names a usable target set is bound, deduped and validated", () => {
    const binding = proveReviewBinding({
      kind: "declared-targets",
      targets: [...TARGETS, TARGETS[0]],
    });
    expect(binding.bound).toBe(true);
    if (!binding.bound || binding.kind !== "declared-targets") throw new Error("unreachable");
    expect(binding.targets).toEqual(TARGETS);
  });

  it.each([
    ["nothing at all", undefined],
    ["an empty set", []],
    ["a value that is not a list", { artifactId: "art-1" }],
    ["a malformed member", [{ artifactId: "art-1" }]],
  ])("a review step naming %s is unbound, never a policy question", (_label, targets) => {
    const binding = proveReviewBinding({ kind: "declared-targets", targets } as ReviewCoreInput);
    expect(binding.bound).toBe(false);
    if (binding.bound) throw new Error("unreachable");
    expect(binding.why).toContain("names no usable artifact");
  });
});

describe("the policy, asked once and by both kinds", () => {
  it("a template-marked review step goes through the SAME lattice the produced path uses", () => {
    // The two kinds, put on the same axes, must answer identically — that is what
    // "the same policy" means, and it is checkable rather than asserted because
    // the produced path's plan is built on the same call.
    const declared = decideReviewPolicy({
      artifactType: "artifact-blog-post-body",
      destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
      originKind: DECLARED_REVIEW_ORIGIN_KIND,
      humanPresent: false,
      orgRule: SILENT,
    });
    const produced = planReviewForEvent(
      { ...WRITE, destinationClass: DECLARED_REVIEW_DESTINATION_CLASS, originKind: DECLARED_REVIEW_ORIGIN_KIND },
      { artifactType: "artifact-blog-post-body", humanPresent: false, orgRule: SILENT },
    );
    expect(declared.fired).toBe(true);
    expect(produced.action).toBe("create-gate");
    expect(produced.action === "create-gate" && produced.outcome).toBe(declared.outcome);
  });

  it("an organization that FORBIDS this review closes both kinds, not one", () => {
    const forbidden = { bound: "forbidden" } as const;
    const declared = decideReviewPolicy({
      artifactType: "artifact-blog-post-body",
      destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
      originKind: DECLARED_REVIEW_ORIGIN_KIND,
      humanPresent: false,
      orgRule: forbidden,
    });
    const produced = planReviewForEvent(
      { ...WRITE, destinationClass: DECLARED_REVIEW_DESTINATION_CLASS, originKind: DECLARED_REVIEW_ORIGIN_KIND },
      { artifactType: "artifact-blog-post-body", humanPresent: false, orgRule: forbidden },
    );
    expect(declared.fired).toBe(false);
    expect(produced.action).toBe("no-gate");
  });

  it("an agent that declares the review checkpoint SKIPPED is honoured on both kinds", () => {
    const manifest = { requestedSkips: ["review" as const] };
    expect(
      decideReviewPolicy({
        artifactType: "artifact-blog-post-body",
        destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
        originKind: DECLARED_REVIEW_ORIGIN_KIND,
        humanPresent: false,
        orgRule: SILENT,
        manifest,
      }).fired,
    ).toBe(false);
    expect(
      planReviewForEvent(
        { ...WRITE, destinationClass: DECLARED_REVIEW_DESTINATION_CLASS, originKind: DECLARED_REVIEW_ORIGIN_KIND },
        { artifactType: "artifact-blog-post-body", humanPresent: false, orgRule: SILENT, manifest },
      ).action,
    ).toBe("no-gate");
  });
});

describe("the declared decision", () => {
  it("opens the review when the policy fires for the named work", () => {
    const binding = proveReviewBinding({ kind: "declared-targets", targets: TARGETS });
    const decision = decideDeclaredReview({
      binding,
      perTarget: [
        decideReviewPolicy({
          artifactType: "artifact-blog-post-body",
          destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
          originKind: DECLARED_REVIEW_ORIGIN_KIND,
          humanPresent: false,
          orgRule: SILENT,
        }),
      ],
    });
    expect(decision.review).toBe(true);
    if (!decision.review) throw new Error("unreachable");
    expect(decision.targets).toEqual(TARGETS);
  });

  it("a FORBIDDEN target is dropped from what the gate pins — an org bound is absolute", () => {
    // The policy table's first rule: nothing below an org bound can fire a gate
    // the organization barred. So a set that disagrees with itself opens a
    // review for the members that fire and leaves the forbidden one out —
    // never a gate that pins a refused artifact because a neighbour fired.
    const binding = proveReviewBinding({ kind: "declared-targets", targets: TARGETS });
    const forbidden = decideReviewPolicy({
      artifactType: "a",
      destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
      originKind: DECLARED_REVIEW_ORIGIN_KIND,
      humanPresent: false,
      orgRule: { bound: "forbidden" },
    });
    const fires = decideReviewPolicy({
      artifactType: "b",
      destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
      originKind: DECLARED_REVIEW_ORIGIN_KIND,
      humanPresent: false,
      orgRule: SILENT,
    });

    const mixed = decideDeclaredReview({ binding, perTarget: [forbidden, fires] });
    expect(mixed.review).toBe(true);
    if (!mixed.review) throw new Error("unreachable");
    expect(mixed.targets).toEqual([TARGETS[1]]);

    // …and nothing surviving is no review at all.
    expect(decideDeclaredReview({ binding, perTarget: [forbidden, forbidden] }).review).toBe(false);

    // …while a set that agrees with itself pins exactly what it named.
    const whole = decideDeclaredReview({ binding, perTarget: [fires, fires] });
    expect(whole.review).toBe(true);
    if (!whole.review) throw new Error("unreachable");
    expect(whole.targets).toEqual(TARGETS);
  });

  it("a target with NO policy answer is kept, not dropped — a resolver fault is not a refusal", () => {
    // Dropping a target because nothing answered for it would quietly narrow
    // what a person reviews, and leave no trace that it happened.
    const binding = proveReviewBinding({ kind: "declared-targets", targets: TARGETS });
    const fires = decideReviewPolicy({
      artifactType: "b",
      destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
      originKind: DECLARED_REVIEW_ORIGIN_KIND,
      humanPresent: false,
      orgRule: SILENT,
    });
    const partial = decideDeclaredReview({ binding, perTarget: [fires] });
    expect(partial.review).toBe(true);
    if (!partial.review) throw new Error("unreachable");
    expect(partial.targets).toEqual(TARGETS);
  });

  it("an unbound step decides nothing and says why", () => {
    const decision = decideDeclaredReview({
      binding: proveReviewBinding({ kind: "declared-targets", targets: [] }),
      perTarget: [],
    });
    expect(decision.review).toBe(false);
    if (decision.review) throw new Error("unreachable");
    expect(decision.why).toContain("names no usable artifact");
  });
});
