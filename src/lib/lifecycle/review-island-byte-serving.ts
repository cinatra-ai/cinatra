import "server-only";

// The ISLAND BYTE-CAPABILITY SERVING DECISION (enabler 0.6 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// Everything that decides whether an artifact's pinned bytes may be streamed to
// a display inside a third-party application lives here, as a pure function over
// injected ports, so the whole matrix — expired, revoked, re-bound site, wrong
// gate, wrong revision, a pasted URL, a navigation — is provable without a
// database, a browser or a route.
//
// THE LADDER, and why it is in this order. Each rung is cheaper and less
// disclosing than the next, and the order is the fail-closed discipline
// `capture-capability-serving.ts` and `loadReviewGateSurface` already use: never
// touch a store on behalf of a caller who has not yet proven the previous rung.
//
//   1. TRANSPORT SHAPE. The request must present itself as a SUBRESOURCE load
//      from a same-origin document. `Sec-Fetch-*` are forbidden headers, so no
//      page can forge them; pasting the address into a tab is a `document`
//      navigation and a foreign page mounting it is `cross-site`. Both are
//      refused before a byte of work happens. This is NOT proof the requester
//      is a browser — see the capture module's statement of exactly that limit,
//      which holds here word for word.
//   2. THE CAPABILITY ITSELF — sealed, unexpired, under its OWN key label.
//   3. THE LIVE PRINCIPAL — the `cwu_` row behind the sealed `jti` still alive
//      and still bound to the same person, org, site, client, instance and
//      agent. A sealed binding that disagrees with the live row is refused
//      rather than downgraded to the live one: disagreement means the binding
//      moved under it, which is exactly when stale bytes must stop.
//   4. RUN READ ACCESS — re-checked live, against the sealed principal.
//   5. THE GATE BINDING — the sealed (artifact, revision) pair must be in THIS
//      gate's FROZEN pinned set. This is the rung that makes "a capability
//      minted for gate A cannot fetch gate B's bytes" true even when both
//      capabilities are genuine, and it is why the route reads no id from the
//      request: the caller supplies no id at all.
//   6. THE BYTES ARE THAT EXACT PINNED REVISION — resolved by the exact
//      (org, artifact, revision) tuple, within the serve cap.
//
// WHAT IT STRUCTURALLY CANNOT SERVE. Anything the gate did not pin. There is no
// path through this module to an arbitrary artifact, to another revision of the
// same artifact, or to a renderer bundle: rung 5 runs before the resolver is
// consulted, and the resolver is called with the sealed tuple only.
//
// EVERY "no" IS THE SAME "no". The result is a bare discriminated union with no
// reason field, so a route cannot accidentally turn a denial into an oracle.

import {
  verifyReviewIslandByteCapability,
  type IslandByteDisposition,
  type VerifiedReviewIslandByteCapability,
} from "@/lib/lifecycle/review-island-byte-capability";
import type { LiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

/**
 * Ceiling on a served artifact body, mirroring the host's own inline-transport
 * budget. Bytes larger than this are not painted into a card on a third-party
 * page; the display's floor renders instead.
 */
export const ISLAND_BYTE_SERVE_MAX_BYTES = 24 * 1024 * 1024;

/** One pinned target of a gate, as the gate froze it. */
export interface IslandByteGateTarget {
  artifactId: string;
  representationRevisionId: string;
}

/** The blob facts needed to stream. */
export interface IslandByteServeResolution {
  mime: string;
  storageKey: string;
  sizeBytes: number;
}

/** The live reads this decision delegates. Injected so the matrix is testable. */
export interface IslandByteServePorts {
  /** The live `cwu_` binding behind the sealed jti — null when dead/revoked. */
  readLivePrincipal: (jti: string) => LiveWidgetCapturePrincipal | null;
  /** Live run READ access for the sealed principal. */
  runReadAccess: (input: { runId: string; userId: string; orgId: string }) => Promise<boolean>;
  /** The gate's FROZEN pinned target set — null when the gate is absent. */
  readGatePinnedTargets: (
    runId: string,
    reviewTaskId: string,
  ) => Promise<readonly IslandByteGateTarget[] | null>;
  /** The blob facts for the sealed (org, artifact, revision) tuple. */
  resolveServe: (input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
  }) => IslandByteServeResolution | null;
}

