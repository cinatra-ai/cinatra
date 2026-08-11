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
// harmless BECAUSE the authorization is here: a session is required, the ref is
// decoded server-side (it is authenticated-encrypted; a forged one does not
// decode), and `loadReviewGateSurface` re-runs the reader's run access and reads
// the pinned set from the frozen gate. The response also declares
// `frame-ancestors 'self'` (next.config.ts), so a hostile site cannot frame it.
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
// EVERY DENIAL DRAWS NOTHING. No access, no such gate, a ref that does not
// decode, a gate that is no longer pending — all render an empty document. The
// island never says why, because the card above it must be indistinguishable
// between "you may not read this" and "there is nothing here" (the generic
// refusal contract). The card's own authoritative refetch is what turns a
// settled gate into §IV's "no longer open" panel; the island stays silent.
// ---------------------------------------------------------------------------

import { Suspense } from "react";
import { redirect } from "next/navigation";

import { getAuthSession, signInRedirectTarget } from "@/lib/auth-session";
import { resolveVerifiedWidgetFrameOrigin } from "@/lib/embed/frame-ancestors.server";
import { loadReviewGateSurface } from "@/app/artifacts/[id]/review-gate-ports";
import { pinnedCaptureKey } from "@/lib/artifacts/review-surface-model";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { ReviewGateLoading } from "@cinatra-ai/agents/review-gate-states";

import { resolveReviewActorContext } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor";
import { ReviewTargetPanel } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel";

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
 * The empty island — the ONE shape every denial and every absence renders. It is
 * a single shared ELEMENT rather than a component, so "no access", "no such
 * gate", "a ref that does not decode" and "the gate moved on" are not merely
 * similar: they are the same object, and nothing downstream can accidentally
 * make one of them distinguishable from another.
 */
const EMPTY_ISLAND = <div data-conformance-id="review-target-island-empty" />;

export default async function ReviewTargetIslandPage({ searchParams }: PageProps) {
  const sp = (await searchParams) ?? {};
  const rawRef = sp.ref;
  const ref = typeof rawRef === "string" ? rawRef : null;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

  // Is this a VERIFIED widget frame? Resolved server-side from the SAME closed
  // binding the island's `frame-ancestors` wall uses, so the header and this
  // page cannot disagree (cinatra#2577). Nothing here is authorization: it only
  // decides which SHAPE a denial takes.
  const widgetFrame = resolveVerifiedWidgetFrameOrigin({
    assistant: one(sp.assistant),
    instanceId: one(sp.instanceId),
  });

  // A session is required. First-party, that is the ONE branch that is not an
  // empty island: an unauthenticated frame lands on sign-in exactly like any
  // other first-party page, rather than silently rendering blank forever.
  //
  // INSIDE A WIDGET IT DRAWS NOTHING INSTEAD (codex round 1, finding 4). The
  // redirect there would put Cinatra's interactive sign-in form inside chrome a
  // third-party site controls — the shape of a credential-phishing surface —
  // and the reader has no way to tell it apart from the real thing. It is also
  // pointless: the widget reader's own sign-in is the hosted popup flow, not a
  // form in a nested frame. So on that surface an absent session, an expired or
  // revoked one, and an unresolvable actor all draw the SAME empty island every
  // other denial here draws.
  const session = await getAuthSession();
  if (!session) {
    if (widgetFrame) return EMPTY_ISLAND;
    redirect(await signInRedirectTarget());
  }
  const actorCtx = await resolveReviewActorContext();
  if (!actorCtx) {
    if (widgetFrame) return EMPTY_ISLAND;
    redirect(await signInRedirectTarget());
  }

  if (!ref) return EMPTY_ISLAND;
  // The ref is authenticated-encrypted: a forged or tampered one does not decode,
  // and a replayed one still has to pass the access checks below.
  const payload = decodeLifecycleGateRef(ref);
  if (!payload) return EMPTY_ISLAND;

  const surface = await loadReviewGateSurface({
    runId: payload.runId,
    reviewTaskId: payload.reviewTaskId,
    actorCtx,
  });
  // `not-authorized` and `blocked` both draw nothing here — see the header.
  if (surface.kind !== "ready") return EMPTY_ISLAND;

  return (
    <div
      className="flex flex-col gap-3 bg-surface p-3"
      data-conformance-id="review-target-island-body"
      data-target-count={surface.targets.length}
    >
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
            capturePair={surface.pinnedCapturePairs[pinnedCaptureKey(prepared.target)] ?? null}
          />
        </Suspense>
      ))}
    </div>
  );
}
