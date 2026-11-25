/**
 * cinatra#3089 — the `artifact_materialize` LIST MODE on the real write core:
 * the list filing (`materializeArtifactList`) drives the real
 * `materializeToolArtifact`, `writeClaimedArtifact` and the email fan-out's
 * `materializeFanoutMessageRevision` over an in-memory ledger that keeps the
 * ledger's own key (run, output id, extension, content hash) and its mid-run
 * lookup. The module graph is mocked as materialize-tool-artifact.test.ts and
 * run-artifact-materializer-email-fanout-3089.test.ts mock it.
 *
 * Cases:
 *   L1 N members give N `materialize_tool` ledger rows and N artifacts, in
 *      order, with the review targets JSON
 *   L2 a retry after a partial failure files nothing twice
 *   L3 a marked gate fed by the list node reviews every member's write, and
 *      plans one review leg per artifact, in order
 *   L4 the send fan-out reuses each list-filed body by its bytes when the
 *      filing declared the correlation the send stores, and refuses one that
 *      declared none
 *   L5 a list-filed body that declares no typed data is stored with the same
 *      fields as a single filing of the same body (a single filing takes no
 *      typed data; the send records the correlation of a body it reuses)
 *   L7 a marked list node whose member 2 fails stores member 1 as the gate's
 *      write, answers the failure with what is stored and no review targets,
 *      and a retry of the same call files the rest and reaches the gate with
 *      every member
 *   L6 a list-filed body stores the typed data its call declares (member
 *      fields, call-wide values, the run's own id) beside the writer's fields,
 *      and the campaign body query's filter matches it
 *
 *   npx vitest run src/lib/artifacts/__tests__/materialize-list-3089.test.ts
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  poolQueryMock,
  getAgentPackageMock,
  registerAllObjectTypesMock,
  createSemanticArtifactMock,
  claimMaterializationMock,
  buildFinalizeMaterializationQueryMock,
  readFinalizedMaterializationMock,
  findFinalizedMidRunMaterializationMock,
  findFinalizedFanoutMessageMaterializationMock,
  findFinalizedToolMaterializationMock,
  recordFanoutReuseMaterializationMock,
  isWriteAllowedMock,
  resolveBoundArtifactTargetMock,
  enqueueArtifactMatchRunMock,
  readArtifactTypeClaimsForOrgMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getAgentPackageMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  findFinalizedMidRunMaterializationMock: vi.fn(),
  findFinalizedFanoutMessageMaterializationMock: vi.fn(),
  findFinalizedToolMaterializationMock: vi.fn(),
  recordFanoutReuseMaterializationMock: vi.fn(),
  isWriteAllowedMock: vi.fn(async () => true),
  resolveBoundArtifactTargetMock: vi.fn(),
  enqueueArtifactMatchRunMock: vi.fn(async (): Promise<void> => {}),
  readArtifactTypeClaimsForOrgMock: vi.fn(),
}));

vi.mock("@/lib/db/pooled", async () => ({
  ...await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled"),
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: getAgentPackageMock }));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({ registryUrl: "http://registry.test", token: "t" })),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: registerAllObjectTypesMock }));
vi.mock("../resolve-bound-artifact-type", () => ({ resolveBoundArtifactTarget: resolveBoundArtifactTargetMock }));
vi.mock("../artifact-creation", async () => ({
  ...(await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation")),
  createSemanticArtifact: createSemanticArtifactMock,
}));
// The canonical object read the fan-out's reuse asks (the stored rows are those the creation mock "wrote").
vi.mock("@/lib/objects-store", async () => ({
  ...(await vi.importActual<typeof import("@/lib/objects-store")>("@/lib/objects-store")),
  getObjectById: (id: string) => {
    const row = storedObjects.get(id);
    return row ? { id, type: row.type, data: row.data } : null;
  },
}));
vi.mock("../materialization-ledger", () => ({
  claimMaterialization: claimMaterializationMock,
  buildFinalizeMaterializationQuery: buildFinalizeMaterializationQueryMock,
  readFinalizedMaterialization: readFinalizedMaterializationMock,
  findFinalizedMidRunMaterialization: findFinalizedMidRunMaterializationMock,
  findFinalizedFanoutMessageMaterialization: findFinalizedFanoutMessageMaterializationMock,
  findFinalizedToolMaterialization: findFinalizedToolMaterializationMock,
  recordFanoutReuseMaterialization: recordFanoutReuseMaterializationMock,
  isMaterializationFinalizeConflict: (err: unknown) =>
    err instanceof Error && err.message.includes("materialization-finalize-conflict"),
}));
vi.mock("../artifact-extension-access", () => ({ isArtifactExtensionWriteAllowed: isWriteAllowedMock }));
vi.mock("../matcher-enqueue", () => ({ enqueueArtifactMatchRun: enqueueArtifactMatchRunMock }));
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: readArtifactTypeClaimsForOrgMock,
}));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set(["text/markdown", "text/plain"]),
}));

import {
  materializeFanoutMessageRevision,
  materializeToolArtifact,
  precheckToolMaterializeWrite,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";
import {
  planPerArtifactReviewGates,
  resolveDeclaredReviewTargets,
} from "../artifact-review-target";
import { shapeArtifactMaterializeInput } from "@/app/api/agents/passthrough/artifact-materialize-shaper";
import {
  MATERIALIZE_LIST_ENVELOPE_FIELDS,
  readMaterializeListDataDeclaration,
} from "../../../../packages/agents/src/artifact-binding";
import { compileDataEqualsClause } from "@/lib/objects-store";

const EXT = "@cinatra-ai/email-artifacts";
const BODY_TYPE = "@cinatra-ai/email:body";
const NODE = "file_drafts";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const DRAFTS = [
  { id: "d1", contactId: "c-1", subject: "Hello Ada", body: "Dear Ada, ..." },
  { id: "d2", contactId: "c-2", subject: "Hello Bob", body: "Dear Bob, ..." },
  { id: "d3", contactId: "c-3", subject: "Hello Cy", body: "Dear Cy, ..." },
];

/** The list module is loaded per test, so a missing module fails each test. */
async function listModule(): Promise<typeof import("@/app/api/agents/passthrough/artifact-materialize-list")> {
  return import("@/app/api/agents/passthrough/artifact-materialize-list");
}

