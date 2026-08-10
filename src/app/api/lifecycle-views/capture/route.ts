import "server-only";

// ---------------------------------------------------------------------------
// GET /api/lifecycle-views/capture — the WIDGET CAPTURE EGRESS
// (cinatra#2576, epic #2564 S8c).
//
// A review card in the CMS widget has to show the before/after page pictures.
// The card is drawn inside cinatra's OWN embed iframe, so the request is
// same-origin — but the reader is authenticated by a broker `cwu_` bearer, not a
// cookie session, and an `<img>` load carries no bearer. That is the whole
// problem this route solves: the URL itself is the authorization, sealed,
// gate-scoped and short-lived (`capture-capability.ts`), and every binding in it
// is re-checked live here (`capture-capability-serving.ts`).
//
// THIS IS A THIN SHELL. It binds real ports to the pure decision and streams the
// bytes; it makes no authorization judgement of its own, so the entire matrix is
// unit-provable and there is exactly one place a rung could be dropped.
//
// ONE ANSWER FOR EVERY "NO". Expired, forged, revoked, wrong gate, wrong
// capture, no run access, a pasted link, a `curl` replay, a store failure — all
// 404 with an empty body and the same headers. A status code is as much of an
// oracle as a message: 401 vs 403 vs 404 would let anyone holding a capability
// probe which gates and captures exist.
//
// WHAT THIS ROUTE CAN SERVE, AND WHAT IT STRUCTURALLY CANNOT. Only a PINNED
// CAPTURE PNG bound to the sealed gate. It never reads an id from the request
// (there are no path or query identifiers — only the sealed capability), it
// reaches the blob resolver ONLY after the gate has vouched for the capture, and
// it refuses anything whose resolved representation is not `image/png`. There is
// no reachable path from here to `/api/artifacts/**/content` bytes, to an
// arbitrary artifact, or to a renderer bundle.
// ---------------------------------------------------------------------------

import { readReviewGate, enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { readPinnedPreviewCapture } from "@/lib/artifacts/cms-preview-capture-store";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { CAPTURE_CAPABILITY_QUERY_PARAM } from "@/lib/lifecycle/capture-capability";
import {
  CAPTURE_SERVE_MIME,
  decideCaptureCapabilityServe,
  type CaptureServePorts,
} from "@/lib/lifecycle/capture-capability-serving";
import { readLiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

export const runtime = "nodejs";

/**
 * Response headers for a served capture.
 *
 * `Cross-Origin-Resource-Policy: same-origin` is the point of the whole slice:
 * even inside the widget's own page tree, no CROSS-ORIGIN document may consume
 * these bytes — the picture belongs to cinatra's iframe and nowhere else. The
 * sandbox CSP + `nosniff` mirror the first-party byte routes (a PNG that is
 * somehow not a PNG must not become active content), and `no-store` keeps an
 * auth-gated picture out of every shared cache, which matters far more for a
 * bearer-in-URL than for a cookie-gated route.
 *
 * `Vary` names the two request headers the admission decision reads, so no cache
 * anywhere can serve a `same-origin` image answer to a navigation.
 *
 * NO `Accept-Ranges`. A capture is a single PNG painted by one `<img>`; range
 * support would only widen the surface a capability reaches.
 */
const CAPTURE_RESPONSE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox; style-src 'unsafe-inline'",
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  Vary: "Sec-Fetch-Site, Sec-Fetch-Dest",
};

/** The ONE refusal. Empty body, same headers, no reason, always 404. */
function refuse(): Response {
  return new Response(null, { status: 404, headers: CAPTURE_RESPONSE_HEADERS });
}

/**
 * The widget principal as a run-access actor.
 *
 * DELIBERATELY MINIMAL, and deliberately NOT S8a's. A `cwu_` holder is a real
 * cinatra principal, and S8a (#2574) is the slice that decides how much of that
 * person's org standing a widget read carries. This route does not pre-empt that
 * decision: it presents the bare {userId, orgId} actor with NO role hints, which
 * is the NARROWEST reading of the principal — strictly a subset of anything S8a
 * can widen it to. A picture is therefore never visible to a widget reader who
 * would not already reach the run through ownership or the run's own policy.
 */
function widgetRunActor(userId: string, orgId: string): PrimitiveActorContext {
  return { actorType: "human", source: "route", userId, orgId };
}

const ports: CaptureServePorts = {
  readLivePrincipal: (jti) => readLiveWidgetCapturePrincipal(jti),
  runReadAccess: async ({ runId, userId, orgId }) => {
    const outcome = await enforceReviewRunAccess(
      runId,
      widgetRunActor(userId, orgId),
      "read",
    );
    return outcome.ok;
  },
  // The gate's FROZEN pinned set, for a gate in ANY state. A decided gate keeps
  // its pictures for a reader who may still read the run — the same parity the
  // first-party review surface has, where a settled gate's captures still serve
  // through the session byte route.
  readGatePinnedTargets: async (runId, reviewTaskId) => {
    const gate = await readReviewGate(runId, reviewTaskId);
    if (!gate) return null;
    return gate.pinnedTargets.map((t) => ({
      artifactId: t.artifactId,
      representationRevisionId: t.representationRevisionId,
    }));
  },
  readCapture: (orgId, captureArtifactId) => {
    // Org-scoped and TYPE-scoped by the store's own query: a row that is not a
    // pinned preview capture in this org simply does not come back, which is
    // what confines this route to captures no matter what a capability seals.
    const stored = readPinnedPreviewCapture(orgId, captureArtifactId);
    if (!stored) return null;
    return {
      representationRevisionId: stored.representationRevisionId,
      boundArtifactId: stored.data.boundArtifactId,
      boundSnapshotRevisionId: stored.data.boundSnapshotRevisionId,
      status: stored.data.status,
    };
  },
  resolveServe: (input) => {
    // `liveOnly` — the tombstoned-pin replay override on the session byte routes
    // is gated by an actor-visibility check this route does not perform, so the
    // broker tier never gets it. A capture whose artifact was tombstoned stops
    // serving here; the reader still gets the decision, minus the picture.
    const resolved = resolveArtifactVersionForServe({ ...input, liveOnly: true });
    if (!resolved) return null;
    return {
      mime: resolved.mime,
      storageKey: resolved.storageKey,
      sizeBytes: resolved.sizeBytes,
    };
  },
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const decision = await decideCaptureCapabilityServe({
    encodedCapability: url.searchParams.get(CAPTURE_CAPABILITY_QUERY_PARAM),
    headers: request.headers,
    ports,
  });
  if (!decision.ok) return refuse();

  try {
    const store = createLocalDiskBlobStore();
    const handle = await store.openByStorageKey({
      orgId: decision.capability.orgId,
      storageKey: decision.serve.storageKey,
    });
    return new Response(handle.stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        ...CAPTURE_RESPONSE_HEADERS,
        "Content-Type": CAPTURE_SERVE_MIME,
        // Always `inline`, never `attachment`: this is a picture painted into a
        // card. The filename is the capture's own id — it names nothing about
        // the gate, the run or the site.
        "Content-Disposition": `inline; filename="capture-${decision.capability.captureArtifactId}.png"`,
        "Content-Length": String(decision.serve.sizeBytes),
      },
    });
  } catch {
    // A blob read failure answers exactly like every other "no".
    return refuse();
  }
}
