/**
 * Deterministic `artifact_materialize` tool path (cinatra#925) unit tests —
 * `materializeToolArtifact` shares the write core + idempotency ledger with
 * the #923 run-completion path; here we pin the tool-specific contract:
 * fail-closed produces parity, ledger identity (`path:'materialize_tool'`,
 * output_id = the calling node id), and the concurrent-loser recovery.
 *
 *   npx vitest run src/lib/artifacts/__tests__/materialize-tool-artifact.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  poolQueryMock,
  getAgentPackageMock,
  listArtifactsMock,
  registerAllObjectTypesMock,
  createSemanticArtifactMock,
  claimMaterializationMock,
  buildFinalizeMaterializationQueryMock,
  readFinalizedMaterializationMock,
  isWriteAllowedMock,
  resolveBoundArtifactTargetMock,
  enqueueArtifactMatchRunMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getAgentPackageMock: vi.fn(),
  listArtifactsMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(() => ({
    text: "UPDATE finalize",
    values: [],
  })),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  isWriteAllowedMock: vi.fn(async () => true),
  resolveBoundArtifactTargetMock: vi.fn(),
  enqueueArtifactMatchRunMock: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("@/lib/db/pooled", async () => ({
  ...await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled"),
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: getAgentPackageMock,
}));
// getAgentPackage now requires an explicit VerdaccioConfig (cinatra#1454); the
// materializer loads it via this host wrapper. The mocked getAgentPackage
// ignores the value, so a stub config suffices.
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({
    registryUrl: "http://registry.test",
    token: "test-token",
  })),
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: listArtifactsMock },
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("../resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: resolveBoundArtifactTargetMock,
}));
vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: createSemanticArtifactMock,
}));
vi.mock("../materialization-ledger", () => ({
  claimMaterialization: claimMaterializationMock,
  buildFinalizeMaterializationQuery: buildFinalizeMaterializationQueryMock,
  readFinalizedMaterialization: readFinalizedMaterializationMock,
  // Real predicate logic (message-marker match) so the recovery path is
  // exercised against the same contract the ledger module ships.
  isMaterializationFinalizeConflict: (err: unknown) =>
    err instanceof Error && err.message.includes("materialization-finalize-conflict"),
}));
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: isWriteAllowedMock,
}));
// cinatra#1891 A3: the shared write core POST-COMMIT enqueues the meaning-matcher
// via `./matcher-enqueue` (dynamic import). Stub it so this UNIT suite stays
// hermetic — the real seam opens a live BullMQ/Redis connection (hangs on an
// unreachable broker); its behavior is covered by the enqueue suite + live walk.
vi.mock("../matcher-enqueue", () => ({
  enqueueArtifactMatchRun: enqueueArtifactMatchRunMock,
  artifactMatchJobId: (p: { orgId: string; artifactId: string; representationRevisionId: string }) =>
    `artifact-match__${p.orgId}__${p.artifactId}__${p.representationRevisionId}`,
  ARTIFACT_MATCH_RETRY_POLICY: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
}));
// artifact-authoring pulls the full authoring stack; the materializer needs
// only its two exported constants (values mirror the real module).
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set([
    "text/markdown",
    "text/plain",
    "text/html",
    "application/json",
    "application/xml",
  ]),
}));

import {
  authorizeToolMaterializeWrite,
  loadRunImageWriteFacts,
  materializeToolArtifact,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";

const EXT = "@cinatra-ai/blog-post-artifact";

function artifactDef(mimes: string[] = ["text/markdown", "application/json"]) {
  return {
    type: `${EXT}:artifact`,
    isArtifact: { accepts: { file: { mimeTypes: mimes } } },
  };
}

const BASE_INPUT = {
  runId: "run-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
  createdBy: "user-1",
  nodeId: "persist_draft",
  extension: EXT,
  title: "My Draft",
  mime: "text/markdown",
  content: "# Hello",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  poolQueryMock.mockResolvedValue({ rows: [{ package_name: "@test/agent" }] });
  getAgentPackageMock.mockResolvedValue({
    manifest: {
      name: "@test/agent",
      cinatra: { produces: [{ extension: EXT }] },
    },
    // No OAS payload needed by the tool path — produces comes from the
    // manifest even when the payload is absent.
    payload: null,
  });
  listArtifactsMock.mockReturnValue([artifactDef()]);
  // Mirror the legacy `${extension}:artifact` lookup off the same fixture.
  resolveBoundArtifactTargetMock.mockImplementation(
    async ({ extension }: { extension: string }) => {
      const defs = listArtifactsMock() as Array<{
        type: string;
        isArtifact?: { accepts?: { file?: { mimeTypes?: string[] } } };
      }>;
      const def = defs.find((d) => d.type === `${extension}:artifact`);
      if (!def) {
        return {
          ok: false,
          error: `artifact extension "${extension}" is not installed/registered on this host`,
        };
      }
      return {
        ok: true,
        target: {
          objectTypeId: def.type,
          acceptedFileMimeTypes: def.isArtifact?.accepts?.file?.mimeTypes ?? [],
        },
      };
    },
  );
  isWriteAllowedMock.mockResolvedValue(true);
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
  createSemanticArtifactMock.mockResolvedValue({
    artifactId: "art-1",
    representationRevisionId: "rep-1",
  });
});

describe("materializeToolArtifact", () => {
  it("writes through createSemanticArtifact under the materialize_tool ledger identity", async () => {
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      deduped: false,
    });
    expect(claimMaterializationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        runId: "run-1",
        outputId: "persist_draft",
        nodeId: "persist_draft",
        path: "materialize_tool",
        extension: EXT,
      }),
    );
    const createInput = createSemanticArtifactMock.mock.calls[0][0];
    expect(createInput).toMatchObject({
      orgId: "org-a",
      createdBy: "user-1",
      ownerLevel: "organization",
      ownerId: "org-a",
      title: "My Draft",
      declaredMime: "text/markdown",
      originKind: "agent_generated",
      createdByRunId: "run-1",
      producerAssertionExtension: EXT,
      skipFallbackClassification: true,
    });
    const composed = createInput.additionalTx2Queries({
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
    expect(composed).toEqual([{ text: "UPDATE finalize", values: [] }]);
    expect(buildFinalizeMaterializationQueryMock).toHaveBeenCalledWith({
      ledgerId: "led-1",
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
  });

  it("FAILS CLOSED when the extension is not in the run package's produces", async () => {
    const outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      extension: "@cinatra-ai/other-artifact",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("@cinatra-ai/other-artifact");
    expect(outcome.error).toContain("cinatra.produces");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(claimMaterializationMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on an empty/absent produces block", async () => {
    getAgentPackageMock.mockResolvedValue({
      manifest: { name: "@test/agent" },
      payload: null,
    });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("cinatra.produces");
  });

  it("fails when the run's template has no package name", async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("has no package name");
  });

  it("rejects a non-text-authorable MIME", async () => {
    const outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      mime: "image/png",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("not text-authorable");
  });

  it("rejects a MIME the extension does not accept", async () => {
    const outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      mime: "text/plain",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("the call declared MIME");
  });

  it("rejects an uninstalled extension and a write-denied org", async () => {
    listArtifactsMock.mockReturnValue([]);
    let outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("not installed/registered");
    }

    listArtifactsMock.mockReturnValue([artifactDef()]);
    isWriteAllowedMock.mockResolvedValue(false);
    outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("not write-allowed");
    }
  });

  it("rejects over-cap content and an empty title", async () => {
    let outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      content: "x".repeat(10 * 1024 * 1024 + 1),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("exceeds the");

    outcome = await materializeToolArtifact({ ...BASE_INPUT, title: "   " });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("title must be a non-empty string");
  });

  it("returns the finalized refs without writing on a ledger dedupe (retry)", async () => {
    claimMaterializationMock.mockResolvedValue({
      kind: "finalized",
      artifactId: "art-prev",
      representationRevisionId: "rep-prev",
      // cinatra#1893: the finalized claim now carries the winning row's `path`
      // (the ledger SELECT surfaces it); the Q3 alias guard compares it to this
      // write's path. A normal same-path dedupe returns the refs unchanged.
      path: "materialize_tool",
    });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-prev",
      representationRevisionId: "rep-prev",
      deduped: true,
    });
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("recovers the winner's refs when the finalize guard aborts a concurrent loser", async () => {
    createSemanticArtifactMock.mockRejectedValue(
      new Error("materialization-finalize-conflict: claim already finalized"),
    );
    readFinalizedMaterializationMock.mockResolvedValue({
      artifactId: "art-winner",
      representationRevisionId: "rep-winner",
    });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-winner",
      representationRevisionId: "rep-winner",
      deduped: true,
    });
  });

  it("never throws — infra failures come back as error outcomes", async () => {
    claimMaterializationMock.mockRejectedValue(new Error("db down"));
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("materialization failed: db down");
  });
});

// ---------------------------------------------------------------------------
// cinatra#3035: the origin of a mid-run write follows a marked review gate THAT
// EXECUTES after it — read with the compiler's topology, never from a
// marker-shaped value anywhere in the document.
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;
const ref = (id: string) => ({ $component_ref: id });
const control = (from: string, to: string) => ({
  component_type: "ControlFlowEdge",
  name: `${from}->${to}`,
  from_node: ref(from),
  to_node: ref(to),
});
const data = (from: string, output: string, to: string, input: string) => ({
  component_type: "DataFlowEdge",
  name: `${from}.${output}->${to}.${input}`,
  source_node: ref(from),
  source_output: output,
  destination_node: ref(to),
  destination_input: input,
});
const port = (title: string) => ({ title, type: "array" });
const collector = (id: string) => ({
  component_type: "ApiNode",
  id,
  name: id,
  inputs: [port("items")],
  outputs: [port("reviewTargets")],
});
const writeNode = (id: string) => ({
  component_type: "ApiNode",
  id,
  name: id,
  metadata: { cinatra: { extension: EXT } },
  outputs: [port("artifact")],
});
const gate = (targetsInput: unknown, inputs = [port("review_targets")]) => ({
  component_type: "InputMessageNode",
  id: "review_gate",
  name: "review_gate",
  metadata: { cinatra: { artifactReview: { targetsInput } } },
  inputs,
  outputs: [{ title: "userResponse", type: "string" }],
});

/** A flow: start -> each `order` node -> end, with the given data edges. */
function flow(order: string[], components: Doc, dataEdges: unknown[], extra: Doc = {}): Doc {
  const ids = ["start", ...order, "end"];
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "flow",
    name: "flow",
    metadata: { cinatra: { type: "flow" } },
    inputs: [],
    outputs: [],
    start_node: ref("start"),
    nodes: ids.map(ref),
    control_flow_connections: ids.slice(1).map((id, i) => control(ids[i]!, id)),
    data_flow_connections: dataEdges,
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start" },
      end: { component_type: "EndNode", id: "end", name: "end" },
      ...components,
    },
    ...extra,
  };
}

