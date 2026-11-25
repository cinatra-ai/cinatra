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
 *   L4 the send fan-out reuses each list-filed body by its bytes
 *   L5 a list-filed body is stored with the same fields as a single filing of
 *      the same body (neither carries typed data: the send records the
 *      correlation of a body it reuses, not the filing)
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
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: createSemanticArtifactMock }));
vi.mock("../materialization-ledger", () => ({
  claimMaterialization: claimMaterializationMock,
  buildFinalizeMaterializationQuery: buildFinalizeMaterializationQueryMock,
  readFinalizedMaterialization: readFinalizedMaterializationMock,
  findFinalizedMidRunMaterialization: findFinalizedMidRunMaterializationMock,
  findFinalizedFanoutMessageMaterialization: findFinalizedFanoutMessageMaterializationMock,
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
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";
import {
  planPerArtifactReviewGates,
  resolveDeclaredReviewTargets,
} from "../artifact-review-target";
import { shapeArtifactMaterializeInput } from "@/app/api/agents/passthrough/artifact-materialize-shaper";

const EXT = "@cinatra-ai/email-artifacts";
const BODY_TYPE = "@cinatra-ai/email:body";
const NODE = "file_drafts";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const DRAFTS = [
  { id: "d1", subject: "Hello Ada", body: "Dear Ada, ..." },
  { id: "d2", subject: "Hello Bob", body: "Dear Bob, ..." },
  { id: "d3", subject: "Hello Cy", body: "Dear Cy, ..." },
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
      additionalTx2Queries: (ids: { artifactId: string; representationRevisionId: string }) => Array<{ values: unknown[] }>;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (failOnce.delete(body)) throw new Error("tx2 rolled back");
      artifactSeq += 1;
      const ids = { artifactId: `art-${artifactSeq}`, representationRevisionId: `rep-${artifactSeq}` };
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
  it("L3 a marked gate fed by the list node reviews every member's write and plans one review leg per artifact", async () => {
    const ref = (id: string) => ({ $component_ref: id });
    const order = ["start", NODE, "review_gate", "end"];
    getAgentPackageMock.mockResolvedValue(withPayload({
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
          data: { tool: "artifact_materialize" }, outputs: [{ title: "reviewTargets", type: "string" }],
        },
        review_gate: {
          component_type: "InputMessageNode", id: "review_gate", name: "review_gate",
          metadata: { cinatra: { artifactReview: { targetsInput: "review_targets" } } },
          inputs: [{ title: "review_targets", type: "string" }],
          outputs: [{ title: "userResponse", type: "string" }],
        },
      },
    }));
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

  // red-first-expect: input.title must be a non-empty string
  it("L4 the send fan-out reuses each list-filed body by its bytes", async () => {
    const listed = await fileList(NODE);
    if (!listed.ok) throw new Error(listed.error);
    createSemanticArtifactMock.mockClear();
    claimMaterializationMock.mockClear();

    const sent: Array<Awaited<ReturnType<typeof materializeFanoutMessageRevision>>> = [];
    for (const draft of DRAFTS) {
      sent.push(await materializeFanoutMessageRevision({
        runId: "run-1",
        orgId: "org-a",
        createdBy: "user-1",
        objectTypeId: BODY_TYPE,
        outputId: `email-body:run-1:${draft.id}`,
        title: draft.subject,
        markdown: draft.body,
        typedData: { subject: draft.subject, bodyMarkdown: draft.body },
      }));
    }
    expect(sent).toEqual(EXPECTED.map((ids) => ({ ok: true, ...ids, deduped: true })));
    // No second artifact and no fan-out claim: each message is bound to its list-filed body.
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(ledger.filter((r) => r.path === "email_fanout").map((r) => r.artifactId)).toEqual(["art-1", "art-2", "art-3"]);
  });
  // red-first-expect: input.title must be a non-empty string
  it("L5 a list-filed body is stored with the same fields as a single filing of the same body", async () => {
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

describe("cinatra#3089 — the raw size check of a list call never throws", () => {
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
