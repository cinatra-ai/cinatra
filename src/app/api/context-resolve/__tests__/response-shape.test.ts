import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ContextCandidate } from "@/lib/artifacts/context-route-support";

vi.mock("server-only", () => ({}));

const deriveContextRouteContext = vi.fn();
const loadTrustedSlot = vi.fn();
const resolveCandidates = vi.fn();

vi.mock("@/lib/artifacts/context-route-io", () => ({
  deriveContextRouteContext: (...args: unknown[]) =>
    deriveContextRouteContext(...args),
  loadTrustedSlot: (...args: unknown[]) => loadTrustedSlot(...args),
  resolveCandidates: (...args: unknown[]) => resolveCandidates(...args),
}));

// Importing AFTER vi.mock so the route picks up the mocked module.
const { POST } = await import("../route");

function makeSlot(over: Partial<AgentContextSlot> = {}): AgentContextSlot {
  return {
    slotId: "draftContext",
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

function makeRequest(): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: "run-1",
      parentPackageName: "@cinatra-ai/blog-draft-writer-agent",
      slotId: "draftContext",
    }),
  });
}

describe("/api/context-resolve response shape", () => {
  beforeEach(() => {
    deriveContextRouteContext.mockReset();
    loadTrustedSlot.mockReset();
    resolveCandidates.mockReset();
    deriveContextRouteContext.mockResolvedValue({
      actor: { sub: "user-1", organizationId: "org-1" },
      projectId: undefined,
      trustedPackageName: "@cinatra-ai/blog-draft-writer-agent",
    });
  });

  // The context-selection-agent OAS REQUIRES top-level `selectionMode` and
  // `resolutionMode` on resolve_context's response so the BranchingNode
  // (select_mode) and the finalize_* DFEs can bind them. Without these the
  // /api/context-finalize call downstream fails Zod validation with
  // "selectionMode: Invalid option". If you change the response shape,
  // update the OAS too.
  it("interactive override slot: mirrors slotMeta.selectionMode + slotMeta.resolutionMode at top level", async () => {
    const slot = makeSlot({
      selectionMode: "interactive",
      resolutionMode: "override",
    });
    loadTrustedSlot.mockResolvedValue(slot);
    resolveCandidates.mockReturnValue([makeCandidate("a")]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      selectionMode: "interactive",
      resolutionMode: "override",
    });
    const slotMeta = body.slotMeta as Record<string, unknown>;
    expect(body.selectionMode).toBe(slotMeta.selectionMode);
    expect(body.resolutionMode).toBe(slotMeta.resolutionMode);
  });

  it("autonomous accumulate slot: mirrors slotMeta.selectionMode + slotMeta.resolutionMode at top level", async () => {
    const slot = makeSlot({
      selectionMode: "autonomous",
      resolutionMode: "accumulate",
      minItems: 0,
      maxItems: undefined,
    });
    loadTrustedSlot.mockResolvedValue(slot);
    resolveCandidates.mockReturnValue([
      makeCandidate("a"),
      makeCandidate("b"),
    ]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      selectionMode: "autonomous",
      resolutionMode: "accumulate",
    });
    const slotMeta = body.slotMeta as Record<string, unknown>;
    expect(body.selectionMode).toBe(slotMeta.selectionMode);
    expect(body.resolutionMode).toBe(slotMeta.resolutionMode);
  });

  it("response carries the full envelope: candidates + slotMeta + selectedRefs + selectionMode + resolutionMode", async () => {
    loadTrustedSlot.mockResolvedValue(makeSlot());
    resolveCandidates.mockReturnValue([makeCandidate("a")]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    for (const key of [
      "candidates",
      "slotMeta",
      "selectedRefs",
      "selectionMode",
      "resolutionMode",
    ]) {
      expect(body).toHaveProperty(key);
    }
  });
});
