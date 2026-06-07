import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobTooLargeError } from "@cinatra-ai/artifacts";

// Upload route handler status mapping.
// Pure handler logic: auth + write helper mocked (no DB / no fs).

const getAuthSession = vi.fn();
const writeUploadedArtifact = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  createUploadedArtifact: (i: unknown) => writeUploadedArtifact(i),
}));

// Raw-body upload: never multipart formData.
async function POST(
  body: string | null,
  opts?: {
    origin?: string;
    filename?: string;
    contentLength?: string;
    chatThreadId?: string;
  },
) {
  const { POST: handler } = await import("../route");
  const headers = new Headers();
  if (opts?.origin) headers.set("origin", opts.origin);
  if (opts?.filename) headers.set("x-artifact-filename", opts.filename);
  if (opts?.contentLength) headers.set("content-length", opts.contentLength);
  if (opts?.chatThreadId)
    headers.set("x-artifact-chat-thread-id", opts.chatThreadId);
  if (body != null) headers.set("content-type", "text/plain");
  const req = new Request("http://localhost:3000/api/artifacts/upload", {
    method: "POST",
    headers,
    body: body ?? undefined,
    // @ts-expect-error Node fetch requires duplex for a streaming body
    duplex: "half",
  });
  return handler(req);
}

describe("POST /api/artifacts/upload", () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    writeUploadedArtifact.mockReset();
  });
  afterEach(() => vi.resetModules());

  it("401 when unauthenticated", async () => {
    getAuthSession.mockResolvedValue(null);
    expect((await POST("x", { filename: "a.txt" })).status).toBe(401);
  });

  it("400 when no active organization", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
    expect((await POST("x", { filename: "a.txt" })).status).toBe(400);
  });

  it("400 when request body is empty", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    expect((await POST(null)).status).toBe(400);
  });

  it("413 early when Content-Length exceeds the cap (no buffering)", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    const res = await POST("x", {
      filename: "big.bin",
      contentLength: String(60 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(writeUploadedArtifact).not.toHaveBeenCalled();
  });

  it("413 when the streamed blob exceeds the cap mid-stream", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockRejectedValue(new BlobTooLargeError(10));
    const res = await POST("xxxx", { filename: "big.bin" });
    expect(res.status).toBe(413);
  });

  it("201 + ref on success", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockResolvedValue({
      objectId: "o1",
      artifactId: "a1",
      representationRevisionId: "v1",
      ref: {
        artifactId: "a1",
        representationRevisionId: "v1",
        digest: "sha",
        mime: "text/plain",
        originKind: "upload",
      },
    });
    const res = await POST("hi", { filename: "a.txt" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; ref: { representationRevisionId: string } };
    expect(json.ok).toBe(true);
    expect(json.ref.representationRevisionId).toBe("v1");
  });

  it("403 on cross-origin", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    const res = await POST("x", {
      filename: "a.txt",
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("x-artifact-chat-thread-id header forwards as chatContextSource handle", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockResolvedValue({
      objectId: "o1",
      artifactId: "a1",
      representationRevisionId: "v1",
      ref: {
        artifactId: "a1",
        representationRevisionId: "v1",
        digest: "sha",
        mime: "text/plain",
        originKind: "upload",
      },
    });
    const res = await POST("hi", {
      filename: "a.txt",
      chatThreadId: "thread-abc-123",
    });
    expect(res.status).toBe(201);
    // Route passes only the HANDLE — never a pre-built signals blob.
    // The service composes server-side.
    const call = writeUploadedArtifact.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.chatContextSource).toEqual({ threadId: "thread-abc-123" });
    expect(call?.classifierSignals).toBeUndefined();
  });

  it("header absence means NO chatContextSource (back-compat invariant)", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockResolvedValue({
      objectId: "o1",
      artifactId: "a1",
      representationRevisionId: "v1",
      ref: {
        artifactId: "a1",
        representationRevisionId: "v1",
        digest: "sha",
        mime: "text/plain",
        originKind: "upload",
      },
    });
    const res = await POST("hi", { filename: "a.txt" });
    expect(res.status).toBe(201);
    const call = writeUploadedArtifact.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call?.chatContextSource).toBeUndefined();
  });

  it("header value is truncated to 256 chars (cap-floor; the leaf schema also enforces)", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockResolvedValue({
      objectId: "o1",
      artifactId: "a1",
      representationRevisionId: "v1",
      ref: {
        artifactId: "a1",
        representationRevisionId: "v1",
        digest: "sha",
        mime: "text/plain",
        originKind: "upload",
      },
    });
    const longId = "t".repeat(1000);
    await POST("hi", { filename: "a.txt", chatThreadId: longId });
    const call = writeUploadedArtifact.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((call?.chatContextSource as { threadId: string }).threadId).toHaveLength(256);
  });
});
