/**
 * AN INHERITED SELECTION IS THE INHERITED SELECTION (cinatra#3080).
 *
 * A repair that inherits its producing run's answered context screen runs the
 * slot on the child flow's no-person branch. That branch is the one road into
 * this route that a person does not stand on, so what it may write has to be
 * pinned: the refs it finalizes are the refs the producing run answered, and
 * the audit row it appends says what the producing run's own row said about
 * who chose. Nothing a caller puts in the body makes a run a repair, and
 * nothing in the body may steer the answer it inherits.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ContextCandidate } from "@/lib/artifacts/context-route-support";

vi.mock("server-only", () => ({}));

const deriveContextRouteContext = vi.fn();
const loadTrustedSlot = vi.fn();
const resolveCandidates = vi.fn();
const resolveInheritedContextSelection = vi.fn();
const finalizeContextSelectionPinsAtomic = vi.fn();
const planAllocationForGate = vi.fn();

vi.mock("@/lib/artifacts/context-route-io", () => ({
  deriveContextRouteContext: (...a: unknown[]) => deriveContextRouteContext(...a),
  loadTrustedSlot: (...a: unknown[]) => loadTrustedSlot(...a),
  resolveCandidates: (...a: unknown[]) => resolveCandidates(...a),
  readInstalledOasForPackage: vi.fn(),
}));

// The finalize validates against the manifest-wide ALLOCATION its token names
// (cinatra#2815 S3 part 3); the allocation is stood in for exactly as the
// allocation-token test of this folder stands it in.
vi.mock("@/lib/artifacts/context-allocation-gate", () => ({
  planAllocationForGate: (...a: unknown[]) => planAllocationForGate(...a),
  __clearContextAllocationGateCache: vi.fn(),
}));

// The leaf's OWN decision has its own store-level suite against a real
// Postgres; here it is the route's use of that decision that is under test.
vi.mock("@/lib/artifacts/context-repair-inheritance", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveInheritedContextSelection: (...a: unknown[]) =>
      resolveInheritedContextSelection(...a),
  };
});

vi.mock("@/lib/artifacts/context-selection-finalize", () => ({
  finalizeContextSelectionPinsAtomic: (...a: unknown[]) =>
    finalizeContextSelectionPinsAtomic(...a),
  MissingRepresentationError: class MissingRepresentationError extends Error {},
  SelectionCoherenceError: class SelectionCoherenceError extends Error {},
}));

vi.mock("@/lib/artifacts/ensure-artifact-registry", () => ({
  ensureArtifactTypesRegistered: () => undefined,
}));

const { POST } = await import("../route");

const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const SLOT = "draftContext";

function makeSlot(over: Partial<AgentContextSlot> = {}): AgentContextSlot {
  return {
    slotId: SLOT,
    acceptedArtifactExtensions: ["@cinatra-ai/blog-idea-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 1,
    maxItems: 2,
    readableOnly: true,
    ...over,
  };
}

function makeCandidate(id: string): ContextCandidate {
  return {
    artifactId: id,
    representationRevisionId: `${id}-rev`,
    semanticAssertionId: `${id}-sem`,
    extension: "@cinatra-ai/blog-idea-artifact",
    sourceScope: "user",
    ownerId: "user-1",
  };
}

function request(input: {
  selectionMode: "interactive" | "autonomous";
  refs: ContextCandidate[];
}): Request {
  return new Request("http://localhost/api/context-finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: "lifecycle-repair-run:r-1",
      parentPackageName: PACKAGE,
      slotId: SLOT,
      selectionMode: input.selectionMode,
      allocationToken: TOKEN,
      userResponse: JSON.stringify({
        slotId: SLOT,
        resolutionMode: "accumulate",
        selectedRefs: input.refs.map((r) => ({
          artifactId: r.artifactId,
          representationRevisionId: r.representationRevisionId,
          semanticAssertionId: r.semanticAssertionId,
        })),
      }),
    }),
  });
}

const answeredRef = makeCandidate("a");
const otherRef = makeCandidate("b");
const TOKEN = "ContextAllocationTokenV1.repair";

describe("/api/context-finalize — a repair's inherited selection", () => {
  beforeEach(() => {
    for (const m of [
      deriveContextRouteContext,
      loadTrustedSlot,
      resolveCandidates,
      resolveInheritedContextSelection,
      finalizeContextSelectionPinsAtomic,
      planAllocationForGate,
    ]) {
      m.mockReset();
    }
    deriveContextRouteContext.mockResolvedValue({
      actor: { sub: "user-1", organizationId: "org-1" },
      run: { id: "lifecycle-repair-run:r-1", orgId: "org-1", runBy: "user-1" },
      servedBy: "context_id",
      projectId: undefined,
      trustedPackageName: PACKAGE,
      trustedSlotPackageName: PACKAGE,
    });
    loadTrustedSlot.mockResolvedValue(makeSlot());
    // The trusted set holds BOTH: the ref the producing run answered, and one
    // it did not. Both are eligible for this actor — membership alone is not
    // what makes the inherited answer the answer.
    resolveCandidates.mockReturnValue([answeredRef, otherRef]);
    finalizeContextSelectionPinsAtomic.mockReturnValue([{ selectionWritten: true }]);
    // Both refs are ALLOCATED to the slot: allocation alone is not what makes
    // the inherited answer the answer.
    planAllocationForGate.mockResolvedValue({
      token: TOKEN,
      allocation: {
        plannerVersion: "context-allocation-planner-v1",
        manifestDigest: "digest",
        slots: [{ slotId: SLOT, refs: [answeredRef, otherRef] }],
      },
    });
  });

  it("writes the answer the producing run gave, with the provenance that run recorded", async () => {
    resolveInheritedContextSelection.mockReturnValue({
      refs: [answeredRef],
      selectedBy: "user",
    });

    const res = await POST(
      request({ selectionMode: "autonomous", refs: [answeredRef] }),
    );
    expect(res.status).toBe(200);

    const written = finalizeContextSelectionPinsAtomic.mock.calls[0]![0] as Array<{
      selection: { selectedBy: string; selectionMode: string; artifactId: string };
    }>;
    expect(written).toHaveLength(1);
    // No person stood in THIS run — the mode says so…
    expect(written[0]!.selection.selectionMode).toBe("autonomous");
    // …and the audit still names who actually chose, on the producing run.
    expect(written[0]!.selection.selectedBy).toBe("user");
    expect(written[0]!.selection.artifactId).toBe(answeredRef.artifactId);
    // The same transaction records the WHOLE answer, with the same provenance.
    expect(finalizeContextSelectionPinsAtomic.mock.calls[0]![1]).toEqual({
      orgId: "org-1",
      parentRunId: "lifecycle-repair-run:r-1",
      parentPackageName: PACKAGE,
      slotId: SLOT,
      selectionMode: "autonomous",
      selectedBy: "user",
    });
  });

  it("records an answer of NOTHING as an answer: an empty selection still hands finalize the slot's whole answer", async () => {
    // An ordinary run whose slot admits emptiness, answered with nothing: no
    // audit row is written, and the answer is still recorded — the one trace
    // a later repair can read it from.
    loadTrustedSlot.mockResolvedValue(makeSlot({ minItems: 0 }));
    resolveInheritedContextSelection.mockReturnValue(null);
    finalizeContextSelectionPinsAtomic.mockReturnValue([]);

    const res = await POST(request({ selectionMode: "interactive", refs: [] }));
    expect(res.status).toBe(200);
    expect(finalizeContextSelectionPinsAtomic).toHaveBeenCalledTimes(1);
    expect(finalizeContextSelectionPinsAtomic.mock.calls[0]![0]).toEqual([]);
    expect(finalizeContextSelectionPinsAtomic.mock.calls[0]![1]).toEqual({
      orgId: "org-1",
      parentRunId: "lifecycle-repair-run:r-1",
      parentPackageName: PACKAGE,
      slotId: SLOT,
      selectionMode: "interactive",
      selectedBy: "user",
    });
  });

  it("repeats a resolver's pick as a resolver's — an inherited choice is never promoted to a person's", async () => {
    resolveInheritedContextSelection.mockReturnValue({
      refs: [answeredRef],
      selectedBy: "autonomous",
    });

    const res = await POST(
      request({ selectionMode: "autonomous", refs: [answeredRef] }),
    );
    expect(res.status).toBe(200);
    const written = finalizeContextSelectionPinsAtomic.mock.calls[0]![0] as Array<{
      selection: { selectedBy: string };
    }>;
    expect(written[0]!.selection.selectedBy).toBe("autonomous");
    expect(
      (finalizeContextSelectionPinsAtomic.mock.calls[0]![1] as { selectedBy: string }).selectedBy,
    ).toBe("autonomous");
  });

  it("refuses a submission that is not the answer it claims to have inherited, and writes NOTHING", async () => {
    resolveInheritedContextSelection.mockReturnValue({
      refs: [answeredRef],
      selectedBy: "user",
    });

    // Eligible for this actor, and still not what the producing run answered.
    const res = await POST(
      request({ selectionMode: "autonomous", refs: [otherRef] }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("inherited_selection_mismatch");
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });

  it("still refuses an ORDINARY run that merely claims the no-person mode", async () => {
    // Nothing a caller can say makes a run a repair holding a stored answer.
    resolveInheritedContextSelection.mockReturnValue(null);

    const res = await POST(
      request({ selectionMode: "autonomous", refs: [answeredRef] }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("selection_mode_mismatch");
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });

  it("hands the leaf the slot's ALLOCATION, never the candidate pool", async () => {
    resolveInheritedContextSelection.mockReturnValue(null);

    const res = await POST(
      request({ selectionMode: "interactive", refs: [answeredRef] }),
    );
    expect(res.status).toBe(200);
    expect(resolveInheritedContextSelection).toHaveBeenCalledTimes(1);
    const arg = resolveInheritedContextSelection.mock.calls[0]![0] as {
      candidates: ContextCandidate[];
    };
    expect(arg.candidates.map((c) => c.artifactId)).toEqual([
      answeredRef.artifactId,
      otherRef.artifactId,
    ]);
    expect(resolveCandidates).not.toHaveBeenCalled();
  });
});
