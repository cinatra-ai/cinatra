import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ContextCandidate } from "@/lib/artifacts/context-route-support";

vi.mock("server-only", () => ({}));

const deriveContextRouteContext = vi.fn();
const loadTrustedSlot = vi.fn();
const resolveCandidates = vi.fn();
const planAllocationForGate = vi.fn();
const finalizeContextSelectionPinsAtomic = vi.fn();

vi.mock("@/lib/artifacts/context-route-io", () => ({
  deriveContextRouteContext: (...a: unknown[]) => deriveContextRouteContext(...a),
  loadTrustedSlot: (...a: unknown[]) => loadTrustedSlot(...a),
  resolveCandidates: (...a: unknown[]) => resolveCandidates(...a),
  readInstalledOasForPackage: vi.fn(),
}));
vi.mock("@/lib/artifacts/context-allocation-gate", () => ({
  planAllocationForGate: (...a: unknown[]) => planAllocationForGate(...a),
  __clearContextAllocationGateCache: vi.fn(),
}));
vi.mock("@/lib/artifacts/context-selection-finalize", () => {
  class SelectionCoherenceError extends Error {}
  class MissingRepresentationError extends Error {}
  return {
    finalizeContextSelectionPinsAtomic: (...a: unknown[]) =>
      finalizeContextSelectionPinsAtomic(...a),
    SelectionCoherenceError,
    MissingRepresentationError,
  };
});
vi.mock("@/lib/artifacts/ensure-artifact-registry", () => ({
  ensureArtifactTypesRegistered: vi.fn(),
}));

const { POST: RESOLVE } = await import("@/app/api/context-resolve/route");
const { POST: FINALIZE } = await import("@/app/api/context-finalize/route");

const SLOT_ID = "draftContext";

function slot(over: Partial<AgentContextSlot> = {}): AgentContextSlot {
  return {
    slotId: SLOT_ID,
    acceptedArtifactExtensions: ["@cinatra-ai/blog-idea-artifact"],
    selectionMode: "interactive",
    resolutionMode: "override",
    minItems: 1,
    maxItems: 1,
    readableOnly: true,
    ...over,
  };
}

function candidate(id: string): ContextCandidate {
  return {
    artifactId: id,
    representationRevisionId: `${id}-rev`,
    semanticAssertionId: `${id}-sem`,
    extension: "@cinatra-ai/blog-idea-artifact",
    sourceScope: "user",
    ownerId: "user-1",
  };
}

function gateAllocation(token: string, refs: ContextCandidate[]) {
  return {
    token,
    allocation: {
      plannerVersion: "context-allocation-planner-v1",
      manifestDigest: "digest",
      slots: [{ slotId: SLOT_ID, refs }],
    },
  };
}

function resolveRequest(): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: "run-1",
      parentPackageName: "@cinatra-ai/blog-draft-writer-agent",
      slotId: SLOT_ID,
    }),
  });
}

function finalizeRequest(allocationToken?: string): Request {
  return new Request("http://localhost/api/context-finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: "run-1",
      parentPackageName: "@cinatra-ai/blog-draft-writer-agent",
      slotId: SLOT_ID,
      selectionMode: "interactive",
      userResponse: JSON.stringify({
        slotId: SLOT_ID,
        resolutionMode: "override",
        selectedRefs: [
          {
            artifactId: "a",
            representationRevisionId: "a-rev",
            semanticAssertionId: "a-sem",
          },
        ],
      }),
      ...(allocationToken ? { allocationToken } : {}),
    }),
  });
}

describe("cinatra#2815 S3 part 3 — the allocation token across resolve and finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deriveContextRouteContext.mockResolvedValue({
      actor: { sub: "user-1", organizationId: "org-1" },
      run: { id: "run-1", orgId: "org-1", runBy: "user-1" },
      servedBy: "run_token",
      projectId: undefined,
      trustedPackageName: "@cinatra-ai/blog-draft-writer-agent",
      trustedSlotPackageName: "@cinatra-ai/blog-draft-writer-agent",
    });
    loadTrustedSlot.mockResolvedValue(slot());
    resolveCandidates.mockResolvedValue([candidate("a")]);
    finalizeContextSelectionPinsAtomic.mockReturnValue([{ selectionWritten: true }]);
  });

  it("resolve returns the ContextAllocationTokenV1 and the slot's planned refs", async () => {
    planAllocationForGate.mockResolvedValue(
      gateAllocation("ContextAllocationTokenV1.abc", [candidate("a")]),
    );
    const res = await RESOLVE(resolveRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.allocationToken).toBe("ContextAllocationTokenV1.abc");
    expect((body.plannedRefs as ContextCandidate[]).map((r) => r.artifactId)).toEqual(["a"]);
  });

  it("resolve still serves its slot when the manifest cannot be planned — no token", async () => {
    planAllocationForGate.mockRejectedValue(new Error("oas unreadable"));
    const res = await RESOLVE(resolveRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.allocationToken).toBeUndefined();
    expect(body.candidates).toBeDefined();
  });

  it("the allocation is IDENTICAL at resolve and finalize — the finalize proceeds", async () => {
    planAllocationForGate.mockResolvedValue(
      gateAllocation("ContextAllocationTokenV1.same", [candidate("a")]),
    );
    const resolved = (await (await RESOLVE(resolveRequest())).json()) as {
      allocationToken: string;
    };
    const res = await FINALIZE(finalizeRequest(resolved.allocationToken));
    expect(res.status).toBe(200);
    expect(finalizeContextSelectionPinsAtomic).toHaveBeenCalledTimes(1);
  });

  it("drift between resolve and finalize is a structured conflict and writes NOTHING", async () => {
    planAllocationForGate.mockResolvedValue(
      gateAllocation("ContextAllocationTokenV1.moved", [candidate("a")]),
    );
    const res = await FINALIZE(finalizeRequest("ContextAllocationTokenV1.drawn"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("allocation_drift");
    expect(String(body.message)).toContain("ContextAllocationTokenV1.drawn");
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });

  it("a token that cannot be recomputed fails CLOSED under its own code", async () => {
    planAllocationForGate.mockRejectedValue(new Error("oas unreadable"));
    const res = await FINALIZE(finalizeRequest("ContextAllocationTokenV1.drawn"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "allocation_unavailable",
    );
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });

  it("a finalize carrying NO token never consults the planner (the landed path)", async () => {
    const res = await FINALIZE(finalizeRequest());
    expect(res.status).toBe(200);
    expect(planAllocationForGate).not.toHaveBeenCalled();
    expect(finalizeContextSelectionPinsAtomic).toHaveBeenCalledTimes(1);
  });
});
