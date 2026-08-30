import "server-only";

// ---------------------------------------------------------------------------
// The REVIEW-TARGET ISLAND (cinatra#2566, epic #2564 S2). Design:
// design@6c20871b4108176c1d0193f19ecd2947f6c6355f `specs/app-lifecycle-cards.html`
// §III ("what the target shows" — the three-tier ladder and the never-blank
// floor), spliced from `Application Design — Agent run & review` §V.
//
// WHAT IT IS. One authenticated, same-origin, DISPLAY-ONLY document that
// server-renders the pinned targets of ONE review gate: the immutable target
// header, the renderer-provenance chip, and whichever tier of the ladder
// resolves — a build-time renderer the defining extension ships, a runtime
// renderer from an installed extension, or the sanitized metadata floor. Plus
// the pinned capture pair where the target has one. It is the SAME
// `ReviewTargetPanel` the review page has always rendered; there is no second
// implementation of the ladder anywhere.
//
// WHY IT EXISTS. §III's ladder is resolved by SERVER components, and two of the
// three hosts that must show it (the chat thread, the run card) are
// client-rendered transcripts. The card embeds this document instead of
// re-implementing the ladder on the client, which would have meant a second
// renderer resolution path — exactly what the epic's one-card rule forbids.
//
// WHAT IT IS NOT. It carries NO decision chrome. The floor lives in the card,
// outside the frame, so a decision is always taken by the first-party document
// the reader is actually looking at and never by something inside an embedded
// context. It also carries no navigation and no links out beyond the ones the
// shipped floor already renders (version-pinned preview / download hrefs
// authorized by the host).
//
// THE FRAME IS CONTAINMENT, NOT A TRUST BOUNDARY. The embedding card sets
// `sandbox="allow-scripts allow-same-origin"`, which — with both tokens — does
// not isolate a same-origin document from its opener. That is deliberate and
// harmless BECAUSE the authorization is here: a reader is required, the ref is
// decoded server-side (it is authenticated-encrypted; a forged one does not
// decode), and `loadReviewGateSurface` re-runs the reader's run access and reads
// the pinned set from the frozen gate. The response also declares
// `frame-ancestors 'self'` (next.config.ts), so a hostile site cannot frame it.
//
// TWO WAYS TO BE A READER (cinatra#2674 scope addition, 2026-08-12).
//
//   • A SESSION COOKIE — the first-party path, unchanged in every respect.
//   • AN ISLAND CREDENTIAL (`?ic=`) — for the widget. The island is same-origin
//     to Cinatra but the PAGE around it is a third-party CMS, and a
//     SameSite-bound session cookie is simply not sent into that frame. So on a
//     genuinely cross-site deployment the cookie path paints nothing, however
//     correct the framing wall is; until this slice, island parity held only on
//     same-site and subdomain deployments. The credential closes that: it is
//     short-lived, ref-bound, derived from the WIDGET principal (never from the
//     parent), and re-checked against the live `cwu_` row at every paint.
//
// THE CREDENTIAL AUTHENTICATES; IT AUTHORIZES NOTHING. Both paths converge on
// the SAME `loadReviewGateSurface` call with a fully-resolved actor, so the
// reader's run access decides what appears, exactly as it always has.
//
// `Cache-Control: no-store` is configured for this path in next.config.ts.
// The MECHANISM, not this exact route, is verified: a minimal reproduction
// using this same headers() configuration on node_modules/next@16.2.10 shows
// the production Next.js server (`next build && next start`) serves a
// next.config.ts-configured Cache-Control header unmodified for a
// force-dynamic App Router page. This route was not independently curled in
// production, and a released image's own proxy/deployment layer was not
// checked either. On `next dev` only, EVERY App Router PAGE response is
// forced to `no-cache, must-revalidate` by the framework itself,
// unconditionally and with no config to opt out (`routeModule.isDev` in
// next/dist/build/templates/app-page.js) — so a dev-server capture of this
// header shows the dev value, not the configured one. That is a `next dev`
// artifact, not evidence the header is unset in production.
//
// ONE DOCUMENT, THE HOST'S PALETTE (cinatra#2931, epic #2926 W4). The island is
// a nested browsing context and cannot see the surface around it, so it used to
// resolve a palette from its OWN theme state. On a first-party page that store
// is the app's own and the island came out matching the page by coincidence;
// inside a third-party application it is a partitioned store nothing writes, so
// the island fell back to the app's default palette and painted a light panel
// inside a dark widget. The card that frames it now NAMES the host's palette on
// this URL, for every host from one read, and this page paints in exactly what
// it was told: the palette class carries the tokens to every descendant and the
// full-frame height keeps the document's own ground from showing around them.
// The parameter is a closed two-word enum and authorizes nothing; a request that
// names no palette renders exactly what it rendered before it existed.
//
// EVERY DENIAL DRAWS NOTHING. No access, no such gate, a ref that does not
// decode, a gate too damaged to read — all render an empty document. The island
// never says why, because the card above it must be indistinguishable between
// "you may not read this" and "there is nothing here" (the generic refusal
// contract).
//
// A DECIDED GATE IS NOT A DENIAL. "A resolved gate opens read-only: what was
// decided, and the reviewed target(s), kept for the run's audit trail" — so this
// document draws a resolved gate's frozen pinned set exactly as it draws a
// pending one's: the same panels, the same renderers, the same pinned revision.
// The reading is still display-only, and the difference is entirely above the
// frame: the card that mounts this island for a decided gate draws no floor at
// all, so there is nothing to press on either side of the boundary.
// ---------------------------------------------------------------------------

