/**
 * cinatra#3089 — the `artifact_materialize` LIST MODE as ONE UNIT, on the real materializer core
 * (`materializeToolArtifactSet`): every member is checked, then ALL members are written in ONE
 * transaction with the ledger finalized for ALL of them, so there is no partial state. The
 * transaction itself is modelled by `createSemanticArtifactsMock` (all-or-nothing, a fault can be
 * injected at any member); the creation path's own batch entry point (`createSemanticArtifacts`) is
 * driven for real over a transaction double in the last describe. The module graph is mocked as
 * materialize-tool-artifact.test.ts mocks it.
 *
 *   S1  N members: one batch, N ledger rows finalized together, the set in member order
 *   S2  a fault at member k of n inside the transaction stores nothing; the identical retry files the set once
 *   S3  an identical retry after success answers the stored set and writes nothing
 *   S4  a retry that differs in any member (bytes, title, typed data, count) is refused, naming the member
 *   S5  a member refused before the write (schema, MIME, authorization) stores nothing
 *   S6  50 members are ONE transaction
 *   S7  a marked gate receives every member as a target, and every member is the gate's write
 *   S8  typed data per member; the same fields as a single filing when none is declared
 *   S9  the send fan-out reuses the batch-written bodies (type, title and correlation must match)
 *   C1  the batch entry point: ONE transaction for N artifacts, every row writer once per artifact, ONE rollback
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
  createSemanticArtifactsMock,
  claimMaterializationMock,
  buildFinalizeMaterializationQueryMock,
  readFinalizedMaterializationMock,
  findFinalizedMidRunMaterializationMock,
  findFinalizedFanoutMessageMaterializationMock,
  readToolSetRowsMock,
  recordFanoutReuseMaterializationMock,
  isWriteAllowedMock,
  resolveBoundArtifactTargetMock,
  enqueueArtifactMatchRunMock,
  readArtifactTypeClaimsForOrgMock,
  pgSyncMock,
  blobPutMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getAgentPackageMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  createSemanticArtifactsMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  findFinalizedMidRunMaterializationMock: vi.fn(),
  findFinalizedFanoutMessageMaterializationMock: vi.fn(),
  readToolSetRowsMock: vi.fn(),
  recordFanoutReuseMaterializationMock: vi.fn(),
  isWriteAllowedMock: vi.fn(async () => true),
  resolveBoundArtifactTargetMock: vi.fn(),
  enqueueArtifactMatchRunMock: vi.fn(async (): Promise<void> => {}),
  readArtifactTypeClaimsForOrgMock: vi.fn(),
  pgSyncMock: vi.fn(),
  blobPutMock: vi.fn(),
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
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: pgSyncMock }));
vi.mock("@/lib/database", () => ({ readChatThreadForClassifier: vi.fn(async () => null) }));
vi.mock("../producer-assertions", () => ({
  resolveProducerAssertionPlan: async () => ({ validatedRunId: "run-1", produces: [] }),
  buildAssertSemanticTypeQueries: vi.fn(),
}));
vi.mock("../local-disk-blob-store", async () => ({
  ...(await vi.importActual<typeof import("../local-disk-blob-store")>("../local-disk-blob-store")),
  createLocalDiskBlobStore: () => ({ put: blobPutMock, deleteByStorageKey: vi.fn(async () => {}) }),
}));
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: getAgentPackageMock }));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({ registryUrl: "http://registry.test", token: "t" })),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: registerAllObjectTypesMock }));
vi.mock("../resolve-bound-artifact-type", () => ({ resolveBoundArtifactTarget: resolveBoundArtifactTargetMock }));
vi.mock("../artifact-creation", async () => ({
  ...(await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation")),
  createSemanticArtifact: createSemanticArtifactMock,
  createSemanticArtifacts: createSemanticArtifactsMock,
}));
// The canonical object read the fan-out's reuse and the set's comparison ask (the stored rows are those the creation mock "wrote").
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
  readToolSetRows: readToolSetRowsMock,
  toolSetOutputId: (nodeId: string, position: number) => `${nodeId}#${position}`,
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
  materializeToolArtifactSet,
  __resetRunPackageBindingsCacheForTests,
  type ToolArtifactSetMember,
} from "../run-artifact-materializer";
import {
  planPerArtifactReviewGates,
  resolveDeclaredReviewTargets,
} from "../artifact-review-target";
import { MATERIALIZE_LIST_ENVELOPE_FIELDS } from "../../../../packages/agents/src/artifact-binding";
import { compileDataEqualsClause } from "@/lib/objects-store";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

const EXT = "@cinatra-ai/email-artifacts";
const BODY_TYPE = "@cinatra-ai/email:body";
const NODE = "file_drafts";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const DRAFTS = [
  { id: "d1", contactId: "c-1", subject: "Hello Ada", body: "Dear Ada, ..." },
  { id: "d2", contactId: "c-2", subject: "Hello Bob", body: "Dear Bob, ..." },
  { id: "d3", contactId: "c-3", subject: "Hello Cy", body: "Dear Cy, ..." },
];

type LedgerRow = {
  ledgerId: string;
  runId: string;
  nodeId?: string | null;
  outputId: string;
  path: string;
  extension: string;
  contentHash: string;
  artifactId?: string;
  representationRevisionId?: string;
};

/** The ledger as the real table keys it: one row per (run, output id, extension, content hash);
 *  finalized when the set's ONE transaction commits. */