type LedgerRow = {
  ledgerId: string;
  runId: string;
  outputId: string;
  path: string;
  extension: string;
  contentHash: string;
  artifactId?: string;
  representationRevisionId?: string;
};

/** The ledger as the real table keys it: one row per (run, output id,
 *  extension, content hash); finalized when the create's Tx2 commits. */
let ledger: LedgerRow[];
/** Bodies whose create fails once, as a rolled-back Tx2 does. */
let failOnce: Set<string>;
/** The stored `objects` rows (data) of what the creation path wrote, by artifact id. */
let storedObjects: Map<string, { type: string; data: Record<string, unknown> }>;

/** The list filing through the real tool materializer, as the route wires it. */
async function fileList(verifiedStepId?: string) {
  const shaped = shapeArtifactMaterializeInput({
    extension: EXT,
    objectTypeId: BODY_TYPE,
    content: JSON.stringify(DRAFTS),
    memberContentField: "body",
    memberTitleField: "subject",
    declaredMime: "text/markdown",
    node_id: NODE,
  });
  const { materializeArtifactList } = await listModule();
  return materializeArtifactList(shaped.members!, (member) =>
    materializeToolArtifact({
      runId: "run-1",
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.0.0",
      createdBy: "user-1",
      nodeId: shaped.nodeId,
      ...(verifiedStepId ? { verifiedStepId } : {}),
      extension: shaped.extension,
      objectTypeId: shaped.objectTypeId,
      title: member.title,
      mime: shaped.declaredMime,
      content: member.content,
    }),
  );
}

