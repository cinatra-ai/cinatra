import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import {
  resolveArtifactVersionForServe,
  downloadDispositionFor,
} from "@/lib/artifacts/artifact-read";
import { getArtifact } from "@/lib/artifacts/artifact-service";
import { isRepresentationPinned } from "@/lib/artifacts/artifact-refs-store";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";

// Secure serving/viewer backend. Node runtime (fs streaming).
// Session-gated; tenant isolation enforced in the resolver
// (org+artifact+version). No-exec serving: strict CSP, nosniff, and
// attachment disposition for everything except a small image allowlist.
export const runtime = "nodejs";

type Params = { params: Promise<{ artifactId: string; versionId: string }> };

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  // Defuse any active content (HTML/SVG/JS) even if a wrong MIME slips in.
  "Content-Security-Policy":
    "default-src 'none'; sandbox; style-src 'unsafe-inline'",
  "Cache-Control": "private, no-store",
  "Accept-Ranges": "bytes",
};

// Range parsing returns a discriminated result.
//  - absent       -> no Range header (full 200)
//  - ignore       -> malformed/multi-range syntax: per RFC 9110 ignore -> 200
//  - satisfiable   -> 206 with the resolved [start,end]
//  - unsatisfiable -> 416 + `Content-Range: bytes */<size>`
type RangeResult =
  | { kind: "absent" }
  | { kind: "ignore" }
  | { kind: "satisfiable"; start: number; end: number }
  | { kind: "unsatisfiable" };

function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: "absent" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "ignore" }; // malformed / multi-range -> ignore
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  if (!hasStart && !hasEnd) return { kind: "ignore" };
  let start: number;
  let end: number;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  } else {
    const n = Number(m[2]); // suffix: last n bytes
    if (!Number.isSafeInteger(n) || n <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - n);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
    return { kind: "ignore" };
  }
  // A start at/after the resource end (incl. `bytes=999-` on a short file)
  // is a syntactically-valid but unsatisfiable range -> 416, NOT ignore.
  if (size === 0 || start >= size) return { kind: "unsatisfiable" };
  if (start > end) return { kind: "ignore" }; // inverted range -> ignore
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
  // URL segment `[versionId]` stays for backwards-compatible serve links;
  // mapped to the semantic field name when calling into the typed
  // serve/blob APIs.
  const representationRevisionId = versionId;

  // Actor-scoped visibility gate. The semantic creation contract accepts
  // 4-tier ownership (user/team/organization/workspace) -- without this
  // check, any org member with an artifactId + representationRevisionId
  // could fetch the bytes of a user- or team-owned artifact. `getArtifact`
  // mirrors the listArtifacts/getArtifact authz path used everywhere else.
  //
  // Replay-safe pin override. A tombstoned artifact stays SERVEable through
  // a pinned representation revision (an existing chat-thread / WayFlow /
  // agent-run pin row). The pin is NOT a standalone authorizer: the request
  // must FIRST pass actor visibility against the artifact (`getArtifact`
  // with `allowDeleted:true`), and THEN find a valid pin. An actor whom the
  // visibility filter denies gets 404 with no pin fallback. An actor visible
  // to the LIVE artifact who hits a tombstone may serve via a valid pin until
  // physical GC reclaims the resource.
  const actorContext = await requireActorContext();
  const visible = getArtifact({
    artifactId,
    orgId,
    actor: actorContext,
  });
  if (!visible) {
    // Distinguish "actor-denied" from "tombstoned-but-actor-visible". The
    // pin override fires ONLY when the actor would have been allowed to see
    // the LIVE artifact (visibility filter passes) AND the artifact is now
    // tombstoned AND a valid pin exists for this representation revision.
    // A wholly-denied actor (no visibility) gets 404 with no fallback.
    const visibleIncludingTombstoned = getArtifact({
      artifactId,
      orgId,
      actor: actorContext,
      allowDeleted: true,
    });
    if (!visibleIncludingTombstoned) {
      // Actor-denied (visibility filter excludes the row even allowing
      // tombstoned). No pin can override the ownership gate.
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    // Tombstoned-but-actor-visible. The pin IS the authorization to replay
    // the bytes until physical GC reclaims the resource.
    const pinned = isRepresentationPinned(orgId, artifactId, representationRevisionId);
    if (!pinned) {
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    // Falls through to the resolver, which has the deleted-allowed OR-clause
    // keyed on artifact_refs.
  }

  const resolved = resolveArtifactVersionForServe({
    orgId,
    artifactId,
    representationRevisionId,
  });
  if (!resolved) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  // Serve via the resource-bound storage_key returned by the semantic
  // resolver (no scope-keyed path; dedupe-safe).
  const store = createLocalDiskBlobStore();
  const disposition = downloadDispositionFor(
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
    console.error("[artifacts:serve] failed", err);
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }
}
