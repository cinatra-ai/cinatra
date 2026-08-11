"use client";

// ---------------------------------------------------------------------------
// `ReviewGateCard` — THE renderer of `artifact_review_gate` (cinatra#2566, epic
// #2564 S2). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §II (the card in the thread), §III (what the
// target shows), §IV (the review states), §IX (where each card appears).
//
// ONE RENDERER, EVERY HOST — INCLUDING THE WIDGET (corrected 2026-08-11;
// cinatra#2577 + #2575, owner ruling). The same component draws the review in
// the chat thread, in the run card, in the review page's gate region and in the
// site widget. That is the epic's structural rule, and it is why this file is
// the only place the review interaction is composed: S1's registry dispatches
// `artifact_review_gate` here, the run panel mounts it where the display-only
// redirect card used to be, the review page mounts it where its own target-panel
// + decision-bar composition used to be, and the embed mounts it inside its own
// host declaration. The HOST supplies a frame (spacing, a credential, and on the
// page a bound decision action); it never supplies a second drawing.
//
// WHAT WAS REMOVED HERE, AND WHY. This file used to hold a `FIRST_PARTY_HOSTS`
// set that made the widget draw nothing, on the premise that a widget reader may
// not mount a renderer and must pass a fresh confirmation window before any
// decision. That premise was invented: the widget session IS the person's own
// cinatra authentication (hosted PKCE sign-in, cinatra#407), so through the
// widget they have the same rights and the same experience as inside Cinatra —
// the renderer island, the live floor, the same states. The restriction that
// remains is the one that was always real and is surface-independent: the AI
// transport may show and propose, and can never decide, schedule or mutate.
//
// THE DECISION TRAVELS ON THE HOST'S OWN CREDENTIAL. A first-party host posts
// same-origin with its cookie; the widget posts the broker headers it already
// proves its resolve with, at `credentials: "omit"`. That is not a second
// decision path — it is the same endpoint and the same core decision module,
// entered with the proof the surface actually has. On the widget the omission is
// load-bearing: the embed is same-origin to the app, so an ambient cookie would
// record the decision against a different person entirely.
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
//   not-present→ NO card DOM at all either, for a different reason: no host
//                declared itself, so this subtree is not a lifecycle surface.
//                The two absences are separate branches on purpose — one is
//                "you may not see this", the other is "nothing here draws
//                lifecycle cards".
//
// What the two absences guarantee, precisely: neither produces card DOM, and
// neither is ever drawn as the OTHER or as a disabled card. They are not
// indistinguishable to an observer of the page's own network activity — the
// surface-absence issues no resolve at all, the reader-absence issues one and is
// answered `absent`. That difference leaks nothing about a row: whether a
// subtree declares a lifecycle host is a static, public property of the surface,
// and the resolve itself is the endpoint that already collapses "no access" and
// "no such row" into one 200 `absent`. The oracle the design forbids is "does
// this gate exist / may this reader see it", and neither branch answers it.
//
// SUGGESTION CHIPS ARE PART OF THIS ONE RENDERER (cinatra#2572, epic #2564 S6c;
// spec §VIII). The chips are not a second component mounted per host — they are
// drawn HERE, between §III's target and §II's floor, which is what makes "page
// and card, one component" true by construction rather than by convention: the
// review page's gate region and the run card and the chat thread all mount this
// file, so there is exactly one place a chip can come from.
//
// A MARK IS LOCAL; THE DECISION IS THE ACT. §VIII: "the chips carry no submit of
// their own — the review card's floor is the terminal act". So this component
// holds the marks in React state, and the ONLY way they leave the browser is as
// the `suggestionDecisions` field of the one decision the floor submits (S6b's
// partition, folded into the decision fingerprint). There is no per-item request
// on any host, which is the #2047-row-8 rule the whole epic is built on.
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
import { Check, ClipboardCheck, Maximize2, Minimize2, Sparkles, X } from "lucide-react";

