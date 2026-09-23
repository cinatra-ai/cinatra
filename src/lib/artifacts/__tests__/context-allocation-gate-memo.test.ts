/**
 * ONE ALLOCATION PER GATE (cinatra#2815 S3 part 3).
 *
 * The gate memoizes the manifest-wide allocation so one human gate's several
 * callbacks do not each re-resolve every slot. Two things about that memo were
 * wrong, and both defeated the very token it was serving:
 *
 *   - it was keyed on the run, the package and the project alone, so a
 *     republished agent whose slot declaration moved was handed the PREVIOUS
 *     allocation and the previous TOKEN, and the drift the token exists to
 *     catch was hidden by the cache;
 *   - it stored completed values only, so two callbacks that missed together
 *     planned independently against a world that could move between their two
 *     reads, and answered differently for one gate.
 *
 * This suite pins the manifest digest as part of the gate's identity, one
 * shared computation under concurrency, the `fresh` recompute finalize asks
 * for, and that a failed computation is never the cached answer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";

vi.mock("server-only", () => ({}));

const readInstalledOasForPackage = vi.fn();
const resolveCandidates = vi.fn();
const readAgentContextSlotsFromOas = vi.fn();

vi.mock("@/lib/artifacts/context-route-io", () => ({
  readInstalledOasForPackage: (...a: unknown[]) => readInstalledOasForPackage(...a),
  resolveCandidates: (...a: unknown[]) => resolveCandidates(...a),
}));
vi.mock("@cinatra-ai/extensions/agent-context-slots-reader", () => ({
  readAgentContextSlotsFromOas: (...a: unknown[]) => readAgentContextSlotsFromOas(...a),
}));

const { planAllocationForGate, __clearContextAllocationGateCache } = await import(
  "@/lib/artifacts/context-allocation-gate"
);

const SLOT_ID = "draftContext";

function slot(over: Partial<AgentContextSlot> = {}): AgentContextSlot {
  return {
    slotId: SLOT_ID,
    acceptedArtifactExtensions: ["@cinatra-ai/blog-idea-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 3,
    readableOnly: true,
    ...over,
  };
}

function candidate(id: string) {
  return {
    artifactId: id,
    representationRevisionId: `${id}-rev`,
    semanticAssertionId: `${id}-sem`,
    extension: "@cinatra-ai/blog-idea-artifact",
    sourceScope: "user",
    ownerId: "user-1",
  };
}

const GATE = {
  actor: { organizationId: "org-1" } as never,
  runId: "run-1",
  trustedSlotPackageName: "@cinatra-ai/blog-draft-writer-agent",
  projectId: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  __clearContextAllocationGateCache();
  readInstalledOasForPackage.mockResolvedValue({});
  readAgentContextSlotsFromOas.mockReturnValue([slot()]);
  resolveCandidates.mockResolvedValue([candidate("a")]);
});

describe("the manifest digest is part of the gate's identity", () => {
  it("serves the memo while the declaration is unchanged", async () => {
    const first = await planAllocationForGate(GATE);
    const second = await planAllocationForGate(GATE);
    expect(second.token).toBe(first.token);
    expect(resolveCandidates).toHaveBeenCalledTimes(1);
  });

  it("MISSES when a slot's bounds change, and the token changes with them", async () => {
    const first = await planAllocationForGate(GATE);
    // Same run, same package, same project, same second. Only the manifest moved.
    readAgentContextSlotsFromOas.mockReturnValue([slot({ minItems: 2, maxItems: 2 })]);
    const second = await planAllocationForGate(GATE);
    expect(second.token).not.toBe(first.token);
    expect(resolveCandidates).toHaveBeenCalledTimes(2);
  });
});

describe("concurrency", () => {
  it("two callbacks that miss together share ONE computation and ONE answer", async () => {
    // The candidates move between the two reads. Without a shared in-flight
    // computation the second caller would plan against the newer world and the
    // one gate would have two allocations.
    let call = 0;
    resolveCandidates.mockImplementation(async () => {
      call += 1;
      return [candidate(call === 1 ? "a" : "b")];
    });
    const [one, two] = await Promise.all([
      planAllocationForGate(GATE),
      planAllocationForGate(GATE),
    ]);
    expect(two.token).toBe(one.token);
    expect(one.allocation.slots[0].refs.map((r) => r.artifactId)).toEqual(["a"]);
    expect(two.allocation.slots[0].refs.map((r) => r.artifactId)).toEqual(["a"]);
    expect(call).toBe(1);
  });
});

describe("the fresh recompute finalize asks for", () => {
  it("ignores the memo and plans against the world as it is now", async () => {
    const drawn = await planAllocationForGate(GATE);
    resolveCandidates.mockResolvedValue([candidate("b")]);
    const now = await planAllocationForGate(GATE, { fresh: true });
    expect(now.token).not.toBe(drawn.token);
    expect(now.allocation.slots[0].refs.map((r) => r.artifactId)).toEqual(["b"]);
  });

  it("replaces the entry, so a later callback reads the newer world", async () => {
    await planAllocationForGate(GATE);
    resolveCandidates.mockResolvedValue([candidate("b")]);
    const fresh = await planAllocationForGate(GATE, { fresh: true });
    const later = await planAllocationForGate(GATE);
    expect(later.token).toBe(fresh.token);
  });
});

describe("a failure is never the cached answer", () => {
  it("evicts a rejected computation so the next call tries again", async () => {
    resolveCandidates.mockRejectedValueOnce(new Error("resolver down"));
    await expect(planAllocationForGate(GATE)).rejects.toThrow("resolver down");
    resolveCandidates.mockResolvedValue([candidate("a")]);
    const ok = await planAllocationForGate(GATE);
    expect(ok.allocation.slots[0].refs.map((r) => r.artifactId)).toEqual(["a"]);
  });
});
