/**
 * cinatra#3089 (lifecycle-d W1) — the email fan-out's body entry on the shared
 * ledgered write core (`writeClaimedArtifact`).
 *
 * The module graph is mocked exactly as materialize-tool-artifact.test.ts mocks
 * it (pooled db, postgres config, schema init, the bound-type resolver, the
 * creation path, the ledger, the extension write gate, the matcher enqueue);
 * the claim store answers which pack's claim wins the body type (the real
 * winner arbitration decides); the unit under test —
 * `materializeFanoutMessageRevision` and `writeClaimedArtifact` — is never
 * stubbed.
 *
 * Cases:
 *   A1 the fan-out's own ledger path, keyed by the message identity and the
 *      content hash, one claim per message
 *   A2 each revision carries the live_generator origin and exactly one produced
 *      event (and a write that names no origin keeps agent_generated)
 *   A3 a retried fan-out writes nothing new and returns the same artifact ids
 *   B1 a body the drafting step already filed mid-run is reused, no claim and no
 *      second artifact, and bound to the message so the retry reads its own row
 *   B2 two messages with the same bytes over one pre-filed body keep one body
 *      each: the first is bound to it, the second writes its own
 *   B3 a retried message keeps its own mapping even when a mid-run body of the
 *      same bytes is filed between drives
 *   L1 the ledger reads and the reuse row the entry relies on, as SQL
 *   E1 the ledger's path CHECK admits the fan-out's path in the fresh-install
 *      bootstrap and in the operator-upgrade migration, whose down narrows back
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  poolQueryMock,
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
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(() => ({ text: "UPDATE finalize", values: [] })),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  findFinalizedMidRunMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  findFinalizedFanoutMessageMaterializationMock: vi.fn(),
  recordFanoutReuseMaterializationMock: vi.fn(),
  isWriteAllowedMock: vi.fn(async () => true),
  resolveBoundArtifactTargetMock: vi.fn(),
  enqueueArtifactMatchRunMock: vi.fn(async (): Promise<void> => {}),
  readArtifactTypeClaimsForOrgMock: vi.fn(),
}));

vi.mock("@/lib/db/pooled", () => ({
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
  getAgentPackage: vi.fn(),
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({
    registryUrl: "http://registry.test",
    token: "test-token",
  })),
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
  findFinalizedMidRunMaterialization: findFinalizedMidRunMaterializationMock,
  findFinalizedFanoutMessageMaterialization: findFinalizedFanoutMessageMaterializationMock,
  recordFanoutReuseMaterialization: recordFanoutReuseMaterializationMock,
  isMaterializationFinalizeConflict: (err: unknown) =>
    err instanceof Error && err.message.includes("materialization-finalize-conflict"),
}));
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: isWriteAllowedMock,
}));
vi.mock("../matcher-enqueue", () => ({
  enqueueArtifactMatchRun: enqueueArtifactMatchRunMock,
}));
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: readArtifactTypeClaimsForOrgMock,
}));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set(["text/markdown", "text/plain"]),
}));

import {
  materializeFanoutMessageRevision,
  writeClaimedArtifact,
} from "../run-artifact-materializer";
import { buildProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";
import { artifactMaterializationLedgerSchemaQueries } from "@/lib/artifact-claim-schema";

const EXT = "@cinatra-ai/email-artifacts";
const BODY_TYPE = "@cinatra-ai/email:body";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
type Outcome = Awaited<ReturnType<typeof materializeFanoutMessageRevision>>;

const MESSAGES = [
  { outputId: "email-body:run-1:d1", title: "Hello One", markdown: "Body one" },
  { outputId: "email-body:run-1:d2", title: "Hello Two", markdown: "Body two" },
];

function bodyInput(m: (typeof MESSAGES)[number]) {
  return {
    runId: "run-1",
    orgId: "org-a",
    createdBy: "user-1",
    objectTypeId: BODY_TYPE,
    outputId: m.outputId,
    title: m.title,
    markdown: m.markdown,
    typedData: { runId: "run-1", campaignId: "camp-1", subject: m.title, bodyMarkdown: m.markdown },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The pack that declares the body type holds the winning platform claim.
  readArtifactTypeClaimsForOrgMock.mockReturnValue([
    {
      id: "claim-1",
      scope: "platform",
      objectTypeId: BODY_TYPE,
      claimKind: "dedicated",
      extensionPackage: EXT,
      status: "active",
      generation: 1,
      dispositions: null,
      installId: null,
      createdAt: null,
      updatedAt: null,
    },
  ]);
  poolQueryMock.mockImplementation(async (text: string) => {
    if (text.includes("SELECT template_id")) return { rows: [{ template_id: "tpl-1" }] };
    if (text.includes("owner_level")) return { rows: [{ owner_level: "organization", owner_id: "org-a" }] };
    if (text.includes("project_id")) return { rows: [{ project_id: null }] };
    return { rows: [] };
  });
  resolveBoundArtifactTargetMock.mockResolvedValue({
    ok: true,
    target: { objectTypeId: BODY_TYPE, acceptedFileMimeTypes: ["text/markdown", "text/plain"] },
  });
  isWriteAllowedMock.mockResolvedValue(true);
  findFinalizedMidRunMaterializationMock.mockResolvedValue(null);
  // The ledger's email_fanout rows a reuse binds, read back as the message's own.
  const bound = new Map<string, { artifactId: string; representationRevisionId: string }>();
  recordFanoutReuseMaterializationMock.mockImplementation(
    async (r: { outputId: string; artifactId: string; representationRevisionId: string }) => {
      if (!bound.has(r.outputId)) {
        bound.set(r.outputId, {
          artifactId: r.artifactId,
          representationRevisionId: r.representationRevisionId,
        });
      }
    },
  );
  findFinalizedFanoutMessageMaterializationMock.mockImplementation(
    async (k: { outputId: string }) => bound.get(k.outputId) ?? null,
  );
  let n = 0;
  claimMaterializationMock.mockImplementation(async () => {
    n += 1;
    return { kind: "claimed", ledgerId: `led-${n}` };
  });
  let a = 0;
  createSemanticArtifactMock.mockImplementation(async () => {
    a += 1;
    return { artifactId: `art-${a}`, representationRevisionId: `rep-${a}` };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cinatra#3089 — materializeFanoutMessageRevision on the ledgered write core", () => {
  it("A1 a fan-out over N draft items writes N body revisions through the ledgered writer on the fan-out's own path, each keyed by the message identity and the content hash", async () => {
    const outcomes: Outcome[] = [];
    for (const m of MESSAGES) outcomes.push(await materializeFanoutMessageRevision(bodyInput(m)));

    expect(outcomes).toEqual([
      { ok: true, artifactId: "art-1", representationRevisionId: "rep-1", deduped: false },
      { ok: true, artifactId: "art-2", representationRevisionId: "rep-2", deduped: false },
    ]);
    expect(claimMaterializationMock).toHaveBeenCalledTimes(2);
    for (const [i, m] of MESSAGES.entries()) {
      expect(claimMaterializationMock.mock.calls[i][0]).toMatchObject({
        orgId: "org-a",
        runId: "run-1",
        outputId: m.outputId,
        nodeId: null,
        path: "email_fanout",
        extension: EXT,
        contentHash: sha256(m.markdown),
      });
    }
    // The declared body type, resolved exactly as the binding road resolves one.
    expect(resolveBoundArtifactTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", extension: EXT, bindingObjectTypeId: BODY_TYPE }),
    );
    for (const call of createSemanticArtifactMock.mock.calls) {
      expect(call[0]).toMatchObject({
        objectType: BODY_TYPE,
        declaredMime: "text/markdown",
        createdByRunId: "run-1",
        producerAssertionExtension: EXT,
      });
    }
    // The revision's own data carries the declared field.
    expect(createSemanticArtifactMock.mock.calls[0][0].typedData).toEqual({
      runId: "run-1",
      campaignId: "camp-1",
      subject: "Hello One",
      bodyMarkdown: "Body one",
    });
  });

  it("A2 each revision carries the live_generator origin and exactly one produced event", async () => {
    for (const m of MESSAGES) await materializeFanoutMessageRevision(bodyInput(m));

    // One create per revision — the create path splices exactly one produced
    // event per create, under the origin it is handed.
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(2);
    for (const call of createSemanticArtifactMock.mock.calls) {
      expect(call[0].originKind).toBe("live_generator");
    }
    const op = buildProducedEventInsertOp("public", {
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      emitter: "createSemanticArtifact",
      originKind: "live_generator",
      producerRunId: "run-1",
      producerAgentId: null,
    });
    expect(op.values[8]).toBe("intermediate");

    // A write that names no origin keeps the writer's agent_generated default
    // and hands the creation path no typed data — every existing caller.
    createSemanticArtifactMock.mockClear();
    await writeClaimedArtifact({
      runId: "run-1",
      orgId: "org-a",
      createdBy: "user-1",
      outputId: "persist_draft",
      nodeId: "persist_draft",
      path: "materialize_tool",
      extension: EXT,
      title: "T",
      mime: "text/markdown",
      content: "# x",
      ownership: { ownerLevel: "organization", ownerId: "org-a", visibility: "organization", projectId: null },
      resolvedTarget: { objectTypeId: BODY_TYPE, acceptedFileMimeTypes: ["text/markdown"] },
      mimeDescription: "the call declared MIME",
    });
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0][0].originKind).toBe("agent_generated");
    expect(createSemanticArtifactMock.mock.calls[0][0]).not.toHaveProperty("typedData");
  });

  it("A3 a retried fan-out over the same drafts writes nothing new and returns the same artifact ids", async () => {
    const first: Outcome[] = [];
    for (const m of MESSAGES) first.push(await materializeFanoutMessageRevision(bodyInput(m)));

    // The retry finds each claim finalized with the first drive's refs.
    claimMaterializationMock.mockImplementation(async (c: { outputId: string }) => {
      const i = MESSAGES.findIndex((m) => m.outputId === c.outputId);
      return {
        kind: "finalized",
        artifactId: `art-${i + 1}`,
        representationRevisionId: `rep-${i + 1}`,
        path: "email_fanout",
      };
    });
    createSemanticArtifactMock.mockClear();
    const second: Outcome[] = [];
    for (const m of MESSAGES) second.push(await materializeFanoutMessageRevision(bodyInput(m)));

    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(second.map((o) => (o.ok ? o.artifactId : null))).toEqual(
      first.map((o) => (o.ok ? o.artifactId : null)),
    );
    expect(second.every((o) => o.ok && o.deduped)).toBe(true);
  });

  it("B1 a fan-out over a body already filed under the same identity key returns that artifact and writes no second one", async () => {
    findFinalizedMidRunMaterializationMock.mockResolvedValue({
      artifactId: "prefiled-1",
      representationRevisionId: "prefiled-rep-1",
    });

    const first = await materializeFanoutMessageRevision(bodyInput(MESSAGES[0]));
    const second = await materializeFanoutMessageRevision(bodyInput(MESSAGES[0]));

    for (const outcome of [first, second]) {
      expect(outcome).toEqual({
        ok: true,
        artifactId: "prefiled-1",
        representationRevisionId: "prefiled-rep-1",
        deduped: true,
      });
    }
    expect(findFinalizedMidRunMaterializationMock).toHaveBeenCalledWith({
      orgId: "org-a",
      runId: "run-1",
      extension: EXT,
      contentHash: sha256("Body one"),
    });
    // The reuse is bound to the message; the retry reads that row first.
    expect(recordFanoutReuseMaterializationMock).toHaveBeenCalledTimes(1);
    expect(recordFanoutReuseMaterializationMock).toHaveBeenCalledWith({
      orgId: "org-a",
      runId: "run-1",
      outputId: MESSAGES[0].outputId,
      extension: EXT,
      contentHash: sha256("Body one"),
      artifactId: "prefiled-1",
      representationRevisionId: "prefiled-rep-1",
    });
    expect(findFinalizedMidRunMaterializationMock).toHaveBeenCalledTimes(1);
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("B2 two messages with the same bytes over one pre-filed body keep one body each", async () => {
    // The mid-run read never hands out an artifact already bound to a message
    // of the run (the NOT EXISTS clause L1 pins).
    findFinalizedMidRunMaterializationMock.mockImplementation(async () =>
      recordFanoutReuseMaterializationMock.mock.calls.length === 0
        ? { artifactId: "prefiled-1", representationRevisionId: "prefiled-rep-1" }
        : null,
    );
    const same = (m: (typeof MESSAGES)[number]) => ({ ...bodyInput(m), markdown: "Same body" });

    const one = await materializeFanoutMessageRevision(same(MESSAGES[0]));
    const two = await materializeFanoutMessageRevision(same(MESSAGES[1]));

    expect(one).toMatchObject({ ok: true, artifactId: "prefiled-1", deduped: true });
    expect(two).toMatchObject({ ok: true, artifactId: "art-1", deduped: false });
    expect(claimMaterializationMock).toHaveBeenCalledTimes(1);
    expect(claimMaterializationMock.mock.calls[0][0]).toMatchObject({
      outputId: MESSAGES[1].outputId,
      path: "email_fanout",
    });
  });

  it("B3 a retried message keeps its own mapping even when a mid-run body of the same bytes is filed between drives", async () => {
    const first = await materializeFanoutMessageRevision(bodyInput(MESSAGES[0]));
    expect(first).toMatchObject({ ok: true, artifactId: "art-1" });

    // Between drives: the message's own finalized row, and a later mid-run body.
    findFinalizedFanoutMessageMaterializationMock.mockResolvedValue({
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
    findFinalizedMidRunMaterializationMock.mockResolvedValue({
      artifactId: "prefiled-late",
      representationRevisionId: "prefiled-late-rep",
    });
    findFinalizedMidRunMaterializationMock.mockClear();
    const retry = await materializeFanoutMessageRevision(bodyInput(MESSAGES[0]));

    expect(retry).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      deduped: true,
    });
    expect(findFinalizedFanoutMessageMaterializationMock).toHaveBeenLastCalledWith({
      orgId: "org-a",
      runId: "run-1",
      outputId: MESSAGES[0].outputId,
      extension: EXT,
      contentHash: sha256("Body one"),
    });
    expect(findFinalizedMidRunMaterializationMock).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
  });

  it("L1 the ledger reads a message's own row, skips a mid-run body bound to another message, and binds a reuse", async () => {
    const ledger = await vi.importActual<typeof import("../materialization-ledger")>(
      "../materialization-ledger",
    );
    poolQueryMock.mockClear();
    poolQueryMock.mockResolvedValue({ rows: [] });

    await ledger.findFinalizedMidRunMaterialization({
      orgId: "org-a",
      runId: "run-1",
      extension: EXT,
      contentHash: "h",
    });
    const [midSql, midParams] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(midSql).toMatch(/m\.path IN \('materialize_tool', 'end_node_binding'\)/);
    expect(midSql).toMatch(/NOT EXISTS \([\s\S]*f\.path = 'email_fanout'[\s\S]*f\.artifact_id = m\.artifact_id/);
    expect(midParams).toEqual(["run-1", EXT, "h", "org-a"]);

    await ledger.findFinalizedFanoutMessageMaterialization({
      orgId: "org-a",
      runId: "run-1",
      outputId: "email-body:run-1:d1",
      extension: EXT,
      contentHash: "h",
    });
    const [ownSql, ownParams] = poolQueryMock.mock.calls[1] as [string, unknown[]];
    expect(ownSql).toMatch(/output_id = \$2/);
    expect(ownSql).toMatch(/path = 'email_fanout' AND phase = 'finalized'/);
    expect(ownParams).toEqual(["run-1", "email-body:run-1:d1", EXT, "h", "org-a"]);

    await ledger.recordFanoutReuseMaterialization({
      orgId: "org-a",
      runId: "run-1",
      outputId: "email-body:run-1:d1",
      extension: EXT,
      contentHash: "h",
      artifactId: "prefiled-1",
      representationRevisionId: "prefiled-rep-1",
    });
    const [insSql, insParams] = poolQueryMock.mock.calls[2] as [string, unknown[]];
    expect(insSql).toMatch(/'email_fanout', \$5, \$6, \$7, \$8, 'finalized'/);
    expect(insSql).toMatch(/ON CONFLICT \(run_id, output_id, extension, content_hash\) DO NOTHING/);
    expect(insParams.slice(1)).toEqual([
      "org-a",
      "run-1",
      "email-body:run-1:d1",
      EXT,
      "h",
      "prefiled-1",
      "prefiled-rep-1",
    ]);
  });

  it("E1 the ledger's path CHECK admits the fan-out's path in the bootstrap and the migration, whose down narrows back", async () => {
    const ddl = artifactMaterializationLedgerSchemaQueries("cinatra")
      .map((q) => q.text)
      .join("\n");
    expect(ddl).toContain(
      "CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road','email_fanout'))",
    );

    const migrationPath = "../../../../migrations/core/core__0109_email-fanout-ledger-path.mjs";
    const migration = (await import(/* @vite-ignore */ migrationPath)) as {
      up: (pgm: { sql: (s: string) => void }) => void;
      down: (pgm: { sql: (s: string) => void }) => void;
    };
    const upSql: string[] = [];
    migration.up({ sql: (s) => upSql.push(s) });
    expect(upSql.join("\n")).toContain(
      "CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road','email_fanout'))",
    );
    const downSql: string[] = [];
    migration.down({ sql: (s) => downSql.push(s) });
    expect(downSql.join("\n")).toContain(
      "CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output','default_road'))",
    );
    expect(downSql.join("\n")).not.toContain("email_fanout'");
    expect(downSql.join("\n")).not.toMatch(/DELETE/i);
  });
});
