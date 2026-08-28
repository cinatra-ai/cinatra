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
//   settled    → the DECIDED reading: the reviewed target(s), kept read-only in
//                the same island, under the line that records who decided and
//                how — and no decision controls at all. A gate whose disposition
//                this build cannot read falls back to "This review is no longer
//                open", with a Refresh instead of a stale decision;
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
// THE COMPOSER BINDS TO A CARD, NOT TO "THE" GATE (cinatra#2566's composer-focus
// deliverable). On a host that has a chat composer, this card registers its gate
// with the surface's focus store — but ONLY when the server's own answer says
// this reader may comment on it — and draws which review a typed message will
// reach. What the composer then calls is the card's OWN comment action, the same
// closure the floor's Comment button calls, so there is one comment path rather
// than a second one that could drift. With several reviews open and none chosen,
// nothing routes at all and the cards say so: a comment on a single-target
// automatic gate resolves as `changes_requested`, so guessing which review a
// message belongs to would send the wrong run into a repair.
//
// NO NEW DECISION PRIMITIVE. A decision leaves through a seam that already
// exists: the page passes the route-bound server action it has always used, and
// a card with no host action posts its OPAQUE ref to the gate-scoped endpoint,
// which decodes the ref server-side and calls the SAME decision helper with the
// SAME validation order (access before gate read → pending re-check → pinned-set
// membership → provenance re-derivation → the gate CAS). Single-decision safety
// is the CAS, never the route the decision came in on.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  ArrowRight,
  Check,
  CircleX,
  ClipboardCheck,
  Maximize2,
  MessageSquare,
  Minimize2,
  RotateCcw,
} from "lucide-react";

