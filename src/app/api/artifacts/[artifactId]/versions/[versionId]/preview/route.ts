/**
 * Preview-safe artifact serving route.
 *
 * Serves the SAME bytes as `../content/route.ts` (full session/actor/
 * tenant/tombstone/pin gating) but with:
 *
 *   - CAPABILITY-RESOLVED eligibility (cinatra#1630 AC-2): the route serves
 *     inline ONLY when the representation's MIME is inline-transport eligible
 *     through the effective representation-provider capability
 *     (`isInlineTransportEligible`) — NOT a concrete MIME allowlist. A new
 *     admitted preview provider (e.g. a marketplace `-artifact`) adds its type
 *     with no host edit; an archived/retired provider FAILS CLOSED (415 on a
 *     now-stale preview URL). Ineligible ⇒ 415, so a misbehaving caller cannot
 *     exfiltrate bytes through the preview path (they always remain downloadable,
 *     `attachment`, via the `/content` endpoint).
 *   - `Content-Disposition: inline` on the served (eligible) path so the detail
 *     page + reuse renderers can `<embed>`/`<img>`/`<video>`. The host applies
 *     its safe-transport POLICY to whatever the capability admits, WITHOUT naming
 *     concrete MIMEs.
 *   - Byte caps by TRANSPORT CLASS (the MIME's top-level type), not per concrete
 *     MIME: text 10MB, image 25MB, application 100MB, audio 100MB, video 500MB.
 *     Anything bigger 413s; the user can still download uncapped via `/content`.
 *     An eligible MIME whose transport class has NO registered cap fails closed
 *     (415) so a future capability admission cannot serve uncapped bytes.
 *   - Range support — required for `<embed>`-served PDFs (browsers issue
 *     bytes 0-1 then re-request) and for `<video>`/`<audio>` scrubbing
 *     (browsers issue `bytes=0-` then seek with follow-up ranges).
 *   - A constant sandbox CSP + `nosniff` + same-origin CORP (host transport
 *     policy, MIME-agnostic) — the real inline-execution control.
 *
 * Guardrail: the preview route ALWAYS calls `previewDispositionFor`. The content
 * route ALWAYS calls `downloadDispositionFor`. A unit test (`dispositions.test.ts`)
 * pairs the two helpers so a preview refactor cannot make the download route
 * serve `inline`.
 */
import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import {
  resolveArtifactVersionForServe,
  previewDispositionFor,
} from "@/lib/artifacts/artifact-read";
import { isInlineTransportEligible } from "@/app/artifacts/[id]/renderer-resolution";
import { ensureActivatedRepresentationProviders } from "@/lib/artifacts/system-artifact-renderer-registrar";
import { getArtifact } from "@/lib/artifacts/artifact-service";
import { isRepresentationPinned } from "@/lib/artifacts/artifact-refs-store";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ artifactId: string; versionId: string }> };

// Byte caps by TRANSPORT CLASS (the MIME's top-level type) — host safe-transport
// policy applied WITHOUT naming concrete MIMEs (cinatra#1630 AC-2). These values
// reproduce the prior per-MIME caps exactly (every image was 25MB, every audio
// 100MB, every video 500MB, text 10MB, pdf/application 100MB) — a same-class
// format now deliberately inherits the class cap. The preview path is for inline
// rendering, not unbounded transport; the download route is uncapped (and always
// `attachment`) so a user can still grab large artifacts wholesale. Media
// (audio/video) is range-served (never buffered wholesale), so the cap bounds
// which artifacts are previewable — not per-request transfer size.
const ONE_MB = 1024 * 1024;
const TRANSPORT_CLASS_BYTE_CAPS: Readonly<Record<string, number>> = {
  text: 10 * ONE_MB,
  image: 25 * ONE_MB,
  application: 100 * ONE_MB,
  audio: 100 * ONE_MB,
  video: 500 * ONE_MB,
};

/** The transport class (top-level MIME type) a byte cap is keyed by. */
function transportClassOf(mime: string): string {
  const slash = mime.indexOf("/");
  return slash > 0 ? mime.slice(0, slash) : mime;
}

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
  // Auth-gated bytes must not be embeddable by cross-origin documents
  // (e.g. a third-party page mounting `<video src>` against this route
  // and riding ambient cookies). Same-origin detail-page handlers are
  // unaffected.
  "Cross-Origin-Resource-Policy": "same-origin",
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

  // 415 short-circuit — CAPABILITY-RESOLVED (cinatra#1630 AC-2). The preview
  // route serves inline ONLY a representation whose MIME is inline-transport
  // eligible through the effective representation-provider capability; everything
  // else 415s so a caller cannot use the preview path for unintended types (they
  // remain downloadable, `attachment`, via `/content`). Fails closed when the
  // resolving provider is no longer effective (archived/retired base ⇒ no
  // binding ⇒ 415 on a stale preview URL).
  // ACTIVATION-COUPLED BINDING (cinatra#2044 L-A3): the byte request can land on a
  // DIFFERENT worker than the page render, so the org's activated (non-system,
  // build-bundled) representation providers are reconciled from the canonical
  // install rows HERE too — otherwise a pack whose `preview` provider legitimately
  // opens the byte route would 415 on half the workers, and a pack whose install
  // was torn down could keep serving on a worker that missed the teardown. The
  // reconcile binds the governed and RETIRES the ungoverned, so this is the
  // fail-closed direction as well.
  await ensureActivatedRepresentationProviders(orgId);
  if (!isInlineTransportEligible(orgId, resolved.mime)) {
    return Response.json(
      { ok: false, error: "Preview unsupported for this MIME type" },
      { status: 415 },
    );
  }

  // Byte cap by TRANSPORT CLASS. 413 if exceeded; user can still download via
  // the content endpoint.
  //
  // Fail closed on an unbounded class: an eligible representation whose transport
  // class has NO registered cap 415s instead of serving uncapped bytes — so
  // admitting a new capability can never silently open unbounded transport.
  const cap = TRANSPORT_CLASS_BYTE_CAPS[transportClassOf(resolved.mime)];
  if (cap === undefined) {
    return Response.json(
      { ok: false, error: "Preview unsupported for this MIME type" },
      { status: 415 },
    );
  }
  if (resolved.sizeBytes > cap) {
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
  // Eligibility was decided above (capability); the served path is always inline.
  const disposition = previewDispositionFor(true, `artifact-${versionId}`);
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