function withPayload(payload: Record<string, unknown> | null) {
  return { manifest: { name: "@test/agent", cinatra: { produces: [{ extension: EXT }] } }, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  ledger = [];
  failOnce = new Set();
  storedObjects = new Map();
  getAgentPackageMock.mockResolvedValue(withPayload(null));
  poolQueryMock.mockImplementation(async (text: string) => {
    if (text.includes("SELECT package_name")) return { rows: [{ package_name: "@test/agent" }] };
    if (text.includes("SELECT template_id")) return { rows: [{ template_id: "tpl-1" }] };
    if (text.includes("owner_level")) return { rows: [{ owner_level: "organization", owner_id: "org-a" }] };
    if (text.includes("project_id")) return { rows: [{ project_id: null }] };
    return { rows: [] };
  });
  readArtifactTypeClaimsForOrgMock.mockReturnValue([
    {
      id: "claim-1", scope: "platform", objectTypeId: BODY_TYPE, claimKind: "dedicated",
      extensionPackage: EXT, status: "active", generation: 1, dispositions: null,
      installId: null, createdAt: null, updatedAt: null,
    },
  ]);
  resolveBoundArtifactTargetMock.mockResolvedValue({
    ok: true,
    target: { objectTypeId: BODY_TYPE, acceptedFileMimeTypes: ["text/markdown", "text/plain"] },
  });
  isWriteAllowedMock.mockResolvedValue(true);

  let ledgerSeq = 0;
  claimMaterializationMock.mockImplementation(
    async (c: { runId: string; outputId: string; path: string; extension: string; contentHash: string }) => {
      const row = ledger.find(
        (r) => r.runId === c.runId && r.outputId === c.outputId && r.extension === c.extension && r.contentHash === c.contentHash,
      );
      if (row?.artifactId) {
        return { kind: "finalized", path: row.path, artifactId: row.artifactId, representationRevisionId: row.representationRevisionId };
      }
      if (row) return { kind: "claimed", ledgerId: row.ledgerId, path: row.path };
      ledgerSeq += 1;
      const fresh = { ledgerId: `led-${ledgerSeq}`, runId: c.runId, outputId: c.outputId, path: c.path, extension: c.extension, contentHash: c.contentHash };
      ledger.push(fresh);
      return { kind: "claimed", ledgerId: fresh.ledgerId };
    },
  );
  buildFinalizeMaterializationQueryMock.mockImplementation(
    (f: { ledgerId: string; artifactId: string; representationRevisionId: string }) => ({ text: "UPDATE finalize", values: [f] }),
  );
  let artifactSeq = 0;
  createSemanticArtifactMock.mockImplementation(
    async (input: {
      stream: AsyncIterable<Uint8Array>;
      objectType: string;
      title: string;
      typedData?: Record<string, unknown>;
      additionalTx2Queries: (ids: { artifactId: string; representationRevisionId: string }) => Array<{ values: unknown[] }>;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (failOnce.delete(body)) throw new Error("tx2 rolled back");
      artifactSeq += 1;
      const ids = { artifactId: `art-${artifactSeq}`, representationRevisionId: `rep-${artifactSeq}` };
      storedObjects.set(ids.artifactId, { type: input.objectType, data: { ...(input.typedData ?? {}), title: input.title } });
      // The Tx2 commits: the finalize lands on the claimed row.
      for (const q of input.additionalTx2Queries(ids)) {
        const f = q.values[0] as { ledgerId: string };
        const row = ledger.find((r) => r.ledgerId === f.ledgerId)!;
        row.artifactId = ids.artifactId;
        row.representationRevisionId = ids.representationRevisionId;
      }
      return ids;
    },
  );
  findFinalizedMidRunMaterializationMock.mockImplementation(
    async (k: { runId: string; extension: string; contentHash: string }) => {
      const row = ledger.find(
        (r) =>
          r.runId === k.runId && r.extension === k.extension && r.contentHash === k.contentHash &&
          (r.path === "materialize_tool" || r.path === "end_node_binding") && r.artifactId &&
          !ledger.some((f) => f.path === "email_fanout" && f.artifactId === r.artifactId),
      );
      return row ? { artifactId: row.artifactId!, representationRevisionId: row.representationRevisionId! } : null;
    },
  );
  findFinalizedToolMaterializationMock.mockImplementation(
    async (k: { runId: string; outputId: string; extension: string; contentHash: string }) => {
      const row = ledger.find(
        (r) => r.path === "materialize_tool" && r.runId === k.runId && r.outputId === k.outputId &&
          r.extension === k.extension && r.contentHash === k.contentHash && r.artifactId,
      );
      return row ? { artifactId: row.artifactId!, representationRevisionId: row.representationRevisionId! } : null;
    },
  );
  findFinalizedFanoutMessageMaterializationMock.mockImplementation(
    async (k: { runId: string; outputId: string; extension: string; contentHash: string }) => {
      const row = ledger.find(
        (r) => r.path === "email_fanout" && r.runId === k.runId && r.outputId === k.outputId && r.contentHash === k.contentHash && r.artifactId,
      );
      return row ? { artifactId: row.artifactId!, representationRevisionId: row.representationRevisionId! } : null;
    },
  );
  recordFanoutReuseMaterializationMock.mockImplementation(
    async (r: { runId: string; outputId: string; extension: string; contentHash: string; artifactId: string; representationRevisionId: string }) => {
      ledger.push({ ledgerId: `reuse-${r.outputId}`, path: "email_fanout", ...r });
    },
  );
});

/** The list node's call as the flow author writes it (the detection reads its tool only). */
const LIST_NODE_DATA = {
  tool: "artifact_materialize",
  input: {
    extension: EXT, content: "{{ drafts }}", memberContentField: "body", memberTitleField: "subject",
    declaredMime: "text/markdown", node_id: NODE,
  },
};

/** A flow whose list node feeds a marked review gate (`nodeData` is the node's data). */
function markedListFlow(nodeData: unknown) {
  const ref = (id: string) => ({ $component_ref: id });
  const order = ["start", NODE, "review_gate", "end"];
  return withPayload({
    component_type: "Flow",
    id: "flow",
    name: "flow",
    start_node: ref("start"),
    nodes: order.map(ref),
    control_flow_connections: order.slice(1).map((id, i) => ({
      component_type: "ControlFlowEdge", name: `${order[i]}->${id}`, from_node: ref(order[i]!), to_node: ref(id),
    })),
    data_flow_connections: [{
      component_type: "DataFlowEdge", name: "targets", source_node: ref(NODE), source_output: "reviewTargets",
      destination_node: ref("review_gate"), destination_input: "review_targets",
    }],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start" },
      end: { component_type: "EndNode", id: "end", name: "end" },
      [NODE]: {
        component_type: "ApiNode", id: NODE, name: NODE,
        data: nodeData, outputs: [{ title: "reviewTargets", type: "string" }],
      },
      review_gate: {
        component_type: "InputMessageNode", id: "review_gate", name: "review_gate",
        metadata: { cinatra: { artifactReview: { targetsInput: "review_targets" } } },
        inputs: [{ title: "review_targets", type: "string" }],
        outputs: [{ title: "userResponse", type: "string" }],
      },
    },
  });
}

const EXPECTED = [1, 2, 3].map((i) => ({ artifactId: `art-${i}`, representationRevisionId: `rep-${i}` }));

