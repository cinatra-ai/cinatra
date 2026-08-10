"use client";

// ---------------------------------------------------------------------------
// `ReviewGateCard` — THE renderer of `artifact_review_gate` (cinatra#2566, epic
// #2564 S2). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §II (the card in the thread), §III (what the
// target shows), §IV (the review states), §IX (where each card appears).
//
// ONE RENDERER, THREE FIRST-PARTY HOSTS. The same component draws the review in
// the chat thread, in the run card, and in the review page's gate region. That
// is the epic's structural rule, and it is why this file is the only place the
// review interaction is composed: S1's registry dispatches `artifact_review_gate`
// here, the run panel mounts it where the display-only redirect card used to be,
// and the review page mounts it where its own target-panel + decision-bar
// composition used to be. The HOST supplies a frame (spacing, and on the page a
// bound decision action); it never supplies a second drawing.
//
// IT REUSES THE SHIPPED REVIEW COMPONENTS, IT DOES NOT RESTYLE THEM. The spec
// page was SPLICED from the ratified `Agent run & review` drawings — §II's floor
// is that page's §VI decision bar, §III's three tiers are that page's §V target,
// §IV's states are that page's §VII. So the card mounts `ReviewDecisionBar`,
// `ReviewGateLoading` and `ReviewGateBlocked` verbatim, and renders the target
// through the ISLAND, which server-renders the very `ReviewTargetPanel` the page
// has always used. No pixel here is invented.
//
// WHY THE TARGET ARRIVES IN AN ISLAND. §III's ladder — a build-time renderer, a
// runtime renderer, or the never-blank metadata floor — is resolved by SERVER
// components (`ReviewTargetMount`, `ExtensionRendererSlot`), while a chat
// transcript is client-rendered. The card therefore embeds a same-origin,
// authenticated, DISPLAY-ONLY island that renders the ladder server-side.
//
// THE FRAME IS A RENDERING MECHANISM, NOT AN ISOLATION BOUNDARY, and nothing
// here relies on it being one. `sandbox="allow-scripts allow-same-origin"` with
// BOTH tokens set is not isolation: the framed document shares this origin, can
// reach the parent DOM, and could remove its own sandbox and reload. What the
// tokens do buy is the withholding of the capabilities the island has no use
// for — top-level navigation, form submission, popups, pointer lock — so a fault
// inside a type renderer cannot navigate the app away from the conversation.
// The renderer trust model is UNCHANGED from the review page: the island runs
// the same first-party code the page runs, against the same authorization. If
// renderer isolation ever becomes a requirement, it needs a separate origin, not
// a sandbox attribute, and that is a decision for the slice that requires it.
//
// The AUTHORIZATION is the island's own: it re-decodes the ref, re-runs the
// reader's run access, and renders an empty document when the reader may not
// read the target. `frame-ancestors 'self'` (next.config.ts) keeps a hostile
// site from framing it at all, and `Cache-Control: no-store` keeps a shared
// cache from holding a reader-scoped document.
//
// SEVEN OUTCOMES, AND THE TWO ABSENCES ARE HELD APART. The card resolves its
// state through S1's authoritative refetch and then draws exactly one of:
//   loading    → the shipped skeleton;
//   pending    → target(s) + the live floor;
//   restricted → target(s) + the floor with the terminal affordances disabled
//                and the reason on screen (§IV: a withheld card must never be
//                drawn as a disabled one);
//   settled    → "This review is no longer open", with a Refresh instead of a
//                stale decision;
//   advisory   → nothing. A review gate has no advisory reading (that is §VII's
//                verification card); drawing one here would put a card with no
//                floor where a decision is expected. Fail closed.
//   absent     → NO card DOM at all — the reader may not read the target, so the
//                turn carries only its prose;
//   not-present→ NO card DOM at all either, for a different reason: §IX says
//                this kind does not appear on this host (or no host declared
//                itself). The two absences are separate branches on purpose —
//                one is "you may not see this", the other is "this surface does
//                not carry this card".
//
// What the two absences guarantee, precisely: neither produces card DOM, and
// neither is ever drawn as the OTHER or as a disabled card. They are not
// indistinguishable to an observer of the page's own network activity — the
// surface-absence issues no resolve at all, the reader-absence issues one and is
// answered `absent`. That difference leaks nothing about a row: whether a host
// carries this card is a static, public property of the surface, and the resolve
// itself is the endpoint that already collapses "no access" and "no such row"
// into one 200 `absent`. The oracle the design forbids is "does this gate exist
// / may this reader see it", and neither branch answers it.
//
// NO NEW DECISION PRIMITIVE. A decision leaves through a seam that already
// exists: the page passes the route-bound server action it has always used, and
// a card with no host action posts its OPAQUE ref to the gate-scoped endpoint,
// which decodes the ref server-side and calls the SAME decision helper with the
// SAME validation order (access before gate read → pending re-check → pinned-set
// membership → provenance re-derivation → the gate CAS). Single-decision safety
// is the CAS, never the route the decision came in on.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ClipboardCheck, Maximize2, Minimize2 } from "lucide-react";

