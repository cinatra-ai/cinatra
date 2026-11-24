import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  readRun: vi.fn(), context: vi.fn(), target: vi.fn(), allowed: vi.fn(), ownership: vi.fn(),
  claim: vi.fn(), create: vi.fn(), finalize: vi.fn(), winner: vi.fn(), assertion: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({ readAgentRunById: mock.readRun }));
vi.mock("@cinatra-ai/mcp-server", () => ({ mcpRequestContextStorage: { run: (_context: unknown, f: () => unknown) => f() } }));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({ loadRunDerivationContext: mock.context, resolveRunScopeOwnership: mock.ownership }));
vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({ resolveBoundArtifactTarget: mock.target }));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({ isArtifactExtensionWriteAllowed: mock.allowed }));
vi.mock("@/lib/artifacts/artifact-creation", () => ({ createSemanticArtifact: mock.create }));
vi.mock("@/lib/artifacts/producer-assertions", () => ({ resolveProducerAssertionPlan: mock.assertion }));
// The facts record names the configured schema; the reader below is handed its rows.
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => { throw new Error("no database in this suite"); },
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/artifacts/materialization-ledger", () => ({
  claimMaterialization: mock.claim, buildFinalizeMaterializationQuery: mock.finalize,
  isMaterializationFinalizeConflict: (e: Error) => e.message === "finalize-conflict", readFinalizedMaterialization: mock.winner,
}));
import { prepareScreenshotProducer } from "../../../scripts/fixtures/lib/file-screenshot";
import { projectRecordedPageCaptureFacts } from "@/lib/artifacts/page-capture-facts-record";

