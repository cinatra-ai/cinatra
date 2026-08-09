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
// `frame-ancestors 'self'` and `Cache-Control: no-store` (next.config.ts), so a
// hostile site cannot frame it and no proxy may retain it.
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

  // A session is required. This is the ONE branch that is not an empty island:
  // an unauthenticated frame should land on sign-in, exactly like any other
  // first-party page, rather than silently render blank forever.
  const session = await getAuthSession();
  if (!session) redirect(await signInRedirectTarget());
  const actorCtx = await resolveReviewActorContext();
  if (!actorCtx) redirect(await signInRedirectTarget());

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
