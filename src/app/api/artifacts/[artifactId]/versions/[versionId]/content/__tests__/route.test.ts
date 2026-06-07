import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Serve route handler. Auth + resolver + blob store mocked (no DB / fs).
// Asserts authz, tenant 404, headers, disposition policy, and Range -> 206.

const getAuthSession = vi.fn();
const requireActorContext = vi.fn();
const resolveArtifactVersionForServe = vi.fn();
const getArtifact = vi.fn();
const isRepresentationPinned = vi.fn();
const openByStorageKey = vi.fn();
const openRangeByStorageKey = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  requireActorContext: () => requireActorContext(),
}));
vi.mock("@/lib/artifacts/artifact-read", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/artifacts/artifact-read")
  >("@/lib/artifacts/artifact-read");
  return {
    resolveArtifactVersionForServe: (i: unknown) =>
      resolveArtifactVersionForServe(i),
    // `contentDispositionFor` was split into separate download + preview
    // helpers. The content route now calls `downloadDispositionFor`
    // explicitly (always `attachment` regardless of MIME). The mock
    // surfaces both new helpers so the route can re-import without
    // redirect-through-the-shim drift.
    downloadDispositionFor: actual.downloadDispositionFor,
    previewDispositionFor: actual.previewDispositionFor,
  };
});
// Route gates on `getArtifact` for actor-scoped visibility BEFORE resolving
// the representation. Mocked here to drive visible/not-visible cases without
// standing up the full actor-context + objects-store machinery.
vi.mock("@/lib/artifacts/artifact-service", () => ({
  getArtifact: (i: unknown) => getArtifact(i),
}));
// Replay-safe pin override: when getArtifact denies (tombstoned or
// actor-denied), the route falls back to isRepresentationPinned. If pinned,
// serve continues; else 404.
vi.mock("@/lib/artifacts/artifact-refs-store", () => ({
  isRepresentationPinned: (...a: unknown[]) => isRepresentationPinned(...a),
}));
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({ openByStorageKey, openRangeByStorageKey }),
}));

function streamOf(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

async function GET(opts?: { range?: string }) {
  const { GET: handler } = await import("../route");
  const headers = new Headers();
  if (opts?.range) headers.set("range", opts.range);
  const req = new Request(
    "http://localhost:3000/api/artifacts/a1/versions/v1/content",
    { headers },
  );
  return handler(req, {
    params: Promise.resolve({ artifactId: "a1", versionId: "v1" }),
  });
}

describe("GET artifact content", () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    requireActorContext.mockReset();
    resolveArtifactVersionForServe.mockReset();
    getArtifact.mockReset();
    isRepresentationPinned.mockReset();
    openByStorageKey.mockReset();
    openRangeByStorageKey.mockReset();
    // Default actor + visible — individual tests override to drive the
    // not-visible 404 case.
    requireActorContext.mockResolvedValue({
      principalType: "User",
      principalId: "u",
    });
    getArtifact.mockReturnValue({ artifactId: "a1" }); // visible by default
  });
  afterEach(() => vi.resetModules());

  it("401 unauthenticated", async () => {
    getAuthSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("404 when actor cannot see the artifact", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    getArtifact.mockReturnValue(null); // owner gate denies
    isRepresentationPinned.mockReturnValue(false); // and no pin saves it
    const res = await GET();
    expect(res.status).toBe(404);
    expect(resolveArtifactVersionForServe).not.toHaveBeenCalled();
  });

  it("tombstoned-but-actor-visible-and-pinned serves bytes via the deleted-allowed pin override", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    // First getArtifact() call (live + actor-visible) returns null
    // because the artifact is tombstoned. Second getArtifact() call
    // (allowDeleted: true + actor-visible) returns truthy because
    // the actor WOULD have been allowed to see the live artifact —
    // the pin is authorized. Pin-override fires → serve continues.
    getArtifact
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ artifactId: "a1" });
    isRepresentationPinned.mockReturnValue(true);
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "orgs/org1/artifacts/a1/versions/v1/b1.bin",
      mime: "application/pdf",
      sizeBytes: 5,
      originKind: "upload",
    });
    openByStorageKey.mockResolvedValue({ stream: streamOf("pinned"), sizeBytes: 6 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(getArtifact).toHaveBeenCalledTimes(2);
    expect(isRepresentationPinned).toHaveBeenCalled();
    expect(resolveArtifactVersionForServe).toHaveBeenCalled();
  });

  it("actor-denied gets 404 even when a pin exists", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    // Both getArtifact() calls return null — actor cannot see the
    // artifact even with allowDeleted: true. A pin row exists but
    // does NOT authorize bytes for a denied actor.
    getArtifact.mockReturnValue(null);
    isRepresentationPinned.mockReturnValue(true); // pin exists but unauthorized
    const res = await GET();
    expect(res.status).toBe(404);
    // Pin check should NOT be reached (route returns 404 after the
    // second allowDeleted getArtifact() returns null).
    expect(isRepresentationPinned).not.toHaveBeenCalled();
    expect(resolveArtifactVersionForServe).not.toHaveBeenCalled();
  });

  it("404 when version does not resolve for this org (tenant isolation)", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    resolveArtifactVersionForServe.mockReturnValue(null);
    expect((await GET()).status).toBe(404);
  });

  it("200 + security headers + attachment for non-inline mime", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "orgs/org1/artifacts/a1/versions/v1/b1.bin",
      mime: "application/pdf",
      sizeBytes: 5,
      originKind: "upload",
    });
    openByStorageKey.mockResolvedValue({ stream: streamOf("hello"), sizeBytes: 5 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("always serves attachment from the download route, even for image mimes", async () => {
    // The download route NEVER serves `inline` regardless of MIME — the
    // inline allowlist belongs to the separate preview route. An image mime
    // must still come back as `attachment` here.
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "orgs/org1/artifacts/a1/versions/v1/b1.bin",
      mime: "image/png",
      sizeBytes: 3,
      originKind: "upload",
    });
    openByStorageKey.mockResolvedValue({ stream: streamOf("png"), sizeBytes: 3 });
    const res = await GET();
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("416 + Content-Range:*/size on an unsatisfiable range", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "orgs/org1/artifacts/a1/versions/v1/b1.bin",
      mime: "application/octet-stream",
      sizeBytes: 100,
      originKind: "upload",
    });
    const res = await GET({ range: "bytes=999-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */100");
    expect(openRangeByStorageKey).not.toHaveBeenCalled();
  });

  it("malformed range is ignored → full 200", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "orgs/org1/artifacts/a1/versions/v1/b1.bin",
      mime: "application/octet-stream",
      sizeBytes: 50,
      originKind: "upload",
    });
    openByStorageKey.mockResolvedValue({ stream: streamOf("xxxxx"), sizeBytes: 50 });
    const res = await GET({ range: "rows=0-9" });
    expect(res.status).toBe(200);
  });

  it("206 + Content-Range on a Range request", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
    resolveArtifactVersionForServe.mockReturnValue({
      storageKey: "orgs/org1/artifacts/a1/versions/v1/b1.bin",
      mime: "application/octet-stream",
      sizeBytes: 100,
      originKind: "upload",
    });
    openRangeByStorageKey.mockResolvedValue({
      stream: streamOf("rng"),
      sizeBytes: 10,
      totalSize: 100,
    });
    const res = await GET({ range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-9/100");
    expect(openRangeByStorageKey).toHaveBeenCalled();
  });
});