import {
  LIFECYCLE_CARD_PRESENCE,
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  type LifecycleCardHost,
  type LifecycleCardState,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { Button } from "@/components/ui/button";
import type { ReviewDisposition } from "@/lib/artifacts/artifact-review-decision";
import type {
  ReviewDecisionPermissions,
  ReviewSubmitOutcome,
} from "@/lib/artifacts/review-surface-model";

import {
  useLifecycleCardHost,
  useLifecycleCardState,
} from "./lifecycle-card-runtime";
import { ReviewDecisionBar, type SubmitReviewDecisionAction } from "./review-decision-bar";
import { ReviewGateBlocked, ReviewGateLoading } from "./review-gate-states";

// Re-exported so a HOST that mounts the card does not have to reach into the
// protocol package for the one constant it needs to name a payload. The card is
// already the module that knows the wire shape; a second import edge from a
// widely-reachable surface (the run panel) would only widen that surface's graph.
export { LIFECYCLE_VIEW_SCHEMA_VERSION };

/** The authenticated, display-only island that server-renders §III's ladder. */
export const REVIEW_TARGET_ISLAND_PATH = "/lifecycle/review-island";
/** The gate-scoped decision entry — decodes the ref, calls the SAME core. */
export const LIFECYCLE_VIEW_DECIDE_PATH = "/api/lifecycle-views/decide";

/**
 * The per-host FRAME — the closed list of hosts (§IX) mapped to spacing only.
 *
 * "Presence is not layout": §IX fixes WHETHER a card appears, and the section
 * that draws the card fixes HOW. So a host may change the box the card sits in
 * and nothing else — the thread gives it the vertical rhythm of a turn's
 * content slot, the run card and the page gate region are already inside their
 * own spacing. Keeping this a total map over `LifecycleCardHost` is what makes
 * "one renderer, host-specific frame" checkable rather than aspirational: a new
 * host cannot be added without deciding its frame here.
 */
const HOST_FRAME: Record<LifecycleCardHost, string> = {
  chat_thread: "my-3 flex w-full flex-col gap-3",
  run_card: "flex w-full flex-col gap-3",
  page_gate_region: "flex w-full flex-col gap-3",
  site_widget: "my-3 flex w-full flex-col gap-3",
};

/**
 * The hosts THIS slice renders on (#2566 is "ReviewGateCard on first-party
 * hosts"). §IX's presence matrix says the review card eventually appears on the
 * site widget too, but a widget reader may not mount a renderer and must meet a
 * fresh confirmation before any decision — both are S8b/S8d's, and neither
 * exists yet. So the widget is not enabled HERE, in the renderer, rather than
 * quietly weakened in the design table: a surface whose rules are unbuilt draws
 * no card at all. That is the same surface-absence as "no host declared itself".
 */
const FIRST_PARTY_HOSTS: ReadonlySet<LifecycleCardHost> = new Set<LifecycleCardHost>([
  "chat_thread",
  "run_card",
  "page_gate_region",
]);

/** Clamped island height (§ the issue's clamp + internal scroll + expand). */
const ISLAND_HEIGHT_CLAMPED = 380;
const ISLAND_HEIGHT_EXPANDED = 760;

export type ReviewGateCardView = {
  viewType: "artifact_review_gate";
  schemaVersion: number;
  ref: string;
};

/** What the card falls back to when an answer cannot be trusted. */
const UNREADABLE_OUTCOME: ReviewSubmitOutcome = {
  kind: "error",
  message: "The decision could not be read back.",
};

/**
 * Narrow an unknown body to a `ReviewSubmitOutcome`.
 *
 * EVERY MEMBER'S FIELDS ARE CHECKED, not just the discriminant. A shape whose
 * `kind` says "decided" but carries no `disposition` would otherwise render as a
 * successful REJECT (the notice keys on `disposition === "approve"`), which is
 * the worst possible way to be wrong about a decision. Anything that does not
 * validate becomes a retryable error — the card never reports a landed decision
 * it cannot fully read.
 */
function asSubmitOutcome(body: unknown): ReviewSubmitOutcome {
  if (typeof body !== "object" || body === null) return UNREADABLE_OUTCOME;
  const outcome = (body as { outcome?: unknown }).outcome;
  if (typeof outcome !== "object" || outcome === null) return UNREADABLE_OUTCOME;
  const o = outcome as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const bool = (v: unknown): v is boolean => typeof v === "boolean";
  switch (o.kind) {
    case "decided":
      return (o.disposition === "approve" ||
        o.disposition === "reject" ||
        o.disposition === "comment") &&
        bool(o.idempotent)
        ? { kind: "decided", disposition: o.disposition, idempotent: o.idempotent }
        : UNREADABLE_OUTCOME;
    case "annotated":
      return { kind: "annotated" };
    case "changes-requested":
      return (o.status === "requested" || o.status === "escalated") && bool(o.idempotent)
        ? { kind: "changes-requested", status: o.status, idempotent: o.idempotent }
        : UNREADABLE_OUTCOME;
    case "blocked":
      // The blocked axis is a closed set; an unknown reason is not a block the
      // shipped panel has copy for, so it is not a block this card will draw.
      return o.reason === "no-longer-pending" ||
        o.reason === "targets-mismatch" ||
        o.reason === "revision-not-live"
        ? { kind: "blocked", reason: o.reason }
        : UNREADABLE_OUTCOME;
    case "not-permitted":
      return str(o.message) ? { kind: "not-permitted", message: o.message } : UNREADABLE_OUTCOME;
    case "error":
      return str(o.message) ? { kind: "error", message: o.message } : UNREADABLE_OUTCOME;
    default:
      return UNREADABLE_OUTCOME;
  }
}

/**
 * The REVIEW card. `view` is S1's wire payload — a viewType, a schemaVersion and
 * an opaque ref, and nothing else; every fact drawn below is resolved from the
 * server against the live reader.
 */
export function ReviewGateCard({
  view,
  submitAction,
}: {
  view: ReviewGateCardView;
  /**
   * The host's own bound decision action. The review PAGE passes the route-bound
   * server action it has always used, so its decision transport is unchanged by
   * the move into this card. Every other host omits it and the card falls back
   * to the gate-scoped, ref-bound endpoint — the same core either way.
   */
  submitAction?: SubmitReviewDecisionAction;
}): ReactElement | null {
  const host = useLifecycleCardHost();
  // §IX presence: no declared host, or a host this kind does not appear on →
  // the card is not part of this surface at all. This is the FIRST absence.
  const present =
    host !== null &&
    LIFECYCLE_CARD_PRESENCE.artifact_review_gate[host] &&
    FIRST_PARTY_HOSTS.has(host);
  const [reloadToken, setReloadToken] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const state = useLifecycleCardState({
    viewType: "artifact_review_gate",
    ref: view.ref,
    enabled: present,
    reloadToken,
  });

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // The ref-bound fallback action. Built once per ref so the decision bar's
  // identity is stable across re-resolves.
  const refBoundSubmit = useMemo<SubmitReviewDecisionAction>(() => {
    return async (input: {
      disposition: ReviewDisposition;
      comment: string | null;
    }): Promise<ReviewSubmitOutcome> => {
      try {
        const response = await fetch(LIFECYCLE_VIEW_DECIDE_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            ref: view.ref,
            disposition: input.disposition,
            comment: input.comment,
          }),
        });
        if (!response.ok) {
          // A non-2xx is deliberately generic: the endpoint answers the same way
          // for "not yours" and "not there", and the card must not turn a status
          // code into a hint about which.
          return {
            kind: "not-permitted",
            message:
              "This decision could not be recorded on this surface. Open the review to continue.",
          };
        }
        return asSubmitOutcome(await response.json());
      } catch {
        return {
          kind: "error",
          message: "The decision could not be sent.",
        };
      }
    };
  }, [view.ref]);

  // A landed decision RE-RESOLVES the card. Whichever transport carried it, an
  // approve/reject/changes-requested leaves the gate resolved, and the card must
  // then show the server's answer (§IV `settled`) rather than sit on the state it
  // resolved before the decision. The review page got this for free from
  // `router.refresh()` re-running its server component; a card in a transcript
  // has no such re-render, so the refresh is explicit here — and it now applies
  // on the page too, keeping all three hosts identical.
  const submitAndRefresh: SubmitReviewDecisionAction = async (input) => {
    const outcome = await (submitAction ?? refBoundSubmit)(input);
    if (outcome.kind === "decided" || outcome.kind === "changes-requested") refresh();
    return outcome;
  };

  // Nothing renders until an authorized resolve has answered (S1's contract) —
  // not even a skeleton, because a placeholder that appears and then vanishes is
  // itself an existence oracle.
  if (!present || state === null) return null;

  const frame = HOST_FRAME[host];
  const body = renderState({
    state,
    islandSrc: `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(view.ref)}`,
    expanded,
    onToggleExpanded: () => setExpanded((v) => !v),
    submit: submitAndRefresh,
    onRefresh: refresh,
  });
  // The SECOND absence: the reader may not read the target (or there is nothing
  // to read). No panel, no placeholder, no reason — the turn carries only prose.
  if (body === null) return null;

  return (
    <div
      className={frame}
      data-lifecycle-card="artifact_review_gate"
      data-lifecycle-card-state={state.state}
      data-lifecycle-card-host={host}
      data-conformance-id="review-gate-card"
    >
      {body}
    </div>
  );
}

