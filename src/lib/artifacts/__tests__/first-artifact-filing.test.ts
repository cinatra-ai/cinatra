/**
 * cinatra#4223: THE FIRST-WRITE ROAD THE IMAGE TOOL AND THE PAGE CAPTURE TOOL SHARE.
 *
 * The ledger claim by the run's own identity, the owner read after the claim,
 * the one writer with the caller's second-transaction ops after the finalize,
 * the schema-refusal test, the fixed texts of a failed write with a log line
 * that carries no error text, and the answer of a re-drive and of the loser of
 * a concurrent double drive, read by the caller's stored-result reader.
 *
 * PURE TIER. The ledger claim, the winner read and the writer are spies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  claimMaterialization: vi.fn(),
  readFinalizedMaterialization: vi.fn(),
  createSemanticArtifact: vi.fn(),
  enqueueArtifactMatchRun: vi.fn(async () => undefined),
}));

vi.mock("@/lib/artifacts/materialization-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>()),
  claimMaterialization: h.claimMaterialization,
  readFinalizedMaterialization: h.readFinalizedMaterialization,
}));
vi.mock("@/lib/artifacts/artifact-creation", () => ({ createSemanticArtifact: h.createSemanticArtifact }));
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({ enqueueArtifactMatchRun: h.enqueueArtifactMatchRun }));

import { fileFirstArtifactWrite, type FirstArtifactFilingInput } from "@/lib/artifacts/first-artifact-filing";
import {
  buildFinalizeMaterializationQuery,
  MATERIALIZATION_FINALIZE_CONFLICT_MARKER,
} from "@/lib/artifacts/materialization-ledger";

const BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TARGET = { objectTypeId: "@scope/pack:picture", acceptedFileMimeTypes: ["image/png"] };
const OWNERSHIP = { ownerLevel: "organization", ownerId: "org-1", visibility: "organization", projectId: null };
const EXTRA_OP = { text: "INSERT INTO extra", values: ["x"] };
// Assembled at runtime so no committed line carries a complete scheme, userinfo and host literal for a
// secret scanner to trip on.
const SECRET = ["postgres:", "", "user:hunter2@db.internal:5432", "app"].join("/");

type Answer = { served: string };

let reads: Array<{ artifactId: string; representationRevisionId: string }> = [];
let owners = 0;
let written: Array<{ input: Record<string, unknown>; bytes: Buffer; tx2: Array<{ text: string; values: unknown[] }> }> =
  [];
let extraCalls: Array<{ ledgerId: string; artifactId: string; representationRevisionId: string }> = [];
let writerReads = 0;
let logged: ReturnType<typeof vi.spyOn>;

function filingInput(over: Partial<FirstArtifactFilingInput<Answer>> = {}): FirstArtifactFilingInput<Answer> {
  return {
    tool: "some_tool",
    run: { orgId: "org-1", runId: "run-1", nodeId: "node-1", extension: "@scope/pack" },
    bytes: BYTES,
    mime: "image/png",
    target: TARGET,
    writerFields: () => {
      writerReads += 1;
      return { createdBy: "user-1", title: "A title" };
    },
    typedData: () => ({ field: "value" }),
    additionalTx2Ops: (ids) => {
      extraCalls.push(ids);
      return [EXTRA_OP];
    },
    resolveOwnership: async () => {
      owners += 1;
      return OWNERSHIP as never;
    },
    readStored: async (filed) => {
      reads.push(filed);
      return { served: `${filed.artifactId}/${filed.representationRevisionId}` };
    },
    texts: {
      pathCollision: (path) => `collided with "${path}"`,
      dataRejected: "DATA REJECTED",
      writeFailed: "WRITE FAILED",
    },
    logFields: () => ({ orgId: "org-1", runId: "run-1", nodeId: "node-1", extension: "@scope/pack" }),
    ...over,
  };
}

beforeEach(() => {
  reads = [];
  owners = 0;
  written = [];
  extraCalls = [];
  writerReads = 0;
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  h.claimMaterialization.mockResolvedValue({ kind: "claimed", ledgerId: "ledger-1" });
  h.createSemanticArtifact.mockImplementation(
    async (input: {
      stream: AsyncIterable<Uint8Array>;
      additionalTx2Queries: (ids: { artifactId: string; representationRevisionId: string }) => Array<{
        text: string;
        values: unknown[];
      }>;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      written.push({
        input: input as unknown as Record<string, unknown>,
        bytes: Buffer.concat(chunks),
        tx2: input.additionalTx2Queries({ artifactId: "art-1", representationRevisionId: "rev-1" }),
      });
      return { objectId: "art-1", artifactId: "art-1", resourceId: "res-1", representationRevisionId: "rev-1" };
    },
  );
});

afterEach(() => {
  logged.mockRestore();
  vi.clearAllMocks();
});

function loggedText(): string {
  return JSON.stringify(logged.mock.calls);
}

describe("fileFirstArtifactWrite (cinatra#4223)", () => {
  it("claims the ledger by the run's identity, reads the owner after the claim, writes once and finalizes first", async () => {
    const outcome = await fileFirstArtifactWrite(filingInput());
    expect(outcome).toEqual({ kind: "filed", artifactId: "art-1", representationRevisionId: "rev-1" });
    expect(h.claimMaterialization).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "run-1",
      outputId: "node-1",
      nodeId: "node-1",
      path: "materialize_tool",
      extension: "@scope/pack",
      contentHash: createHash("sha256").update(BYTES).digest("hex"),
    });
    expect(owners).toBe(1);
    expect(written).toHaveLength(1);
    expect(written[0].bytes.equals(BYTES)).toBe(true);
    expect(written[0].input).toMatchObject({
      orgId: "org-1",
      objectType: TARGET.objectTypeId,
      expectedAcceptMimes: TARGET.acceptedFileMimeTypes,
      createdBy: "user-1",
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      title: "A title",
      declaredMime: "image/png",
      originKind: "agent_generated",
      createdByRunId: "run-1",
      producerAssertionExtension: "@scope/pack",
      skipFallbackClassification: true,
      typedData: { field: "value" },
    });
    expect(written[0].tx2).toEqual([
      buildFinalizeMaterializationQuery({
        ledgerId: "ledger-1",
        orgId: "org-1",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
      }),
      EXTRA_OP,
    ]);
    expect(extraCalls).toEqual([{ ledgerId: "ledger-1", artifactId: "art-1", representationRevisionId: "rev-1" }]);
    expect(h.enqueueArtifactMatchRun).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      createdByRunId: "run-1",
    });
    expect(reads).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("passes no typedData when the caller gives none, and a failed matcher enqueue never fails the filing", async () => {
    h.enqueueArtifactMatchRun.mockRejectedValueOnce(new Error(SECRET));
    const outcome = await fileFirstArtifactWrite(filingInput({ typedData: () => undefined }));
    expect(outcome).toEqual({ kind: "filed", artifactId: "art-1", representationRevisionId: "rev-1" });
    expect("typedData" in written[0].input).toBe(false);
    expect(loggedText()).not.toContain("hunter2");
  });

  it("serves a re-drive of the same node and bytes from the stored-result reader, with no owner read and no write", async () => {
    h.claimMaterialization.mockResolvedValueOnce({
      kind: "finalized",
      artifactId: "art-0",
      representationRevisionId: "rev-0",
      path: "materialize_tool",
    });
    const outcome = await fileFirstArtifactWrite(filingInput());
    expect(outcome).toEqual({ kind: "served", answer: { served: "art-0/rev-0" } });
    expect(reads).toEqual([{ artifactId: "art-0", representationRevisionId: "rev-0" }]);
    expect(owners).toBe(0);
    expect(writerReads).toBe(0);
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
    expect(h.enqueueArtifactMatchRun).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "claimed", ledgerId: "ledger-1", path: "run_completion" },
    { kind: "finalized", artifactId: "art-0", representationRevisionId: "rev-0", path: "run_completion" },
  ])("refuses a claim another path owns ($kind) with the caller's sentence, before any owner read or write", async (claim) => {
    h.claimMaterialization.mockResolvedValueOnce(claim);
    const outcome = await fileFirstArtifactWrite(filingInput());
    expect(outcome).toEqual({ kind: "refused", reason: "write_refused", error: 'collided with "run_completion"' });
    expect(owners).toBe(0);
    expect(reads).toEqual([]);
    expect(writerReads).toBe(0);
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
  });

  it("answers a writer field that throws as a failed write, logged with the caller's log fields", async () => {
    const outcome = await fileFirstArtifactWrite(
      filingInput({
        writerFields: () => {
          throw new RangeError(SECRET);
        },
        logFields: () => ({ orgId: "org-1", runId: "run-1", nodeId: "unreadable", extension: "@scope/pack" }),
      }),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "write_refused", error: "WRITE FAILED" });
    expect(owners).toBe(1);
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("[some_tool] failed; the error's own text is not logged", {
      orgId: "org-1",
      runId: "run-1",
      nodeId: "unreadable",
      extension: "@scope/pack",
      errorClass: "RangeError",
    });
    expect(loggedText()).not.toContain("hunter2");
  });

  it("answers a schema refusal of the writer as data_rejected with the caller's fixed text, logging the class word only", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(
      new Error(`object payload does not satisfy the declared schema of "${TARGET.objectTypeId}": ${SECRET}`),
    );
    const outcome = await fileFirstArtifactWrite(filingInput());
    expect(outcome).toEqual({ kind: "refused", reason: "data_rejected", error: "DATA REJECTED" });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("[some_tool] failed; the error's own text is not logged", {
      orgId: "org-1",
      runId: "run-1",
      nodeId: "node-1",
      extension: "@scope/pack",
      errorClass: "Error",
    });
    expect(loggedText()).not.toContain("hunter2");
    expect(h.enqueueArtifactMatchRun).not.toHaveBeenCalled();
  });

  it("answers any other writer error as write_refused with the caller's fixed text, and logs no error text", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(new TypeError(`connect failed: ${SECRET}`));
    const outcome = await fileFirstArtifactWrite(filingInput());
    expect(outcome).toEqual({ kind: "refused", reason: "write_refused", error: "WRITE FAILED" });
    expect(logged).toHaveBeenCalledWith("[some_tool] failed; the error's own text is not logged", {
      orgId: "org-1",
      runId: "run-1",
      nodeId: "node-1",
      extension: "@scope/pack",
      errorClass: "TypeError",
    });
    expect(loggedText()).not.toContain("hunter2");
    expect(reads).toEqual([]);
  });

  it("serves the loser of a concurrent double drive from the winner's revision, through the stored-result reader", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(
      new Error(`${MATERIALIZATION_FINALIZE_CONFLICT_MARKER}: claim already finalized by a concurrent writer; rows=0`),
    );
    h.readFinalizedMaterialization.mockResolvedValueOnce({ artifactId: "art-w", representationRevisionId: "rev-w" });
    const outcome = await fileFirstArtifactWrite(filingInput());
    expect(outcome).toEqual({ kind: "served", answer: { served: "art-w/rev-w" } });
    expect(h.readFinalizedMaterialization).toHaveBeenCalledWith({ orgId: "org-1", ledgerId: "ledger-1" });
    expect(reads).toEqual([{ artifactId: "art-w", representationRevisionId: "rev-w" }]);
    expect(logged).not.toHaveBeenCalled();
    expect(h.enqueueArtifactMatchRun).not.toHaveBeenCalled();
  });

  it("answers a conflict whose winner does not read as a failed write", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(new Error(`${MATERIALIZATION_FINALIZE_CONFLICT_MARKER}: rows=0`));
    h.readFinalizedMaterialization.mockResolvedValueOnce(null);
    const outcome = await fileFirstArtifactWrite(filingInput());
    expect(outcome).toEqual({ kind: "refused", reason: "write_refused", error: "WRITE FAILED" });
    expect(reads).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("lets a throw of the claim reach the caller's own catch", async () => {
    h.claimMaterialization.mockRejectedValueOnce(new Error(SECRET));
    await expect(fileFirstArtifactWrite(filingInput())).rejects.toThrow();
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
  });
});