describe("cinatra#3089 — artifact_materialize list mode on the ledgered write core", () => {
  // red-first-expect: input.title must be a non-empty string
  it("L1 N members give N materialize_tool ledger rows and N artifacts, in order, with the review targets JSON", async () => {
    const listed = await fileList(NODE);
    expect(listed).toEqual({ ok: true, artifacts: EXPECTED, reviewTargets: JSON.stringify(EXPECTED) });
    expect(ledger).toHaveLength(3);
    for (const [i, draft] of DRAFTS.entries()) {
      expect(ledger[i]).toMatchObject({
        runId: "run-1",
        outputId: NODE,
        path: "materialize_tool",
        extension: EXT,
        contentHash: sha256(draft.body),
        ...EXPECTED[i],
      });
      expect(createSemanticArtifactMock.mock.calls[i]![0]).toMatchObject({
        objectType: BODY_TYPE,
        title: draft.subject,
        declaredMime: "text/markdown",
        createdByRunId: "run-1",
      });
    }
  });

  // red-first-expect: input.title must be a non-empty string
  it("L2 a retry after a partial failure files nothing twice", async () => {
    failOnce.add(DRAFTS[1]!.body);
    const first = await fileList(NODE);
    expect(first).toMatchObject({ ok: false, code: "materialize_list_partial", failedMember: 2, filedCount: 1 });
    expect(first).not.toHaveProperty("artifacts");
    // Member 3 was never tried; member 2's claim is left unfinalized.
    expect(ledger.map((r) => [r.contentHash, Boolean(r.artifactId)])).toEqual([
      [sha256(DRAFTS[0]!.body), true],
      [sha256(DRAFTS[1]!.body), false],
    ]);

    const retry = await fileList(NODE);
    expect(retry).toEqual({ ok: true, artifacts: EXPECTED, reviewTargets: JSON.stringify(EXPECTED) });
    // One row per member, each finalized once; member 1's artifact is reused.
    expect(ledger).toHaveLength(3);
    expect(new Set(ledger.map((r) => r.artifactId))).toEqual(new Set(["art-1", "art-2", "art-3"]));
    // Three creates committed plus the one that rolled back — never a second create of member 1.
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(4);

    const again = await fileList(NODE);
    expect(again).toEqual(retry);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(4);
  });

  // red-first-expect: input.title must be a non-empty string
  it.each([
    ["an object", LIST_NODE_DATA],
    ["JSON text of an object (the form the binding also reads)", JSON.stringify(LIST_NODE_DATA)],
  ])("L3 a marked gate fed by the list node whose data is %s reviews every member's write and plans one review leg per artifact", async (_form, nodeData) => {
    getAgentPackageMock.mockResolvedValue(markedListFlow(nodeData));
    const listed = await fileList(NODE);
    if (!listed.ok) throw new Error(listed.error);
    // Each member is a reviewed write: the gate is its review.
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(3);
    for (const call of createSemanticArtifactMock.mock.calls) expect(call[0].originKind).toBe("live_generator");

    // The node's reviewTargets output, as the gate's input carries it.
    const targets = resolveDeclaredReviewTargets({
      inputName: "review_targets",
      startParams: null,
      pausePayload: { review_targets: listed.reviewTargets },
    });
    expect(planPerArtifactReviewGates({ reviewTaskId: "wayflow-task-1", targets })).toEqual([
      { reviewTaskId: "wayflow-task-1", targets: [EXPECTED[0]] },
      { reviewTaskId: "wayflow-task-1#2", targets: [EXPECTED[1]] },
      { reviewTaskId: "wayflow-task-1#3", targets: [EXPECTED[2]] },
    ]);
  });

  /** The send fan-out's own call for one draft, as `materializeEmailFanout` makes it. */
  const fanOut = (draft: (typeof DRAFTS)[number]) =>
    materializeFanoutMessageRevision({
      runId: "run-1",
      orgId: "org-a",
      createdBy: "user-1",
      objectTypeId: BODY_TYPE,
      outputId: `email-body:run-1:${draft.id}`,
      title: draft.subject,
      markdown: draft.body,
      typedData: { runId: "run-1", campaignId: "camp-1", subject: draft.subject, bodyMarkdown: draft.body, contactId: draft.contactId },
      reuseMustCarry: ["runId", "campaignId", "contactId"],
    });

  // red-first-expect: readMaterializeListDataDeclaration is not a function
  it("L4 the send fan-out reuses each list-filed body by its bytes when the filing declared the correlation it stores", async () => {
    const raw = {
      extension: EXT,
      objectTypeId: BODY_TYPE,
      content: JSON.stringify(DRAFTS),
      memberContentField: "body",
      memberTitleField: "subject",
      memberDataFields: ["contactId"],
      memberData: { campaignId: "camp-1" },
      memberRunIdField: "runId",
      declaredMime: "text/markdown",
      node_id: NODE,
    };
    const declaration = readMaterializeListDataDeclaration(raw);
    if (!declaration.ok) throw new Error(declaration.message);
    const shaped = shapeArtifactMaterializeInput(raw, declaration);
    const { materializeArtifactList } = await listModule();
    const listed = await materializeArtifactList(shaped.members!, (member) =>
      materializeToolArtifact({
        runId: "run-1", orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", createdBy: "user-1",
        nodeId: shaped.nodeId, verifiedStepId: NODE, extension: shaped.extension, objectTypeId: shaped.objectTypeId,
        title: member.title, mime: shaped.declaredMime, content: member.content,
        typedData: { ...member.data, [shaped.runIdField!]: "run-1" },
      }),
    );
    if (!listed.ok) throw new Error(listed.error);
    createSemanticArtifactMock.mockClear();
    claimMaterializationMock.mockClear();

    const sent: Array<Awaited<ReturnType<typeof fanOut>>> = [];
    for (const draft of DRAFTS) sent.push(await fanOut(draft));
    expect(sent).toEqual(EXPECTED.map((ids) => ({ ok: true, ...ids, deduped: true })));
    // No second artifact and no fan-out claim: each message is bound to its list-filed body.
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(ledger.filter((r) => r.path === "email_fanout").map((r) => r.artifactId)).toEqual(["art-1", "art-2", "art-3"]);
  });

  // red-first-expect: input.title must be a non-empty string
  it("L4b the send fan-out refuses a list-filed body that declared no typed data: nothing is bound, the send does not report success", async () => {
    const listed = await fileList(NODE);
    if (!listed.ok) throw new Error(listed.error);
    createSemanticArtifactMock.mockClear();
    claimMaterializationMock.mockClear();

    const outcome = await fanOut(DRAFTS[0]!);
    expect(outcome).toMatchObject({ ok: false, code: "fanout_reuse_typed_data_mismatch" });
    expect((outcome as { error: string }).error).toContain("keys: runId, campaignId, contactId");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(ledger.filter((r) => r.path === "email_fanout")).toEqual([]);
  });

  // red-first-expect: input.title must be a non-empty string
  it("L5 a list-filed body that declares no typed data is stored with the same fields as a single filing of the same body", async () => {
    const stored = (call: unknown[]) => {
      const { stream: _stream, additionalTx2Queries: _tx2, ...fields } = call[0] as Record<string, unknown>;
      return fields;
    };
    const listed = await fileList(NODE);
    if (!listed.ok) throw new Error(listed.error);
    const fromList = stored(createSemanticArtifactMock.mock.calls[0]!);

    ledger = [];
    createSemanticArtifactMock.mockClear();
    const single = shapeArtifactMaterializeInput({
      extension: EXT,
      objectTypeId: BODY_TYPE,
      content: DRAFTS[0]!.body,
      title: DRAFTS[0]!.subject,
      declaredMime: "text/markdown",
      node_id: NODE,
    });
    const filed = await materializeToolArtifact({
      runId: "run-1",
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.0.0",
      createdBy: "user-1",
      nodeId: single.nodeId,
      verifiedStepId: NODE,
      extension: single.extension,
      objectTypeId: single.objectTypeId,
      title: single.title,
      mime: single.declaredMime,
      content: single.content,
    });
    expect(filed).toMatchObject({ ok: true });
    const fromSingle = stored(createSemanticArtifactMock.mock.calls[0]!);

    expect(fromList).toEqual(fromSingle);
    expect(fromList).not.toHaveProperty("typedData");
  });
});

