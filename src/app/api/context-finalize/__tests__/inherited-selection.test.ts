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

vi.mock("@/lib/artifacts/context-route-io", () => ({
  deriveContextRouteContext: (...a: unknown[]) => deriveContextRouteContext(...a),
  loadTrustedSlot: (...a: unknown[]) => loadTrustedSlot(...a),
  resolveCandidates: (...a: unknown[]) => resolveCandidates(...a),
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
    resolutionMode: "override",
    minItems: 1,
    maxItems: 1,
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
      userResponse: JSON.stringify({
        slotId: SLOT,
        resolutionMode: "override",
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

describe("/api/context-finalize — a repair's inherited selection", () => {
  beforeEach(() => {
    for (const m of [
      deriveContextRouteContext,
      loadTrustedSlot,
      resolveCandidates,
      resolveInheritedContextSelection,
      finalizeContextSelectionPinsAtomic,
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
});