import {
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  type LifecycleCardHost,
  type LifecycleCardState,
  type LifecycleSuggestion,
  type ReviewTargetRow,
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
// The header and floor projections the review PAGE has always used. Imported as
// values (not re-implemented) so the reading this card draws before a frame has
// painted is composed by the same functions that compose the one inside it.
import {
  reviewPreviewFloorDiagnostic,
  reviewRevisionMarker,
  reviewTargetPackageName,
  reviewTargetRowFacts,
  reviewTypeLabel,
  type ReviewPreviewFloorReason,
} from "@/lib/artifacts/review-surface-model";

import {
  useComposerFocusBinding,
  useLifecycleCardAuth,
  useLifecycleCardColorScheme,
  useLifecycleCardFrame,
  useLifecycleCardHost,
  useLifecycleCardResolve,
  type ComposerCommentAction,
  type ComposerCommentResult,
  type ComposerFocusBinding,
  type LifecycleCardFrame,
  type LifecycleColorScheme,
} from "./lifecycle-card-runtime";
import { ReviewDecisionBar, type SubmitReviewDecisionAction } from "./review-decision-bar";
import {
  ReviewGateBlocked,
  ReviewGateLoading,
  ReviewGateSettled,
} from "./review-gate-states";

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
 *
 * CROSS-SITE: the resolve answer carries a SERVER-MINTED island URL, and its
 * credential is taken from there (cinatra#2754). A frame load on a third-party
 * page sends no cookie, so without it the island is authenticated by nothing
 * and paints blank; the client cannot mint one, and it never invents one. A
 * same-site host receives no such URL and this composes exactly what it
 * composed before.
 *
 * EVERY HOST, THE PALETTE IT IS PAINTING IN (cinatra#2931). The island is a
 * nested document, so it cannot see the surface around it; left to itself it
 * resolves a palette from its OWN theme state. On a first-party page that store
 * is the app's own and the answer came out right by coincidence; inside a
 * third-party application it is a partitioned store nothing writes, so the
 * island painted the DEFAULT palette — a light panel inside a dark widget, which
 * is the defect this closes. The scheme rides here for EVERY host, from the same
 * read, so no host is a special case and the widget is not a patch. A host whose
 * document declares no palette names none, and the island keeps the resolution
 * it always had.
 */
export function reviewTargetIslandSrc(
  ref: string,
  frame: LifecycleCardFrame | null,
  serverIslandSrc?: string | null,
  colorScheme?: LifecycleColorScheme | null,
): string {
  const params = new URLSearchParams({ ref });
  const credential = islandCredentialFrom(serverIslandSrc, ref);
  if (credential) params.set(REVIEW_ISLAND_CREDENTIAL_PARAM, credential);
  if (frame) {
    params.set("assistant", frame.assistant);
    params.set("instanceId", frame.instanceId);
  }
  if (colorScheme) params.set(REVIEW_ISLAND_COLOR_SCHEME_PARAM, colorScheme);
  return `${REVIEW_TARGET_ISLAND_PATH}?${params.toString()}`;
}

/** The query parameter the island reads its credential from — the client half
 *  of `src/lib/lifecycle/review-island-credential.ts`. */
const REVIEW_ISLAND_CREDENTIAL_PARAM = "ic";

/** The query parameter the island reads the HOST's palette from — the client
 *  half of `src/app/lifecycle/review-island/island-color-scheme.ts`, mirrored
 *  here for the same reason the credential's key is. The literal is pinned on
 *  this side by `__tests__/review-island-host-color-scheme.test.tsx` and on the
 *  server side by the island page's own suite. */
const REVIEW_ISLAND_COLOR_SCHEME_PARAM = "scheme";

/**
 * The credential OUT of a server-issued island URL — never the URL itself.
 *
 * The answer is read over the network, so the card takes the one opaque value
 * it needs and recomposes the address from its own constants. Adopting the
 * string wholesale would make an `<iframe src>` out of something a response
 * body chose; taking only `ic` means a hostile answer can at most supply a
 * credential the island will refuse. The URL must also name THIS card's ref, or
 * it is an answer to another question and the credential is dropped with it.
 */
function islandCredentialFrom(
  src: string | null | undefined,
  ref: string,
): string | null {
  if (typeof src !== "string" || src.length === 0) return null;
  try {
    // The base is a placeholder: only the path and the query are read, and the
    // address below is built from `REVIEW_TARGET_ISLAND_PATH` either way.
    const url = new URL(src, "https://island.invalid");
    if (url.pathname !== REVIEW_TARGET_ISLAND_PATH) return null;
    if (url.searchParams.get("ref") !== ref) return null;
    const credential = url.searchParams.get(REVIEW_ISLAND_CREDENTIAL_PARAM);
    return credential !== null && credential.length > 0 ? credential : null;
  } catch {
    return null;
  }
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
/**
 * DID THE ISLAND ACTUALLY PAINT? (cinatra#3051)
 *
 * The island is same-origin by construction — the module header says so, and
 * says why the sandbox is not an isolation boundary — so the card can read which
 * of the island's two documents arrived. It answers on the island's OWN anchors
 * and on nothing else:
 *
 * ONE ANCHOR SAYS PAINTED, AND NOTHING ELSE DOES. The island's own body carries
 * `review-target-island-body`; that is the whole test. Every other document —
 * the island's `review-target-island-empty` refusal, a framework error page, a
 * response that did not parse, a document this card cannot read at all — is NOT
 * a painted target, and the header, the floor and the retry all stay on screen.
 *
 * THE DEFAULT FAILS TOWARD THE NAMED PANEL, deliberately. The two ways to be
 * wrong are not symmetric: reading an unpainted frame as painted puts the reader
 * back in front of a box that names nothing, which is the defect this slice
 * exists to close; reading a painted frame as unpainted leaves the header, the
 * floor and a retry over a frame that is in fact fine — a worse-looking panel,
 * not an unreadable one, and one press away from correct. So the fallback is
 * "not painted", and the anchor is what has to be present.
 *
 * THE ANCHOR CANNOT SILENTLY GO AWAY: it is in the review surface's ratified
 * conformance set and its own suite requires the island body to carry it.
 *
 * BOTH SERVER HALVES ARE HELD TO THIS. The island page renders both documents,
 * and the request guard's own empty answer to a cross-site widget frame that
 * presented no address is the anchored one too — it used to be a zero-byte body.
 * `review-island-first-render` drives the REAL guard and asserts the document it
 * returns is the one read here, so the two cannot drift.
 *
 * It learns nothing a denial must not disclose: it distinguishes "the preview is
 * on screen" from "the preview is not on screen", never WHY — the card says the
 * same sentence for every reason a frame did not paint.
 */
function islandPainted(frame: HTMLIFrameElement): boolean {
  try {
    const doc = frame.contentDocument;
    if (!doc) return false;
    // Read the anchors OFF the framed document rather than composing an
    // attribute-VALUE selector here: the review surface's conformance gate scans
    // this file's text for conformance-id attributes carrying a literal value
    // and holds every one it finds to the ratified anchor set — and a selector
    // is not an anchor this file renders. So the query names the attribute
    // alone, and the values are compared as values.
    const ids = new Set<string | null>(
      Array.from(doc.querySelectorAll("[data-conformance-id]"), (el) =>
        el.getAttribute("data-conformance-id"),
      ),
    );
    return ids.has(ISLAND_BODY_ANCHOR);
  } catch {
    return false;
  }
}

/**
 * The island's own two documents, named by their conformance anchors.
 *
 * The server halves are `src/app/lifecycle/review-island/page.tsx` (both) and
 * the request guard's own empty response in `src/lib/auth-route-guard.ts`, which
 * answers the cross-site widget frame that presented no address. EXPORTED so the
 * suites that drive the real guard and the real page can assert the documents
 * they return are the ones this card reads, rather than files agreeing by
 * coincidence. Only the BODY anchor decides `islandPainted`; the EMPTY one is
 * named here because it is the refusal both server halves render, and because a
 * test that asserts it is asserting the seam.
 */
export const ISLAND_BODY_ANCHOR = "review-target-island-body";
export const ISLAND_EMPTY_ANCHOR = "review-target-island-empty";

/** An answer that carried no target rows — the one shared empty, so a re-render
 *  never hands the reading a new array identity for the same nothing. */
const EMPTY_TARGET_ROWS: readonly ReviewTargetRow[] = Object.freeze([]);

const ISLAND_HEIGHT_CLAMPED = 380;
const ISLAND_HEIGHT_EXPANDED = 760;

// ---------------------------------------------------------------------------
// The island's OWN load state (cinatra#2713). The island is a same-origin,
// authenticated iframe — its `load` event is a real network round trip (auth
// ladder + content fetch + decode), never a component mount — so the window
// between mount and that event is not nothing. It is a THIRD axis the §IV
// ladder above does not know about, because it lives entirely inside the
// `pending`/`restricted` branch that already decided to draw the island. A
// bare `<iframe>` left that window painting the page's own white, which is
// what the 333 proof round photographed (evidence/2674-s8e V5 vs V6) and what
// this fixes.
// ---------------------------------------------------------------------------

type IslandLoadState = "loading" | "loaded" | "timed-out";

/**
 * Bounded wait for the iframe's `load` event before treating a hang as a
 * failure. Long enough that a normal authenticated round trip never misfires
 * into a false timeout; short enough that a genuine failure (an auth loop, a
 * 5xx, a hung renderer) does not strand the reviewer on a skeleton forever.
 * Restarted on every retry and on every new `src` — a different target
 * document gets its own full budget, never the remainder of the last one's.
 *
 * KNOWN RESIDUAL: the iframe below keeps `loading="lazy"` (a chat thread can
 * mount several of these off screen at once), so a card that never scrolls
 * into view can reach this bound before the browser has even started
 * fetching it. The bug this slice fixes is the ON-SCREEN island painting
 * blank while it loads (the proof round's evidence); gating the timer on
 * real intersection is a further refinement the acceptance criteria here do
 * not ask for, and is left as a follow-up rather than folded in silently.
 */
const ISLAND_LOAD_TIMEOUT_MS = 12_000;

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
 * Say back, in one line, what a COMPOSER comment did (cinatra#2566).
 *
 * The composer surface has no decision chrome of its own — it appends a line to
 * a conversation — so the outcome the decision bar draws as a notice has to
 * become a sentence here. It is written in this file because this is where the
 * review's copy lives; the card runtime deliberately never learns the review
 * vocabulary.
 *
 * IDENTIFIER-FREE, LIKE EVERY OTHER REFUSAL. The lines below name what happened
 * to the reader's own message and nothing about the gate, the target or the run:
 * this text is persisted into the transcript, which is LLM-visible.
 */
function composerCommentResult(outcome: ReviewSubmitOutcome): ComposerCommentResult {
  switch (outcome.kind) {
    case "changes-requested":
      // The comment RESOLVED the gate into a repair (#2566's single-target
      // automatic-gate rule) — the strongest thing a comment can do, and the
      // reader must be told it was terminal rather than an annotation.
      return {
        ok: true,
        message:
          outcome.status === "escalated"
            ? "Changes requested. This review needs a person to pick it up."
            : "Changes requested. The agent is working on a revision.",
      };
    case "decided":
      return { ok: true, message: "Your comment was recorded with the decision." };
    case "annotated":
      return { ok: true, message: "Comment added to the review. It is still open." };
    case "blocked":
      return {
        ok: false,
        message: "This review is no longer open, so the comment was not added.",
      };
    case "not-permitted":
    case "error":
      return { ok: false, message: outcome.message };
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
  // The palette THIS host is painting in (cinatra#2931). It addresses the island
  // and nothing else: the card itself is drawn by the host's own stylesheet and
  // has never needed to know. Read for every host from the one read, so the
  // island cannot follow one host and not another.
  const cardColorScheme = useLifecycleCardColorScheme();
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
  // §VIII — the reviewer's LOCAL dismissals, keyed by suggestion id, and BOUND
  // to the surface that offered them. A surfaced suggestion is ACCEPTED unless it
  // is named here (§VIII: "a suggestion arrives accepted"), so this is the whole
  // marking state. Never sent on its own; read at submit time into the one
  // decision's partition. See `MarkState` for why the binding exists.
  const [markState, setMarkState] = useState<MarkState>(EMPTY_MARKS);

  // The review kind's envelope carries STATE and no body: §III's target arrives
  // through the island, server-rendered against the reader, so there is nothing
  // for a body to add and a body beside this kind is refused at the parse.
  const resolved = useLifecycleCardResolve({
    viewType: "artifact_review_gate",
    ref: view.ref,
    enabled: present,
    reloadToken,
  });
  const state: LifecycleCardState | null = resolved?.state ?? null;

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // THE ADDRESS THE ISLAND IS FRAMED AT — which is not always what the newest
  // answer and the current palette would compose (cinatra#2931).
  //
  // A credentialed island URL is a SINGLE-USE bearer: the grant is spent the
  // moment the frame paints from it. `ReviewTargetIsland` keys the iframe on the
  // `src` STRING, so ANY rewrite after that paint remounts the frame — on a
  // spent grant, or on no grant at all — and the island goes blank in front of
  // the reader. That is a worse defect than the one the palette is here to fix,
  // and it has two ways to happen: the surface repaints, or an answer arrives
  // that carries no grant (the mint can fail while the gate is still perfectly
  // pending). So the card holds the address it framed and lets it move on ONE
  // condition only — a grant it has not seen before.
  //
  //   • A FRESH GRANT adopts the palette in force at that moment. The frame
  //     remounts once, on a grant nothing has spent.
  //   • NOTHING TO SPEND on either side is the cookie-authenticated island: no
  //     grant, no remount cost, so a repaint lands immediately — exactly what
  //     this surface did before the mechanism existed.
  //   • OTHERWISE the held address stands, and a repaint asks ONCE PER PALETTE
  //     for a fresh one. An answer that fails, or that carries no grant, leaves
  //     the island painted as it is rather than blanking it, and the next
  //     palette the reader chooses asks again.
  // §IV's header and §V's floor, from the GATE'S OWN ROWS (cinatra#3051). They
  // arrive with the answer that authorized this card, so the panel names what is
  // under review at the FIRST render — before any frame has loaded, and whatever
  // the frame goes on to do. An answer that carried none draws the floor alone,
  // which is still a named panel rather than the blank one this closes.
  const targetRows: readonly ReviewTargetRow[] = resolved?.targets ?? EMPTY_TARGET_ROWS;
  const liveIslandSrc = resolved?.islandSrc ?? null;
  const liveCredential = islandCredentialFrom(liveIslandSrc, view.ref);
  const [islandAddress, setIslandAddress] = useState<{
    scheme: LifecycleColorScheme | null;
    islandSrc: string | null;
    askedFor: LifecycleColorScheme | null | undefined;
  }>({ scheme: cardColorScheme, islandSrc: liveIslandSrc, askedFor: undefined });
  const heldCredential = islandCredentialFrom(islandAddress.islandSrc, view.ref);
  if (liveCredential !== null && liveCredential !== heldCredential) {
    setIslandAddress({ scheme: cardColorScheme, islandSrc: liveIslandSrc, askedFor: undefined });
  } else if (islandAddress.scheme === cardColorScheme) {
    // Nothing is outstanding — the frame is already in the host's palette. Drop
    // any standing request, so a reader who returns to a palette whose ask went
    // unanswered is asked for again rather than left latched on it.
    if (islandAddress.askedFor !== undefined) {
      setIslandAddress({ ...islandAddress, askedFor: undefined });
    }
  } else if (heldCredential === null && liveCredential === null) {
    setIslandAddress({ scheme: cardColorScheme, islandSrc: liveIslandSrc, askedFor: undefined });
  } else if (islandAddress.askedFor !== cardColorScheme) {
    setIslandAddress({ ...islandAddress, askedFor: cardColorScheme });
    refresh();
  }

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

  // #2566's COMPOSER COMMENT — the card's own comment path, published to the
  // composer rather than re-implemented by it.
  //
  // It is `submitAndRefresh` with `disposition: "comment"`: the same closure the
  // decision bar's Comment button calls, so it carries this host's credential,
  // lands in the same decision module with the same validation order, and
  // re-resolves the card afterwards. A comment resolving as `changes_requested`
  // therefore settles the card in the transcript exactly as pressing Comment
  // does — there is no second transport that could drift from the first.
  //
  // NO SUGGESTION PARTITION, for the reason the bar states in full: a comment
  // does not resolve the gate, so it cannot carry terminal per-item choices. The
  // reader's marks stay on screen and ride the terminal decision they take.
  const composerComment = useCallback<ComposerCommentAction>(
    async (text) => {
      const trimmed = text.trim();
      // A blank comment is not an annotation; it would post an empty rationale
      // and read back as a no-op the reader cannot tell from a lost message.
      if (trimmed.length === 0) {
        return { ok: false, message: "A review comment needs some text." };
      }
      return composerCommentResult(
        await submitAndRefresh({ disposition: "comment", comment: trimmed }),
      );
    },
    // `submitAndRefresh` is rebuilt every render, but it closes over exactly
    // these three — so listing them is listing it, and the callback is rebuilt
    // whenever the transport it would use actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [submitAction, refBoundSubmit, refresh],
  );

  // The gate takes composer input only while the SERVER says it is open to this
  // reader's comment. `canComment` is the same answer the floor's Comment button
  // is gated on, so a reader who may look but not respond registers nothing and
  // the composer can never bind to a gate that would refuse them.
  const composerEligible =
    state !== null &&
    (state.state === "pending" || state.state === "restricted") &&
    state.canComment;
  const focusBinding = useComposerFocusBinding({
    ref: view.ref,
    eligible: composerEligible,
    comment: composerComment,
  });

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
  let dismissed = markState.dismissed;
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
      ? markState.cleared || Object.keys(markState.dismissed).length > 0
      : false;
    dismissed = {};
    setMarkState({ ref: view.ref, identity: surfacedIdentity, dismissed, cleared: marksCleared });
  }
  // The partition THIS surface would submit, per disposition (§VIII, cinatra#2852).
  const suggestionDecisionsFor = (disposition: ReviewDisposition) =>
    disposition === "reject"
      ? rejectPartition(surfaced)
      : disposition === "approve"
        ? buildPartition(surfaced, dismissed)
        : null;

  const frame = HOST_FRAME[host];
  // The server-minted island URL, when this answer carried one (cinatra#2754).
  // Only the widget arm ever does; the cookie hosts resolve `null` here and the
  // composed `src` below is byte-identical to the one they composed before.
  //
  // IT KEEPS LIVING IN THE RESOLVE'S STATE, AND THAT IS THE DECIDED ANSWER. The
  // hardening round asked whether the card could drop the credential after the
  // first paint. It cannot, not without redesigning the island's retry machine:
  // `ReviewTargetIsland` keys its iframe (and resets its load-state bag) on the
  // `src` STRING, so a `src` that loses its credential after the paint is a
  // DIFFERENT src — the frame remounts on an uncredentialed address and the
  // island goes blank in front of the reader. The timeout retry depends on the
  // same identity: it re-resolves precisely so a FRESH credentialed src arrives
  // and remounts the frame by itself. The ruling ordered three hardenings and
  // explicitly not a redesign, so what closes the exposure instead is single
  // use: the held copy is spent the moment the island paints from it, which
  // makes the copy in this state — and every other copy of the address — inert
  // rather than merely short-lived.
  // THE HELD ONE, not the newest one — see the address state above. On a cookie
  // host the two are the same `null` and this composes byte-for-byte what it
  // composed before.
  const serverIslandSrc = islandAddress.islandSrc;
  const body = renderState({
    state,
    targetRows,
    islandSrc: reviewTargetIslandSrc(view.ref, cardFrame, serverIslandSrc, islandAddress.scheme),
    islandCredentialed: heldCredential !== null,
    expanded,
    onToggleExpanded: () => setExpanded((v) => !v),
    submit: submitAndRefresh,
    onRefresh: refresh,
    dismissed,
    marksCleared,
    onToggleMark: (id) =>
      setMarkState((current) => {
        const next = { ...current.dismissed };
        // accepted ⇄ dismissed. TWO states and no third (§VIII, redrawn): a
        // suggestion arrives accepted, one press dismisses it, one press accepts
        // it again. There is no unmarked state to return to and nothing to
        // clear, so the toggle is its own inverse.
        if (next[id]) delete next[id];
        else next[id] = true;
        // The reviewer has looked since the surface changed; the notice has done
        // its job and stops competing with the marks they are making now.
        return { ...current, dismissed: next, cleared: false };
      }),
    suggestionDecisionsFor,
    focusBinding,
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
  /** The gate's own pinned rows — the header and floor the card draws itself. */
  targetRows: readonly ReviewTargetRow[];
  islandSrc: string;
  islandCredentialed: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  submit: SubmitReviewDecisionAction;
  onRefresh: () => void;
  dismissed: Readonly<Record<string, true>>;
  marksCleared: boolean;
  onToggleMark: (id: string) => void;
  suggestionDecisionsFor: (disposition: ReviewDisposition) => SuggestionDecisionPartition | null;
  focusBinding: ComposerFocusBinding;
}): ReactElement | null {
  const {
    state,
    targetRows,
    islandSrc,
    islandCredentialed,
    expanded,
    onToggleExpanded,
    submit,
    onRefresh,
    dismissed,
    marksCleared,
    onToggleMark,
    suggestionDecisionsFor,
    focusBinding,
  } = args;

  // §III's target reading — ONE element, used by both arms that draw a target,
  // so the pending and the decided readings cannot drift apart.
  const targetReading: ReactElement = (
    <ReviewTargetIsland
      src={islandSrc}
      credentialed={islandCredentialed}
      rows={targetRows}
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
      onRetryResolve={onRefresh}
    />
  );

  switch (state.state) {
    case "loading":
      return (
        <>
          <ReviewGateHeader pending />
          <ReviewGateLoading />
        </>
      );

    case "settled":
      // THE DECIDED READING KEEPS WHAT WAS REVIEWED. "A resolved gate opens
      // read-only: what was decided, and the reviewed target(s), kept for the
      // run's audit trail." So this is the pending reading with the decision
      // taken out of it and the decision itself put in its place:
      //
      //   THE TARGET STAYS, drawn by its own renderer, in the SAME island, from
      //     the SAME ref. That is what makes it the revision that was decided
      //     rather than whatever the artifact says now — the gate froze the
      //     pinned set and the island prepares that set ("You approve exactly
      //     what you saw ... a later re-materialization of the artifact can
      //     never silently change what was approved"). A decision line over an
      //     empty box records who pressed a button; it does not keep the work.
      //
      //   NO DECISION CONTROLS, ANYWHERE. No Approve, no Reject, no Comment, no
      //     rationale field, and no composer binding: there is nothing left to
      //     decide, and a control that cannot act is a control that fails on
      //     press. §II's settled schedule reading is this same shape — the form,
      //     read-only, "with no controls at all". The header loses its
      //     awaiting-your-decision pill for the same reason.
      //
      //   THE DISPOSITION READS DISTINCTLY. Approve, reject and changes-
      //     requested are three outcomes and are named as three ("Reject is not
      //     a quiet approve" — a rejection "can never be mistaken for or routed
      //     as an approval"; a change request "is neither approve nor reject").
      //     `ReviewGateSettled` draws the recorded one and its decider where one
      //     can be named — and, when the gate carried suggestions, the partition
      //     RECORDED against them, in the same chips with no live affordance.
      //
      // TWO READINGS, AND THE RESOLVER PICKS (cinatra#2855; plan §4.2).
      //
      //   WITH an outcome — the decided reading above, and NO Refresh. The
      //     button existed to resolve an ambiguity ("decided, or the run moved
      //     on?") that a named outcome has already resolved; leaving it there
      //     would offer a re-pull that can only return the same answer.
      //
      //   WITHOUT one — byte-for-byte what shipped before: the generic "This
      //     review is no longer open", its one line naming both possibilities,
      //     and the Refresh. A gate resolved before the outcome travelled, and a
      //     disposition this build cannot read, both land here, and neither is a
      //     card that may guess. Neither may present a target as decided either,
      //     when it cannot say what the decision was — so that reading draws the
      //     panel it always drew, and no island.
      return state.outcome ? (
        <>
          <ReviewGateHeader pending={false} />
          {/* §III — the reviewed target(s), read-only, exactly as the pending
              reading drew them: one island, every pinned target, the renderer
              resolved from the artifact's own type. The island carries no
              decision chrome on either reading. */}
          {targetReading}
          {/* §VIII — the RECORDED partition, in the place it annotated: between
              the target it is about and the decision it rode on. */}
          {state.suggestions && state.suggestions.length > 0 ? (
            <SuggestionChips suggestions={state.suggestions} recorded />
          ) : null}
          {/* The decision line — who decided, and how. Where the floor was. */}
          <ReviewGateSettled
            outcome={state.outcome}
            decidedByName={state.decidedByName}
          />
        </>
      ) : (
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
          {targetReading}
          {/* §VIII — the per-item chips, between the target they annotate and
              the floor that decides them. Marks are LIVE only for a reader who
              may take the terminal decision they would ride on: a reader with
              respond access alone may read the suggestions (they may read the
              target) and mark none, because a mark that could never be
              submitted is a control that fails on press. */}
          <SuggestionChips
            suggestions={suggestions}
            dismissed={dismissed}
            marksCleared={marksCleared}
            onToggleMark={state.canDecide ? onToggleMark : undefined}
          />
          {/* #2566 — the composer binding, drawn immediately above the floor it
              mirrors: typing in the chat box is the same act as typing in the
              rationale field and pressing Comment. */}
          <ComposerFocusRow binding={focusBinding} />
          {/* §II/§IV — ONE gate-level decision floor, however many targets. */}
          <ReviewDecisionBar
            permissions={permissions}
            submitAction={submit}
            suggestionDecisionsFor={suggestionDecisionsFor}
            suggestionSummary={
              state.canDecide && suggestions.length > 0
                ? {
                    accepted: suggestions.filter((s) => !dismissed?.[s.id]).length,
                    total: suggestions.length,
                  }
                : undefined
            }
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
// The COMPOSER BINDING (cinatra#2566's composer-focus deliverable)
// ---------------------------------------------------------------------------

/**
 * "Where does what I type go?" — answered on the card, next to the floor.
 *
 * THE CARD NAMES THE TARGET, WHICH IS THE WHOLE POINT. #2566: "Typing in the
 * chat requests changes — and the card names WHICH item your message goes to."
 * A composer that silently forwarded a message to whichever gate happened to
 * register last would be routing a real decision-module call on a guess, so the
 * binding is drawn where the reader can see it and take it back.
 *
 * THREE STATES, AND THEY ARE THE RESOLVER'S. Bound (a typed message comments on
 * THIS review), unbound-and-ambiguous (several reviews are open, nothing routes
 * until one is chosen), unbound-and-quiet (the binding is elsewhere, or the
 * reader gave it back). None of them is invented here: each is a branch of
 * `resolveComposerTarget`, which is also what the composer itself reads, so the
 * sentence on screen and the behaviour on send cannot disagree.
 *
 * THE BINDING IS ALWAYS REFUSABLE. A single open review binds the composer with
 * no press at all (#2566), and one press gives it back — because a lone review
 * would otherwise turn every chat message into a comment, and on a single-target
 * automatic gate a comment resolves as `changes_requested`. The reader must be
 * able to say "not this" without deciding anything.
 *
 * NOTHING AT ALL WITHOUT A COMPOSER. `available` is false on every surface with
 * no composer to bind — the review page, the run-detail page — and on a gate
 * this reader may not comment on. A control that named a composer that is not
 * there, or a comment that would be refused, is a control that fails on press.
 */
function ComposerFocusRow({ binding }: { binding: ComposerFocusBinding }): ReactElement | null {
  if (!binding.available) return null;
  return (
    <div
      data-conformance-id="review-composer-focus"
      data-composer-bound={binding.bound ? "true" : "false"}
      data-composer-ambiguous={binding.ambiguous ? "true" : "false"}
      className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-surface-strong px-4 py-3"
    >
      <Button
        type="button"
        variant={binding.bound ? "secondary" : "ghost"}
        size="sm"
        data-action="focus-review-composer"
        aria-pressed={binding.bound}
        onClick={binding.toggleFocus}
      >
        <MessageSquare aria-hidden="true" className="size-3.5" />
        {binding.bound ? "Replying to this review" : "Reply from the chat box"}
      </Button>
      {binding.bound ? (
        <span
          data-conformance-id="review-composer-bound"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          Your next chat message becomes a comment on this review. Press again to chat normally.
        </span>
      ) : binding.ambiguous ? (
        // The refusal the composer will give, said BEFORE the reader types it.
        <span
          role="status"
          data-conformance-id="review-composer-ambiguous"
          className="text-xs leading-relaxed text-mustard-ink"
        >
          More than one review is waiting. Choose the one you want to reply to — chat messages
          are not routed until you do.
        </span>
      ) : (
        <span
          data-conformance-id="review-composer-unbound"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          Chat messages are not going to this review.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §VIII — the suggestion chips
// ---------------------------------------------------------------------------

/**
 * The reviewer's DISMISSALS, and the surface they were made against.
 *
 * §VIII's marking is a two-state toggle that starts ACCEPTED, so the only thing
 * worth holding is which surfaced suggestions the reviewer has pressed away:
 * everything surfaced and not named here is accepted, and there is no third
 * state to represent.
 *
 * `identity` is the ref plus the sorted surfaced id set. It is what makes a mark
 * meaningful: a mark belongs to the exact set that offered it, so a set that
 * changes underneath the reviewer invalidates the marks rather than silently
 * narrowing the decision they would ride on, and a card reused for another gate
 * cannot apply the previous gate's marks to identically-named suggestions.
 *
 * `cleared` is one bit of TRUTH OWED TO THE READER: their dismissals were
 * dropped — the row is back to all-accepted — and they have not looked since. It
 * is never used to alter a decision, only to say so on screen before they take
 * one.
 */
type MarkState = {
  /** The gate the marks belong to, held apart from `identity` so the notice can
   * be sticky WITHIN a gate and absent on a different one. */
  ref: string;
  identity: string;
  /** The ids pressed to DISMISSED. Absence from this map is acceptance. */
  dismissed: Readonly<Record<string, true>>;
  cleared: boolean;
};

const EMPTY_MARKS: MarkState = { ref: "", identity: "", dismissed: {}, cleared: false };

/**
 * Derive the decision partition from what is on screen (§VIII, cinatra#2852).
 *
 * ACCEPTED BY DEFAULT. Every surfaced suggestion lands in exactly one side: the
 * ones the reviewer pressed away are dismissed, all the rest are accepted. That
 * is the drawn state read back out — a reviewer who touches nothing accepts what
 * they were shown, which is what the redraw says the row means.
 *
 * Iterated over the SURFACED list, so what rides the decision is exactly what is
 * on screen; the dismissals have already been re-bound to that list, so this
 * cannot quietly carry an id the reader can no longer see.
 *
 * Returns `null` only when NOTHING is surfaced. A gate with no chips submits the
 * decision it submitted before any of this existed — no partition key, hence the
 * identity-version-1 fingerprint, byte for byte.
 */
function buildPartition(
  surfaced: ReadonlyArray<LifecycleSuggestion>,
  dismissed: Readonly<Record<string, true>>,
): SuggestionDecisionPartition | null {
  if (surfaced.length === 0) return null;
  const accepted: string[] = [];
  const notTaken: string[] = [];
  for (const s of surfaced) {
    if (dismissed[s.id]) notTaken.push(s.id);
    else accepted.push(s.id);
  }
  return { accepted, dismissed: notTaken };
}

/**
 * The partition a REJECT carries: every surfaced suggestion recorded as NOT
 * TAKEN (§VIII, cinatra#2852).
 *
 * The shipped guard refused an immediate Reject while anything was accepted, and
 * with the old unmarked default that was survivable — nothing was accepted until
 * a reviewer pressed. Accepted-by-default makes the same guard refuse the very
 * first press of Reject, on a row the reviewer never touched, which is a control
 * that fails on press.
 *
 * So the rework is here, at the surface that knows what a reject MEANS for these
 * items: a reject tombstones every reviewed revision, so nothing can be applied
 * into them, and the truthful record of that is a dismissal for each surfaced
 * id — the reviewer looked at them and took none. The decision core's rule ("a
 * reject decision cannot accept suggestions") is untouched and still enforced
 * server-side; this simply never asks it for the impossible.
 */
function rejectPartition(
  surfaced: ReadonlyArray<LifecycleSuggestion>,
): SuggestionDecisionPartition | null {
  if (surfaced.length === 0) return null;
  return { accepted: [], dismissed: surfaced.map((s) => s.id) };
}

/**
 * §VIII's TWO drawn readings, plus the one HISTORY reading a settled gate can
 * still need.
 *
 * `accepted` and `dismissed` are the whole live vocabulary: the redrawn section
 * states "two states, and no third … there is no unmarked state to return to and
 * nothing to clear". Dismissed is carried by the muted ground and the dashed
 * edge ALONE — never a strike, which would pile a second marker on a pill that
 * is already marked.
 *
 * `unrecorded` is NOT a third live state and is unreachable on a pending gate.
 * It exists because a gate decided BEFORE this slice legitimately recorded a
 * mark for only the items the reviewer touched, and drawing those untouched ids
 * as either accepted or dismissed would report a choice nobody made.
 */
const CHIP_STATE = {
  accepted: {
    conformanceId: "suggestion-accepted",
    // The pill WITH its fill — accepted is where a suggestion starts, so the
    // resting Artifacts pill deepened is the accepted reading (§VIII, "Borrowed,
    // then extended").
    block: "border-solid border-warning/40 bg-warning/[0.07]",
    pill: "border-solid border-warning/60 bg-warning/25 text-warning",
    after: "border-warning/40 bg-surface-strong",
    body: "text-foreground",
    action: "dismiss-suggestion -> dismissed",
  },
  dismissed: {
    conformanceId: "suggestion-dismissed",
    // The resting pill's dashed edge over a muted ground, with the fill removed.
    // NO STRIKE-THROUGH.
    block: "border-dashed border-line-strong bg-transparent",
    pill: "border-dashed border-line-strong bg-transparent text-muted-foreground",
    after: "border-line bg-surface",
    body: "text-muted-foreground",
    action: "accept-suggestion -> accepted",
  },
  unrecorded: {
    conformanceId: "suggestion-unrecorded",
    block: "border-dashed border-line bg-transparent",
    pill: "border-dashed border-line bg-transparent text-muted-foreground",
    after: "border-line bg-surface",
    body: "text-muted-foreground",
    action: "none",
  },
} as const;

type ChipState = keyof typeof CHIP_STATE;

const CHIP_ICON: Record<ChipState, typeof Check> = {
  accepted: Check,
  dismissed: RotateCcw,
  unrecorded: MessageSquare,
};

/** What the pill's accessible name says the next press will do. */
const CHIP_PRESS_LABEL: Record<ChipState, string> = {
  accepted: "press to dismiss",
  dismissed: "press to accept",
  unrecorded: "no choice recorded",
};

/**
 * ONE suggestion, drawn as §VIII draws it: the pill and the change class on top,
 * the before/after panel beneath.
 *
 * THE PANEL IS THE POINT. A label plus a change class cannot tell a reader what
 * accepting does, so the row shows the change itself — the current content beside
 * the suggested content, text-valued, on the shared surface and line tokens.
 *
 * ABSENCE DRAWS NOTHING. A snapshot from before the pair existed, a `remove`
 * (there is no one value to show) and an `add` of the empty string all carry no
 * values, and the row is then the pill and the class alone — never an empty
 * panel, which would read as "this change is blank".
 */
function SuggestionPanel({
  suggestion,
  spec,
}: {
  suggestion: LifecycleSuggestion;
  spec: (typeof CHIP_STATE)[ChipState];
}): ReactElement | null {
  const { before, after } = suggestion;
  if (before === undefined && after === undefined) return null;
  return (
    <div
      data-conformance-id="suggestion-before-after"
      className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] sm:items-stretch"
    >
      {before !== undefined ? (
        <div
          data-suggestion-panel="before"
          className="min-w-0 rounded-control border border-line bg-surface px-2.5 py-2"
        >
          <div className="mb-1 font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
            Now
          </div>
          <p className={`m-0 whitespace-pre-wrap break-words text-xs leading-relaxed ${spec.body}`}>
            {before}
          </p>
        </div>
      ) : null}
      {before !== undefined && after !== undefined ? (
        <div aria-hidden="true" className="hidden place-items-center text-muted-foreground sm:grid">
          <ArrowRight className="size-3.5" />
        </div>
      ) : null}
      {after !== undefined ? (
        <div
          data-suggestion-panel="after"
          className={`min-w-0 rounded-control border px-2.5 py-2 ${spec.after}`}
        >
          <div className="mb-1 font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
            Suggested
          </div>
          <p className={`m-0 whitespace-pre-wrap break-words text-xs leading-relaxed ${spec.body}`}>
            {after}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * THE suggestion-chip row (spec §VIII, redrawn at
 * design@60b27dfbb8a2a1594e6e88333cc5c048c244e640), drawn once for every host
 * this card appears on.
 *
 * ONE CONTROL PER SUGGESTION, TWO DRAWN STATES. A suggestion arrives ACCEPTED;
 * one press dismisses it, one press accepts it again. The toggle is its own
 * inverse — there is no unmarked state to return to and nothing to clear — and
 * no second affordance exists that the drawing does not show.
 *
 * WHAT A SUGGESTION SAYS. The readable pointer into the reviewed document as the
 * label, the transform class in the mono slot the drawing gives a secondary
 * datum, and beneath them the change itself: the current content beside the
 * suggested content. The values come from the SAME disclosed projection the
 * target panel above already renders to this reader, so the row discloses
 * nothing the card did not already show — it only puts the two side by side.
 *
 * READ-ONLY IS A DIFFERENT ELEMENT, NOT A DISABLED BUTTON. A reader who may not
 * decide, and a gate that has already been decided, both get plain elements with
 * no press target at all. A disabled button would read as "you could do this,
 * later"; neither of these is that.
 */
export function SuggestionChips({
  suggestions,
  dismissed,
  marksCleared = false,
  onToggleMark,
  recorded = false,
}: {
  suggestions: ReadonlyArray<LifecycleSuggestion>;
  /** The reader's LOCAL dismissals (pending gate). Ignored when `recorded`. */
  dismissed?: Readonly<Record<string, true>>;
  /**
   * The surfaced set changed and the reader's dismissals were dropped. Drawn
   * even when there is nothing left to draw a suggestion for — a reviewer who
   * pressed something and then finds the row empty is owed the reason, not a
   * silence.
   */
  marksCleared?: boolean;
  /** Omitted ⇒ read-only: the reader may see the suggestions and mark none. */
  onToggleMark?: (id: string) => void;
  /** Draw the RECORDED partition of a gate that has already been decided. */
  recorded?: boolean;
}): ReactElement | null {
  if (suggestions.length === 0 && !marksCleared) return null;
  const interactive = !recorded && onToggleMark !== undefined;
  const stateOf = (s: LifecycleSuggestion): ChipState =>
    recorded
      ? (s.mark ?? "unrecorded")
      : dismissed?.[s.id]
        ? "dismissed"
        : "accepted";
  return (
    <div
      data-conformance-id="suggestion-chips"
      data-suggestion-chips-mode={recorded ? "recorded" : interactive ? "live" : "read-only"}
      className="flex flex-col gap-2.5 rounded-control border border-line bg-surface-strong px-4 py-3"
    >
      {/* #2042's labelling rule: a CORE lane is chrome, never an agent. The
          producer deliberately left this string to the surface that draws it. */}
      <div className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
        Audit · Suggestions
      </div>
      {suggestions.map((s) => {
        const chipState = stateOf(s);
        const spec = CHIP_STATE[chipState];
        const Icon = CHIP_ICON[chipState];
        const pill = `inline-flex h-auto items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${spec.pill}`;
        const name = `${s.label} — ${s.message} (${chipState}${
          interactive ? `; ${CHIP_PRESS_LABEL[chipState]}` : ""
        })`;
        return (
          <div
            key={s.id}
            data-conformance-id={spec.conformanceId}
            data-suggestion-state={chipState}
            data-action={spec.action}
            className={`grid gap-2 rounded-control border px-3 py-2.5 ${spec.block}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              {interactive ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={pill}
                  title={s.message}
                  aria-pressed={chipState === "accepted"}
                  aria-label={name}
                  onClick={() => onToggleMark(s.id)}
                >
                  <Icon aria-hidden="true" className="size-3" />
                  {s.label}
                </Button>
              ) : (
                <span className={pill} title={s.message} aria-label={name}>
                  <Icon aria-hidden="true" className="size-3" />
                  {s.label}
                </span>
              )}
              <span className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
                {s.op}
              </span>
            </div>
            <SuggestionPanel suggestion={s} spec={spec} />
          </div>
        );
      })}
      {marksCleared ? (
        // The surface moved under the reviewer. Said BEFORE the decision, and
        // said out loud: the alternative — deciding against a row that quietly
        // went back to all-accepted — lands a decision the reviewer did not make.
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
              ? "Press a suggestion to dismiss it, press it again to accept it. Nothing is recorded until you approve or reject below."
              : "Deciding these needs approve access on this run."}
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
 *
 * cinatra#2713 — the region draws THREE states while the iframe's own document
 * loads, layered over the same clamped box so the card never resizes under the
 * reviewer: a skeleton (the shipped `ReviewGateLoading` bar motif, extended
 * into this taller box — no dedicated island mockup exists in
 * `specs/app-lifecycle-cards.html` or `app-components.html`'s Skeleton/Spinner
 * section for THIS iframe's own load window, only the generic bar-skeleton
 * language this reuses); the painted iframe once `onLoad` fires; and, past the
 * bound, a retry panel. The panel deliberately does NOT mount the shipped
 * `ReviewGateBlocked` component: that component's `ReviewBlockedReason` is a
 * closed set about the GATE's own lifecycle (no longer pending / mismatched /
 * revision not live) that `review-surface-model.ts` shares with the review
 * page server-side — none of its three reasons is true here (the gate is
 * exactly as open as it was; only the PREVIEW failed to arrive), and drawing
 * one anyway would tell the reviewer something false. What IS reused,
 * verbatim, is that component's established VISUAL shape — the destructive
 * icon circle, the title/body pairing, the `link` retry button — so the card
 * still has exactly one "this didn't work" drawing language, just not the
 * gate-scoped component whose props don't fit.
 *
 * Applies identically on every host this card mounts on: nothing here reads
 * `host`, so the chat thread, the run card, the page gate region and the site
 * widget all get the same three states from the one code path.
 */
function ReviewTargetIsland({
  src,
  credentialed,
  rows,
  expanded,
  onToggleExpanded,
  onRetryResolve,
}: {
  src: string;
  /** True when this `src` carries a server-minted, expiring credential. */
  credentialed: boolean;
  /** The gate's own pinned rows — what the panel names while the frame has not
   *  painted, so no load state is ever a panel that names nothing. */
  rows: readonly ReviewTargetRow[];
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Re-resolve the card, so a retry gets a FRESH island URL (cinatra#2754). */
  onRetryResolve: () => void;
}): ReactElement {
  // One state bag KEYED BY `src`, reset IN-RENDER rather than in an effect —
  // the same shape `useLifecycleCardState` uses above for the identical
  // reason: an effect-based reset would leave one committed frame in which
  // the PREVIOUS target's loaded/timed-out verdict paints under the new src.
  //
  // `attempt` REMOUNTS the frame; `wait` only restarts the bound. They are two
  // fields because a CREDENTIALED address must not be remounted (cinatra#3051):
  // its grant is worth one paint and is already spent, so re-presenting it is a
  // guaranteed empty island. See the retry below.
  const [load, setLoad] = useState({
    src,
    attempt: 0,
    wait: 0,
    loaded: false,
    timedOut: false,
    empty: false,
  });
  if (load.src !== src) {
    setLoad({ src, attempt: 0, wait: 0, loaded: false, timedOut: false, empty: false });
  }

  useEffect(() => {
    if (load.loaded || load.empty) return;
    const timer = setTimeout(() => {
      setLoad((current) => (current.loaded ? current : { ...current, timedOut: true }));
    }, ISLAND_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [load.src, load.attempt, load.wait, load.loaded, load.empty]);

  // A FRAME THAT LOADED IS NOT NECESSARILY A FRAME THAT PAINTED (cinatra#3051).
  // An island that refused — a spent or expired address, a reader who may not
  // read the run, a gate that moved — answers 200 with the EMPTY document, and
  // an empty document fires `load` exactly like a full one. Treating that as
  // "loaded" is what put the reader back in front of a blank box with nothing
  // to press, which is the defect this slice is closing.
  const state: IslandLoadState =
    load.loaded ? "loaded" : load.timedOut || load.empty ? "timed-out" : "loading";
  const height = expanded ? ISLAND_HEIGHT_EXPANDED : ISLAND_HEIGHT_CLAMPED;

  return (
    <div
      data-conformance-id="review-target-island"
      data-island-load-state={state}
      className="relative overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      <iframe
        // Keyed by src+attempt so a retry (or a genuinely new target) forces a
        // real remount — a re-render alone would leave the SAME iframe element
        // sitting on whatever connection already stalled or failed.
        key={`${load.src}:${load.attempt}`}
        src={src}
        title="Review target"
        // NOT an isolation boundary — see the module header. These tokens
        // withhold top-navigation, form submission and popups from a document
        // that needs none of them; the authorization is the island's own.
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="same-origin"
        // A CREDENTIALED src is a perishable bearer: it is minted by the resolve
        // this render came from and dies shortly after, so it cannot wait for a
        // scroll — a lazily-fetched frame below the fold would present an
        // expired credential and paint the refusal. A cookie-authenticated src
        // has no such clock and keeps `lazy`, which is what lets a thread mount
        // several of these off screen without fetching them all.
        loading={credentialed ? "eager" : "lazy"}
        className={`w-full border-0 bg-surface-strong transition-opacity duration-200 ${
          load.loaded ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        style={{ height }}
        onLoad={(event) => {
          const painted = islandPainted(event.currentTarget);
          setLoad((current) =>
            current.src === src ? { ...current, loaded: painted, empty: !painted } : current,
          );
        }}
      />
      {/* Overlays the iframe's own box exactly (same height) — never the
          footer below, so neither state changes the card's footprint. The
          iframe stays mounted underneath while timed out: a late `onLoad`
          self-heals the display instead of leaving a reviewer stuck on a
          retry panel for content that did, eventually, arrive. */}
      {state !== "loaded" ? (
        <div className="absolute inset-x-0 top-0" style={{ height }}>
          {state === "loading" ? (
            <IslandLoadingSkeleton rows={rows} />
          ) : (
            <IslandLoadTimedOut
              rows={rows}
              onRetry={() => {
                // A RETRY RE-RESOLVES FIRST (cinatra#2754). A credentialed src
                // that failed has very likely expired, and remounting the frame
                // on the same URL would present the same dead credential; the
                // re-resolve mints a fresh one and the new `src` remounts the
                // frame by itself.
                //
                // AND ON THAT ARM IT DOES NOTHING ELSE (cinatra#3051). The
                // attempt bump used to run here too, which remounted the frame
                // on the address that had just been spent — the second
                // presentation of a single-use grant, which the serving path
                // refuses, so the retry's own first act was to guarantee an
                // empty island. The bump stays for the COOKIE arm, where the
                // URL does not change and the remount IS the retry; the
                // credentialed arm only restarts the bound and waits for the
                // fresh address, which remounts by itself.
                onRetryResolve();
                setLoad((current) =>
                  credentialed
                    ? { ...current, wait: current.wait + 1, timedOut: false, empty: false }
                    : {
                        ...current,
                        attempt: current.attempt + 1,
                        wait: current.wait + 1,
                        loaded: false,
                        timedOut: false,
                        empty: false,
                      },
                );
              }}
            />
          )}
        </div>
      ) : null}
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

/**
 * The island's loading skeleton (cinatra#2713). Extends the SHIPPED
 * `ReviewGateLoading` bar language (review-gate-states.tsx) — `bg-surface-muted`
 * bars in the same card tokens — into the island's taller box, with a minimal
 * `animate-pulse`: no dedicated island mockup exists to draw from (checked
 * `specs/app-components.html`'s Skeleton/Spinner section and
 * `specs/app-lifecycle-cards.html`'s own card drawings), so this reuses the
 * one bar-skeleton language the card family already ships rather than
 * inventing a second one.
 */
function IslandLoadingSkeleton({ rows }: { rows: readonly ReviewTargetRow[] }): ReactElement {
  return (
    <div
      data-conformance-id="review-target-island-skeleton"
      className="h-full space-y-3 overflow-y-auto bg-surface-strong p-4"
    >
      {/* §IV's header, REAL and from the gate's own rows — the bars that used to
          stand in for it named nothing, which is the whole defect (cinatra#3051). */}
      <ReviewTargetRows rows={rows} reason="preview-loading" />
      {/* Only the REPRESENTATION is still unknown, so only it is a skeleton. */}
      <div aria-busy="true" className="animate-pulse space-y-2">
        <div className="h-1.5 w-11/12 rounded bg-surface-muted" />
        <div className="h-1.5 w-4/5 rounded bg-surface-muted" />
        <div className="h-1.5 w-full rounded bg-surface-muted" />
        <div className="h-1.5 w-2/3 rounded bg-surface-muted" />
        <div className="h-1.5 w-3/4 rounded bg-surface-muted" />
      </div>
    </div>
  );
}

/**
 * §IV's IMMUTABLE TARGET HEADER + §V's NEVER-BLANK FLOOR, drawn by the CARD
 * (cinatra#3051).
 *
 * WHY IT IS HERE AND NOT ONLY IN THE FRAME. The header names what is under
 * review and fixes it in place; the floor guarantees the surface never shows an
 * empty panel where a target should be. Both used to exist only INSIDE the
 * island document, so every state that is not a painted frame — still loading,
 * past its bound, or a frame this host cannot authenticate — drew a panel that
 * named nothing at all. Measured inside a third-party application at the pending
 * instant, the reader was shown "The preview did not load" with no title, no
 * package, no revision, no ownership, no visibility and no floor.
 *
 * THE FIELDS ARE THE GATE'S, NOT THE PREVIEW'S. They come off the gate's own
 * pinned rows on the resolve answer, so this reading is available at the card's
 * FIRST render and does not depend on any fetch the frame makes.
 *
 * ONE PROJECTION, TWO PLACES. `reviewTypeLabel`, `reviewRevisionMarker` and
 * `reviewTargetRowFacts` are the same functions `ReviewTargetPanel` renders the
 * header inside the frame with, so what the card names before the frame paints
 * is what the frame paints.
 *
 * NOTHING IS DRAWN TWICE. This reading is the frame's OVERLAY: it is in the DOM
 * exactly while the frame has not painted, and a painted frame — which carries
 * its own §IV header, from the same functions — replaces it.
 *
 * PLAIN DATA ATTRIBUTES, NOT CONFORMANCE ANCHORS. `review-target` is the spec's
 * anchor for the panel, and the panel is what the frame draws; this reading is
 * the card's own account of the same target while that panel is not there, so it
 * does not claim the anchor.
 *
 * NEVER BLANK, EVEN WITH NO ROWS. An answer that carried no rows still draws the
 * floor — one sanitized `package · slot · reason` line — because "no rows" is
 * exactly the state a blank panel would be indistinguishable from.
 */
function ReviewTargetRows({
  rows,
  reason,
}: {
  rows: readonly ReviewTargetRow[];
  reason: ReviewPreviewFloorReason;
}): ReactElement {
  return (
    <div data-review-target-reading={reason} className="space-y-3">
      {rows.length === 0 ? (
        <ReviewTargetFloorLine packageName={null} reason={reason} />
      ) : (
        rows.map((row) => (
          <div
            key={`${row.artifactId}:${row.representationRevisionId}`}
            data-review-target-header=""
            data-field="name=type.displayName"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-sans text-sm font-bold text-foreground">
                {row.title ?? row.artifactId}
              </span>
              <span className="inline-flex items-center rounded-full border border-blue/30 bg-blue/10 px-2 py-0.5 text-xs font-semibold text-blue">
                {row.objectType ? reviewTypeLabel(row.objectType) : "Artifact"}
              </span>
            </div>
            <p className="mt-1 font-mono text-badge-xs tracking-tight text-muted-foreground">
              {row.objectType ? <span>{row.objectType} · </span> : null}
              <span title={reviewRevisionMarker(row.representationRevisionId).full}>
                revision {reviewRevisionMarker(row.representationRevisionId).short}
              </span>
              <span className="text-mustard-ink"> · pinned</span>
              {row.ownerLevel || row.visibility || row.mime || row.updatedAt ? (
                <>
                  {" · "}
                  {reviewTargetRowFacts({
                    ownerLevel: row.ownerLevel,
                    visibility: row.visibility,
                    mime: row.mime,
                    updatedAt: row.updatedAt,
                  }).join(" · ")}
                </>
              ) : null}
            </p>
            <ReviewTargetFloorLine
              packageName={reviewTargetPackageName(row.packageName, row.objectType)}
              reason={reason}
            />
          </div>
        ))
      )}
    </div>
  );
}

/** §V's floor — ONE sanitized, telemetry-safe `package · slot · reason` line.
 *  Never a raw error, never a value, and never absent while the representation
 *  is not on screen. */
function ReviewTargetFloorLine({
  packageName,
  reason,
}: {
  packageName: string | null;
  reason: ReviewPreviewFloorReason;
}): ReactElement {
  return (
    <p
      role="status"
      data-review-target-floor={reason}
      data-review-floor-package={packageName ?? ""}
      data-review-floor-slot={REVIEW_TARGET_SLOT}
      className="mt-1 font-mono text-badge-2xs tracking-tight text-muted-foreground"
    >
      {reviewPreviewFloorDiagnostic(packageName, REVIEW_TARGET_SLOT, reason)}
    </p>
  );
}

/** The one slot a review target is ever mounted in this release (§III). */
const REVIEW_TARGET_SLOT = "detail";

/**
 * The island's past-the-bound presentation (cinatra#2713) — reuses
 * `ReviewGateBlocked`'s exact visual shape (icon circle, title/body, `link`
 * retry) rather than the component itself; see the doc above
 * `ReviewTargetIsland` for why the reason enum does not fit. The decision
 * floor below is untouched and still live — a preview that did not load is
 * never drawn as a reason the reviewer cannot decide.
 */
function IslandLoadTimedOut({
  rows,
  onRetry,
}: {
  rows: readonly ReviewTargetRow[];
  onRetry: () => void;
}): ReactElement {
  return (
    <div
      data-conformance-id="review-target-island-timeout"
      className="h-full space-y-3 overflow-y-auto bg-surface-strong p-4"
    >
      {/* THE HEADER AND THE FLOOR STAY (cinatra#3051). A preview that did not
          arrive removes the preview, not the target: the reader still has to be
          told what they are deciding about, and §V's floor is what makes this a
          named panel rather than an empty one. */}
      <ReviewTargetRows rows={rows} reason="preview-unavailable" />
      <div className="text-center">
        <div className="mx-auto mb-2.5 grid size-9 place-items-center rounded-lg bg-destructive/10 text-destructive">
          <CircleX aria-hidden="true" className="size-[18px]" />
        </div>
        <p className="font-sans text-sm font-semibold text-foreground">The preview did not load</p>
        <p className="mx-auto mt-1 max-w-[46ch] text-xs text-muted-foreground">
          This does not block your decision below — try again, or continue without it.
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1"
          data-action="retry-review-target-island -> reload"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
