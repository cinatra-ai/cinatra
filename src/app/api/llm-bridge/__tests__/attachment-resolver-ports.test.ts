import { describe, it, expect, vi, beforeEach } from "vitest";

// Bridge-side resolver ports. All cache/blob/upload sites are scoped to a
// caller-supplied orgId (NOT a bridge-token actor's org). A
// hijacked bridge token must not be able to pivot to a different tenant's
// artifacts — these tests prove the orgId scoping on each side.

const {
  getCachedProviderFileMock,
  putCachedProviderFileMock,
  resolveArtifactVersionForServeMock,
  blobOpenMock,
  orchestrateUploadFileMock,
} = vi.hoisted(() => ({
  getCachedProviderFileMock: vi.fn(),
  putCachedProviderFileMock: vi.fn(),
  resolveArtifactVersionForServeMock: vi.fn(),
  blobOpenMock: vi.fn(),
  orchestrateUploadFileMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  uploadFile: orchestrateUploadFileMock,
}));
vi.mock("@/lib/artifacts/provider-file-cache", () => ({
  getCachedProviderFile: getCachedProviderFileMock,
  putCachedProviderFile: putCachedProviderFileMock,
}));
vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: resolveArtifactVersionForServeMock,
}));
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({ openByStorageKey: blobOpenMock }),
}));

import { buildBridgeAttachmentResolverPorts } from "../attachment-resolver-ports";

const ORG = "org-x";
const ref = {
  artifactId: "art1",
  representationRevisionId: "ver1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload" as const,
  filename: "in.pdf",
  size: 4096,
};

