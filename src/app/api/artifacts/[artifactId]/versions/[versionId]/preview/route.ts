/**
 * Preview-safe artifact serving route.
 *
 * Serves the SAME bytes as `../content/route.ts` (full session/actor/
 * tenant/tombstone/pin gating) but with:
 *
 *   - `Content-Disposition: inline` for MIMEs in
 *     `PREVIEW_INLINE_MIME_ALLOWLIST` (so the `/artifacts/[id]` detail
 *     page handlers can render via `<embed>`, `<img>`, or text+markdown
 *     react components). Non-allowlisted MIMEs → `attachment` (defense-
 *     in-depth alongside the 415 short-circuit below).
 *   - 415 for any MIME outside the allowlist — keeps a misbehaving
 *     caller from exfiltrating bytes through the preview path that would
 *     otherwise force-download via the content endpoint.
 *   - Per-MIME byte caps: markdown 10MB, text 10MB, image 25MB,
 *     PDF 100MB. Anything bigger 413s; the user can still download
 *     uncapped via the content endpoint.
 *   - Range support — required for `<embed>`-served PDFs (browsers issue
 *     bytes 0-1 then re-request).
 *
 * Guardrail: the preview route ALWAYS calls
 * `previewDispositionFor`. The content route ALWAYS calls
 * `downloadDispositionFor`. A unit test (`dispositions.test.ts`) pairs
 * the two helpers on every MIME class so a future MIME-allowlist edit
 * cannot make one helper's behaviour leak into the other.
 */
import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import {
  resolveArtifactVersionForServe,
  previewDispositionFor,
  PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS,
} from "@/lib/artifacts/artifact-read";
import { getArtifact } from "@/lib/artifacts/artifact-service";
import { isRepresentationPinned } from "@/lib/artifacts/artifact-refs-store";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ artifactId: string; versionId: string }> };

// Per-MIME byte caps. Generous — the preview path is for inline
// rendering inside the detail page's MIME handlers, not for unbounded
// transport. The download route is uncapped (and always `attachment`)
// so a user can still grab large artifacts wholesale.
const ONE_MB = 1024 * 1024;
const BYTE_CAPS: Readonly<Record<string, number>> = {
  "text/markdown": 10 * ONE_MB,
  "text/x-markdown": 10 * ONE_MB,
  "text/plain": 10 * ONE_MB,
  "application/pdf": 100 * ONE_MB,
  "image/png": 25 * ONE_MB,
  "image/jpeg": 25 * ONE_MB,
  "image/gif": 25 * ONE_MB,
  "image/webp": 25 * ONE_MB,
  "image/svg+xml": 25 * ONE_MB,
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  // Bare `sandbox` blocks scripts, popups, plugins, and same-origin
  // privileges. The required header verbatim. Browsers tolerate
  // this for the bundled PDF viewer because the viewer process is its
  // own sandboxed context.
  "Content-Security-Policy":
    "default-src 'none'; sandbox; style-src 'unsafe-inline'",
  // The preview route is for live rendering — never cache, the bytes
  // are auth-gated.
  "Cache-Control": "private, no-store",
  "Accept-Ranges": "bytes",
};

type RangeResult =
  | { kind: "absent" }
  | { kind: "ignore" }
  | { kind: "satisfiable"; start: number; end: number }
  | { kind: "unsatisfiable" };

function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: "absent" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "ignore" };
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  if (!hasStart && !hasEnd) return { kind: "ignore" };
  let start: number;
  let end: number;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  } else {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - n);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
    return { kind: "ignore" };
  }
  if (size === 0 || start >= size) return { kind: "unsatisfiable" };
  if (start > end) return { kind: "ignore" };
  return { kind: "satisfiable", start, end: Math.min(end, size - 1) };
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
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
  const { artifactId, versionId } = await params;
  const representationRevisionId = versionId;

  // Same actor + tombstone + pin path as the content route. Inline so
  // a refactor of one cannot accidentally widen the other.
  const actorContext = await requireActorContext();
  const visible = getArtifact({ artifactId, orgId, actor: actorContext });
  if (!visible) {
    const visibleIncludingTombstoned = getArtifact({
      artifactId,
      orgId,
      actor: actorContext,
      allowDeleted: true,
    });
    if (!visibleIncludingTombstoned) {
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    const pinned = isRepresentationPinned(
      orgId,
      artifactId,
      representationRevisionId,
    );
    if (!pinned) {
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }
  }

  const resolved = resolveArtifactVersionForServe({
    orgId,
    artifactId,
    representationRevisionId,
  });
  if (!resolved) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  // 415 short-circuit. The preview route SERVES only allowlisted
  // MIMEs; everything else 415s so a caller cannot use the preview path
  // for unintended types. The download route at `/content` still serves
  // these MIMEs (always `attachment`).
  if (!PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS.has(resolved.mime)) {
    return Response.json(
      { ok: false, error: "Preview unsupported for this MIME type" },
      { status: 415 },
    );
  }

  // Per-MIME byte cap. 413 if exceeded; user can still
  // download via the content endpoint.
  const cap = BYTE_CAPS[resolved.mime];
  if (cap !== undefined && resolved.sizeBytes > cap) {
    return Response.json(
      {
        ok: false,
        error: "Artifact exceeds preview byte cap",
        cap,
        sizeBytes: resolved.sizeBytes,
      },
      { status: 413 },
    );
  }

  const store = createLocalDiskBlobStore();
  const disposition = previewDispositionFor(
    resolved.mime,
    `artifact-${versionId}`,
  );
  const range = parseRange(
    request.headers.get("range"),
    resolved.sizeBytes,
  );
  if (range.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        ...SECURITY_HEADERS,
        "Content-Range": `bytes */${resolved.sizeBytes}`,
      },
    });
  }

  try {
    if (range.kind === "satisfiable") {
      const h = await store.openRangeByStorageKey({
        orgId,
        storageKey: resolved.storageKey,
        start: range.start,
        end: range.end,
      });
      return new Response(h.stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": resolved.mime,
          "Content-Disposition": disposition,
          "Content-Length": String(h.sizeBytes),
          "Content-Range": `bytes ${range.start}-${range.end}/${h.totalSize}`,
        },
      });
    }
    const h = await store.openByStorageKey({
      orgId,
      storageKey: resolved.storageKey,
    });
    return new Response(h.stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": resolved.mime,
        "Content-Disposition": disposition,
        "Content-Length": String(resolved.sizeBytes),
      },
    });
  } catch (err) {
    console.error("[artifacts:preview] failed", err);
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }
}