/**
 * §IV's state ladder. Returns `null` for every state that draws nothing, so the
 * caller has exactly one place where "no card DOM at all" is decided.
 */
function renderState(args: {
  state: LifecycleCardState;
  islandSrc: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  submit: SubmitReviewDecisionAction;
  onRefresh: () => void;
}): ReactElement | null {
  const { state, islandSrc, expanded, onToggleExpanded, submit, onRefresh } = args;

  switch (state.state) {
    case "loading":
      return (
        <>
          <ReviewGateHeader pending />
          <ReviewGateLoading />
        </>
      );

    case "settled":
      // §IV "no longer open": the gate was already decided or the run moved on.
      // A Refresh, never a stale decision slipping through.
      return <ReviewGateBlocked reason="no-longer-pending" onRefresh={onRefresh} />;

    case "pending":
    case "restricted": {
      // The floor's permissions are the SERVER's answer, carried through
      // unchanged. §IV's `restricted` is exactly `canDecide: false` with the
      // reason the shipped bar already renders — the card adds no judgement of
      // its own, and a reader who may comment keeps a live Comment.
      const permissions: ReviewDecisionPermissions = {
        canDecide: state.canDecide,
        canComment: state.canComment,
      };
      return (
        <>
          <ReviewGateHeader pending />
          {/* §III — the target(s). ONE island renders every pinned target as
              sibling panels, exactly as the page stacks them, because the
              decision below is all-or-nothing across the whole gate. */}
          <ReviewTargetIsland
            src={islandSrc}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
          />
          {/* §II/§IV — ONE gate-level decision floor, however many targets. */}
          <ReviewDecisionBar permissions={permissions} submitAction={submit} />
        </>
      );
    }

    case "advisory":
      // Not a review state (§VII owns it). Fail closed rather than draw a card
      // that asks for a decision it has no floor for.
      return null;

    case "absent":
      return null;
  }
}

