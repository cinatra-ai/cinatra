import "server-only";

// ---------------------------------------------------------------------------
// The capture-capability SERVING DECISION (cinatra#2576, epic #2564 S8c).
//
// Everything that decides whether a picture may be streamed lives here, as a
// pure function over injected ports, so the whole matrix — expired, revoked,
// re-bound site, wrong gate, wrong capture, degraded capture, non-PNG bytes,
// a pasted URL — is provable without a database, a browser or a route.
//
// THE LADDER, and why it is in this order. Each rung is cheaper and less
// disclosing than the next, and the order is the same fail-closed discipline
// `loadReviewGateSurface` and S1's refetch use: never touch a store on behalf of
// a caller who has not yet proven the previous rung.
//
//   1. TRANSPORT SHAPE. The request must present itself as an image subresource
//      load from a same-origin document.
//
//      WHAT THIS RUNG IS WORTH, EXACTLY. Fetch Metadata is set by the BROWSER
//      and cannot be forged by a page, so it closes the whole class of
//      browser-driven misuse: pasting the link into a tab is a `document`
//      navigation with `Sec-Fetch-Site: none`, and a CMS page mounting
//      `<img src>` against it is `cross-site`. Both are refused before a byte of
//      work happens.
//
//      WHAT IT IS NOT WORTH. It is NOT proof that the requester is a browser. A
//      party who holds the URL can send these headers by hand from `curl` or a
//      server, and this rung will pass. Nothing about a bearer-in-a-URL can stop
//      that; what bounds it is the 5-minute life, the live revocation edge
//      (rung 3), the live run-access re-check (rung 4) and the gate binding
//      (rung 5) — a replay only ever gets what the still-authorized reader could
//      have got in that window. The rung is a real narrowing, not a proof of
//      origin, and the tests assert both halves.
//   2. THE CAPABILITY ITSELF — sealed, unexpired (`capture-capability.ts`).
//   3. THE LIVE PRINCIPAL — the `cwu_` row behind the sealed `jti` still alive,
//      still an interactive per-user widget bearer, and still bound to the same
//      person, org, site, client, canonical instance and agent. A capability
//      whose sealed binding disagrees with the live row is refused rather than
//      downgraded to the live one: disagreement means the binding moved under
//      it, which is exactly when a stale picture must stop.
//   4. RUN READ ACCESS — re-checked live, against the sealed principal. A reader
//      who lost access between the mint and the fetch loses the picture too.
//   5. THE GATE BINDING — the sealed capture must be bound to a target THIS gate
//      pinned. This is the rung that makes "a URL minted for gate A cannot fetch
//      gate B's capture" true even when both capabilities are genuine.
//   6. THE BYTES ARE A CAPTURE PNG — captured (not degraded), the exact
//      representation revision sealed, `image/png`, within the capture cap.
//
// ONLY CAPTURES, EVER. The resolve port is reached ONLY after rung 5 has proven
// the artifact id is a pinned-capture row bound to this gate, and rung 6 refuses
// anything that is not a stored PNG. There is no path through this module that
// serves an arbitrary artifact, a snapshot, or a renderer bundle — no id the
// caller supplies reaches a store, because the caller supplies no id at all: the
// sealed capability does, and the gate has to vouch for it.
//
// EVERY "no" IS THE SAME "no". The result is a bare discriminated union with no
// reason field, so the route cannot accidentally turn a denial into an oracle.
// ---------------------------------------------------------------------------

import {
  verifyCaptureCapability,
  type VerifiedCaptureCapability,
} from "@/lib/lifecycle/capture-capability";
import type { LiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

/** The MIME a pinned capture is stored as (`cms-preview-capture-store.ts`). */
export const CAPTURE_SERVE_MIME = "image/png";

/**
 * Ceiling on a served capture, mirroring the capture store's own write-side cap.
 * A capture larger than the writer could ever have stored is not one of ours —
 * refuse rather than stream it.
 */
export const CAPTURE_SERVE_MAX_BYTES = 24 * 1024 * 1024;

/** One pinned target of a gate, as the gate froze it. */
export interface CaptureGateTarget {
  artifactId: string;
  representationRevisionId: string;
}

/** The capture-store facts this decision needs. */
export interface CaptureRecordFacts {
  /** The stored PNG revision — null for a degraded capture (no bytes exist). */
  representationRevisionId: string | null;
  /** The gate target this capture is context for. */
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
  status: "captured" | "degraded";
}

/** The blob facts needed to stream. */
export interface CaptureServeResolution {
  mime: string;
  storageKey: string;
  sizeBytes: number;
}

/** The live reads this decision delegates. Injected so the matrix is testable. */
export interface CaptureServePorts {
  /** The live `cwu_` binding behind the sealed jti — null when dead/revoked. */
  readLivePrincipal: (jti: string) => LiveWidgetCapturePrincipal | null;
  /** Live run READ access for the sealed principal. */
  runReadAccess: (input: {
    runId: string;
    userId: string;
    orgId: string;
  }) => Promise<boolean>;
  /** The gate's FROZEN pinned target set — null when the gate is absent. */
  readGatePinnedTargets: (
    runId: string,
    reviewTaskId: string,
  ) => Promise<readonly CaptureGateTarget[] | null>;
  /** One capture row, by id, scoped to the org. */
  readCapture: (orgId: string, captureArtifactId: string) => CaptureRecordFacts | null;
  /** The blob facts for the capture's PNG representation. */
  resolveServe: (input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
  }) => CaptureServeResolution | null;
}