/** The reviewed shape: write -> marked gate, the gate's targets fed by the write. */
function reviewedFlow(): Doc {
  return flow(
    ["persist_draft", "review_gate"],
    { persist_draft: writeNode("persist_draft"), review_gate: gate("review_targets") },
    [data("persist_draft", "artifact", "review_gate", "review_targets")],
  );
}

function withPayload(payload: Doc | null, manifestName = "@test/agent") {
  return {
    manifest: { name: manifestName, cinatra: { produces: [{ extension: EXT }] } },
    payload,
  };
}

async function originOf(payload: Doc, nodeId = "persist_draft"): Promise<unknown> {
  getAgentPackageMock.mockResolvedValue(withPayload(payload));
  const outcome = await materializeToolArtifact({ ...BASE_INPUT, nodeId });
  expect(outcome.ok).toBe(true);
  return (createSemanticArtifactMock.mock.calls[0]?.[0] as { originKind?: unknown }).originKind;
}

describe("cinatra#3035 — a mid-run write under an executed marked review gate", () => {
  it("writes with the intermediate origin when a reachable marked gate after the write takes its targets from it", async () => {
    expect(await originOf(reviewedFlow())).toBe("live_generator");
  });

  it("writes with the intermediate origin when the write sits in a FlowNode subflow that feeds the gate", async () => {
    const payload = flow(
      ["drafting", "review_gate"],
      {
        drafting: {
          component_type: "FlowNode",
          id: "drafting",
          name: "drafting",
          subflow: ref("drafting_flow"),
          outputs: [port("artifact")],
        },
        drafting_flow: {
          component_type: "Flow",
          id: "drafting_flow",
          name: "drafting_flow",
          start_node: ref("inner_start"),
          nodes: [ref("inner_start"), ref("persist_draft"), ref("inner_end")],
        },
        inner_start: { component_type: "StartNode", id: "inner_start", name: "inner_start" },
        persist_draft: writeNode("persist_draft"),
        inner_end: { component_type: "EndNode", id: "inner_end", name: "inner_end" },
        review_gate: gate("review_targets"),
      },
      [data("drafting", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("live_generator");
  });

  it("keeps the durable origin when the flow marks no review gate", async () => {
    const payload = flow(
      ["persist_draft", "review_gate"],
      {
        persist_draft: writeNode("persist_draft"),
        review_gate: { ...gate("review_targets"), metadata: { cinatra: {} } },
      },
      [data("persist_draft", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a decoy marked gate in the flow's own metadata", async () => {
    const payload = flow(["persist_draft"], { persist_draft: writeNode("persist_draft") }, [], {
      metadata: { cinatra: { type: "flow", decoy: gate("review_targets") } },
    });
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a marker-shaped value in another node's data", async () => {
    const payload = flow(
      ["persist_draft"],
      {
        persist_draft: {
          ...writeNode("persist_draft"),
          data: { example: gate("review_targets") },
        },
      },
      [],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a marked gate that is an unused component", async () => {
    const payload = flow(
      ["persist_draft"],
      { persist_draft: writeNode("persist_draft"), review_gate: gate("review_targets") },
      [data("persist_draft", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a marked gate inside a subflow no reachable node calls", async () => {
    const payload = flow(
      ["persist_draft"],
      {
        persist_draft: writeNode("persist_draft"),
        uncalled: { component_type: "FlowNode", id: "uncalled", name: "uncalled", subflow: ref("uncalled_flow") },
        uncalled_flow: {
          component_type: "Flow",
          id: "uncalled_flow",
          name: "uncalled_flow",
          nodes: [ref("review_gate")],
        },
        review_gate: gate("review_targets"),
      },
      [data("persist_draft", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a marked gate nested in a called subflow (the compiler propagates no nested marker)", async () => {
    const payload = flow(
      ["persist_draft", "reviewing"],
      {
        persist_draft: writeNode("persist_draft"),
        reviewing: {
          component_type: "FlowNode",
          id: "reviewing",
          name: "reviewing",
          subflow: ref("reviewing_flow"),
          inputs: [port("review_targets")],
        },
        reviewing_flow: {
          component_type: "Flow",
          id: "reviewing_flow",
          name: "reviewing_flow",
          nodes: [ref("review_gate")],
        },
        review_gate: gate("review_targets"),
      },
      [data("persist_draft", "artifact", "reviewing", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a marked gate that runs before the write", async () => {
    const payload = flow(
      ["review_gate", "persist_draft"],
      { persist_draft: writeNode("persist_draft"), review_gate: gate("review_targets") },
      [data("persist_draft", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a marker naming an input the gate does not declare", async () => {
    const payload = flow(
      ["persist_draft", "review_gate"],
      { persist_draft: writeNode("persist_draft"), review_gate: gate("review_targets", []) },
      [data("persist_draft", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a blank marker", async () => {
    const payload = flow(
      ["persist_draft", "review_gate"],
      { persist_draft: writeNode("persist_draft"), review_gate: gate("   ", [port("   ")]) },
      [data("persist_draft", "artifact", "review_gate", "   ")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a write the gate's targets do not come from", async () => {
    const payload = flow(
      ["persist_draft", "persist_other", "review_gate"],
      {
        persist_draft: writeNode("persist_draft"),
        persist_other: writeNode("persist_other"),
        review_gate: gate("review_targets"),
      },
      [data("persist_other", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("writes with the intermediate origin when a collector between the write and the gate gathers the targets", async () => {
    const payload = flow(
      ["persist_draft", "gather", "review_gate"],
      { persist_draft: writeNode("persist_draft"), gather: collector("gather"), review_gate: gate("review_targets") },
      [
        data("persist_draft", "artifact", "gather", "items"),
        data("gather", "reviewTargets", "review_gate", "review_targets"),
      ],
    );
    expect(await originOf(payload)).toBe("live_generator");
  });

  it("writes with the intermediate origin through two collectors", async () => {
    const payload = flow(
      ["persist_draft", "gather_one", "gather_two", "review_gate"],
      {
        persist_draft: writeNode("persist_draft"),
        gather_one: collector("gather_one"),
        gather_two: collector("gather_two"),
        review_gate: gate("review_targets"),
      },
      [
        data("persist_draft", "artifact", "gather_one", "items"),
        data("gather_one", "reviewTargets", "gather_two", "items"),
        data("gather_two", "reviewTargets", "review_gate", "review_targets"),
      ],
    );
    expect(await originOf(payload)).toBe("live_generator");
  });

  it("keeps the durable origin when the collector feeding the gate does not take the write's output", async () => {
    const payload = flow(
      ["persist_draft", "persist_other", "gather", "review_gate"],
      {
        persist_draft: writeNode("persist_draft"),
        persist_other: writeNode("persist_other"),
        gather: collector("gather"),
        review_gate: gate("review_targets"),
      },
      [
        data("persist_other", "artifact", "gather", "items"),
        data("gather", "reviewTargets", "review_gate", "review_targets"),
      ],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a writer the start node never reaches", async () => {
    const payload = flow(
      ["review_gate"],
      { persist_draft: writeNode("persist_draft"), review_gate: gate("review_targets") },
      [data("persist_draft", "artifact", "review_gate", "review_targets")],
    );
    // The writer runs into the gate, but nothing runs into the writer.
    (payload.control_flow_connections as unknown[]).push(control("persist_draft", "review_gate"));
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("keeps the durable origin for a node id that also stands in a place no gate reviews", async () => {
    const payload = flow(
      ["persist_draft", "review_gate", "other_flow"],
      {
        persist_draft: writeNode("persist_draft"),
        review_gate: gate("review_targets"),
        other_flow: {
          component_type: "FlowNode",
          id: "other_flow",
          name: "other_flow",
          subflow: ref("other_subflow"),
        },
        other_subflow: {
          component_type: "Flow",
          id: "other_subflow",
          name: "other_subflow",
          nodes: [ref("persist_draft")],
        },
      },
      [data("persist_draft", "artifact", "review_gate", "review_targets")],
    );
    expect(await originOf(payload)).toBe("agent_generated");
  });

  it("answers the append road (no writing node named) as unreviewed", async () => {
    getAgentPackageMock.mockResolvedValue(withPayload(reviewedFlow()));
    const authorized = await authorizeToolMaterializeWrite({
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.2.3",
      extension: EXT,
      mime: "text/markdown",
      content: "# Hello",
    });
    expect(authorized).toMatchObject({ ok: true, reviewed: false });
  });
});

describe("cinatra#3035 — the image road's write facts come from one reading", () => {
  it("takes the produces refs and the review answer from the same registry result while the tag moves", async () => {
    // An unpinned run: the tag first resolves to a version whose flow marks no
    // gate, then moves to one that does. Each reading is one registry read, and
    // both answers of a reading come from that one result.
    getAgentPackageMock
      .mockResolvedValueOnce(withPayload(flow(["persist_draft"], { persist_draft: writeNode("persist_draft") }, [])))
      .mockResolvedValueOnce(withPayload(reviewedFlow()));
    const before = await loadRunImageWriteFacts({
      templateId: "tpl-1",
      packageVersion: null,
      nodeId: "persist_draft",
    });
    expect(getAgentPackageMock).toHaveBeenCalledTimes(1);
    expect(before).toEqual({ producesRefs: [{ extension: EXT }], reviewed: false });

    const after = await loadRunImageWriteFacts({
      templateId: "tpl-1",
      packageVersion: null,
      nodeId: "persist_draft",
    });
    expect(getAgentPackageMock).toHaveBeenCalledTimes(2);
    expect(after).toEqual({ producesRefs: [{ extension: EXT }], reviewed: true });
  });

  it("reads nothing reviewed for a template with no package", async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ package_name: null }] });
    const facts = await loadRunImageWriteFacts({
      templateId: "tpl-1",
      packageVersion: "1.2.3",
      nodeId: "persist_draft",
    });
    expect(facts).toEqual({ producesRefs: [], reviewed: false });
    expect(getAgentPackageMock).not.toHaveBeenCalled();
  });
});

describe("cinatra#3035 — the shipped blog pipeline's wiring (writes -> collector -> marked gate)", () => {
  // The shape of the blog pipeline's own flow: the draft and its picture are
  // written, a collector gathers their references into the draft gate's review
  // targets; the LinkedIn post is written after that gate and its own collector
  // feeds the LinkedIn gate.
  function pipelineFlow(): Doc {
    const linkedinGate = {
      ...gate("reviewTargets", [port("linkedinPost"), port("linkedinTitle"), port("reviewTargets")]),
      id: "linkedin_review_gate",
      name: "linkedin_review_gate",
    };
    return flow(
      [
        "write_draft",
        "file_image",
        "complete_relation",
        "draft_review_gate",
        "write_linkedin",
        "gather_linkedin_review",
        "linkedin_review_gate",
      ],
      {
        write_draft: writeNode("write_draft"),
        file_image: { ...writeNode("file_image"), inputs: [port("postArtifactId")] },
        complete_relation: {
          ...collector("complete_relation"),
          inputs: [port("draftArtifactId"), port("draftRevisionId"), port("imageArtifactId"), port("imageRevisionId")],
        },
        draft_review_gate: {
          ...gate("reviewTargets", [port("reviewTargets")]),
          id: "draft_review_gate",
          name: "draft_review_gate",
        },
        write_linkedin: writeNode("write_linkedin"),
        gather_linkedin_review: {
          ...collector("gather_linkedin_review"),
          inputs: [port("linkedinArtifactId"), port("linkedinRevisionId")],
        },
        linkedin_review_gate: linkedinGate,
      },
      [
        data("write_draft", "artifactId", "file_image", "postArtifactId"),
        data("write_draft", "artifactId", "complete_relation", "draftArtifactId"),
        data("write_draft", "representationRevisionId", "complete_relation", "draftRevisionId"),
        data("file_image", "artifactId", "complete_relation", "imageArtifactId"),
        data("file_image", "representationRevisionId", "complete_relation", "imageRevisionId"),
        data("complete_relation", "reviewTargets", "draft_review_gate", "reviewTargets"),
        data("write_linkedin", "artifactId", "gather_linkedin_review", "linkedinArtifactId"),
        data("write_linkedin", "representationRevisionId", "gather_linkedin_review", "linkedinRevisionId"),
        data("gather_linkedin_review", "reviewTargets", "linkedin_review_gate", "reviewTargets"),
      ],
    );
  }

  it("writes the draft with the intermediate origin", async () => {
    expect(await originOf(pipelineFlow(), "write_draft")).toBe("live_generator");
  });

  it("writes the LinkedIn post with the intermediate origin", async () => {
    expect(await originOf(pipelineFlow(), "write_linkedin")).toBe("live_generator");
  });

  it("reads the picture's write as reviewed on the image road", async () => {
    getAgentPackageMock.mockResolvedValue(withPayload(pipelineFlow()));
    const facts = await loadRunImageWriteFacts({
      templateId: "tpl-1",
      packageVersion: "1.2.3",
      nodeId: "file_image",
    });
    expect(facts).toEqual({ producesRefs: [{ extension: EXT }], reviewed: true });
  });
});
