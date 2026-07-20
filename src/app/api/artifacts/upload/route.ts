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
  // The uploading user — the recipient of the refusal advisory (cinatra#1890).
  const userId = session.user?.id ?? undefined;
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
      createdBy: userId ?? null,
      // Ownership is required by the semantic creation contract. Web uploads
      // are organization-owned and org-visible — canonical vocabulary only
      // (cinatra#1428): visibility 'organization', never the retired 'org'
      // composite.
      ownerLevel: "organization",
      ownerId: orgId,
      visibility: "organization",
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
    // Fail-closed type refusal (epic #1785): the upload MIME maps to no installed
    // system-base artifact type. 415 Unsupported Media Type — a client error, not
    // a transient failure (retrying the same bytes/type fails identically).
    if (
      err instanceof Error &&
      (err.name === "ObjectsTypeNotRegisteredError" ||
        (err as { code?: unknown }).code === "OBJECTS_TYPE_NOT_REGISTERED")
    ) {
      // Make the refusal VISIBLE with recourse (cinatra#1890 / D6): surface the
      // refused MIME + a marketplace deep link so chat can render an honest,
      // actionable refusal instead of silently dropping the file. The structured
      // `uploadRefusal.kind` decides whether "install a type that accepts this"
      // is the right recourse — only a real MIME no installed type accepts
      // (`no_type`) earns the deep link + advisory notification. An `ambiguous`
      // or `no_mime` refusal is still surfaced (visible 415) but WITHOUT a
      // marketplace link, since installing more types is not the fix.
      const refusal = (err as { uploadRefusal?: { kind?: string; normalizedMime?: string } })
        .uploadRefusal;
      const refusedMime =
        typeof refusal?.normalizedMime === "string" && refusal.normalizedMime.length > 0
          ? refusal.normalizedMime
          : undefined;
      const offerInstall = refusal?.kind === "no_type" && !!refusedMime;
      // Build the deep link AND fire the advisory inside ONE guarded block: a
      // failed dynamic import or a bell-write throw must NEVER turn the intended
      // 415 into a 500. The href is computed BEFORE the notify so a notify throw
      // still leaves the recourse link in the response.
      let marketplaceHref: string | undefined;
      if (offerInstall && refusedMime) {
        try {
          const advisory = await import("@/lib/artifacts/upload-refusal-advisory");
          marketplaceHref = advisory.buildUploadRefusalMarketplaceHref(refusedMime);
          if (userId) {
            await advisory.notifyUploadRefusal({
              userId,
              normalizedMime: refusedMime,
              filename,
            });
          }
        } catch (advisoryErr) {
          console.warn(
            "[artifacts:upload] refusal advisory failed:",
            advisoryErr instanceof Error ? advisoryErr.message : advisoryErr,
          );
        }
      }
      return Response.json(
        {
          ok: false,
          error: err.message,
          ...(refusedMime ? { mime: refusedMime } : {}),
          ...(marketplaceHref ? { marketplaceHref } : {}),
        },
        { status: 415 },
      );
    }
    console.error("[artifacts:upload] failed", err);
    return Response.json(
      { ok: false, error: "Upload failed" },
      { status: 500 },
    );
  }
}