let ledger: LedgerRow[];
/** The stored `objects` rows (data) of what the transaction wrote, by artifact id. */
let storedObjects: Map<string, { type: string; data: Record<string, unknown> }>;
/** The produced events the transaction wrote (one per artifact), with the origin each carries. */
let events: Array<{ artifactId: string; originKind: string }>;
/** How many members each COMMITTED transaction held. */
let commits: number[];
/** A 1-based member at which the transaction fails (a row writer faults): the whole transaction rolls back. */
let faultAtMember: number | null;
/** The registry definition of the body type: a schema that every test may replace. */
let bodySchema: (v: Record<string, unknown>) => { success: true } | { success: false; error: { message: string } };

const members = (over?: (m: ToolArtifactSetMember, i: number) => ToolArtifactSetMember): ToolArtifactSetMember[] =>
  DRAFTS.map((d, i) => {
    const base: ToolArtifactSetMember = {
      title: d.subject,
      content: d.body,
      typedData: { contactId: d.contactId, campaignId: "camp-1", runId: "run-1" },
    };
    return over ? over(base, i) : base;
  });

const fileSet = (list: ToolArtifactSetMember[] = members(), over?: Record<string, unknown>) =>
  materializeToolArtifactSet({
    runId: "run-1", orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", createdBy: "user-1",
    nodeId: NODE, verifiedStepId: NODE, extension: EXT, objectTypeId: BODY_TYPE, mime: "text/markdown",
    members: list, ...over,
  });

function withPayload(payload: Record<string, unknown> | null) {
  return { manifest: { name: "@test/agent", cinatra: { produces: [{ extension: EXT }] } }, payload };
}

