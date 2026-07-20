import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobTooLargeError } from "@cinatra-ai/artifacts";

// Upload route handler status mapping.
// Pure handler logic: auth + write helper mocked (no DB / no fs).

const getAuthSession = vi.fn();
const writeUploadedArtifact = vi.fn();
const notifyUploadRefusal = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  createUploadedArtifact: (i: unknown) => writeUploadedArtifact(i),
}));
// cinatra#1890 — the route dynamically imports the refusal-advisory module in
// the 415 branch. Mock it so the advisory + deep link are observable without a
// DB/notifications host.
vi.mock("@/lib/artifacts/upload-refusal-advisory", () => ({
  notifyUploadRefusal: (a: unknown) => notifyUploadRefusal(a),
  buildUploadRefusalMarketplaceHref: (mime: string) =>
    `/configuration/marketplace?accepts=${encodeURIComponent(mime)}`,
}));

/** Build the structured upload type-refusal the service throws (cinatra#1785 /
 *  #1890): an ObjectsTypeNotRegisteredError-shaped Error carrying the refusal
 *  classification the route branches on. */
function typeRefusal(
  kind: "no_type" | "ambiguous" | "no_mime",
  normalizedMime: string,
): Error {
  const e = new Error(`upload cannot be typed to a system-base artifact pack: ${kind}`);
  e.name = "ObjectsTypeNotRegisteredError";
  Object.assign(e, {
    code: "OBJECTS_TYPE_NOT_REGISTERED",
    uploadRefusal: { kind, normalizedMime },
  });
  return e;
}

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
    notifyUploadRefusal.mockReset();
    notifyUploadRefusal.mockResolvedValue(undefined);
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

  it("upload lands session-user-owned + private, never organization-wide (#1885 C1 / D10, ruling 3)", async () => {
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
    expect(call?.ownerLevel).toBe("user");
    expect(call?.ownerId).toBe("u1");
    expect(call?.visibility).toBe("private");
    expect(call?.createdBy).toBe("u1");
    // Org boundary still carried, never client-supplied project input.
    expect(call?.orgId).toBe("org1");
    expect(call?.projectId).toBeUndefined();
  });

  it("session without a user id is Unauthorized (uploader ownership requires a user)", async () => {
    getAuthSession.mockResolvedValue({
      user: {},
      session: { activeOrganizationId: "org1" },
    });
    const res = await POST("hi", { filename: "a.txt" });
    expect(res.status).toBe(401);
    expect(writeUploadedArtifact).not.toHaveBeenCalled();
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

  // ---------------------------------------------------------------------------
  // cinatra#1890 — 415 refusal surfacing + advisory (D6).
  // ---------------------------------------------------------------------------

  it("415 no_type refusal → visible body (mime + marketplaceHref) + advisory fired", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockRejectedValue(typeRefusal("no_type", "application/zip"));
    const res = await POST("PK", { filename: "bundle.zip" });
    expect(res.status).toBe(415);
    const json = (await res.json()) as {
      ok: boolean;
      mime?: string;
      marketplaceHref?: string;
    };
    expect(json.ok).toBe(false);
    expect(json.mime).toBe("application/zip");
    expect(json.marketplaceHref).toBe(
      "/configuration/marketplace?accepts=application%2Fzip",
    );
    // Advisory fired to the uploader with the refused MIME + filename.
    expect(notifyUploadRefusal).toHaveBeenCalledTimes(1);
    expect(notifyUploadRefusal.mock.calls[0]?.[0]).toEqual({
      userId: "u1",
      normalizedMime: "application/zip",
      filename: "bundle.zip",
    });
  });

  it("415 ambiguous refusal → visible 415 but NO marketplace link + NO advisory", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockRejectedValue(typeRefusal("ambiguous", "image/png"));
    const res = await POST("x", { filename: "amb.png" });
    expect(res.status).toBe(415);
    const json = (await res.json()) as { marketplaceHref?: string; mime?: string };
    expect(json.marketplaceHref).toBeUndefined();
    // The refused MIME is still echoed for the visible surface.
    expect(json.mime).toBe("image/png");
    expect(notifyUploadRefusal).not.toHaveBeenCalled();
  });

  it("advisory throw never turns the 415 into a 500", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    });
    writeUploadedArtifact.mockRejectedValue(typeRefusal("no_type", "application/zip"));
    notifyUploadRefusal.mockRejectedValue(new Error("bell down"));
    const res = await POST("x", { filename: "bundle.zip" });
    expect(res.status).toBe(415);
    const json = (await res.json()) as { marketplaceHref?: string };
    expect(json.marketplaceHref).toBe(
      "/configuration/marketplace?accepts=application%2Fzip",
    );
  });
});