export type IslandByteServeDecision =
  | {
      ok: true;
      capability: VerifiedReviewIslandByteCapability;
      serve: IslandByteServeResolution;
      disposition: IslandByteDisposition;
    }
  | { ok: false };

const REFUSED: IslandByteServeDecision = { ok: false };

/**
 * The transport-shape gate (rung 1).
 *
 * FAIL-CLOSED ON ABSENCE, deliberately — treating "absent" as "allowed" would
 * give the rung away to the casual replay for nothing.
 *
 * The admitted destinations are the ones a DISPLAY legitimately uses to paint
 * pinned bytes inside the island: `image`, `video`, `audio`, `object`,
 * `embed`, and the `empty` of a display's own `fetch()` for a text/JSON body.
 * `document` and `iframe` are absent on purpose: those are navigations, which is
 * the pasted-link case, and a byte capability must never become a top-level page.
 *
 * WHAT THAT MEANS FOR THE `download` DISPOSITION, SAID PLAINLY, because the
 * contract is easy to read the other way round. A sealed `download` capability
 * chooses the RESPONSE's `Content-Disposition`; it does NOT widen this rung. A
 * plain `<a href download>` click is a navigation (`Sec-Fetch-Dest: document`,
 * `Sec-Fetch-Mode: navigate`) and is REFUSED here like any other navigation — a
 * display saves the bytes by fetching them (`Sec-Fetch-Dest: empty`) and handing
 * the result to the reader, never by pointing a link at this route. Admitting
 * `document` for the download disposition would reopen exactly the top-level
 * rendering of artifact bytes this rung exists to close, so the rung stays as it
 * is and the wiring follows it.
 */
export function isSameOriginDisplaySubresourceFetch(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  const site = headers.get("sec-fetch-site");
  if (site !== "same-origin") return false;
  const mode = headers.get("sec-fetch-mode");
  if (mode !== null && mode === "navigate") return false;
  return (
    dest === "image" ||
    dest === "video" ||
    dest === "audio" ||
    dest === "object" ||
    dest === "embed" ||
    dest === "empty"
  );
}

/**
 * Decide whether this capability may stream its pinned bytes right now.
 *
 * Never throws — a port that rejects is a refusal, because a 500 would be as
 * distinguishable as a 403.
 */
export async function decideIslandByteServe(params: {
  encodedCapability: string | null;
  headers: Headers;
  ports: IslandByteServePorts;
  nowSeconds?: number;
}): Promise<IslandByteServeDecision> {
  const { encodedCapability, headers, ports } = params;

  // 1. Transport shape.
  if (!isSameOriginDisplaySubresourceFetch(headers)) return REFUSED;

  // 2. The capability itself.
  if (typeof encodedCapability !== "string" || encodedCapability.length === 0) {
    return REFUSED;
  }
  const capability = verifyReviewIslandByteCapability(encodedCapability, {
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

    // 5. THE GATE BINDING. The sealed pair must be one the gate itself froze —
    //    artifact AND revision together, so a capability cannot walk to a later
    //    revision of a legitimately pinned artifact.
    const targets = await ports.readGatePinnedTargets(
      capability.runId,
      capability.reviewTaskId,
    );
    if (!targets || targets.length === 0) return REFUSED;
    const pinnedByThisGate = targets.some(
      (t) =>
        t.artifactId === capability.artifactId &&
        t.representationRevisionId === capability.representationRevisionId,
    );
    if (!pinnedByThisGate) return REFUSED;

    // 6. The bytes of exactly that pinned revision.
    const serve = ports.resolveServe({
      orgId: capability.orgId,
      artifactId: capability.artifactId,
      representationRevisionId: capability.representationRevisionId,
    });
    if (!serve) return REFUSED;
    if (!Number.isFinite(serve.sizeBytes) || serve.sizeBytes < 0) return REFUSED;
    if (serve.sizeBytes > ISLAND_BYTE_SERVE_MAX_BYTES) return REFUSED;
    if (typeof serve.mime !== "string" || serve.mime.length === 0) return REFUSED;

    return { ok: true, capability, serve, disposition: capability.disposition };
  } catch {
    // A store/transport failure must not become a distinguishable answer.
    return REFUSED;
  }
}
