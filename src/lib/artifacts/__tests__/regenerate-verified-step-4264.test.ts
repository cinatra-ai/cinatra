/**
 * cinatra#4264 slice B1a, T1: the ledger records the filing step.
 *
 * `claimMaterialization` writes `verified_step_id` only when the runtime's
 * signed step equals the claim's `node_id` (else NULL); a re-drive hits the
 * key and writes nothing, so the first value stays. The image tool's first
 * write (`fileFirstArtifactWrite`) and the append road (`appendArtifactRevision`,
 * compared with the request node, not the composite ledger output id) hand the
 * signed step to the claim.
 *
 * PURE TIER: the pool, the ledger claim and the SQL helper are spies.
 *
 * Red at main: the INSERT carries no `verified_step_id`, and neither road
 * passes a verified step to the claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  claimSpy: vi.fn(),
}));

vi.mock("@/lib/db/pooled", () => ({ getPooledDb: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unit-test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

beforeEach(() => {
  h.poolQuery.mockReset();
  h.claimSpy.mockReset();
});
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/artifacts/materialization-ledger");
});

const BASE = {
  orgId: "org-1",
  runId: "run-1",
  outputId: "file_image",
  nodeId: "file_image",
  path: "materialize_tool" as const,
  extension: "@scope/pack",
  contentHash: "h1",
};

describe("claimMaterialization records the verified filing step (T1)", () => {
  async function claim(over: Record<string, unknown>) {
    h.poolQuery.mockResolvedValueOnce({ rows: [{ id: "ledger-1" }] });
    const { claimMaterialization } = await import("@/lib/artifacts/materialization-ledger");
    await claimMaterialization({ ...BASE, ...over } as Parameters<typeof claimMaterialization>[0]);
    const [text, values] = h.poolQuery.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/verified_step_id\)\s+VALUES \(.*\$13\)/s);
    expect(text).toMatch(/ON CONFLICT \(run_id, output_id, extension, content_hash\) DO NOTHING/);
    return values[12];
  }

  it("stores the verified step when it equals the node", async () => {
    expect(await claim({ verifiedStepId: "file_image" })).toBe("file_image");
  });

  it("stores NULL for a different step, an absent step or an empty one", async () => {
    expect(await claim({ verifiedStepId: "other_node" })).toBeNull();
    h.poolQuery.mockReset();
    expect(await claim({})).toBeNull();
    h.poolQuery.mockReset();
    expect(await claim({ verifiedStepId: "" })).toBeNull();
  });

  it("compares with the node id, not a composite output id (the append road)", async () => {
    expect(
      await claim({ outputId: "file_image:append:art-1:rev-1", nodeId: "file_image", verifiedStepId: "file_image" }),
    ).toBe("file_image");
    h.poolQuery.mockReset();
    expect(
      await claim({ outputId: "file_image", nodeId: "file_image", verifiedStepId: "file_image:append:art-1:rev-1" }),
    ).toBeNull();
  });

  it("a re-drive keeps the first value: the conflict path issues no write", async () => {
    h.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "ledger-1", phase: "finalized", path: "materialize_tool", artifact_id: "a", representation_revision_id: "r" }],
      });
    const { claimMaterialization } = await import("@/lib/artifacts/materialization-ledger");
    const out = await claimMaterialization({ ...BASE, verifiedStepId: "file_image" });
    expect(out.kind).toBe("finalized");
    expect(h.poolQuery).toHaveBeenCalledTimes(2);
    expect(String(h.poolQuery.mock.calls[1]![0])).toMatch(/^\s*SELECT/);
  });
});

describe("the image tool's first write and the append road pass the signed step (T1)", () => {
  it("fileFirstArtifactWrite hands run.verifiedStepId to the claim", async () => {
    vi.doMock("@/lib/artifacts/materialization-ledger", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>()),
      claimMaterialization: h.claimSpy,
    }));
    vi.doMock("@/lib/artifacts/artifact-creation", () => ({ createSemanticArtifact: vi.fn() }));
    vi.doMock("@/lib/artifacts/matcher-enqueue", () => ({ enqueueArtifactMatchRun: vi.fn(async () => undefined) }));
    h.claimSpy.mockRejectedValue(new Error("stop after the claim"));
    const { fileFirstArtifactWrite } = await import("@/lib/artifacts/first-artifact-filing");
    const run = { orgId: "org-1", runId: "run-1", nodeId: "file_image", extension: "@scope/pack" };
    for (const verifiedStepId of ["file_image", undefined]) {
      await fileFirstArtifactWrite({
        tool: "artifact_image_generate",
        run: { ...run, ...(verifiedStepId ? { verifiedStepId } : {}) },
        bytes: Buffer.from([1, 2, 3]),
        mime: "image/png",
        target: { objectTypeId: "@scope/pack:picture", acceptedFileMimeTypes: ["image/png"] },
        writerFields: () => ({ createdBy: "u", title: "t" }),
        additionalTx2Ops: () => [],
        resolveOwnership: async () => ({}) as never,
        readStored: () => ({}),
        texts: { pathCollision: () => "", dataRejected: "", writeFailed: "" },
        logFields: () => ({}),
      }).catch(() => undefined);
    }
    expect(h.claimSpy.mock.calls.map((c) => (c[0] as { verifiedStepId?: unknown }).verifiedStepId)).toEqual([
      "file_image",
      undefined,
    ]);
  });

  it("appendArtifactRevision hands the signed step and the request node to the claim", async () => {
    vi.doMock("@/lib/artifacts/materialization-ledger", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>()),
      claimMaterialization: h.claimSpy,
    }));
    vi.doMock("@/lib/database", () => ({
      ensurePostgresSchema: () => {},
      getPostgresConnectionString: () => "postgres://unit-test",
      postgresSchema: "cinatra",
    }));
    vi.doMock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
    vi.doMock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { resolve: () => undefined } }));
    vi.doMock("@/lib/postgres-async", () => ({
      runPostgresQueriesAsync: async (input: { queries: Array<{ text: string }> }) => {
        const text = input.queries[0]?.text ?? "";
        if (/"objects"/.test(text)) return [{ rows: [{ type: "post" }] }];
        return [{ rows: [{ revision: 1 }] }];
      },
    }));
    h.claimSpy.mockRejectedValue(new Error("stop after the claim"));
    const { appendArtifactRevision } = await import("@/lib/artifacts/artifact-revision-append");
    await appendArtifactRevision({
      orgId: "org-1",
      runId: "run-2",
      nodeId: "file_image",
      verifiedStepId: "file_image",
      artifactId: "art-1",
      baseRepresentationRevisionId: "rev-1",
      content: "text",
      mime: "text/markdown",
      createdBy: null,
      extension: "@scope/pack",
    }).catch(() => undefined);
    expect(h.claimSpy).toHaveBeenCalledTimes(1);
    const arg = h.claimSpy.mock.calls[0]![0] as { nodeId: string; outputId: string; verifiedStepId: unknown };
    expect(arg.nodeId).toBe("file_image");
    expect(arg.outputId).not.toBe("file_image");
    expect(arg.verifiedStepId).toBe("file_image");
  });
});
