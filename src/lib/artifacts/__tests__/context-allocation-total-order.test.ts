/**
 * THE ALLOCATION IS A PURE FUNCTION OF THE DATA (cinatra#2815 S3 part 3).
 *
 * The token exists to detect that the world MOVED between a gate being drawn
 * and a person answering it. That only works if unchanged data always plans the
 * same allocation. One artifact can carry two eligible assertions from two
 * accepted extensions; both land at the same ownership tier and the same
 * artifact id, so the resolver's comparator ranked them EQUAL and the database
 * returned them in whatever order the plan produced. An override slot then took
 * whichever happened to be first, and a finalize that re-planned could take the
 * other one, reporting drift against data nobody touched.
 *
 * The order must be TOTAL: a unique column breaks every remaining tie.
 */
import { describe, expect, it } from "vitest";
import {
  planContextAllocation,
  computeContextAllocationToken,
  type PlannerCandidate,
} from "@/lib/artifacts/context-allocation-planner";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";

function slot(over: Partial<AgentContextSlot> = {}): AgentContextSlot {
  return {
    slotId: "ctx",
    acceptedArtifactExtensions: ["@cinatra-ai/a-artifact", "@cinatra-ai/b-artifact"],
    selectionMode: "interactive",
    resolutionMode: "override",
    minItems: 0,
    readableOnly: true,
    ...over,
  };
}

/** Two assertions on ONE artifact, at one tier, from two accepted extensions.
 *  Every field the old comparator looked at is identical. */
const TIED: PlannerCandidate[] = [
  {
    artifactId: "art-1",
    representationRevisionId: "rev-1",
    semanticAssertionId: "sem-a",
    extension: "@cinatra-ai/a-artifact",
    sourceScope: "user",
    ownerId: "user-1",
  },
  {
    artifactId: "art-1",
    representationRevisionId: "rev-1",
    semanticAssertionId: "sem-b",
    extension: "@cinatra-ai/b-artifact",
    sourceScope: "user",
    ownerId: "user-1",
  },
];

describe("two tied rows plan the same way whichever order they arrive in", () => {
  it("the override collapse picks the same assertion", () => {
    const forward = planContextAllocation([{ slot: slot(), candidates: [...TIED] }]);
    const reversed = planContextAllocation([{ slot: slot(), candidates: [...TIED].reverse() }]);
    expect(reversed.slots[0].refs.map((r) => r.semanticAssertionId)).toEqual(
      forward.slots[0].refs.map((r) => r.semanticAssertionId),
    );
  });

  it("and the token is the same, so no false drift is reported", () => {
    const forward = planContextAllocation([{ slot: slot(), candidates: [...TIED] }]);
    const reversed = planContextAllocation([{ slot: slot(), candidates: [...TIED].reverse() }]);
    expect(computeContextAllocationToken(reversed)).toBe(
      computeContextAllocationToken(forward),
    );
  });

  it("an accumulate slot lists them in the same order too", () => {
    const acc = slot({ resolutionMode: "accumulate" });
    const forward = planContextAllocation([{ slot: acc, candidates: [...TIED] }]);
    const reversed = planContextAllocation([{ slot: acc, candidates: [...TIED].reverse() }]);
    expect(reversed.slots[0].refs.map((r) => r.semanticAssertionId)).toEqual(
      forward.slots[0].refs.map((r) => r.semanticAssertionId),
    );
  });

  it("keeps the narrow-to-broad order the resolver decided", () => {
    // The tiebreak may only order rows that are otherwise equal. A narrower
    // scope still leads, whatever the assertion ids sort like.
    const broad = { ...TIED[0], semanticAssertionId: "sem-a", sourceScope: "organization" as const };
    const narrow = { ...TIED[1], semanticAssertionId: "sem-z", sourceScope: "project" as const };
    const acc = slot({ resolutionMode: "accumulate" });
    const out = planContextAllocation([{ slot: acc, candidates: [broad, narrow] }]);
    expect(out.slots[0].refs.map((r) => r.semanticAssertionId)).toEqual(["sem-z", "sem-a"]);
  });
});
