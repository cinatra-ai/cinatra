import "server-only";

// ---------------------------------------------------------------------------
// GET /api/lifecycle-views/artifact-bytes — THE ISLAND BYTE EGRESS
// (enabler 0.6 of `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE DEFECT IT CLOSES, IN THE PLAN'S WORDS: "both artifact byte routes are
// cookie-only, so inside a third-party application every media display paints
// nothing and the fallback's links are dead ends."
//
// A display drawn on the review card inside the CMS widget paints its bytes
// with `<img src>` / `<video src>`, or fetches them to hand the reader a save.
// NEVER with a link pointed at this route: a link click is a navigation, and
// this route refuses every navigation (see the transport rung in
// `review-island-byte-serving.ts`) whatever disposition the capability seals. The card is drawn inside
// cinatra's OWN embed iframe, so the request is same-origin — but the reader is
// authenticated by a broker `cwu_` bearer, not a cookie session, and a
// subresource load carries no bearer. That is the whole problem this route
// solves: the URL itself is the authorization, sealed to the exact gate,
// artifact and revision the gate pinned
// (`review-island-byte-capability.ts`), and every binding in it is re-checked
// live here (`review-island-byte-serving.ts`).
//
// THIS IS A THIN SHELL. It binds real ports to the pure decision and streams the
// bytes; it makes no authorization judgement of its own, so the entire matrix is
// unit-provable and there is exactly one place a rung could be dropped.
//
// ONE ANSWER FOR EVERY "NO". Expired, forged, revoked, wrong gate, wrong
// revision, no run access, a pasted link, a headerless replay, a store failure —
// all 404 with an empty body and the same headers. A status code is as much of
// an oracle as a message.
//
// WHAT THIS ROUTE CAN SERVE, AND WHAT IT STRUCTURALLY CANNOT. Only ONE
// representation revision of ONE artifact that ONE gate pinned. It reads NO id
// from the request — there are no path or query identifiers, only the sealed
// capability — and it reaches the blob resolver ONLY after the gate has vouched
// for that exact (artifact, revision) pair.
//
// LIVE ARTIFACTS ONLY. `liveOnly` is set on the resolver: the tombstoned-pin
// replay override on the first-party byte routes is gated by an actor-visibility
// check this broker tier does not perform, so it never gets it. A tombstoned
// artifact stops painting here; the settled card still names what was decided.
// ---------------------------------------------------------------------------

import {
  readReviewGate,
  enforceReviewRunAccess,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import {
  downloadDispositionFor,
  previewDispositionFor,
  resolveArtifactVersionForServe,
} from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM } from "@/lib/lifecycle/review-island-byte-capability";
import {
  decideIslandByteServe,
  type IslandByteServePorts,
} from "@/lib/lifecycle/review-island-byte-serving";
import { readLiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

export const runtime = "nodejs";

/**
 * Response headers for served pinned bytes.
 *
 * `Cross-Origin-Resource-Policy: same-origin` is the point of the whole
 * enabler: even inside the widget's own page tree, no CROSS-ORIGIN document may
 * consume these bytes — the work belongs to cinatra's iframe and nowhere else.
 * The sandbox CSP + `nosniff` mirror the first-party byte routes (bytes that are
 * somehow not what they claim must not become active content), and `no-store`
 * keeps auth-gated work out of every shared cache, which matters far more for a
 * bearer-in-URL than for a cookie-gated route.
 *
 * `Vary` names the request headers the admission decision reads, so no cache
 * anywhere can serve a `same-origin` subresource answer to a navigation.
 */
const ISLAND_BYTE_RESPONSE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox; style-src 'unsafe-inline'",
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  Vary: "Sec-Fetch-Site, Sec-Fetch-Dest, Sec-Fetch-Mode",
};

/** The ONE refusal. Empty body, same headers, no reason, always 404. */
function refuse(): Response {
  return new Response(null, { status: 404, headers: ISLAND_BYTE_RESPONSE_HEADERS });
}

/**
 * The widget principal as a run-access actor — DELIBERATELY MINIMAL and
 * identical to the capture egress's: the bare {userId, orgId} actor with NO role
 * hints, the NARROWEST reading of the principal. Bytes are therefore never
 * visible to a widget reader who would not already reach the run.
 */
function widgetRunActor(userId: string, orgId: string): PrimitiveActorContext {
  return { actorType: "human", source: "route", userId, orgId };
}

const ports: IslandByteServePorts = {
  readLivePrincipal: (jti) => readLiveWidgetCapturePrincipal(jti),
  runReadAccess: async ({ runId, userId, orgId }) => {
    const outcome = await enforceReviewRunAccess(runId, widgetRunActor(userId, orgId), "read");
    return outcome.ok;
  },
  // The gate's FROZEN pinned set, for a gate in ANY state. A decided gate keeps
  // showing the work it decided (enabler 0.9), so its pinned bytes keep serving
  // to a reader who may still read the run — the same parity the first-party
  // settled surface has through the session byte routes.
  readGatePinnedTargets: async (runId, reviewTaskId) => {
    const gate = await readReviewGate(runId, reviewTaskId);
    if (!gate) return null;
    return gate.pinnedTargets.map((t) => ({
      artifactId: t.artifactId,
      representationRevisionId: t.representationRevisionId,
    }));
  },
  resolveServe: (input) => {
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
  const decision = await decideIslandByteServe({
    encodedCapability: url.searchParams.get(REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM),
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
    // The DISPOSITION IS THE SEALED ONE. The two helpers stay the two distinct
    // helpers the first-party routes use, so a preview can never be turned into
    // a download by editing the address — the holder of a capability never
    // chose which of them applies.
    const filename = `artifact-${decision.capability.artifactId}`;
    const contentDisposition =
      decision.disposition === "download"
        ? downloadDispositionFor(decision.serve.mime, filename)
        : previewDispositionFor(true, filename);
    return new Response(handle.stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        ...ISLAND_BYTE_RESPONSE_HEADERS,
        "Content-Type": decision.serve.mime,
        "Content-Disposition": contentDisposition,
        "Content-Length": String(decision.serve.sizeBytes),
      },
    });
  } catch {
    // A blob read failure answers exactly like every other "no".
    return refuse();
  }
}