async function readBody(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  ledger = [];
  storedObjects = new Map();
  events = [];
  commits = [];
  faultAtMember = null;
  bodySchema = () => ({ success: true });
  vi.spyOn(objectTypeRegistry, "resolve").mockImplementation(
    () => ({ dispositions: { projection: "artifact-safe" }, schema: { safeParse: (v: Record<string, unknown>) => bodySchema(v) } }) as never,
  );
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
    async (c: { runId: string; nodeId: string | null; outputId: string; path: string; extension: string; contentHash: string }) => {
      const row = ledger.find(
        (r) => r.runId === c.runId && r.outputId === c.outputId && r.extension === c.extension && r.contentHash === c.contentHash,
      );
      if (row?.artifactId) {
        return { kind: "finalized", path: row.path, artifactId: row.artifactId, representationRevisionId: row.representationRevisionId };
      }
      if (row) return { kind: "claimed", ledgerId: row.ledgerId, path: row.path };
      ledgerSeq += 1;
      const fresh = {
        ledgerId: `led-${ledgerSeq}`, runId: c.runId, nodeId: c.nodeId, outputId: c.outputId,
        path: c.path, extension: c.extension, contentHash: c.contentHash,
      };
      ledger.push(fresh);
      return { kind: "claimed", ledgerId: fresh.ledgerId };
    },
  );
  readToolSetRowsMock.mockImplementation(
    async (k: { runId: string; nodeId: string; extension: string }) =>
      ledger
        .filter((r) => r.runId === k.runId && r.nodeId === k.nodeId && r.extension === k.extension && r.path === "materialize_tool" && r.outputId.startsWith(`${k.nodeId}#`))
        .map((r) => ({
          outputId: r.outputId, contentHash: r.contentHash, phase: r.artifactId ? "finalized" : "claimed",
          artifactId: r.artifactId ?? null, representationRevisionId: r.representationRevisionId ?? null,
        })),
  );
  buildFinalizeMaterializationQueryMock.mockImplementation(
    (f: { ledgerId: string; artifactId: string; representationRevisionId: string }) => ({ text: "UPDATE finalize", values: [f] }),
  );
  let artifactSeq = 0;
  const land = (
    input: {
      objectType: string; title: string; originKind?: string; typedData?: Record<string, unknown>;
      additionalTx2Queries: (ids: { artifactId: string; representationRevisionId: string }) => Array<{ values: unknown[] }>;
    },
  ) => {
    artifactSeq += 1;
    const ids = { artifactId: `art-${artifactSeq}`, representationRevisionId: `rep-${artifactSeq}` };
    storedObjects.set(ids.artifactId, { type: input.objectType, data: { ...(input.typedData ?? {}), title: input.title } });
    events.push({ artifactId: ids.artifactId, originKind: input.originKind ?? "agent_generated" });
    for (const q of input.additionalTx2Queries(ids)) {
      const f = q.values[0] as { ledgerId: string };
      const row = ledger.find((r) => r.ledgerId === f.ledgerId)!;
      row.artifactId = ids.artifactId;
      row.representationRevisionId = ids.representationRevisionId;
    }
    return ids;
  };
  createSemanticArtifactMock.mockImplementation(async (input: Parameters<typeof land>[0] & { stream: AsyncIterable<Uint8Array> }) => {
    await readBody(input.stream);
    return land(input);
  });
  createSemanticArtifactsMock.mockImplementation(async (inputs: Array<Parameters<typeof land>[0] & { stream: AsyncIterable<Uint8Array> }>) => {
    // The transaction: every member's rows are staged, a fault at any member rolls ALL back, the commit lands once.
    for (const [i, input] of inputs.entries()) {
      await readBody(input.stream);
      if (faultAtMember === i + 1) throw new Error(`row writer fault at member ${i + 1}`);
    }
    commits.push(inputs.length);
    return inputs.map((input) => land(input));
  });
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
const finalizedRows = () => ledger.filter((r) => r.path === "materialize_tool" && r.artifactId);

