// cinatra#4146 — a failed allocation planning at /api/context-resolve is a
// refusal of its own, never a 200 without the token.
//
// Before this fix the resolve route swallowed a planner failure, recorded the
// request as a SUCCESS and answered 200 without `allocationToken` and
// `plannedRefs`. /api/context-finalize then refused the run with 422
// `allocation_token_required`, which names the caller for a fault that
// happened at resolve, and nothing in the logs told the two apart.
//
// These cases drive the REAL resolve and finalize route handlers. Only the
// planner is replaced (by one that throws, or by one that plans). Finalize's
// token check, the stable error codes and the observability module (its
// counters and its log lines) are the real ones. The run and slot derivation
// and the selection write are mocked as in the sibling route tests, because
// they need a database and an installed agent.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
const { getContextRouteCounterSnapshot, resetContextRouteCountersForTest } =
  await import("@/lib/artifacts/context-route-observability");

const RUN_ID = "run-4146";
const SLOT_ID = "draftContext";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const PLANNER_FAULT = "the installed OAS could not be read";

function slot(): AgentContextSlot {
  return {
    slotId: SLOT_ID,
    acceptedArtifactExtensions: ["@cinatra-ai/blog-idea-artifact"],
    selectionMode: "interactive",
    resolutionMode: "override",
    minItems: 1,
    maxItems: 1,
    readableOnly: true,
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

function resolveRequest(): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: RUN_ID,
      parentPackageName: PACKAGE,
      slotId: SLOT_ID,
    }),
  });
}

// The finalize body the context subflow sends: it always carries the token
// field, rendered from what resolve answered (an empty string when resolve
// answered no token).
function finalizeRequest(allocationToken: string): Request {
  return new Request("http://localhost/api/context-finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: RUN_ID,
      parentPackageName: PACKAGE,
      slotId: SLOT_ID,
      selectionMode: "interactive",
      allocationToken,
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
    }),
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetContextRouteCountersForTest();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  deriveContextRouteContext.mockResolvedValue({
    actor: { sub: "user-1", organizationId: "org-1" },
    run: { id: RUN_ID, orgId: "org-1", runBy: "user-1" },
    servedBy: "run_token",
    projectId: undefined,
    trustedPackageName: PACKAGE,
    trustedSlotPackageName: PACKAGE,
  });
  loadTrustedSlot.mockResolvedValue(slot());
  resolveCandidates.mockResolvedValue([candidate("a")]);
  finalizeContextSelectionPinsAtomic.mockReturnValue([{ selectionWritten: true }]);
});

afterEach(() => {
  warnSpy.mockRestore();
  debugSpy.mockRestore();
});

describe("cinatra#4146 — a failed allocation planning at /api/context-resolve", () => {
  it("answers 409 allocation_planning_failed, never a 200 without the token", async () => {
    planAllocationForGate.mockRejectedValue(new Error(PLANNER_FAULT));
    const res = await RESOLVE(resolveRequest());
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("allocation_planning_failed");
    expect(String(body.message)).toContain("could not be planned");
    expect(String(body.message)).toContain(PLANNER_FAULT);
    expect(body).not.toHaveProperty("allocationToken");
    expect(body).not.toHaveProperty("candidates");
  });

  it("logs the failure with the run id and the slot id and counts it as a failure, never as a success", async () => {
    planAllocationForGate.mockRejectedValue(new Error(PLANNER_FAULT));
    await RESOLVE(resolveRequest());
    const outcome = getContextRouteCounterSnapshot().outcome;
    expect(outcome["resolve.allocation_planning_failed"]).toBe(1);
    expect(outcome["resolve.ok"]).toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain("[context-route] rejected kind=resolve");
    expect(line).toContain("code=allocation_planning_failed");
    expect(line).toContain("status=409");
    expect(line).toContain(`run=${RUN_ID}`);
    expect(line).toContain(`slot=${SLOT_ID}`);
  });

  it("names the fault at resolve, so finalize's allocation_token_required is no longer its only trace", async () => {
    // The two routes driven as the context subflow drives them: finalize
    // carries whatever token resolve answered.
    planAllocationForGate.mockRejectedValue(new Error(PLANNER_FAULT));
    const resolved = await RESOLVE(resolveRequest());
    const body = (await resolved.json()) as Record<string, unknown>;
    const finalized = await FINALIZE(
      finalizeRequest(typeof body.allocationToken === "string" ? body.allocationToken : ""),
    );
    const outcome = getContextRouteCounterSnapshot().outcome;
    expect(resolved.status).toBe(409);
    expect(body.error).toBe("allocation_planning_failed");
    expect(outcome["resolve.allocation_planning_failed"]).toBe(1);
    expect(outcome["resolve.ok"]).toBeUndefined();
    // Finalize's own refusal of a missing token is unchanged, and it writes
    // nothing.
    expect(finalized.status).toBe(422);
    expect(((await finalized.json()) as Record<string, unknown>).error).toBe(
      "allocation_token_required",
    );
    expect(finalizeContextSelectionPinsAtomic).not.toHaveBeenCalled();
  });

  it("a normal planning still answers the token and the planned refs, and finalize with that token writes the selection", async () => {
    planAllocationForGate.mockResolvedValue({
      token: "ContextAllocationTokenV1.planned",
      allocation: {
        plannerVersion: "context-allocation-planner-v1",
        manifestDigest: "digest",
        slots: [{ slotId: SLOT_ID, refs: [candidate("a")] }],
      },
    });
    const resolved = await RESOLVE(resolveRequest());
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as Record<string, unknown>;
    expect(body.allocationToken).toBe("ContextAllocationTokenV1.planned");
    expect((body.plannedRefs as ContextCandidate[]).map((r) => r.artifactId)).toEqual(["a"]);

    const finalized = await FINALIZE(finalizeRequest(String(body.allocationToken)));
    expect(finalized.status).toBe(200);
    expect(await finalized.json()).toMatchObject({
      contextSlotBindings: [{ slotId: SLOT_ID }],
      wrote: true,
    });
    expect(finalizeContextSelectionPinsAtomic).toHaveBeenCalledTimes(1);
    const outcome = getContextRouteCounterSnapshot().outcome;
    expect(outcome["resolve.ok"]).toBe(1);
    expect(outcome["finalize.ok"]).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
