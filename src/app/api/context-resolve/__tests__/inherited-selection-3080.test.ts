/**
 * THE SEAM THAT PARKED THE REPAIR (cinatra#3080), with the decision REAL.
 *
 * The child context flow asks this route one question and branches on the
 * answer: `selectionMode` "autonomous" takes the no-person road, anything else
 * opens the screen. A repair run whose producing run already answered the slot
 * must take the no-person road, and that road submits `plannedRefs`, so the
 * inherited answer has to come back as the planned set too.
 *
 * The route and the inheritance leaf are both real here; only the reads that
 * need bridge auth, an on-disk OAS, the manifest-wide planner and the audit
 * store are stood in for. A suite that mocked the leaf could not see the real
 * decision go the other way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ContextCandidate } from "@/lib/artifacts/context-route-support";

vi.mock("server-only", () => ({}));

const deriveContextRouteContext = vi.fn();
const loadTrustedSlot = vi.fn();
const resolveCandidates = vi.fn();
const planAllocationForGate = vi.fn();
const readRunContextSelectionsForRun = vi.fn();

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
// The audit store the producing run's answer was written to. The leaf reads it
// through this one function; everything else of the store is unused here.
vi.mock("@/lib/artifacts/run-context-selections-store", () => ({
  readRunContextSelectionsForRun: (...a: unknown[]) => readRunContextSelectionsForRun(...a),
}));

const { POST } = await import("../route");

const ORG = "org-3080";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const SLOT = "draftContext";
const PRODUCING_RUN = "producing-run-3080";
const TOKEN = "ContextAllocationTokenV1.resolve-3080";

function theOneSlot(over: Partial<AgentContextSlot> = {}): AgentContextSlot {
  return {
    slotId: SLOT,
    acceptedArtifactExtensions: ["@cinatra-ai/blog-idea-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
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

/** The repair run the dispatch drain mints: its source type, the delivered
 *  request it carries (base target included unless told otherwise) and the
 *  producing run it names. */
function repairRun(over: { baseTarget?: boolean } = {}) {
  return {
    id: "lifecycle-repair-run:r-3080",
    orgId: ORG,
    runBy: "user-1",
    sourceType: "lifecycle_repair",
    parentRunId: PRODUCING_RUN,
    inputParams: {
      lifecycleRepairRequest: {
        kind: "lifecycle_repair_request",
        repairId: "repair-3080",
        ...(over.baseTarget === false
          ? {}
          : {
              baseTarget: {
                artifactId: "art-produced",
                representationRevisionId: "rev-produced",
              },
            }),
      },
    },
  };
}

function ordinaryRun() {
  return {
    id: "run-ordinary",
    orgId: ORG,
    runBy: "user-1",
    sourceType: "agent_builder",
    parentRunId: null,
    inputParams: {},
  };
}

function auditRow(ref: ContextCandidate) {
  return {
    id: `rcs-${ref.artifactId}`,
    orgId: ORG,
    parentRunId: PRODUCING_RUN,
    parentPackageName: PACKAGE,
    slotId: SLOT,
    artifactId: ref.artifactId,
    representationRevisionId: ref.representationRevisionId,
    semanticAssertionId: ref.semanticAssertionId,
    extension: ref.extension,
    sourceScope: ref.sourceScope,
    selectedBy: "user",
    selectionMode: "interactive",
    selectedAt: "2026-10-14T10:00:00.000Z",
  };
}

function context(run: Record<string, unknown>) {
  deriveContextRouteContext.mockResolvedValue({
    actor: { sub: "user-1", organizationId: ORG },
    run,
    servedBy: "run_token",
    projectId: undefined,
    trustedPackageName: PACKAGE,
    trustedSlotPackageName: PACKAGE,
  });
}

function allocate(refs: ContextCandidate[]) {
  planAllocationForGate.mockResolvedValue({
    token: TOKEN,
    allocation: {
      plannerVersion: "context-allocation-planner-v1",
      manifestDigest: "digest",
      slots: [{ slotId: SLOT, refs }],
    },
  });
}

