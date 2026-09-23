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

describe("the gate plans over the FULL eligible pool", () => {
  it("asks the resolver not to truncate, because the cap belongs after the dedupe", async () => {
    // Each slot's resolver used to cut to maxItems BEFORE the manifest-wide
    // dedupe ran, so a later slot could end EMPTY where the full pool would
    // have filled it: the first slot takes `a`, the second is eligible for
    // [a, b] with maxItems 1, its resolver keeps only `a`, the dedupe removes
    // it, and nothing is left. Planning the full pool yields [b].
    await planAllocationForGate(GATE);
    for (const call of resolveCandidates.mock.calls) {
      expect((call[0] as { applyMaxItems?: boolean }).applyMaxItems).toBe(false);
    }
  });

  it("fills a later slot from the pool the earlier slot did not claim", async () => {
    const first = slot({ slotId: "first", maxItems: 1 });
    const second = slot({ slotId: "second", maxItems: 1, minItems: 0 });
    readAgentContextSlotsFromOas.mockReturnValue([first, second]);
    resolveCandidates.mockImplementation(async (input: { slot: { slotId: string } }) =>
      input.slot.slotId === "first" ? [candidate("a")] : [candidate("a"), candidate("b")],
    );
    const gate = await planAllocationForGate(GATE);
    const refs = gate.allocation.slots.map((s) => s.refs.map((r) => r.artifactId));
    expect(refs).toEqual([["a"], ["b"]]);
  });
});

describe("refreshing one entry does not evict an unrelated gate", () => {
  it("replaces in place, because a replacement needs no extra capacity", async () => {
    // A `fresh` recompute of a key the cache ALREADY holds is a REPLACEMENT.
    // Evicting the oldest entry to make room for it throws away another gate's
    // allocation for nothing, and the next ordinary callback for that gate then
    // starts a second computation instead of reading the one already there.
    const CAPACITY = 200;
    for (let i = 0; i < CAPACITY; i += 1) {
      await planAllocationForGate({ ...GATE, runId: `run-${i}` });
    }
    const afterFill = resolveCandidates.mock.calls.length;
    // Refresh one entry the cache already holds. The oldest is `run-0`.
    await planAllocationForGate({ ...GATE, runId: "run-100" }, { fresh: true });
    // ...and the oldest must still be memoized.
    await planAllocationForGate({ ...GATE, runId: "run-0" });
    expect(resolveCandidates.mock.calls.length).toBe(afterFill + 1);
  });
});