describe("cinatra#3089 — the list is filed as ONE UNIT", () => {
  // red-first-expect: materializeToolArtifactSet is not a function
  it("S1 N members are one batch: N ledger rows finalized together, one artifact each, the set in member order", async () => {
    const filed = await fileSet();
    expect(filed).toEqual({ ok: true, deduped: false, artifacts: EXPECTED });
    expect(createSemanticArtifactsMock).toHaveBeenCalledTimes(1);
    expect(commits).toEqual([3]);
    // The ledger names each member's place in the set; the unique key stays (run, output id, extension, hash).
    expect(finalizedRows().map((r) => [r.outputId, r.contentHash])).toEqual(
      DRAFTS.map((d, i) => [`${NODE}#${i + 1}`, sha256(d.body)]),
    );
    expect(events).toHaveLength(3);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it.each([1, 2, 3])("S2 a fault at member %i inside the transaction stores nothing and answers ONE refusal; the identical retry files the set once", async (k) => {
    faultAtMember = k;
    const failed = await fileSet();
    expect(failed).toMatchObject({ ok: false, code: "materialize_list_set_failed" });
    expect((failed as { error: string }).error).toContain("nothing of it was stored");
    // Nothing exists: no object, no event, no finalized ledger row, no commit.
    expect(storedObjects.size).toBe(0);
    expect(events).toEqual([]);
    expect(finalizedRows()).toEqual([]);
    expect(commits).toEqual([]);

    faultAtMember = null;
    const retried = await fileSet();
    expect(retried).toEqual({ ok: true, deduped: false, artifacts: EXPECTED });
    expect(commits).toEqual([3]);
    expect(storedObjects.size).toBe(3);
    expect(events).toHaveLength(3);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S3 an identical retry after success answers the stored set and writes nothing", async () => {
    await fileSet();
    createSemanticArtifactsMock.mockClear();
    claimMaterializationMock.mockClear();
    const again = await fileSet();
    expect(again).toEqual({ ok: true, deduped: true, artifacts: EXPECTED });
    expect(createSemanticArtifactsMock).not.toHaveBeenCalled();
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(commits).toEqual([3]);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it.each([
    ["a member's bytes", members((m, i) => (i === 1 ? { ...m, content: "Dear Bob, REVISED" } : m)), 2, "member 2: bytes"],
    ["a member's title", members((m, i) => (i === 2 ? { ...m, title: "Hello Cy Lovelace" } : m)), 3, "member 3: title"],
    ["a member's corrected contact", members((m, i) => (i === 0 ? { ...m, typedData: { ...m.typedData, contactId: "c-CORRECTED" } } : m)), 1, "member 1: keys: contactId"],
    ["a member more", [...members(), { title: "Hello Di", content: "Dear Di", typedData: { contactId: "c-4", campaignId: "camp-1", runId: "run-1" } }], 4, "count (filed 3, call 4)"],
    ["a member fewer", members().slice(0, 2), undefined, "count (filed 3, call 2)"],
  ])("S4 a retry that differs in %s is a different set: refused, naming the member and never the values; nothing is written or changed", async (_n, changed, member, what) => {
    await fileSet();
    createSemanticArtifactsMock.mockClear();
    const before = JSON.stringify([...storedObjects]);
    const refused = await fileSet(changed);
    expect(refused).toMatchObject({ ok: false, code: "materialize_list_set_differs", ...(member === undefined ? {} : { failedMember: member }) });
    const text = (refused as { error: string }).error;
    expect(text).toContain(what);
    for (const value of ["c-CORRECTED", "Hello Cy Lovelace", "REVISED", "c-1", "camp-1", "Dear"]) expect(text).not.toContain(value);
    expect(createSemanticArtifactsMock).not.toHaveBeenCalled();
    expect(JSON.stringify([...storedObjects])).toBe(before);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it.each([
    ["typed data the type's schema rejects", () => { bodySchema = (v) => (v.contactId === "c-2" ? { success: false, error: { message: "contactId: bad" } } : { success: true }); }, undefined, 2, "contactId: bad"],
    ["bytes whose detected MIME the type does not accept", () => {}, members((m, i) => (i === 2 ? { ...m, content: "%PDF-1.4\nnot markdown" } : m)), 3, 'detected MIME "application/pdf" is not accepted'],
    ["a blank title", () => {}, members((m, i) => (i === 0 ? { ...m, title: "  " } : m)), 1, "title must be a non-empty string"],
  ])("S5 member refused before the write for %s: nothing is claimed, stored or finalized", async (_n, arrange, list, member, why) => {
    arrange();
    const refused = await fileSet(list);
    expect(refused).toMatchObject({ ok: false, code: "materialize_list_member_refused", failedMember: member });
    expect((refused as { error: string }).error).toContain(why);
    expect((refused as { error: string }).error).toContain("nothing was filed");
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(createSemanticArtifactsMock).not.toHaveBeenCalled();
    expect(storedObjects.size).toBe(0);
    expect(ledger).toEqual([]);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S6 50 members are ONE transaction", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ title: `Draft ${i + 1}`, content: `Body ${i + 1}`, typedData: { contactId: `c-${i + 1}` } }));
    const filed = await fileSet(fifty);
    expect(filed).toMatchObject({ ok: true, deduped: false });
    expect((filed as { artifacts: unknown[] }).artifacts).toHaveLength(50);
    expect(createSemanticArtifactsMock).toHaveBeenCalledTimes(1);
    expect(commits).toEqual([50]);
    expect(finalizedRows()).toHaveLength(50);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S10 a parallel call that filed a claim first ends this call with nothing stored, in both places it can show", async () => {
    // (a) another drive's claim is already finalized when this call claims it.
    claimMaterializationMock.mockImplementationOnce(async () => ({ kind: "finalized", path: "materialize_tool", artifactId: "art-x", representationRevisionId: "rep-x" }));
    const first = await fileSet();
    expect(first).toMatchObject({ ok: false, code: "materialize_list_set_busy" });
    // (b) the transaction's own finalize guard fires: the whole transaction rolled back.
    createSemanticArtifactsMock.mockRejectedValueOnce(new Error("materialization-finalize-conflict: claim already finalized by a concurrent writer"));
    const second = await fileSet();
    expect(second).toMatchObject({ ok: false, code: "materialize_list_set_busy" });
    expect(storedObjects.size).toBe(0);
    expect(finalizedRows()).toEqual([]);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S7 a marked gate receives every member as a target, and every member is the gate's write", async () => {
    getAgentPackageMock.mockResolvedValue(markedListFlow(LIST_NODE_DATA));
    const filed = await fileSet();
    if (!filed.ok) throw new Error(filed.error);
    expect(events.map((e) => e.originKind)).toEqual(["live_generator", "live_generator", "live_generator"]);
    const targets = resolveDeclaredReviewTargets({
      inputName: "review_targets",
      startParams: null,
      pausePayload: { review_targets: JSON.stringify(filed.artifacts) },
    });
    expect(planPerArtifactReviewGates({ reviewTaskId: "wayflow-task-1", targets })).toEqual([
      { reviewTaskId: "wayflow-task-1", targets: [EXPECTED[0]] },
      { reviewTaskId: "wayflow-task-1#2", targets: [EXPECTED[1]] },
      { reviewTaskId: "wayflow-task-1#3", targets: [EXPECTED[2]] },
    ]);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S7 a node no gate reviews files its members as plain agent writes", async () => {
    await fileSet();
    expect(events.map((e) => e.originKind)).toEqual(["agent_generated", "agent_generated", "agent_generated"]);
  });
});

describe("cinatra#3089 — typed data of a list-filed body", () => {
  // red-first-expect: materializeToolArtifactSet is not a function
  it("S8 stores each member's typed data beside the writer's fields, and the campaign body query's filter matches it", async () => {
    await fileSet();
    const typed = createSemanticArtifactsMock.mock.calls[0]![0].map((i: { typedData: unknown }) => i.typedData);
    expect(typed).toEqual(DRAFTS.map((d) => ({ contactId: d.contactId, campaignId: "camp-1", runId: "run-1" })));
    const values: unknown[] = [];
    const { clauses } = compileDataEqualsClause([{ key: "campaignId", value: "camp-1" }], values, 1);
    expect(clauses).toEqual(["data->>'campaignId' = $1"]);
    for (const { data } of storedObjects.values()) expect(data.campaignId).toBe(values[0]);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S8 a member with no typed data is written with the same fields as a single filing of the same body", async () => {
    const strip = ({ stream: _s, additionalTx2Queries: _a, ...fields }: Record<string, unknown>) => fields;
    await fileSet(members((m) => ({ title: m.title, content: m.content })));
    const fromSet = strip(createSemanticArtifactsMock.mock.calls[0]![0][0]);
    ledger = [];
    await materializeToolArtifact({
      runId: "run-1", orgId: "org-a", templateId: "tpl-1", packageVersion: "1.0.0", createdBy: "user-1",
      nodeId: NODE, verifiedStepId: NODE, extension: EXT, objectTypeId: BODY_TYPE,
      title: DRAFTS[0]!.subject, mime: "text/markdown", content: DRAFTS[0]!.body,
    });
    const fromSingle = strip(createSemanticArtifactMock.mock.calls[0]![0]);
    expect(fromSet).toEqual(fromSingle);
    expect(fromSet).not.toHaveProperty("typedData");
  });

  // red-first-expect: expected 0 to be greater than 0
  it("keeps the writer-owned fields the creation path puts over a caller's typed data in step with the refused names", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../artifact-creation.ts", import.meta.url), "utf8");
    const from = source.indexOf("export function buildArtifactObjectData(");
    const block = source.slice(source.indexOf("return {", from), source.indexOf("} as ArtifactObjectData;", from));
    const owned = [...block.matchAll(/^\s+(\w+)\s*[:,]/gm)].map((m) => m[1]!).sort();
    expect(owned.length).toBeGreaterThan(0);
    expect([...MATERIALIZE_LIST_ENVELOPE_FIELDS].sort()).toEqual(owned);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("admits a member whose type asks the revision id to be a UUID, as the writer's own revision id is", async () => {
    bodySchema = (v) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(v.latestRepresentationRevisionId)) &&
      /^[0-9a-f]{64}$/.test(String(v.latestDigest))
        ? { success: true }
        : { success: false, error: { message: "latestRepresentationRevisionId: Invalid uuid" } };
    expect(await fileSet()).toMatchObject({ ok: true });
  });

  // red-first-expect: to contain 'const objectData = buildArtifactObjec
  it("builds the checked envelope and the stored object data with ONE builder", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../artifact-creation.ts", import.meta.url), "utf8");
    expect(source).toContain("const objectData = buildArtifactObjectData(");
    expect(source).toMatch(/const previewEnvelope = buildArtifactObjectData\(/);
  });
});

describe("cinatra#3089 — the send fan-out reads the batch-written bodies", () => {
  const fanOut = (draft: (typeof DRAFTS)[number]) =>
    materializeFanoutMessageRevision({
      runId: "run-1", orgId: "org-a", createdBy: "user-1", objectTypeId: BODY_TYPE,
      outputId: `email-body:run-1:${draft.id}`, title: draft.subject, markdown: draft.body,
      typedData: { runId: "run-1", campaignId: "camp-1", subject: draft.subject, bodyMarkdown: draft.body, contactId: draft.contactId },
      reuseMustCarry: ["runId", "campaignId", "contactId"],
    });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S9 reuses each batch-written body whose type, title and correlation keys match", async () => {
    await fileSet();
    createSemanticArtifactMock.mockClear();
    const sent: Array<Awaited<ReturnType<typeof fanOut>>> = [];
    for (const draft of DRAFTS) sent.push(await fanOut(draft));
    expect(sent).toEqual(EXPECTED.map((ids) => ({ ok: true, ...ids, deduped: true })));
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(ledger.filter((r) => r.path === "email_fanout").map((r) => r.artifactId)).toEqual(["art-1", "art-2", "art-3"]);
  });

  // red-first-expect: materializeToolArtifactSet is not a function
  it("S9 refuses a batch-written body that declared no correlation: nothing is bound, the send does not report success", async () => {
    await fileSet(members((m) => ({ title: m.title, content: m.content })));
    createSemanticArtifactMock.mockClear();
    const outcome = await fanOut(DRAFTS[0]!);
    expect(outcome).toMatchObject({ ok: false, code: "fanout_reuse_typed_data_mismatch" });
    expect((outcome as { error: string }).error).toContain("keys: runId, campaignId, contactId");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(ledger.filter((r) => r.path === "email_fanout")).toEqual([]);
  });
});

describe("cinatra#3089 — the creation path's batch entry point (createSemanticArtifacts)", () => {
  type Statement = string;
  let committed: Statement[][];
  /** A 0-based statement index of the batch's transaction at which the database fails. */
  let faultAtStatement: number | null;

  async function* stream(text: string): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(text);
  }

  const creationInput = (i: number) => ({
    orgId: "org-a",
    objectType: BODY_TYPE,
    expectedAcceptMimes: ["text/markdown"],
    createdBy: "user-1",
    ownerLevel: "organization" as const,
    ownerId: "org-a",
    visibility: "organization" as const,
    title: `Draft ${i + 1}`,
    declaredMime: "text/markdown",
    originKind: "live_generator" as const,
    typedData: { contactId: `c-${i + 1}` },
    stream: stream(`Body ${i + 1}`),
    createdByRunId: "run-1",
    producerAssertionExtension: EXT,
    skipFallbackClassification: true,
    additionalTx2Queries: (ids: { artifactId: string }) => [{ text: "UPDATE finalize", values: [ids.artifactId] }],
  });

  const count = (batch: Statement[], needle: string) => batch.filter((t) => t.includes(needle)).length;

  beforeEach(() => {
    committed = [];
    faultAtStatement = null;
    let resources = 0;
    let blobs = 0;
    blobPutMock.mockImplementation(async (input: { stream: AsyncIterable<Uint8Array> }) => {
      const body = await readBody(input.stream);
      const digest = sha256(body);
      blobs += 1;
      return { blobId: `blob-${blobs}`, storageKey: `key-${digest}`, sha256: digest, sizeBytes: Buffer.byteLength(body), mimeDetected: "text/markdown" };
    });
    pgSyncMock.mockImplementation((input: { transaction?: boolean; queries: Array<{ text: string }> }) => {
      const texts = input.queries.map((q) => q.text);
      if (texts[0]!.includes("WITH resource_op")) {
        // The resource row of ONE blob: its own transaction, committed before the artifact rows.
        resources += 1;
        return [{ rows: [{ resource_id: `res-${resources}`, mime: "text/markdown", size_bytes: 6, storage_key: `k${resources}`, blob_id: `b${resources}`, is_new: true }], rowCount: 1 }];
      }
      if (faultAtStatement !== null && faultAtStatement < texts.length) throw new Error("statement failed");
      committed.push(texts);
      return texts.map(() => ({ rows: [], rowCount: 0 }));
    });
  });

  // red-first-expect: createSemanticArtifacts is not a function
  it("C1 N artifacts are ONE transaction holding every row writer once per artifact", async () => {
    const creation = await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation");
    const results = await creation.createSemanticArtifacts([0, 1, 2].map(creationInput));
    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.artifactId)).size).toBe(3);
    // ONE transaction call for the rows of all three.
    expect(committed).toHaveLength(1);
    const batch = committed[0]!;
    expect(count(batch, "pg_advisory_xact_lock")).toBe(3);
    expect(count(batch, 'INSERT INTO "public"."objects"')).toBe(3);
    expect(count(batch, 'INSERT INTO "public"."representation"')).toBe(3);
    expect(count(batch, "artifact_audit")).toBe(3);
    expect(count(batch, "UPDATE finalize")).toBe(3);
    expect(count(batch, "artifact_produced_outbox")).toBe(3);
  });

  // red-first-expect: createSemanticArtifacts is not a function
  it("C1 a database fault at any statement rolls the whole batch back: the call rejects and no transaction commits", async () => {
    const creation = await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation");
    faultAtStatement = 20;
    await expect(creation.createSemanticArtifacts([0, 1, 2].map(creationInput))).rejects.toThrow("statement failed");
    expect(committed).toEqual([]);
  });

  // red-first-expect: createSemanticArtifacts is not a function
  it("C1 50 artifacts are ONE transaction", async () => {
    const creation = await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation");
    const results = await creation.createSemanticArtifacts(Array.from({ length: 50 }, (_, i) => creationInput(i)));
    expect(results).toHaveLength(50);
    expect(committed).toHaveLength(1);
    expect(count(committed[0]!, 'INSERT INTO "public"."objects"')).toBe(50);
    expect(count(committed[0]!, "UPDATE finalize")).toBe(50);
  });

  it("C1 a single artifact is still ONE transaction with the same row writers", async () => {
    const creation = await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation");
    await creation.createSemanticArtifact(creationInput(0));
    expect(committed).toHaveLength(1);
    const batch = committed[0]!;
    expect(count(batch, 'INSERT INTO "public"."objects"')).toBe(1);
    expect(count(batch, 'INSERT INTO "public"."representation"')).toBe(1);
    expect(count(batch, "artifact_audit")).toBe(1);
    expect(count(batch, "UPDATE finalize")).toBe(1);
    expect(count(batch, "artifact_produced_outbox")).toBe(1);
  });
});

