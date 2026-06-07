import { getAuthSession } from "@/lib/auth-session";
import { createUploadedArtifact } from "@/lib/artifacts/artifact-service";
// `ArtifactCreationDisabledError` is not an expected upload failure; upload
// creation is enabled on the semantic model. BlobTooLargeError remains as the
// only expected artifact-service throw handled by this route.
import { BlobTooLargeError } from "@cinatra-ai/artifacts";

// Upload ingestion API. Node runtime is required for fs and streaming support.
// The route is session-gated and origin-gated, and must not be added to the
// public-path allowlist. The 50 MiB hard cap is streamed, not buffered.
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin / non-CORS form post
  try {
    const allowed = new URL(
      process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    );
    return new URL(origin).origin === allowed.origin;
  } catch {
    return false;
  }
}

async function* webStreamToAsyncIterable(
  rs: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = rs.getReader();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (value) yield value;
    }
  } finally {
    // On early aborts such as BlobTooLargeError, cancel the underlying stream
    // instead of only releasing the reader lock.
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const orgId = session.session?.activeOrganizationId;
  if (!orgId) {
    return Response.json(
      { ok: false, error: "No active organization" },
      { status: 400 },
    );
  }

  // The file is the raw request body. Do not use request.formData(), which
  // buffers the whole multipart body before the cap check. The body streams
  // straight into the capped blob writer; the client sends MIME via
  // Content-Type and the original name via X-Artifact-Filename.
  // Content-Length is a cheap early reject; the authoritative cap is enforced
  // mid-stream by the blob writer.
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return Response.json(
      { ok: false, error: `File exceeds ${MAX_UPLOAD_BYTES} bytes` },
      { status: 413 },
    );
  }
  if (!request.body) {
    return Response.json(
      { ok: false, error: "Empty request body" },
      { status: 400 },
    );
  }
  const filename = request.headers.get("x-artifact-filename") ?? undefined;
  const title = request.headers.get("x-artifact-title") ?? filename;
  // Opt-in classifier signal: an x-artifact-* header, matching the existing
  // x-artifact-filename/x-artifact-title convention, carries a chat-thread
  // handle. The service-layer composer authorizes via
  // readChatThreadForClassifier; unknown, cross-user, or wrong-org threads are
  // silently omitted. Cap the header value at 256 chars so a bad caller cannot
  // exhaust the signals byte cap before validation.
  const rawThreadHeader = request.headers.get("x-artifact-chat-thread-id");
  const chatThreadId =
    typeof rawThreadHeader === "string" && rawThreadHeader.length > 0
      ? rawThreadHeader.slice(0, 256)
      : undefined;

  try {
    const result = await createUploadedArtifact({
      orgId,
      createdBy: session.user?.id ?? null,
      // Ownership is required by the semantic creation contract. Web uploads
      // use organization ownership with org visibility; note that ownerLevel
      // uses "organization" while visibility uses "org".
      ownerLevel: "organization",
      ownerId: orgId,
      visibility: "org",
      declaredMime: request.headers.get("content-type") ?? undefined,
      title: title ?? undefined,
      originKind: "upload",
      stream: webStreamToAsyncIterable(
        request.body as ReadableStream<Uint8Array>,
      ),
      maxBytes: MAX_UPLOAD_BYTES,
      ...(chatThreadId ? { chatContextSource: { threadId: chatThreadId } } : {}),
    });
    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (err) {
    // name-based check too: robust across module duplication / realms
    // (instanceof alone is brittle under bundler/test module isolation).
    if (
      err instanceof BlobTooLargeError ||
      (err instanceof Error && err.name === "BlobTooLargeError")
    ) {
      return Response.json(
        { ok: false, error: `File exceeds ${MAX_UPLOAD_BYTES} bytes` },
        { status: 413 },
      );
    }
    if (err instanceof Error && /unsafe \w+ segment/.test(err.message)) {
      return Response.json(
        { ok: false, error: "Invalid upload scope" },
        { status: 400 },
      );
    }
    console.error("[artifacts:upload] failed", err);
    return Response.json(
      { ok: false, error: "Upload failed" },
      { status: 500 },
    );
  }
}
