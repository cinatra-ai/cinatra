/**
 * THE MID-RUN TARGET-SET FIXTURE (cinatra#3035, epic #3023 W11; plan (C) §6.1
 * step 4 — "that mid-run references reach the marked gate is this wave's first
 * fixture, since no test proves it today").
 *
 * Two claims, both about a marked review step whose target set is produced
 * INSIDE the run rather than at its start:
 *
 *   1. The value the run's own projection step put on the gate's input is what
 *      the gate pins. Before this wave the executor read the marker's name off
 *      `run.inputParams` first and only fell through on null/undefined, so a
 *      flow that also declares the marked input at its start node — which every
 *      compiled flow does, since a node input is a flow input — shadowed the
 *      mid-run value with the start default (`[]`, `""`) and the gate pinned
 *      nothing.
 *
 *   2. A target set naming N artifacts opens N reviews, one per artifact, in
 *      order — the post's on its immutable reference, then each picture's on
 *      its own — never one combined review over the set.
 *
 *   pnpm exec vitest run src/__tests__/lifecycle-c-w11-declared-review-targets.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  baseReviewTaskId,
  hasPendingSiblingLeg,
  nextUnresolvedLeg,
  planPerArtifactReviewGates,
  resolveDeclaredReviewTargets,
} from "@/lib/lifecycle/declared-review-targets";

const POST = { artifactId: "art-post", representationRevisionId: "rev-post-2" };
const FEATURED = { artifactId: "art-img-featured", representationRevisionId: "rev-img-1" };
const BODY = { artifactId: "art-img-body", representationRevisionId: "rev-img-2" };

describe("W11 — the mid-run target set reaches the marked gate", () => {
  it("pins what the run's projection step emitted, not the start node's default", () => {
    const resolved = resolveDeclaredReviewTargets({
      inputName: "reviewTargets",
      // Every compiled flow lists the gate's input at its start node too, with a
      // default. This is the shadow that made the mid-run set unreachable.
      startParams: { brief: "a brief", reviewTargets: [] },
      pausePayload: { reviewTargets: [POST, FEATURED] },
    });
    expect(resolved).toEqual([POST, FEATURED]);
  });

  it("pins the mid-run set when the start node never declared the input at all", () => {
    expect(
      resolveDeclaredReviewTargets({
        inputName: "reviewTargets",
        startParams: { brief: "a brief" },
        pausePayload: { reviewTargets: [POST] },
      }),
    ).toEqual([POST]);
  });

  it("keeps the run-start set for a gate whose targets are resolved at run start", () => {
    expect(
      resolveDeclaredReviewTargets({
        inputName: "reviewTargets",
        startParams: { reviewTargets: [POST] },
        pausePayload: { somethingElse: 1 },
      }),
    ).toEqual([POST]);
  });

  it("treats an empty-string and an empty-array pause value as no mid-run set", () => {
    expect(
      resolveDeclaredReviewTargets({
        inputName: "reviewTargets",
        startParams: { reviewTargets: [POST] },
        pausePayload: { reviewTargets: "" },
      }),
    ).toEqual([POST]);
    expect(
      resolveDeclaredReviewTargets({
        inputName: "reviewTargets",
        startParams: { reviewTargets: [POST] },
        pausePayload: { reviewTargets: [] },
      }),
    ).toEqual([POST]);
  });

  it("resolves nothing when neither side names the marked input", () => {
    expect(
      resolveDeclaredReviewTargets({
        inputName: "reviewTargets",
        startParams: { brief: "b" },
        pausePayload: {},
      }),
    ).toBeUndefined();
  });

  it("accepts a JSON string, which is what an InputMessageNode carries", () => {
    expect(
      resolveDeclaredReviewTargets({
        inputName: "reviewTargets",
        startParams: {},
        pausePayload: { reviewTargets: JSON.stringify([POST, FEATURED]) },
      }),
    ).toEqual([POST, FEATURED]);
  });
});

describe("W11 — one review per artifact", () => {
  it("opens one review per artifact, in the order the set names them", () => {
    const planned = planPerArtifactReviewGates({
      reviewTaskId: "wayflow-task-7",
      targets: [POST, FEATURED, BODY],
    });
    expect(planned).toEqual([
      { reviewTaskId: "wayflow-task-7", targets: [POST] },
      { reviewTaskId: "wayflow-task-7#2", targets: [FEATURED] },
      { reviewTaskId: "wayflow-task-7#3", targets: [BODY] },
    ]);
  });

  it("never combines two artifacts into one review", () => {
    for (const leg of planPerArtifactReviewGates({
      reviewTaskId: "t",
      targets: [POST, FEATURED],
    })) {
      expect(leg.targets).toHaveLength(1);
    }
  });

  it("keeps a single-artifact set on the gate's own task id, so an existing gate stays itself", () => {
    expect(planPerArtifactReviewGates({ reviewTaskId: "t", targets: [POST] })).toEqual([
      { reviewTaskId: "t", targets: [POST] },
    ]);
  });

  it("gives one artifact one review even when the set names two of its revisions", () => {
    const planned = planPerArtifactReviewGates({
      reviewTaskId: "t",
      targets: [POST, { artifactId: POST.artifactId, representationRevisionId: "rev-post-3" }],
    });
    expect(planned).toHaveLength(1);
    expect(planned[0].targets).toEqual([POST]);
  });

  it("plans nothing for an empty set", () => {
    expect(planPerArtifactReviewGates({ reviewTaskId: "t", targets: [] })).toEqual([]);
  });
});

describe("W11 — the run parks at each review", () => {
  it("reads the WayFlow task id back off a leg's gate id", () => {
    expect(baseReviewTaskId("wayflow-task-7#3")).toBe("wayflow-task-7");
    expect(baseReviewTaskId("wayflow-task-7")).toBe("wayflow-task-7");
  });

  it("keeps the run parked while a sibling leg is still pending", () => {
    expect(
      hasPendingSiblingLeg({
        reviewTaskId: "wayflow-task-7",
        gates: [
          { reviewTaskId: "wayflow-task-7", status: "resolved" },
          { reviewTaskId: "wayflow-task-7#2", status: "pending" },
        ],
      }),
    ).toBe(true);
  });

  it("lets the run go on once every leg of the same gate is resolved", () => {
    expect(
      hasPendingSiblingLeg({
        reviewTaskId: "wayflow-task-7#2",
        gates: [
          { reviewTaskId: "wayflow-task-7", status: "resolved" },
          { reviewTaskId: "wayflow-task-7#2", status: "resolved" },
        ],
      }),
    ).toBe(false);
  });

  it("never counts another gate's legs, nor the leg being resolved itself", () => {
    expect(
      hasPendingSiblingLeg({
        reviewTaskId: "wayflow-task-7",
        gates: [
          { reviewTaskId: "wayflow-task-7", status: "pending" },
          { reviewTaskId: "wayflow-task-9#2", status: "pending" },
        ],
      }),
    ).toBe(false);
  });

  it("names the leg a person is sent to next: the first still pending", () => {
    expect(
      nextUnresolvedLeg({
        planned: [
          { reviewTaskId: "t", targets: [POST] },
          { reviewTaskId: "t#2", targets: [FEATURED] },
          { reviewTaskId: "t#3", targets: [BODY] },
        ],
        gates: [
          { reviewTaskId: "t", status: "resolved" },
          { reviewTaskId: "t#2", status: "pending" },
        ],
      })?.reviewTaskId,
    ).toBe("t#2");
  });

  it("sends a person to a leg no gate exists for yet", () => {
    expect(
      nextUnresolvedLeg({
        planned: [
          { reviewTaskId: "t", targets: [POST] },
          { reviewTaskId: "t#2", targets: [FEATURED] },
        ],
        gates: [{ reviewTaskId: "t", status: "resolved" }],
      })?.reviewTaskId,
    ).toBe("t#2");
  });

  it("names no leg once every one is resolved", () => {
    expect(
      nextUnresolvedLeg({
        planned: [{ reviewTaskId: "t", targets: [POST] }],
        gates: [{ reviewTaskId: "t", status: "resolved" }],
      }),
    ).toBeNull();
  });
});