describe("cinatra#3089 — the creation path's pre-storage check", () => {
  const BODY = "@x/mail:body";
  const ask = async (over: { typedData?: Record<string, unknown>; content?: string; def?: unknown }) => {
    const creation = await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation");
    if (over.def !== undefined) vi.spyOn(objectTypeRegistry, "resolve").mockReturnValue(over.def as never);
    const content = over.content ?? "# Hi";
    return creation.artifactWriteRefusal(
      {
        objectType: BODY, expectedAcceptMimes: ["text/markdown", "text/plain"],
        typedData: over.typedData ?? { contactId: "c-1" }, title: "Hello", originKind: "live_generator",
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
    bodySchema = () => ({ success: false, error: { message: "contactId: Required" } });
    expect(await ask({ typedData: { campaignId: "k" } })).toBe(
      `object payload does not satisfy the declared schema for "${BODY}": contactId: Required`,
    );
  });

  // red-first-expect: artifactWriteFactsOfContent is not a function
  it("refuses bytes whose detected MIME the type does not accept: the sniff reads the bytes, not the declaration", async () => {
    expect(await ask({ content: "%PDF-1.4\nnot a markdown body" })).toBe(
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
    expect(creation.artifactWriteFactsOfContent("é", "text/markdown")).toEqual({
      mimeDetected: "text/markdown",
      sha256: createHash("sha256").update(Buffer.from("é", "utf8")).digest("hex"),
      sizeBytes: 2,
    });
  });
});

describe("cinatra#3089 — the raw size check of a list call never throws", () => {
  // red-first-expect: Cannot find package '@/app/api/agents/passthrough/artifact-materialize-list'
  it("counts an input that cannot be written as JSON text as too large", async () => {
    const { isMaterializeListInputTooLarge } = await import("@/app/api/agents/passthrough/artifact-materialize-list");
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