/**
 * §I/§II — the gate header the review page has always drawn ("Review requested"
 * + the awaiting-your-decision pill), now owned by the card so all three hosts
 * show the same thing. Markup and tokens are the page's, unchanged.
 */
function ReviewGateHeader({ pending }: { pending: boolean }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-mustard-ink/15 text-mustard-ink">
        <ClipboardCheck aria-hidden="true" className="size-4" />
      </span>
      <span className="font-sans text-sm font-bold text-foreground">Review requested</span>
      {pending ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-logo/40 bg-logo/15 px-2.5 py-0.5 text-xs font-semibold text-mustard-ink">
          <span className="size-[7px] rounded-full bg-logo" aria-hidden="true" />
          Awaiting your decision
        </span>
      ) : null}
    </div>
  );
}

/**
 * The island frame: a same-origin, authenticated, DISPLAY-ONLY iframe holding
 * the server-rendered §III ladder, clamped with internal scroll and one expand
 * control. The height is clamped rather than measured: a card in a transcript
 * must not be able to push the rest of the conversation off screen, and reading
 * a height back out of the frame would need a message channel the display-only
 * posture deliberately does not have.
 */
function ReviewTargetIsland({
  src,
  expanded,
  onToggleExpanded,
}: {
  src: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}): ReactElement {
  return (
    <div
      data-conformance-id="review-target-island"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      <iframe
        src={src}
        title="Review target"
        // NOT an isolation boundary — see the module header. These tokens
        // withhold top-navigation, form submission and popups from a document
        // that needs none of them; the authorization is the island's own.
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="same-origin"
        loading="lazy"
        className="w-full border-0 bg-surface-strong"
        style={{ height: expanded ? ISLAND_HEIGHT_EXPANDED : ISLAND_HEIGHT_CLAMPED }}
      />
      <div className="flex items-center justify-end border-t border-line px-2 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="toggle-review-target-height"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? (
            <Minimize2 aria-hidden="true" className="size-3.5" />
          ) : (
            <Maximize2 aria-hidden="true" className="size-3.5" />
          )}
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>
    </div>
  );
}