describe("buildBridgeAttachmentResolverPorts", () => {
  beforeEach(() => {
    getCachedProviderFileMock.mockReset();
    putCachedProviderFileMock.mockReset();
    resolveArtifactVersionForServeMock.mockReset();
    blobOpenMock.mockReset();
    orchestrateUploadFileMock.mockReset();
  });

  it("cacheGet: passes orgId + version + digest + provider into the cache lookup", () => {
    getCachedProviderFileMock.mockReturnValue({
      providerFileId: "file_cached",
      mime: "application/pdf",
      sizeBytes: 4096,
      expiresAt: null,
    });
    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    const hit = ports.cacheGet(ref, "openai");
    expect(hit).toEqual({
      providerFileId: "file_cached",
      mime: "application/pdf",
      sizeBytes: 4096,
    });
    expect(getCachedProviderFileMock).toHaveBeenCalledWith({
      orgId: ORG,
      artifactId: ref.artifactId,
      representationRevisionId: ref.representationRevisionId,
      digest: ref.digest,
      provider: "openai",
    });
  });

  it("cacheGet: a cache miss returns null (NOT undefined) — resolver contract", () => {
    getCachedProviderFileMock.mockReturnValue(null);
    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    expect(ports.cacheGet(ref, "anthropic")).toBeNull();
  });

  it("providerUpload: reads the blob scoped to orgId, uploads via orchestrate, returns id", async () => {
    resolveArtifactVersionForServeMock.mockReturnValue({
      storageKey: "orgs/o/artifacts/x/versions/r/blob-abc.bin",
      mime: "application/pdf",
      sizeBytes: 4096,
      originKind: "upload",
    });
    async function* stream() {
      yield new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    }
    blobOpenMock.mockResolvedValue({
      sizeBytes: 4,
      mimeDetected: "application/pdf",
      stream: stream(),
    });
    orchestrateUploadFileMock.mockResolvedValue({ id: "file_uploaded", provider: "openai" });

    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    const out = await ports.providerUpload(ref, "openai", { maxBytes: 32 * 1024 * 1024, nativeKind: "openai_input_file" });
    expect(out).toEqual({
      providerFileId: "file_uploaded",
      mime: "application/pdf",
      sizeBytes: 4096,
    });

    // orgId MUST scope the artifact lookup (cross-tenant guard).
    // Bridge resolver passes `liveOnly: true` so a tombstoned-but-pinned
    // representation is NOT replayable via the bridge. Pin override is
    // route-only.
    expect(resolveArtifactVersionForServeMock).toHaveBeenCalledWith({
      orgId: ORG,
      artifactId: ref.artifactId,
      representationRevisionId: ref.representationRevisionId,
      liveOnly: true,
    });
    // Open by the resource-bound storage_key (not by scope). The org prefix
    // on the storage_key is the tenant guard, enforced inside
    // local-disk-blob-store.assertOrgPrefix.
    expect(blobOpenMock).toHaveBeenCalledWith({
      orgId: ORG,
      storageKey: "orgs/o/artifacts/x/versions/r/blob-abc.bin",
    });
    // The upload uses the ref's filename + mime — NOT the cache row's
    // mime (which could be stale or wrong-tenant).
    expect(orchestrateUploadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        filename: "in.pdf",
        mimeType: "application/pdf",
      }),
    );
  });

  it("providerUpload: artifact version not resolvable → throws (turn degrades to manifest)", async () => {
    resolveArtifactVersionForServeMock.mockReturnValue(null);
    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    await expect(
      ports.providerUpload(ref, "openai", { maxBytes: 32 * 1024 * 1024, nativeKind: "openai_input_file" }),
    ).rejects.toThrow(/artifact version not resolvable/);
    expect(blobOpenMock).not.toHaveBeenCalled();
    expect(orchestrateUploadFileMock).not.toHaveBeenCalled();
  });

  it("providerUpload: rejects when authoritative sizeBytes > capability.maxBytes", async () => {
    resolveArtifactVersionForServeMock.mockReturnValue({
      storageKey: "orgs/o/artifacts/x/versions/r/blob-big.bin",
      mime: "application/pdf",
      sizeBytes: 99 * 1024 * 1024, // 99 MB
      originKind: "upload",
    });
    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    await expect(
      ports.providerUpload(ref, "openai", { maxBytes: 32 * 1024 * 1024, nativeKind: "openai_input_file" }),
    ).rejects.toThrow(new RegExp(`exceeds the ${32 * 1024 * 1024}-byte limit`));
    expect(blobOpenMock).not.toHaveBeenCalled();
    expect(orchestrateUploadFileMock).not.toHaveBeenCalled();
  });

  it("providerUpload: rejects when authoritative mime disagrees with ref.mime", async () => {
    resolveArtifactVersionForServeMock.mockReturnValue({
      storageKey: "orgs/o/artifacts/x/versions/r/blob-x.bin",
      mime: "application/zip", // authoritative
      sizeBytes: 1024,
      originKind: "upload",
    });
    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    await expect(
      ports.providerUpload(ref /* ref.mime = application/pdf */, "openai", { maxBytes: 32 * 1024 * 1024, nativeKind: "openai_input_file" }),
    ).rejects.toThrow(/mime mismatch/);
    expect(blobOpenMock).not.toHaveBeenCalled();
  });

  it("providerUpload: streaming byte counter trips mid-read if stream over-delivers", async () => {
    resolveArtifactVersionForServeMock.mockReturnValue({
      storageKey: "orgs/o/artifacts/x/versions/r/blob-y.bin",
      mime: "application/pdf",
      sizeBytes: 1024, // claims small
      originKind: "upload",
    });
    async function* runaway() {
      // Emit 2 MB total — exceeds a 1 MB cap mid-stream.
      yield new Uint8Array(512 * 1024);
      yield new Uint8Array(512 * 1024);
      yield new Uint8Array(1024 * 1024);
    }
    blobOpenMock.mockResolvedValue({
      sizeBytes: 1024,
      mimeDetected: "application/pdf",
      stream: runaway(),
    });
    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    await expect(
      ports.providerUpload(ref, "openai", { maxBytes: 1024 * 1024, nativeKind: "openai_input_file" }),
    ).rejects.toThrow(new RegExp(`exceeded the ${1024 * 1024}-byte cap mid-read`));
    expect(orchestrateUploadFileMock).not.toHaveBeenCalled();
  });

  it("cachePut: writes AUTHORITATIVE mime + sizeBytes from the resolver", () => {
    const ports = buildBridgeAttachmentResolverPorts({ orgId: ORG });
    // The resolver now passes value:{providerFileId, mime, sizeBytes, ttlMs}
    // sourced from the upload return (AUTHORITATIVE), NOT ref.mime/ref.size.
    ports.cachePut(ref, "gemini", {
      providerFileId: "https://gen/v1beta/files/x",
      mime: "application/pdf",
      sizeBytes: 12345,
      ttlMs: 60_000,
    });
    expect(putCachedProviderFileMock).toHaveBeenCalledWith(
      {
        orgId: ORG,
        artifactId: ref.artifactId,
        representationRevisionId: ref.representationRevisionId,
        digest: ref.digest,
        provider: "gemini",
      },
      {
        providerFileId: "https://gen/v1beta/files/x",
        mime: "application/pdf",
        sizeBytes: 12345,
        ttlMs: 60_000,
      },
    );
  });

  it("two ports built for DIFFERENT orgs do NOT bleed into each other's lookups", () => {
    getCachedProviderFileMock.mockReturnValue(null);
    const a = buildBridgeAttachmentResolverPorts({ orgId: "org-A" });
    const b = buildBridgeAttachmentResolverPorts({ orgId: "org-B" });
    a.cacheGet(ref, "openai");
    b.cacheGet(ref, "openai");
    const calls = getCachedProviderFileMock.mock.calls;
    expect(calls[0]?.[0]?.orgId).toBe("org-A");
    expect(calls[1]?.[0]?.orgId).toBe("org-B");
  });
});
