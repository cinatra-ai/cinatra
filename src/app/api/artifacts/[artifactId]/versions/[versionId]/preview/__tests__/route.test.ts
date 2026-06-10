import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";

// Preview route handler. Auth + resolver + blob store mocked (no DB /
// fs), mirroring the content route test. Asserts the preview-specific
// contract: 415 outside the allowlist, inline disposition + security
// headers for allowlisted MIMEs, per-MIME 413 byte caps (fail-closed on
// cap drift), and Range -> 206 for media streaming/scrubbing.

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
    // Real disposition helpers + real allowlist: the 415 short-circuit
    // and the inline/attachment split are exactly what this suite pins.
    downloadDispositionFor: actual.downloadDispositionFor,
    previewDispositionFor: actual.previewDispositionFor,
    PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS:
      actual.PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS,
  };
});
vi.mock("@/lib/artifacts/artifact-service", () => ({
  getArtifact: (i: unknown) => getArtifact(i),
}));
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
    "http://localhost:3000/api/artifacts/a1/versions/v1/preview",
    { headers },
  );
  return handler(req, {
    params: Promise.resolve({ artifactId: "a1", versionId: "v1" }),
  });
}

function resolveAs(mime: string, sizeBytes: number) {
  resolveArtifactVersionForServe.mockReturnValue({
    storageKey: "orgs/org1/artifacts/a1/versions/v1/b1.bin",
    mime,
    sizeBytes,
    originKind: "upload",
  });
}

describe("GET artifact preview", () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    requireActorContext.mockReset();
    resolveArtifactVersionForServe.mockReset();
    getArtifact.mockReset();
    isRepresentationPinned.mockReset();
    openByStorageKey.mockReset();
    openRangeByStorageKey.mockReset();
    requireActorContext.mockResolvedValue({
      principalType: "User",
      principalId: "u",
    });
    getArtifact.mockReturnValue({ artifactId: "a1" }); // visible by default
    getAuthSession.mockResolvedValue({
      user: { id: "u" },
      session: { activeOrganizationId: "org1" },
    });
  });
  afterEach(() => vi.resetModules());

  it("401 unauthenticated", async () => {
    getAuthSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(resolveArtifactVersionForServe).not.toHaveBeenCalled();
  });

  it("404 when actor cannot see the artifact", async () => {
    getArtifact.mockReturnValue(null);
    isRepresentationPinned.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(resolveArtifactVersionForServe).not.toHaveBeenCalled();
  });

  it("415 for a non-allowlisted MIME (no bytes served)", async () => {
    resolveAs("application/zip", 10);
    const res = await GET();
    expect(res.status).toBe(415);
    expect(openByStorageKey).not.toHaveBeenCalled();
    expect(openRangeByStorageKey).not.toHaveBeenCalled();
  });

  it("415 for non-allowlisted media containers (quicktime stays excluded)", async () => {
    resolveAs("video/quicktime", 10);
    expect((await GET()).status).toBe(415);
  });

  it("200 + inline + security headers for video/mp4", async () => {
    resolveAs("video/mp4", 5);
    openByStorageKey.mockResolvedValue({ stream: streamOf("video"), sizeBytes: 5 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("200 + inline for audio/mpeg", async () => {
    resolveAs("audio/mpeg", 5);
    openByStorageKey.mockResolvedValue({ stream: streamOf("audio"), sizeBytes: 5 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
  });

  it("206 + Content-Range on a media Range request (scrubbing path)", async () => {
    resolveAs("video/mp4", 100);
    openRangeByStorageKey.mockResolvedValue({
      stream: streamOf("rng"),
      sizeBytes: 10,
      totalSize: 100,
    });
    const res = await GET({ range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-9/100");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(openRangeByStorageKey).toHaveBeenCalledWith(
      expect.objectContaining({ start: 0, end: 9 }),
    );
  });

  it("open-ended bytes=0- range (initial <video> request) is satisfiable", async () => {
    resolveAs("video/mp4", 100);
    openRangeByStorageKey.mockResolvedValue({
      stream: streamOf("rng"),
      sizeBytes: 100,
      totalSize: 100,
    });
    const res = await GET({ range: "bytes=0-" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/100");
  });

  it("416 + Content-Range */size on an unsatisfiable media range", async () => {
    resolveAs("audio/mpeg", 100);
    const res = await GET({ range: "bytes=999-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */100");
    expect(openRangeByStorageKey).not.toHaveBeenCalled();
  });

  it("413 when a video exceeds its byte cap", async () => {
    resolveAs("video/mp4", 501 * 1024 * 1024); // cap is 500MB
    const res = await GET();
    expect(res.status).toBe(413);
    const body = (await res.json()) as { cap: number };
    expect(body.cap).toBe(500 * 1024 * 1024);
    expect(openByStorageKey).not.toHaveBeenCalled();
  });

  it("413 when an audio file exceeds its byte cap", async () => {
    resolveAs("audio/flac", 101 * 1024 * 1024); // cap is 100MB
    expect((await GET()).status).toBe(413);
  });

  it("parity: EVERY allowlisted MIME serves 200 inline at a small size (cap drift fails closed as 415)", async () => {
    for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
      resolveAs(mime, 5);
      openByStorageKey.mockResolvedValue({ stream: streamOf("bytes"), sizeBytes: 5 });
      const res = await GET();
      expect(res.status, `expected 200 for allowlisted ${mime}`).toBe(200);
      expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
    }
  });
});