const extension = "@cinatra-ai/screenshot-artifact";
const facts = { capturedUrl: "http://localhost:3007/artifacts/example", viewport: { width: 640, height: 480 }, capturedAt: "2026-09-19T12:00:00.000Z" };
const capture = { bytes: Buffer.from([0, 255, 128, 17]), facts };
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  mock.readRun.mockResolvedValue({ id: "run", orgId: "org", status: "completed", templateId: "template", packageVersion: "0.1.0", runBy: "user", projectId: null });
  mock.context.mockResolvedValue({ producesRefs: [{ extension }] });
  mock.assertion.mockResolvedValue({ validatedRunId: "run", produces: [extension] });
  mock.target.mockResolvedValue({ ok: true, target: { objectTypeId: `${extension}:screenshot`, acceptedFileMimeTypes: ["image/png"] } });
  mock.allowed.mockResolvedValue(true);
  mock.ownership.mockResolvedValue({ ownerLevel: "organization", ownerId: "org", visibility: "organization" });
  mock.claim.mockResolvedValue({ kind: "claimed", ledgerId: "ledger" });
  mock.create.mockResolvedValue({ artifactId: "artifact", representationRevisionId: "revision" });
  mock.finalize.mockReturnValue({ text: "finalize", values: [] });
});
describe("development screenshot producer", () => {
  it("files exact binary bytes and measured facts, with finalization in the artifact transaction", async () => {
    const file = await prepareScreenshotProducer("run", "org");
    const result = await file(capture, "capture-light", "Screenshot");
    const input = mock.create.mock.calls[0][0];
    const chunks: Uint8Array[] = [];
    for await (const bytes of input.stream) chunks.push(bytes);
    expect(Buffer.concat(chunks)).toEqual(capture.bytes);
    expect(input).toMatchObject({ typedData: facts, createdByRunId: "run", producerAssertionExtension: extension, declaredMime: "image/png", skipFallbackClassification: true });
    const queries = input.additionalTx2Queries({ artifactId: "artifact", representationRevisionId: "revision" });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toEqual({ text: "finalize", values: [] });
    expect(mock.finalize).toHaveBeenCalledWith({ ledgerId: "ledger", orgId: "org", artifactId: "artifact", representationRevisionId: "revision" });
    expect(result).toMatchObject({ artifactId: "artifact", runId: "run", deduped: false });
  });
  it("writes the page capture facts record with the revision, in the artifact transaction (#3459)", async () => {
    const file = await prepareScreenshotProducer("run", "org");
    await file(capture, "capture-light", "Screenshot");
    const queries = mock.create.mock.calls[0][0].additionalTx2Queries({ artifactId: "artifact", representationRevisionId: "revision" });
    const record = queries.find((q: { text: string }) => /"artifact_audit"/.test(q.text));
    expect(record, "no page capture facts record in the filing transaction").toBeDefined();
    expect(record.text).toMatch(/INSERT INTO "cinatra"\."artifact_audit"/);
    expect(record.values.slice(0, 4)).toEqual(["org", "artifact", "revision", "page_capture_facts"]);
    expect(JSON.parse(record.values[4])).toEqual({ v: 1, objectType: `${extension}:screenshot`, ...facts });
  });
  it("files a record the file view reads back as the revision's facts row (#3459)", async () => {
    const file = await prepareScreenshotProducer("run", "org");
    await file(capture, "capture-light", "Screenshot");
    const queries = mock.create.mock.calls[0][0].additionalTx2Queries({ artifactId: "artifact", representationRevisionId: "revision" });
    const record = queries.find((q: { text: string }) => /"artifact_audit"/.test(q.text));
    expect(record, "no page capture facts record in the filing transaction").toBeDefined();
    const runQuery = vi.fn(() => [{ detail: JSON.parse(record.values[4]) }]);
    const content = projectRecordedPageCaptureFacts({
      orgId: "org", artifactId: "artifact", representationRevisionId: "revision", objectType: `${extension}:screenshot`,
      fileProjection: { kind: "none", channelVersion: 1, representationRevisionId: "revision", reason: "unsupported-form" },
    }, { runQuery });
    expect(content).toMatchObject({ kind: "object", source: "snapshot", objectType: `${extension}:screenshot`, representationRevisionId: "revision", data: facts });
  });
  it("refuses facts the record cannot take before the ledger claim or any write (#3459)", async () => {
    const file = await prepareScreenshotProducer("run", "org");
    const longUrl = `http://localhost:3007/${"a".repeat(2100)}`;
    await expect(file({ ...capture, facts: { ...facts, capturedUrl: longUrl } }, "capture-light", "Screenshot")).rejects.toThrow(/cannot be recorded/);
    expect(mock.claim).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("refuses a cross-org run before checking declarations or writing", async () => {
    await expect(prepareScreenshotProducer("run", "another-org")).rejects.toThrow(/requested organization/);
    expect(mock.context).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("requires the executed package's produces declaration", async () => {
    mock.context.mockResolvedValue({ producesRefs: [] });
    await expect(prepareScreenshotProducer("run", "org")).rejects.toThrow(/cinatra.produces/);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("refuses a queued run that has not actually executed", async () => {
    mock.readRun.mockResolvedValue({ id: "run", orgId: "org", status: "queued" });
    await expect(prepareScreenshotProducer("run", "org")).rejects.toThrow(/completed real run/);
    expect(mock.context).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("refuses an archived or denied extension before writing", async () => {
    mock.allowed.mockResolvedValue(false);
    await expect(prepareScreenshotProducer("run", "org")).rejects.toThrow(/not writable/);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("refuses a missing pinned producer manifest instead of silently losing its assertion", async () => {
    mock.assertion.mockResolvedValue({ validatedRunId: "run", produces: [] });
    await expect(prepareScreenshotProducer("run", "org")).rejects.toThrow(/pinned producer manifest/);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("returns the existing artifact when re-driven", async () => {
    mock.claim.mockResolvedValue({ kind: "finalized", path: "materialize_tool", artifactId: "prior", representationRevisionId: "prior-revision" });
    const file = await prepareScreenshotProducer("run", "org");
    expect(await file(capture, "capture-light", "Screenshot")).toMatchObject({ artifactId: "prior", deduped: true });
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("recovers the finalized winner when two captures race", async () => {
    mock.create.mockRejectedValue(new Error("finalize-conflict"));
    mock.winner.mockResolvedValue({ artifactId: "winner", representationRevisionId: "winner-revision" });
    const file = await prepareScreenshotProducer("run", "org");
    expect(await file(capture, "capture-light", "Screenshot")).toMatchObject({ artifactId: "winner", deduped: true });
  });
});