import {
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  type LifecycleCardHost,
  type LifecycleCardState,
  type LifecycleSuggestion,
  type LifecycleSuggestionMark,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { Button } from "@/components/ui/button";
import type {
  ReviewDisposition,
  SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";
import type {
  ReviewDecisionPermissions,
  ReviewSubmitOutcome,
} from "@/lib/artifacts/review-surface-model";

import {
  useLifecycleCardAuth,
  useLifecycleCardFrame,
  useLifecycleCardHost,
  useLifecycleCardState,
  type LifecycleCardFrame,
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

/**
 * The island URL for one gate ref, on one host (cinatra#2577).
 *
 * FIRST-PARTY: the ref and nothing else. The island's only ancestor is the page
 * itself, and its wall stays `frame-ancestors 'self'`.
 *
 * EMBEDDED: the host's two frame disambiguators ride along — the SAME
 * `assistant` + `instanceId` the embed page already carries. They let the
 * SERVER re-derive the one registered site origin that is genuinely an ancestor
 * here, so the island can admit exactly that chain instead of refusing to
 * render (which is what a `'self'`-only wall does inside a widget, and what
 * made the island blank there). They are opaque selectors: no origin, no URL,
 * nothing a caller writes can put into a policy.
 */
export function reviewTargetIslandSrc(
  ref: string,
  frame: LifecycleCardFrame | null,
): string {
  const params = new URLSearchParams({ ref });
  if (frame) {
    params.set("assistant", frame.assistant);
    params.set("instanceId", frame.instanceId);
  }
  return `${REVIEW_TARGET_ISLAND_PATH}?${params.toString()}`;
}
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
  // The host's embedding context, when it has one (cinatra#2577). Only an
  // embedded host declares it; it addresses the island and nothing else.
  const cardFrame = useLifecycleCardFrame();
  // The FIRST absence: a subtree that declared no host is not a lifecycle
  // surface at all. Every DECLARED host — the chat thread, the run card, the
  // page gate region and the site widget — draws this card, identically.
  const present = host !== null;
  // The host's credential, when it has one. The first-party hosts declare none
  // and keep the same-origin cookie; the widget declares broker headers with
  // `credentials: "omit"`, and the DECISION must travel on exactly the same
  // proof its resolve does — a decision posted with an ambient cookie from this
  // same-origin iframe would be recorded against whoever else uses the browser.
  const auth = useLifecycleCardAuth();
  const [reloadToken, setReloadToken] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // §VIII — the reviewer's LOCAL marks, keyed by suggestion id, and BOUND to the
  // surface that offered them. Never sent on their own; read at submit time into
  // the one decision's partition. See `MarkState` for why the binding exists.
  const [markState, setMarkState] = useState<MarkState>(EMPTY_MARKS);

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
      suggestionDecisions?: SuggestionDecisionPartition | null;
    }): Promise<ReviewSubmitOutcome> => {
      try {
        const response = await fetch(LIFECYCLE_VIEW_DECIDE_PATH, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(auth?.headers() ?? {}),
          },
          credentials: auth?.credentials ?? "same-origin",
          body: JSON.stringify({
            ref: view.ref,
            disposition: input.disposition,
            comment: input.comment,
            // Omitted entirely when there is no partition, so a gate with no
            // chips posts the body it posted before this slice — and lands the
            // identity-version-1 fingerprint S6b pinned.
            ...(input.suggestionDecisions
              ? { suggestionDecisions: input.suggestionDecisions }
              : {}),
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
  }, [view.ref, auth]);

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

  // §VIII — the marks, RE-BOUND to whatever is surfaced right now.
  //
  // A mark is meaningful only against the exact set it was made on, and that set
  // can change under the reviewer between resolves: a snapshot row edited
  // underneath the store stops verifying and surfaces NOTHING, and a transport
  // failure draws no chips either. Two things must not happen when it does.
  //
  // A MARK MUST NOT BE SILENTLY LOST. Intersecting the marks with the new set
  // and submitting the remainder would let an approve land WITHOUT the items the
  // reviewer believes they accepted — an identity-version-1 decision recording
  // nothing, from a reviewer who marked something. So a changed surface CLEARS
  // the marks and says so on screen, before any decision, and the reviewer
  // decides from what they can currently see.
  //
  // A MARK MUST NOT CROSS GATES. A suggestion id derives from (lane, projection
  // digest, op, pointer) and NOT from the gate, so two gates shown the same text
  // legitimately mint the SAME ids. The binding is therefore the REF as well as
  // the id set — a card reused for another gate can never apply the previous
  // gate's marks to identically-named suggestions.
  const surfaced = "suggestions" in state ? (state.suggestions ?? []) : [];
  const surfacedIdentity = `${view.ref} ${surfaced
    .map((s) => s.id)
    .sort()
    .join("")}`;
  let marks = markState.marks;
  let marksCleared = markState.cleared;
  if (markState.identity !== surfacedIdentity) {
    // React's documented "adjust state when a prop changes" shape, for the same
    // reason the resolve hook uses it: an effect would leave one painted frame
    // in which marks made against the OLD set sit under the new one.
    //
    // THE NOTICE IS STICKY UNTIL THE REVIEWER ACTS. It cannot be recomputed from
    // "were there marks a moment ago", because the second change in a row would
    // then answer no — the first change already emptied them — and the warning
    // would vanish while the loss it reported stood. A transient store failure
    // that drops the chips and then restores them is exactly two changes in a
    // row, and it would otherwise leave the reviewer looking at chips at rest
    // with nothing to say their marks are gone. Only `onToggleMark` clears it.
    //
    // A DIFFERENT GATE STARTS CLEAN, though: the notice is about marks lost on
    // THIS review, and carrying it onto another one would be a warning about
    // nothing.
    const sameGate = markState.ref === view.ref;
    marksCleared = sameGate
      ? markState.cleared || Object.keys(markState.marks).length > 0
      : false;
    marks = {};
    setMarkState({ ref: view.ref, identity: surfacedIdentity, marks, cleared: marksCleared });
  }
  const partition = buildPartition(surfaced, marks);

  const frame = HOST_FRAME[host];
  const body = renderState({
    state,
    islandSrc: reviewTargetIslandSrc(view.ref, cardFrame),
    expanded,
    onToggleExpanded: () => setExpanded((v) => !v),
    submit: submitAndRefresh,
    onRefresh: refresh,
    marks,
    marksCleared,
    onToggleMark: (id) =>
      setMarkState((current) => {
        const next = { ...current.marks };
        // rest → accepted → dismissed → rest. ONE control, the three states §VIII
        // draws, and every mark reversible without a second affordance the spec
        // does not draw.
        if (next[id] === "accepted") next[id] = "dismissed";
        else if (next[id] === "dismissed") delete next[id];
        else next[id] = "accepted";
        // The reviewer has looked since the surface changed; the notice has done
        // its job and stops competing with the marks they are making now.
        return { ...current, marks: next, cleared: false };
      }),
    partition,
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
  marks: Readonly<Record<string, LifecycleSuggestionMark>>;
  marksCleared: boolean;
  onToggleMark: (id: string) => void;
  partition: SuggestionDecisionPartition | null;
}): ReactElement | null {
  const {
    state,
    islandSrc,
    expanded,
    onToggleExpanded,
    submit,
    onRefresh,
    marks,
    marksCleared,
    onToggleMark,
    partition,
  } = args;

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
      // A Refresh, never a stale decision slipping through — and, when the gate
      // carried suggestions, the partition that was RECORDED against them, drawn
      // in the same chips with no live affordance. The decision stays readable
      // on the surface it was made on.
      return (
        <>
          {state.suggestions && state.suggestions.length > 0 ? (
            <SuggestionChips suggestions={state.suggestions} recorded />
          ) : null}
          <ReviewGateBlocked reason="no-longer-pending" onRefresh={onRefresh} />
        </>
      );

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
      const suggestions = state.suggestions ?? [];
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
          {/* §VIII — the per-item chips, between the target they annotate and
              the floor that decides them. Marks are LIVE only for a reader who
              may take the terminal decision they would ride on: a reader with
              respond access alone may read the suggestions (they may read the
              target) and mark none, because a mark that could never be
              submitted is a control that fails on press. */}
          <SuggestionChips
            suggestions={suggestions}
            marks={marks}
            marksCleared={marksCleared}
            onToggleMark={state.canDecide ? onToggleMark : undefined}
          />
          {/* §II/§IV — ONE gate-level decision floor, however many targets. */}
          <ReviewDecisionBar
            permissions={permissions}
            submitAction={submit}
            suggestionDecisions={partition}
          />
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

// ---------------------------------------------------------------------------
// §VIII — the suggestion chips
// ---------------------------------------------------------------------------

/**
 * The reviewer's marks, and the surface they were made against.
 *
 * `identity` is the ref plus the sorted surfaced id set. It is what makes a mark
 * meaningful: a mark belongs to the exact set that offered it, so a set that
 * changes underneath the reviewer invalidates the marks rather than silently
 * narrowing the decision they would ride on, and a card reused for another gate
 * cannot apply the previous gate's marks to identically-named suggestions.
 *
 * `cleared` is one bit of TRUTH OWED TO THE READER: their marks were dropped and
 * they have not looked since. It is never used to alter a decision — only to say
 * so on screen before they take one.
 */
type MarkState = {
  /** The gate the marks belong to, held apart from `identity` so the notice can
   * be sticky WITHIN a gate and absent on a different one. */
  ref: string;
  identity: string;
  marks: Readonly<Record<string, LifecycleSuggestionMark>>;
  cleared: boolean;
};

const EMPTY_MARKS: MarkState = { ref: "", identity: "", marks: {}, cleared: false };

/**
 * Derive the decision partition from the reader's marks.
 *
 * Iterated over the SURFACED list, so what rides the decision is exactly what is
 * on screen — the marks have already been re-bound to that list, so this cannot
 * quietly drop anything; it is what keeps the two in step.
 *
 * Returns `null` when nothing is marked, and `null` matters: S6b keeps identity
 * version 1 with the key ABSENT for a decision with no partition, so a reviewer
 * who marks nothing submits the byte-identical fingerprint the surface produced
 * before this slice — an in-flight retry across a deploy boundary stays
 * idempotent instead of conflicting.
 */
function buildPartition(
  surfaced: ReadonlyArray<LifecycleSuggestion>,
  marks: Readonly<Record<string, LifecycleSuggestionMark>>,
): SuggestionDecisionPartition | null {
  const accepted: string[] = [];
  const dismissed: string[] = [];
  for (const s of surfaced) {
    const mark = marks[s.id];
    if (mark === "accepted") accepted.push(s.id);
    else if (mark === "dismissed") dismissed.push(s.id);
  }
  if (accepted.length === 0 && dismissed.length === 0) return null;
  return { accepted, dismissed };
}

/** The chip's presentation for each of §VIII's three drawn states. */
const CHIP_STATE = {
  rest: {
    conformanceId: "suggestion-chip-rest",
    // The RATIFIED pill, verbatim from the shipped Artifacts chip
    // (`src/components/artifacts/library-upload.tsx` § SuggestedMeaningChips) —
    // dashed mustard edge, mustard wash, mustard ink. §VIII takes that drawing
    // as its base and states so ("the dashed mustard pill drawn on Artifacts").
    className: "border-dashed border-warning/60 bg-warning/10 text-warning",
    action: "accept-suggestion -> accepted",
  },
  accepted: {
    conformanceId: "suggestion-chip-accepted",
    // §VIII's new accepted mark: "goes solid and checked" — the SAME pill with
    // its edge closed and its wash deepened, so an accepted chip is still
    // recognisably the chip that was offered.
    className: "border-solid border-warning/60 bg-warning/25 text-warning",
    action: "dismiss-suggestion -> dismissed",
  },
  dismissed: {
    conformanceId: "suggestion-chip-dismissed",
    // §VIII's new dismissed mark: "goes struck and muted" — the edge stays
    // dashed, the wash drops out, the ink goes muted and the label is struck.
    className:
      "border-dashed border-line-strong bg-transparent text-muted-foreground line-through opacity-70",
    action: "clear-suggestion-mark -> rest",
  },
} as const;

type ChipState = keyof typeof CHIP_STATE;

const CHIP_ICON: Record<ChipState, typeof Sparkles> = {
  rest: Sparkles,
  accepted: Check,
  dismissed: X,
};

/**
 * THE suggestion-chip row (spec §VIII), drawn once for every host this card
 * appears on.
 *
 * ONE CONTROL PER SUGGESTION, THREE DRAWN STATES. §VIII draws a single pill in
 * three states and no second affordance, and says both marks stay reversible. So
 * the pill is a cycle — rest → accepted → dismissed → rest — rather than a pill
 * plus an invented dismiss button. Every press moves one step, every mark can be
 * walked back, and no pixel exists that the ratified drawing does not.
 *
 * WHAT A CHIP SAYS. The readable pointer into the reviewed document as the
 * label, and the transform class in the mono slot the drawing gives to a
 * secondary datum. It never carries the proposed VALUE: a chip annotates the
 * target beside it, and printing the replacement text into the chip row would
 * make the row a second, unauthorized projection of the document.
 *
 * READ-ONLY IS A DIFFERENT ELEMENT, NOT A DISABLED BUTTON. A reader who may not
 * decide, and a gate that has already been decided, both get plain elements with
 * no press target at all. A disabled button would read as "you could do this,
 * later"; neither of these is that.
 */
export function SuggestionChips({
  suggestions,
  marks,
  marksCleared = false,
  onToggleMark,
  recorded = false,
}: {
  suggestions: ReadonlyArray<LifecycleSuggestion>;
  /** The reader's LOCAL marks (pending gate). Ignored when `recorded`. */
  marks?: Readonly<Record<string, LifecycleSuggestionMark>>;
  /**
   * The surfaced set changed and the reader's marks were dropped. Drawn even
   * when there is nothing left to draw a chip for — a reviewer who marked
   * something and then finds the row empty is owed the reason, not a silence.
   */
  marksCleared?: boolean;
  /** Omitted ⇒ read-only: the reader may see the suggestions and mark none. */
  onToggleMark?: (id: string) => void;
  /** Draw the RECORDED partition of a gate that has already been decided. */
  recorded?: boolean;
}): ReactElement | null {
  if (suggestions.length === 0 && !marksCleared) return null;
  const interactive = !recorded && onToggleMark !== undefined;
  const acceptedCount = recorded
    ? 0
    : suggestions.filter((s) => marks?.[s.id] === "accepted").length;

  return (
    <div
      data-conformance-id="suggestion-chips"
      data-suggestion-chips-mode={recorded ? "recorded" : interactive ? "live" : "read-only"}
      className="flex flex-col gap-2 rounded-control border border-line bg-surface-strong px-4 py-3"
    >
      {/* #2042's labelling rule: a CORE lane is chrome, never an agent. The
          producer deliberately left this string to the surface that draws it. */}
      <div className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
        Core analysis · Suggestions
      </div>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((s) => {
          const chipState: ChipState = recorded
            ? (s.mark ?? "rest")
            : (marks?.[s.id] ?? "rest");
          const spec = CHIP_STATE[chipState];
          const Icon = CHIP_ICON[chipState];
          const inner = (
            <>
              <Icon aria-hidden="true" className="size-3" />
              {s.label}{" "}
              <span className="font-mono text-badge-2xs opacity-75">{s.op}</span>
            </>
          );
          const shared = `inline-flex h-auto items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${spec.className}`;
          return interactive ? (
            <Button
              key={s.id}
              type="button"
              variant="outline"
              size="sm"
              data-conformance-id={spec.conformanceId}
              data-suggestion-state={chipState}
              data-action={spec.action}
              className={shared}
              title={s.message}
              aria-label={`${s.label} — ${s.message} (${chipState}; press to ${
                chipState === "rest"
                  ? "accept"
                  : chipState === "accepted"
                    ? "dismiss"
                    : "clear the mark"
              })`}
              onClick={() => onToggleMark(s.id)}
            >
              {inner}
            </Button>
          ) : (
            <span
              key={s.id}
              data-conformance-id={spec.conformanceId}
              data-suggestion-state={chipState}
              className={shared}
              title={s.message}
              aria-label={`${s.label} — ${s.message} (${chipState})`}
            >
              {inner}
            </span>
          );
        })}
      </div>
      {marksCleared ? (
        // The surface moved under the reviewer. Said BEFORE the decision, and
        // said out loud: the alternative — submitting whatever survived the
        // change — lands an approve that records nothing while the reviewer
        // believes it recorded their accepts.
        <p
          role="status"
          data-conformance-id="suggestion-marks-cleared"
          className="text-xs leading-relaxed text-mustard-ink"
        >
          The suggestions changed while you were reviewing, so your marks were cleared. Check
          them again before you decide.
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {recorded
            ? "These are the per-item choices this review recorded."
            : interactive
              ? "Press a suggestion to accept it, again to dismiss it, again to clear the mark. Nothing is recorded until you approve or reject below."
              : "Deciding these needs approve access on this run."}
        </p>
      ) : null}
      {acceptedCount > 0 ? (
        // The one combination the decision core refuses outright: a reject
        // tombstones every reviewed revision, so it cannot also accept a patch
        // into them. Said here, before the press, rather than only as the error
        // the floor would return — and the accepted marks are still SENT, never
        // silently dropped, because no entry may swallow a per-item choice.
        <p
          data-conformance-id="suggestion-chips-reject-note"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          A reject cannot carry accepted suggestions — clear them first to reject.
        </p>
      ) : null}
    </div>
  );
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