function resolveRequest(): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentRunId: "run",
      parentPackageName: PACKAGE,
      slotId: SLOT,
    }),
  });
}

type ResolveBody = {
  selectionMode: string;
  slotMeta: { selectionMode: string };
  selectedRefs: ContextCandidate[];
  plannedRefs: ContextCandidate[];
  allocationToken: string;
};

async function resolve(): Promise<ResolveBody> {
  const res = await POST(resolveRequest());
  expect(res.status).toBe(200);
  return (await res.json()) as ResolveBody;
}

const ids = (refs: ContextCandidate[]) => refs.map((r) => r.artifactId);

describe("/api/context-resolve — a repair inherits its producing run's answered slot (cinatra#3080)", () => {
  beforeEach(() => {
    for (const m of [
      deriveContextRouteContext,
      loadTrustedSlot,
      resolveCandidates,
      planAllocationForGate,
      readRunContextSelectionsForRun,
    ]) {
      m.mockReset();
    }
    loadTrustedSlot.mockResolvedValue(theOneSlot());
    resolveCandidates.mockResolvedValue([candidate("a"), candidate("b")]);
    allocate([candidate("a"), candidate("b")]);
    readRunContextSelectionsForRun.mockReturnValue([]);
  });

  it("S1 routes the repair around the screen when its producing run answered the one slot with nothing", async () => {
    context(repairRun());
    const body = await resolve();
    expect(body.selectionMode).toBe("autonomous");
    expect(body.slotMeta.selectionMode).toBe("autonomous");
    expect(body.selectedRefs).toEqual([]);
    expect(body.plannedRefs).toEqual([]);
    expect(body.allocationToken).toBe(TOKEN);
    expect(readRunContextSelectionsForRun).toHaveBeenCalledTimes(1);
    expect(readRunContextSelectionsForRun).toHaveBeenCalledWith({
      orgId: ORG,
      parentRunId: PRODUCING_RUN,
    });
  });

  it("S2 keeps the screen for an ordinary run of the very same slot", async () => {
    context(ordinaryRun());
    const body = await resolve();
    expect(body.selectionMode).toBe("interactive");
    expect(ids(body.plannedRefs)).toEqual(["a", "b"]);
  });

  it("S3 keeps the screen for a repair whose delivery names no base revision", async () => {
    context(repairRun({ baseTarget: false }));
    const body = await resolve();
    expect(body.selectionMode).toBe("interactive");
    expect(ids(body.plannedRefs)).toEqual(["a", "b"]);
  });

  it("S4 keeps the screen for a slot that requires items", async () => {
    loadTrustedSlot.mockResolvedValue(theOneSlot({ minItems: 1 }));
    context(repairRun());
    const body = await resolve();
    expect(body.selectionMode).toBe("interactive");
  });

  it("S5 hands back the producing run's audited pick as both the selection and the planned set, on the no-person branch", async () => {
    readRunContextSelectionsForRun.mockReturnValue([auditRow(candidate("a"))]);
    context(repairRun());
    const body = await resolve();
    expect(body.selectionMode).toBe("autonomous");
    expect(ids(body.selectedRefs)).toEqual(["a"]);
    expect(ids(body.plannedRefs)).toEqual(["a"]);
    expect(body.allocationToken).toBe(TOKEN);
  });

  it("S6 keeps the screen when the audited pick is in the pool but no longer in the slot's allocation", async () => {
    resolveCandidates.mockResolvedValue([candidate("a"), candidate("b"), candidate("c")]);
    readRunContextSelectionsForRun.mockReturnValue([auditRow(candidate("c"))]);
    context(repairRun());
    const body = await resolve();
    expect(body.selectionMode).toBe("interactive");
    expect(ids(body.plannedRefs)).toEqual(["a", "b"]);
  });
});