describe("cinatra#3089 — the creation path's pre-storage check, asked of every member before the first is stored", () => {
  const BODY = "@x/mail:body";
  const registryDef = {
    dispositions: { projection: "artifact-safe" },
    schema: { safeParse: (v: Record<string, unknown>) =>
      typeof v.contactId === "string" && v.contactId.length > 0
        ? { success: true }
        : { success: false, error: { message: "contactId: Required" } } },
  };
  const ask = async (over: { typedData?: Record<string, unknown>; content?: string; def?: unknown }) => {
    const creation = await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation");
    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    vi.spyOn(objectTypeRegistry, "resolve").mockReturnValue((over.def === undefined ? registryDef : over.def) as never);
    const content = over.content ?? "# Hi";
    return creation.artifactWriteRefusal(
      {
        objectType: BODY, expectedAcceptMimes: ["text/markdown", "text/plain"],
        typedData: over.typedData ?? { contactId: "c-1" }, title: "Hello", originKind: "live_generator",
        representationRevisionId: "rev-1",
      },
      creation.artifactWriteFactsOfContent(content, "text/markdown"),
    );
  };

  // red-first-expect: artifactWriteFactsOfContent is not a function
  it("admits a write whose bytes, type and typed data are valid", async () => {
    expect(await ask({})).toBeNull();
  });

  // red-first-expect: artifactWriteFactsOfContent is not a function
  it("refuses typed data the type's schema rejects, with the schema's own message", async () => {
    expect(await ask({ typedData: { campaignId: "k" } })).toBe(
      `object payload does not satisfy the declared schema for "${BODY}": contactId: Required`,
    );
  });

  // red-first-expect: artifactWriteFactsOfContent is not a function
  it("refuses bytes whose detected MIME the type does not accept: the sniff reads the bytes, not the declaration", async () => {
    // A member whose text begins with a PDF header reads as a PDF, whatever the call declared.
    const refusal = await ask({ content: "%PDF-1.4\nnot a markdown body" });
    expect(refusal).toBe(
      `detected MIME "application/pdf" is not accepted by "${BODY}" (accepts [text/markdown, text/plain])`,
    );
  });

  // red-first-expect: artifactWriteFactsOfContent is not a function
  it("refuses a type that is not a writable artifact type", async () => {
    expect(await ask({ def: null })).toContain("is no longer a writable artifact type");
  });

  // red-first-expect: artifactWriteFactsOfContent is not a function
  it("derives the facts of the bytes the store derives: UTF-8 size, sha256 of the bytes, the sniffed MIME", async () => {
    const creation = await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation");
    const facts = creation.artifactWriteFactsOfContent("é", "text/markdown");
    expect(facts).toEqual({
      mimeDetected: "text/markdown",
      sha256: createHash("sha256").update(Buffer.from("é", "utf8")).digest("hex"),
      sizeBytes: 2,
    });
  });
});

