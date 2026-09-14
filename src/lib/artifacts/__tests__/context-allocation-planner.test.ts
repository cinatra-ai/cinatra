import { describe, it, expect } from "vitest";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import {
  CONTEXT_ALLOCATION_PLANNER_VERSION,
  CONTEXT_ALLOCATION_TOKEN_VERSION,
  ContextAllocationDriftError,
  allocationForSlot,
  compareAllocationTokens,
  computeContextAllocationToken,
  computeContextManifestDigest,
  planContextAllocation,
  type PlannerCandidate,
} from "../context-allocation-planner";

// ---------------------------------------------------------------------------
// cinatra#2815 S3 part (3): ONE deterministic manifest-wide allocation per
// call, carried by a content-addressed ContextAllocationTokenV1.
// ---------------------------------------------------------------------------

const slot = (over: Partial<AgentContextSlot> & { slotId: string }): AgentContextSlot => ({
  acceptedArtifactExtensions: ["@cinatra-ai/x"],
  selectionMode: "interactive",
  resolutionMode: "accumulate",
  ...over,
});

const ref = (
  id: string,
  sourceScope: PlannerCandidate["sourceScope"],
  layer?: "assigned" | "ambient",
): PlannerCandidate => ({
  artifactId: id,
  representationRevisionId: `${id}-rev`,
  semanticAssertionId: `${id}-sem`,
  extension: "@cinatra-ai/x",
  sourceScope,
  ownerId: `owner-${id}`,
  ...(layer ? { layer } : {}),
});

describe("manifest-wide context allocation planner", () => {
  it("override picks the FIRST ref in the landed chain", () => {
    // The resolver hands candidates narrow -> broad (project < user < team <
    // organization < workspace). Override collapses to the FIRST of that chain.
    const plan = planContextAllocation([
      {
        slot: slot({ slotId: "icp", resolutionMode: "override" }),
        candidates: [
          ref("a", "project"),
          ref("b", "user"),
          ref("c", "organization"),
        ],
      },
    ]);
    expect(allocationForSlot(plan, "icp")?.refs.map((r) => r.artifactId)).toEqual(["a"]);
  });

  it("puts the assigned layer above ambient and applies maxItems AFTER the merge", () => {
    const plan = planContextAllocation([
      {
        slot: slot({ slotId: "voice", maxItems: 2 }),
        candidates: [
          ref("amb1", "project", "ambient"),
          ref("amb2", "user", "ambient"),
          ref("asg1", "organization", "assigned"),
          ref("asg2", "workspace", "assigned"),
        ],
      },
    ]);
    // Assigned first, then the cap trims the ambient tail — never an assigned ref.
    expect(allocationForSlot(plan, "voice")?.refs.map((r) => r.artifactId)).toEqual([
      "asg1",
      "asg2",
    ]);
  });

  it("dedupes a ref across slots, and minItems BEATS the dedupe", () => {
    const shared = ref("shared", "organization");
    const plan = planContextAllocation([
      { slot: slot({ slotId: "first" }), candidates: [shared, ref("only-first", "user")] },
      { slot: slot({ slotId: "second", minItems: 1 }), candidates: [shared] },
      { slot: slot({ slotId: "third" }), candidates: [shared] },
    ]);
    expect(allocationForSlot(plan, "first")?.refs.map((r) => r.artifactId)).toEqual([
      "shared",
      "only-first",
    ]);
    // `second` would be emptied by the dedupe, but its minItems of 1 wins.
    expect(allocationForSlot(plan, "second")?.refs.map((r) => r.artifactId)).toEqual([
      "shared",
    ]);
    // `third` declares no minItems, so the dedupe stands.
    expect(allocationForSlot(plan, "third")?.refs).toEqual([]);
  });

  it("the token is a versioned, content-addressed pure function of the allocation", () => {
    const inputs = [
      { slot: slot({ slotId: "a" }), candidates: [ref("r1", "user")] },
      { slot: slot({ slotId: "b" }), candidates: [ref("r2", "team")] },
    ];
    const one = computeContextAllocationToken(planContextAllocation(inputs));
    const two = computeContextAllocationToken(planContextAllocation(inputs));
    expect(one).toBe(two);
    expect(one.startsWith(`${CONTEXT_ALLOCATION_TOKEN_VERSION}.`)).toBe(true);
    // base64url alphabet only — no padding, no "+" or "/".
    expect(one.slice(CONTEXT_ALLOCATION_TOKEN_VERSION.length + 1)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(planContextAllocation(inputs).plannerVersion).toBe(
      CONTEXT_ALLOCATION_PLANNER_VERSION,
    );
    // A different allocation is a different token.
    const other = computeContextAllocationToken(
      planContextAllocation([
        { slot: slot({ slotId: "a" }), candidates: [ref("r9", "user")] },
        { slot: slot({ slotId: "b" }), candidates: [ref("r2", "team")] },
      ]),
    );
    expect(other).not.toBe(one);
  });

  it("the manifest digest covers the declared slot shape, not the candidates", () => {
    const slots = [slot({ slotId: "a", minItems: 1 }), slot({ slotId: "b" })];
    expect(computeContextManifestDigest(slots)).toBe(computeContextManifestDigest(slots));
    expect(computeContextManifestDigest(slots)).not.toBe(
      computeContextManifestDigest([slot({ slotId: "a", minItems: 2 }), slot({ slotId: "b" })]),
    );
  });

  it("allocations are identical at resolve and finalize; drift raises a structured conflict", () => {
    const inputs = [
      { slot: slot({ slotId: "icp", resolutionMode: "override" as const }), candidates: [ref("a", "project")] },
      { slot: slot({ slotId: "voice" }), candidates: [ref("b", "user")] },
    ];
    const atResolve = computeContextAllocationToken(planContextAllocation(inputs));
    const atFinalize = computeContextAllocationToken(planContextAllocation(inputs));
    expect(compareAllocationTokens(atResolve, atFinalize)).toEqual({ ok: true });

    // A candidate disappeared between the gate's resolve and its finalize.
    const drifted = computeContextAllocationToken(
      planContextAllocation([
        { slot: slot({ slotId: "icp", resolutionMode: "override" as const }), candidates: [] },
        { slot: slot({ slotId: "voice" }), candidates: [ref("b", "user")] },
      ]),
    );
    const verdict = compareAllocationTokens(atResolve, drifted);
    expect(verdict.ok).toBe(false);
    expect(() => {
      if (!verdict.ok) throw new ContextAllocationDriftError(atResolve, drifted);
    }).toThrow(ContextAllocationDriftError);
    const err = new ContextAllocationDriftError(atResolve, drifted);
    expect(err.code).toBe("allocation_drift");
    expect(err.expectedToken).toBe(atResolve);
    expect(err.actualToken).toBe(drifted);
  });

  it("an empty manifest plans to an empty, still-tokenizable allocation", () => {
    const plan = planContextAllocation([]);
    expect(plan.slots).toEqual([]);
    expect(typeof computeContextAllocationToken(plan)).toBe("string");
  });
});
