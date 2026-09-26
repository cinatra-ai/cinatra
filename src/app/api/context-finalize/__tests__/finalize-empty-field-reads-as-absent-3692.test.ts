/**
 * AN EMPTY ALLOCATION FIELD READS AS ABSENT AT FINALIZE (cinatra#3692).
 *
 * A context subflow renders its finalize body from a template, so when resolve
 * could not plan (and returned no allocation token) the rendered field is the
 * EMPTY STRING, not an omitted one. The body schema used to refuse that empty
 * string as a shapeless `invalid_body` (400) before the route could say what was
 * actually wrong. The empty field now reads as absent, so the refusal is the
 * actionable `allocation_token_required` (422) an omitted field already gets —
 * and a field of the wrong type is still a body error.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("server-only", () => ({}));

const deriveContextRouteContext = vi.fn();
const loadTrustedSlot = vi.fn();
const planAllocationForGate = vi.fn();
const finalizeContextSelectionPinsAtomic = vi.fn();

vi.mock("@/lib/artifacts/context-route-io", () => ({
  deriveContextRouteContext: (...a: unknown[]) => deriveContextRouteContext(...a),
  loadTrustedSlot: (...a: unknown[]) => loadTrustedSlot(...a),
  resolveCandidates: vi.fn(),
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

const { POST: FINALIZE } = await import("@/app/api/context-finalize/route");

const SLOT_ID = "draftContext";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

/** A finalize body; `field` is spread as given, so a case can send "", 42 or nothing. */
function finalizeRequest(field: Record<string, unknown>): Request {
  return new Request("http://localhost/api/context-finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: "run-1",
      parentPackageName: PACKAGE,
      slotId: SLOT_ID,
      selectionMode: "interactive",
      userResponse: JSON.stringify({
        slotId: SLOT_ID,
        resolutionMode: "override",
        selectedRefs: [
          { artifactId: "a", representationRevisionId: "a-rev", semanticAssertionId: "a-sem" },
        ],
      }),
      ...field,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deriveContextRouteContext.mockResolvedValue({
    actor: { sub: "user-1", organizationId: "org-1" },
    run: { id: "run-1", orgId: "org-1", runBy: "user-1" },
    servedBy: "run_token",
    projectId: undefined,
    trustedPackageName: PACKAGE,
    trustedSlotPackageName: PACKAGE,
  });
  loadTrustedSlot.mockResolvedValue({
    slotId: SLOT_ID,
    acceptedArtifactExtensions: ["@cinatra-ai/blog-idea-artifact"],
    selectionMode: "interactive",
    resolutionMode: "override",
    minItems: 1,
    maxItems: 1,
    readableOnly: true,
  });
  finalizeContextSelectionPinsAtomic.mockReturnValue([{ selectionWritten: true }]);
});

afterAll(() => {
  vi.clearAllMocks();
  for (const path of [
    "server-only",
    "@/lib/artifacts/context-route-io",
    "@/lib/artifacts/context-allocation-gate",
    "@/lib/artifacts/context-selection-finalize",
    "@/lib/artifacts/ensure-artifact-registry",
  ]) {
    vi.doUnmock(path);
  }
  vi.resetModules();
});

describe("finalize reads an empty allocation field as absent (cinatra#3692)", () => {
  it("R4 an EMPTY field is refused as allocation_token_required (422), never invalid_body, and writes nothing", async () => {
    const res = await FINALIZE(finalizeRequest({ allocationToken: "" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("allocation_token_required");
    expect(res.status).toBe(422);
    expect(planAllocationForGate).not.toHaveBeenCalled();
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });

  it("P3 a field of the wrong type is still a body error (400 invalid_body)", async () => {
    const res = await FINALIZE(finalizeRequest({ allocationToken: 42 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_body");
    expect(deriveContextRouteContext).not.toHaveBeenCalled();
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });

  it("P4 an OMITTED field stays allocation_token_required (422)", async () => {
    const res = await FINALIZE(finalizeRequest({}));
    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "allocation_token_required",
    );
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });
});