describe("cinatra#3089 — the tool's write check before storage (precheckToolMaterializeWrite)", () => {
  const seen: Array<Record<string, unknown>> = [];
  const registryDef = {
    dispositions: { projection: "artifact-safe" },
    schema: { safeParse: (v: Record<string, unknown>) => {
      seen.push(v);
      return typeof v.contactId === "string" && v.contactId.length > 0
        ? { success: true }
        : { success: false, error: { message: "contactId: Required" } };
    } },
  };
  const check = (typedData: Record<string, unknown>, content = "# Hi") =>
    precheckToolMaterializeWrite({
      orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", extension: EXT, objectTypeId: BODY_TYPE,
      mime: "text/markdown", content, nodeId: NODE, title: " Hello ", typedData,
    });
  const useDef = async () => {
    seen.length = 0;
    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    vi.spyOn(objectTypeRegistry, "resolve").mockReturnValue(registryDef as never);
  };

  // red-first-expect: precheckToolMaterializeWrite is not a function
  it("refuses typed data the schema rejects, with the origin of the gate's write when the node's gate reviews it", async () => {
    await useDef();
    getAgentPackageMock.mockResolvedValue(markedListFlow(LIST_NODE_DATA));
    const refused = await check({ campaignId: "k" });
    expect(refused).toEqual({
      ok: false,
      error: `object payload does not satisfy the declared schema for "${BODY_TYPE}": contactId: Required`,
    });
    expect(seen[0]).toMatchObject({ originKind: "live_generator", title: "Hello", mime: "text/markdown" });
  });

  // red-first-expect: precheckToolMaterializeWrite is not a function
  it("reads the plain agent origin for a node no gate reviews, and admits valid typed data", async () => {
    await useDef();
    expect(await check({ contactId: "c-1" })).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ originKind: "agent_generated", contactId: "c-1" });
  });

  // red-first-expect: precheckToolMaterializeWrite is not a function
  it("refuses a member whose text reads as another MIME, and a blank title, without throwing", async () => {
    await useDef();
    expect(await check({ contactId: "c-1" }, "%PDF-1.4\nnot markdown")).toMatchObject({
      ok: false,
      error: expect.stringContaining('detected MIME "application/pdf" is not accepted'),
    });
    expect(
      await precheckToolMaterializeWrite({
        orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", extension: EXT, mime: "text/markdown",
        content: "# Hi", title: "  ",
      }),
    ).toEqual({ ok: false, error: "title must be a non-empty string" });
  });
});

describe("cinatra#3089 — the write check builds the envelope as the writer does", () => {
  // The legal inline schema of a pack that asks the revision id to be a UUID (register-artifact-extensions).
  const uuidDef = {
    dispositions: { projection: "artifact-safe" },
    schema: { safeParse: (v: Record<string, unknown>) =>
      typeof v.latestRepresentationRevisionId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.latestRepresentationRevisionId) &&
      /^[0-9a-f]{64}$/.test(String(v.latestDigest))
        ? { success: true }
        : { success: false, error: { message: "latestRepresentationRevisionId: Invalid uuid" } } },
  };

  // red-first-expect: precheckToolMaterializeWrite is not a function
  it("admits a member whose type asks the revision id to be a UUID, as the writer's own revision id is", async () => {
    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    vi.spyOn(objectTypeRegistry, "resolve").mockReturnValue(uuidDef as never);
    expect(
      await precheckToolMaterializeWrite({
        orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", extension: EXT, objectTypeId: BODY_TYPE,
        mime: "text/markdown", content: "# Hi", nodeId: NODE, title: "Hello",
      }),
    ).toEqual({ ok: true });
  });

  // red-first-expect: to contain 'const objectData = buildArtifactObjec
  it("builds the checked envelope and the stored object data with ONE builder", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../artifact-creation.ts", import.meta.url), "utf8");
    expect(source).toContain("const objectData = buildArtifactObjectData(");
    expect(source).toMatch(/const previewEnvelope = buildArtifactObjectData\(/);
    // No placeholder revision id is left anywhere a checked envelope is built.
    const writeCheck = readFileSync(new URL("../run-artifact-materializer.ts", import.meta.url), "utf8");
    expect(writeCheck).not.toContain('representationRevisionId: "pending"');
  });
});