export type CaptureServeDecision =
  | { ok: true; capability: VerifiedCaptureCapability; serve: CaptureServeResolution }
  | { ok: false };

const REFUSED: CaptureServeDecision = { ok: false };

/**
 * The transport-shape gate (rung 1).
 *
 * FAIL-CLOSED ON ABSENCE, deliberately. `Sec-Fetch-Dest` / `Sec-Fetch-Site` are
 * forbidden headers, so no PAGE can set or forge them, and every browser this
 * widget already requires sends them. Treating "absent" as "allowed" would give
 * the rung away to the casual replay (a link unfurler, a naive `curl`) for
 * nothing, so absence refuses.
 *
 * This does NOT make the headers a proof of origin — a deliberate non-browser
 * caller can send them (see the module header). The rung closes browser-driven
 * misuse; the TTL, the revocation edge and the gate binding bound the rest.
 *
 * `same-origin` only: the picture is drawn inside cinatra's OWN embed iframe, so
 * `same-site` and `cross-site` have no legitimate caller here, and `none` is a
 * top-level navigation — the pasted-link case.
 *
 * BROWSER FLOOR (stated, not hidden): Fetch Metadata ships in Chrome 76+,
 * Firefox 90+ and Safari 16.4+. An older browser sends no such headers and its
 * captures will not load — the card degrades to no picture, the decision still
 * renders. That is the fail-closed direction, and it is the same floor the
 * widget's other modern-browser requirements already impose.
 */
export function isSameOriginImageFetch(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  const site = headers.get("sec-fetch-site");
  if (dest !== "image") return false;
  if (site !== "same-origin") return false;
  // A navigation can never be an image subresource; refuse the contradiction
  // rather than trusting one header over the other.
  const mode = headers.get("sec-fetch-mode");
  if (mode !== null && mode === "navigate") return false;
  return true;
}

/**
 * Decide whether this capability may stream its capture right now.
 *
 * Never throws — a port that rejects is a refusal, because a 500 would be as
 * distinguishable as a 403.
 */
export async function decideCaptureCapabilityServe(params: {
  encodedCapability: string | null;
  headers: Headers;
  ports: CaptureServePorts;
  nowSeconds?: number;
}): Promise<CaptureServeDecision> {
  const { encodedCapability, headers, ports } = params;

  // 1. Transport shape.
  if (!isSameOriginImageFetch(headers)) return REFUSED;

  // 2. The capability itself.
  if (typeof encodedCapability !== "string" || encodedCapability.length === 0) {
    return REFUSED;
  }
  const capability = verifyCaptureCapability(encodedCapability, {
    nowSeconds: params.nowSeconds,
  });
  if (!capability) return REFUSED;

  try {
    // 3. The live principal, and the sealed binding still agreeing with it.
    const live = ports.readLivePrincipal(capability.jti);
    if (!live) return REFUSED;
    if (
      live.userId !== capability.userId ||
      live.orgId !== capability.orgId ||
      live.siteId !== capability.siteId ||
      live.client !== capability.client ||
      live.instanceId !== capability.instanceId ||
      // The agent bind `consumeUserWidgetToken` enforces as `agent_mismatch`.
      // Without it a capability minted under one widget agent would keep
      // serving after the token was re-bound to another.
      live.agentSlug !== capability.agentSlug
    ) {
      return REFUSED;
    }

    // 4. Live run READ access for that principal.
    const canRead = await ports.runReadAccess({
      runId: capability.runId,
      userId: capability.userId,
      orgId: capability.orgId,
    });
    if (!canRead) return REFUSED;

    // 5. The gate binding. The gate's pinned set is FROZEN at emission, so this
    //    is the authoritative answer to "is this picture part of this gate?".
    const targets = await ports.readGatePinnedTargets(
      capability.runId,
      capability.reviewTaskId,
    );
    if (!targets || targets.length === 0) return REFUSED;

    const capture = ports.readCapture(capability.orgId, capability.captureArtifactId);
    if (!capture) return REFUSED;
    const boundToThisGate = targets.some(
      (t) =>
        t.artifactId === capture.boundArtifactId &&
        t.representationRevisionId === capture.boundSnapshotRevisionId,
    );
    if (!boundToThisGate) return REFUSED;

    // 6. The bytes are this capture's own stored PNG.
    if (capture.status !== "captured") return REFUSED;
    if (
      capture.representationRevisionId === null ||
      capture.representationRevisionId !== capability.representationRevisionId
    ) {
      return REFUSED;
    }
    const serve = ports.resolveServe({
      orgId: capability.orgId,
      artifactId: capability.captureArtifactId,
      representationRevisionId: capability.representationRevisionId,
    });
    if (!serve) return REFUSED;
    // MIME is re-asserted from the RESOLVED representation, not from the capture
    // record's own claim: the bytes decide what may be streamed inline, and a
    // capture row whose representation is not a PNG is a corruption, not a
    // picture.
    if (serve.mime !== CAPTURE_SERVE_MIME) return REFUSED;
    if (!Number.isFinite(serve.sizeBytes) || serve.sizeBytes < 0) return REFUSED;
    if (serve.sizeBytes > CAPTURE_SERVE_MAX_BYTES) return REFUSED;

    return { ok: true, capability, serve };
  } catch {
    // A store/transport failure must not become a distinguishable answer.
    return REFUSED;
  }
}