import { Suspense } from "react";
import { redirect } from "next/navigation";

import { getAuthSession, signInRedirectTarget } from "@/lib/auth-session";
import { resolveVerifiedWidgetFrameOrigin } from "@/lib/embed/frame-ancestors.server";
import { loadReviewGateSurface } from "@/app/artifacts/[id]/review-gate-ports";
import { pinnedCaptureKey } from "@/lib/artifacts/review-surface-model";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM } from "@/lib/lifecycle/review-island-credential";
import {
  islandBodyClassName,
  islandDocumentGroundCss,
  islandEmptyClassName,
  parseIslandColorScheme,
  REVIEW_ISLAND_COLOR_SCHEME_PARAM,
  type IslandColorScheme,
} from "./island-color-scheme";
import { resolveIslandCredentialReader } from "@/lib/lifecycle/review-island-serving";
import { ReviewGateLoading } from "@cinatra-ai/agents/review-gate-states";

import { resolveReviewActorContext } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor";
import { ReviewTargetPanel } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel";
import { ReviewIslandHeightReport } from "./island-height-report";

/** Never cached, never statically rendered — the reader is resolved per request. */
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `?assistant` + `?instanceId` (cinatra#2577) are the SAME two disambiguators
 * `/embed/assistant` carries. They are not read as content and never authorize
 * anything — they only let the server re-derive the registered origin of the
 * frame this document is nested in, which the response's `frame-ancestors` wall
 * must admit for the island to render at all inside the widget.
 */

/**
 * The empty island — the ONE shape every denial and every absence renders.
 *
 * It is built ONCE PER REQUEST and every denial below returns that one object,
 * so "no access", "no such gate", "a ref that does not decode" and "the gate
 * moved on" are not merely similar: they are the same element, and nothing
 * downstream can accidentally make one of them distinguishable from another. It
 * takes the host's palette exactly as the body does — a denial inside a dark
 * card is still a painted rectangle — and every denial takes the same one, so
 * the palette separates schemes and never separates refusals.
 */
function emptyIsland(scheme: IslandColorScheme | null) {
  return (
    <div
      className={islandEmptyClassName(scheme)}
      data-conformance-id="review-target-island-empty"
      data-island-color-scheme={scheme ?? undefined}
      style={scheme ? { colorScheme: scheme } : undefined}
    />
  );
}

export default async function ReviewTargetIslandPage({ searchParams }: PageProps) {
  const sp = (await searchParams) ?? {};
  const rawRef = sp.ref;
  const ref = typeof rawRef === "string" ? rawRef : null;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);
  const rawCredential = sp[REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM];
  const credential = typeof rawCredential === "string" ? rawCredential : null;
  // The HOST's palette, named by the card that frames this document. Read before
  // the first refusal below, because a refusal is painted too.
  const scheme = parseIslandColorScheme(one(sp[REVIEW_ISLAND_COLOR_SCHEME_PARAM]));
  const groundCss = islandDocumentGroundCss(scheme);
  const empty = emptyIsland(scheme);

  // Is this a VERIFIED widget frame? Resolved server-side from the SAME closed
  // binding the island's `frame-ancestors` wall uses, so the header and this
  // page cannot disagree (cinatra#2577). Nothing here is authorization: it only
  // decides which SHAPE a denial takes on the COOKIE path below.
  const widgetFrame = resolveVerifiedWidgetFrameOrigin({
    assistant: one(sp.assistant),
    instanceId: one(sp.instanceId),
  });

  // THE WIDGET PATH FIRST, and it never redirects. A frame on a third-party CMS
  // has no session to fall back to and must not be sent to a sign-in page it
  // cannot usefully render inside an embedded card: a credential that does not
  // resolve draws the empty island, like every other refusal here.
  let actorCtx: Awaited<ReturnType<typeof resolveReviewActorContext>> = null;
  let runId: string;
  let reviewTaskId: string;
  if (credential) {
    const reader = await resolveIslandCredentialReader({ credential, ref });
    if (!reader) return empty;
    actorCtx = reader.actorCtx;
    // The GATE COMES FROM THE CREDENTIAL, not from a second decode of the ref.
    // The two were proven equal inside the resolver; reading the ref again here
    // would be a place for them to stop being equal.
    runId = reader.runId;
    reviewTaskId = reader.reviewTaskId;
  } else {
    // THE FIRST-PARTY COOKIE PATH. A session is required, and first-party that
    // is the ONE branch that is not an empty island: an unauthenticated frame
    // lands on sign-in exactly like any other first-party page, rather than
    // silently rendering blank forever.
    //
    // INSIDE A WIDGET IT DRAWS NOTHING INSTEAD (cinatra#2577, codex round 1,
    // finding 4). The redirect there would put Cinatra's interactive sign-in
    // form inside chrome a third-party site controls — the shape of a
    // credential-phishing surface — and the reader has no way to tell it apart
    // from the real thing. It is also pointless: the widget reader's own sign-in
    // is the frame-owned popup flow (cinatra#2674), not a form in a nested
    // frame. So on that surface an absent session, an expired or revoked one,
    // and an unresolvable actor all draw the SAME empty island every other
    // denial here draws. A widget deployment that IS same-site still reaches
    // this branch when it sends no `?ic=`, which is why the guard stays even
    // though the credential path above is the widget's real answer.
    const session = await getAuthSession();
    if (!session) {
      if (widgetFrame) return empty;
      redirect(await signInRedirectTarget());
    }
    actorCtx = await resolveReviewActorContext();
    if (!actorCtx) {
      if (widgetFrame) return empty;
      redirect(await signInRedirectTarget());
    }

    if (!ref) return empty;
    // The ref is authenticated-encrypted: a forged or tampered one does not
    // decode, and a replayed one still has to pass the access checks below.
    const payload = decodeLifecycleGateRef(ref);
    if (!payload) return empty;
    runId = payload.runId;
    reviewTaskId = payload.reviewTaskId;
  }

  const surface = await loadReviewGateSurface({
    runId,
    reviewTaskId,
    actorCtx,
  });
  // `not-authorized` and `blocked` draw nothing here — see the header. It is one
  // empty document either way, so a reader still cannot tell WHY it is empty.
  // `settled` draws: a decided gate keeps its reviewed target(s) read-only.
  if (surface.kind !== "ready" && surface.kind !== "settled") return empty;
  const decided = surface.kind === "settled";

  return (
    <div
      className={islandBodyClassName(scheme)}
      data-conformance-id="review-target-island-body"
      // WHICH READING this document is: the gate's own state, named for the
      // conformance check and for nothing else. Both readings draw the same
      // panels from the same frozen set; neither carries decision chrome.
      data-review-reading={decided ? "decided" : "pending"}
      data-target-count={surface.targets.length}
      data-island-color-scheme={scheme ?? undefined}
      style={scheme ? { colorScheme: scheme } : undefined}
    >
      {/* The document's own ground, which a wrapper cannot reach: the frame's
          scrollbar and the canvas an overscroll exposes. Composed from the
          closed enum, never from the request's text. */}
      {groundCss ? <style>{groundCss}</style> : null}

      {/* The island tells the frame around it how tall its content actually is
          (cinatra#3047), so an expanded frame is the reading's own height rather
          than a fixed ceiling with empty ground under it. Draws nothing. */}
      <ReviewIslandHeightReport />

      {/* §II — the producing agent's one-line summary when the gate carried one.
          Part of the target's context, not of the decision. */}
      {surface.agentSummary ? (
        <p className="max-w-[66ch] text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
            Agent summary
          </span>{" "}
          {surface.agentSummary}
        </p>
      ) : null}

      {/* §II/§III — every pinned target as a sibling panel, in gate order. The
          card below the frame carries ONE floor for all of them, because the
          decision is all-or-nothing across the gate. */}
      {surface.targets.map((prepared) => (
        <Suspense
          key={`${prepared.target.artifactId}:${prepared.target.representationRevisionId}`}
          fallback={<ReviewGateLoading />}
        >
          <ReviewTargetPanel
            prepared={prepared}
            // The TRUSTED organization scope, from the reader this island just
            // authorized — never from the query string and never from the
            // display props. The form rung reads the pinned bytes under it.
            orgId={actorCtx.orgId}
            capturePair={surface.pinnedCapturePairs[pinnedCaptureKey(prepared.target)] ?? null}
          />
        </Suspense>
      ))}
    </div>
  );
}