describe("cinatra#3089 — a retry is admitted only when what it would write is what is stored", () => {
  const FILED = "filed_values_differ";
  const file = (typedData: Record<string, unknown>, over?: { title?: string; verify?: boolean }) =>
    materializeToolArtifact({
      runId: "run-1", orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", createdBy: "user-1",
      nodeId: NODE, verifiedStepId: NODE, extension: EXT, objectTypeId: BODY_TYPE,
      title: over?.title ?? "Hello Ada", mime: "text/markdown", content: "Dear Ada",
      typedData, ...(over?.verify === false ? {} : { verifyFinalizedHit: true }),
    });

  // red-first-expect: to match object { ok: false
  it("L8 a finalized hit with a corrected contact or title is refused, naming what differs and never the values; the stored artifact is not touched", async () => {
    const first = await file({ contactId: "c-OLD" });
    expect(first).toMatchObject({ ok: true, deduped: false });
    createSemanticArtifactMock.mockClear();

    const same = await file({ contactId: "c-OLD" });
    expect(same).toMatchObject({ ok: true, deduped: true });

    const corrected = await file({ contactId: "c-NEW" });
    expect(corrected).toMatchObject({ ok: false, code: FILED });
    expect((corrected as { error: string }).error).toContain("differs: keys: contactId");
    const retitled = await file({ contactId: "c-OLD" }, { title: "Hello Ada Lovelace" });
    expect(retitled).toMatchObject({ ok: false, code: FILED });
    expect((retitled as { error: string }).error).toContain("differs: title");
    for (const r of [corrected, retitled]) {
      for (const value of ["c-OLD", "c-NEW", "Hello Ada"]) expect((r as { error: string }).error).not.toContain(value);
    }
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(storedObjects.get("art-1")!.data).toMatchObject({ contactId: "c-OLD", title: "Hello Ada" });
  });

  it("L8 a filing that does not ask for the check keeps today's behaviour: the hit is returned as it is", async () => {
    await file({ contactId: "c-OLD" }, { verify: false });
    expect(await file({ contactId: "c-NEW" }, { verify: false })).toMatchObject({ ok: true, deduped: true });
  });

  // red-first-expect: precheckToolMaterializeWrite is not a function
  it("L8 the list's write check finds the same difference BEFORE any member is stored", async () => {
    await file({ contactId: "c-OLD" });
    const check = (typedData: Record<string, unknown>) =>
      precheckToolMaterializeWrite({
        orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", extension: EXT, objectTypeId: BODY_TYPE,
        mime: "text/markdown", content: "Dear Ada", nodeId: NODE, title: "Hello Ada", typedData,
        runId: "run-1", outputId: NODE, verifyFiledValues: true,
      });
    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    vi.spyOn(objectTypeRegistry, "resolve").mockReturnValue({ dispositions: { projection: "artifact-safe" }, schema: { safeParse: () => ({ success: true }) } } as never);
    expect(await check({ contactId: "c-OLD" })).toEqual({ ok: true });
    const refused = await check({ contactId: "c-NEW" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("differs: keys: contactId") });
    expect((refused as { error: string }).error).not.toContain("c-NEW");
  });
});

describe("cinatra#3089 — a list call that fails after storing members", () => {
  // red-first-expect: input.title must be a non-empty string
  it("L7 member 2 fails: the failure names what is stored and carries no review targets; a retry files the rest once and the gate covers every member", async () => {
    getAgentPackageMock.mockResolvedValue(markedListFlow(LIST_NODE_DATA));
    failOnce.add(DRAFTS[1]!.body);
    const first = await fileList(NODE);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected a failure");
    // Member 1 is stored as the gate's write (live_generator: the gate is its review) ...
    expect(first).toMatchObject({ failedMember: 2, filedCount: 1 });
    expect(first.filed).toEqual([EXPECTED[0]]);
    expect(createSemanticArtifactMock.mock.calls[0]![0].originKind).toBe("live_generator");
    // ... and nothing the gate could read: no targets, no artifacts.
    expect(first).not.toHaveProperty("reviewTargets");
    expect(first).not.toHaveProperty("artifacts");

    // A retry of the same call: member 1 is the one already stored (the ledger), the others are filed once.
    const retry = await fileList(NODE);
    if (!retry.ok) throw new Error(retry.error);
    expect(retry.artifacts).toEqual(EXPECTED);
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(4); // member 1, failed member 2, member 2, member 3
    expect(ledger.filter((r) => r.path === "materialize_tool" && r.artifactId)).toHaveLength(3);
    for (const call of createSemanticArtifactMock.mock.calls) expect(call[0].originKind).toBe("live_generator");

    // The gate's targets are all three, one review leg each, in order.
    const targets = resolveDeclaredReviewTargets({
      inputName: "review_targets",
      startParams: null,
      pausePayload: { review_targets: retry.reviewTargets },
    });
    expect(planPerArtifactReviewGates({ reviewTaskId: "wayflow-task-1", targets })).toEqual([
      { reviewTaskId: "wayflow-task-1", targets: [EXPECTED[0]] },
      { reviewTaskId: "wayflow-task-1#2", targets: [EXPECTED[1]] },
      { reviewTaskId: "wayflow-task-1#3", targets: [EXPECTED[2]] },
    ]);
  });
});

describe("cinatra#3089 — typed data of a list-filed body", () => {
  /** The list filing as the route wires it, with the typed data the call declares. */
  async function fileTypedList(extra: Record<string, unknown>) {
    const raw = {
      extension: EXT,
      objectTypeId: BODY_TYPE,
      content: JSON.stringify(DRAFTS),
      memberContentField: "body",
      memberTitleField: "subject",
      declaredMime: "text/markdown",
      node_id: NODE,
      ...extra,
    };
    const declaration = readMaterializeListDataDeclaration(raw);
    if (!declaration.ok) throw new Error(declaration.message);
    const shaped = shapeArtifactMaterializeInput(raw, declaration);
    const { materializeArtifactList } = await listModule();
    return materializeArtifactList(shaped.members!, (member) =>
      materializeToolArtifact({
        runId: "run-1",
        orgId: "org-a",
        templateId: "tpl-1",
        packageVersion: "1.0.0",
        createdBy: "user-1",
        nodeId: shaped.nodeId,
        verifiedStepId: NODE,
        extension: shaped.extension,
        objectTypeId: shaped.objectTypeId,
        title: member.title,
        mime: shaped.declaredMime,
        content: member.content,
        ...(member.data || shaped.runIdField
          ? { typedData: { ...member.data, ...(shaped.runIdField ? { [shaped.runIdField]: "run-1" } : {}) } }
          : {}),
      }),
    );
  }

  // red-first-expect: readMaterializeListDataDeclaration is not a function
  it("L6 stores each member's declared fields, the call-wide values and the run's id beside the writer's fields", async () => {
    const listed = await fileTypedList({
      memberDataFields: ["id"],
      memberData: { campaignId: "camp-1" },
      memberRunIdField: "runId",
    });
    if (!listed.ok) throw new Error(listed.error);
    const typed = createSemanticArtifactMock.mock.calls.map((c) => c[0].typedData);
    expect(typed).toEqual(
      DRAFTS.map((d) => ({ id: d.id, campaignId: "camp-1", runId: "run-1" })),
    );

    // The campaign body query filters `data.campaignId` (the indexed dataEquals
    // clause): the stored data of every list-filed body satisfies it.
    const values: unknown[] = [];
    const { clauses } = compileDataEqualsClause([{ key: "campaignId", value: "camp-1" }], values, 1);
    expect(clauses).toEqual(["data->>'campaignId' = $1"]);
    for (const call of createSemanticArtifactMock.mock.calls) {
      const stored = { ...call[0].typedData, title: call[0].title } as Record<string, unknown>;
      expect(stored.campaignId).toBe(values[0]);
    }
  });

  // red-first-expect: readMaterializeListDataDeclaration is not a function
  it("files the same body, with no typed data, when the call declares none", async () => {
    const listed = await fileTypedList({});
    if (!listed.ok) throw new Error(listed.error);
    for (const call of createSemanticArtifactMock.mock.calls) expect(call[0]).not.toHaveProperty("typedData");
  });

  // red-first-expect: expected 0 to be greater than 0
  it("keeps the writer-owned fields the creation path puts over a caller's typed data in step with the refused names", async () => {
    // The creation path composes `{ ...typedData, <the writer's own fields> }`: a caller's
    // typed data can add to the object and can never restate those fields. The names a
    // declaration may not use are exactly them.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../artifact-creation.ts", import.meta.url), "utf8");
    const from = source.indexOf("export function buildArtifactObjectData(");
    const block = source.slice(source.indexOf("return {", from), source.indexOf("} as ArtifactObjectData;", from));
    const owned = [...block.matchAll(/^\s+(\w+)\s*[:,]/gm)].map((m) => m[1]!).sort();
    expect(owned.length).toBeGreaterThan(0);
    expect([...MATERIALIZE_LIST_ENVELOPE_FIELDS].sort()).toEqual(owned);
    expect(block.indexOf("...(input.typedData ?? {})")).toBeLessThan(block.indexOf("artifactType:"));
  });
});

describe("cinatra#3089 — the raw size check of a list call never throws", () => {
  // red-first-expect: Cannot find package '@/app/api/agents/passthrough/artifact-materialize-list'
  it("counts an input that cannot be written as JSON text as too large", async () => {
    const { isMaterializeListInputTooLarge } = await listModule();
    // A small input whose unused field is nested far deeper than the serializer's stack holds.
    let deep: unknown = 1;
    for (let k = 0; k < 200_000; k++) deep = [deep];
    expect(isMaterializeListInputTooLarge({ title: "t", content: "[]", unused: deep }, 262_144)).toBe(true);
    const loop: Record<string, unknown> = { content: "[]" };
    loop.self = loop;
    expect(isMaterializeListInputTooLarge(loop, 262_144)).toBe(true);
    expect(isMaterializeListInputTooLarge({ content: "[]", n: BigInt(1) }, 262_144)).toBe(true);
    expect(isMaterializeListInputTooLarge({ content: "[]", title: "t" }, 262_144)).toBe(false);
  });
});
