"use client";

// ---------------------------------------------------------------------------
// The lifecycle card RUNTIME — host declaration + authoritative refetch +
// composer focus (cinatra#2566, epic #2564 S2; the first two moved verbatim
// out of S1's
// `packages/chat/src/renderable-views/lifecycle-card.tsx`, which re-exports it).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §IV, §IX.
//
// WHY IT MOVED, AND ONLY THAT. S1 put the runtime beside the card SHELL because
// the shell was the only consumer. S2 gives the review card three first-party
// hosts (§IX: the chat thread, the run card, the page gate region) and two of
// them live in this package or above it, while `@cinatra-ai/chat` depends on
// `@cinatra-ai/agents` — so a runtime kept in chat could never be reached from
// the run card without inverting that edge. The runtime therefore sits at the
// package both sides can already import, and chat re-exports it so S1's public
// surface (and its tests) are untouched. The BEHAVIOUR is byte-for-byte S1's.
//
// Three properties this module owns, restated because every host depends on
// them (the third is #2566's composer-focus deliverable, documented at its own
// section below):
//
//  1. FAIL-CLOSED SURFACE GATING. A host opts IN via
//     `LifecycleCardSurfaceProvider`. With no provider there is no host, and a
//     card renders nothing — a surface that has not been reviewed for lifecycle
//     cards (the site widget, whose enablement is S8d's) cannot start drawing
//     them by inheriting a default.
//
//  2. NOTHING WITHOUT AN AUTHORIZED RESOLVE. Before the first successful
//     resolve there is no state, so the card renders no DOM at all — not even a
//     skeleton. A placeholder that appears and then vanishes for a reader who
//     may not see the item is exactly the existence oracle §IV's `absent` state
//     forbids ("no card DOM at all").
// ---------------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  parseLifecycleResolveEnvelope,
  type LifecycleCardHost,
  type LifecycleDataPartViewType,
  type LifecycleResolveAnswerFor,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

// The run vocabulary, from the state machine that owns it — a leaf module with
// no database and no drizzle, so it costs this client bundle nothing.
import {
  TERMINAL_RUN_STATUSES,
  type AgentRunStatus,
} from "./run-status";

/** The server route that re-authorizes a ref and answers with the card envelope. */
export const LIFECYCLE_VIEW_RESOLVE_PATH = "/api/lifecycle-views/resolve";

/**
 * The BROKER read of the recommendation hold (cinatra#2790, epic #2784 S9f).
 *
 * The hold is the one lifecycle kind carried as a typed INTERRUPT rather than a
 * DATA_PART, so it has no view ref to post at the resolve route above and is
 * addressed by its run instead. A card on a COOKIE host never uses this path —
 * it keeps its server action; a card on a credential-declaring host uses it and
 * nothing else, because a server action cannot carry a host credential and would
 * ride the ambient cookie of a same-origin frame.
 */
export const LIFECYCLE_RECOMMENDATION_HOLD_PATH = "/api/lifecycle-views/recommendation-hold";

/** The broker CONFIRM / ADJUST / SKIP for that hold. Same rule as the read. */
export const LIFECYCLE_RECOMMENDATION_DECIDE_PATH =
  "/api/lifecycle-views/recommendation-hold/decide";

/**
 * The BROKER read of the HITL screen (cinatra#2930, lifecycle-b W3).
 *
 * The second kind carried as a typed INTERRUPT, and so the second one with no
 * view ref to post at the resolve route above: the question an agent paused to
 * ask is addressed by the run the transcript already names. Same rule as the
 * hold's path — a cookie host never uses it, a credential-declaring host uses it
 * and nothing else.
 */
export const LIFECYCLE_HITL_SCREEN_PATH = "/api/lifecycle-views/hitl-screen";

/**
 * The BROKER ANSWER to that question (cinatra#2930, lifecycle-b W3).
 *
 * The other half of the path above, and it exists for the same reason: a server
 * action cannot carry a host credential, and firing one from a frame that is
 * same-origin to the app would ride the ambient Cinatra cookie of whoever else
 * is signed in on that browser. A cookie host never uses this path — it keeps
 * its server action, unchanged. A credential-declaring host uses it and nothing
 * else, and the server hands the answer to the SAME approval core the action
 * calls.
 */
export const LIFECYCLE_HITL_SCREEN_SUBMIT_PATH =
  "/api/lifecycle-views/hitl-screen/submit";

// ---------------------------------------------------------------------------
// Host declaration — absent means "no host", which means no card.
// ---------------------------------------------------------------------------

const LifecycleCardSurfaceContext = createContext<LifecycleCardHost | null>(null);

/**
 * How a host proves who is asking, when a cookie cannot (cinatra#2577, epic
 * #2564 S8d). Returns the headers to put on the resolve request and the
 * credentials mode to send it with.
 *
 * The first-party hosts declare NOTHING here and keep the cookie: they are
 * cookie-session surfaces and their identity travels by itself. The site widget
 * declares one, because it has no session — its reader is proven by the `cwu_`
 * broker token the embed already holds in a closure, and `credentials: "omit"`
 * is load-bearing on that surface: the embed iframe is same-origin to the
 * Cinatra app, so an ambient Cinatra cookie belonging to WHOEVER ELSE uses this
 * browser would otherwise ride along and answer as them.
 *
 * The token itself never enters React state, a prop, a log or the DOM — only
 * this call does, at the moment a request is built, exactly like the turn POST.
 */
export type LifecycleCardAuth = {
  headers: () => Record<string, string>;
  credentials: RequestCredentials;
};

/**
 * The EMBEDDING CONTEXT a non-first-party host renders in (cinatra#2577).
 *
 * A card on the site widget is drawn inside `/embed/assistant`, which is itself
 * framed by the registered site. So the review card's §III island — a nested
 * first-party document — has TWO ancestors, and a `frame-ancestors` wall that
 * names only `'self'` refuses to render it (Chrome: "Framing '<app origin>'
 * violates the following Content Security Policy directive: frame-ancestors
 * 'self'. The request has been blocked."). The island was blank on the widget
 * for exactly that reason.
 *
 * These are the SAME two disambiguators the embed page itself carries in its
 * URL, and they are passed on to the island for the SAME reason: so the SERVER
 * can re-derive the one registered origin from its own records. They are
 * opaque selectors, never an origin — nothing a caller writes here can put an
 * origin into a policy. `frameAncestorsDirectiveFor` maps them through the
 * CLOSED host-side binding table and the stored instance row, and fails closed
 * to `'self'`-only for anything it cannot resolve to exactly one registered
 * site.
 */
export type LifecycleCardFrame = {
  /** == the embed's `?assistant` == the `cit_`-bound kind. */
  assistant: string;
  /** == the embed's `?instanceId` — the connector instance disambiguator. */
  instanceId: string;
};

const LifecycleCardAuthContext = createContext<LifecycleCardAuth | null>(null);
const LifecycleCardFrameContext = createContext<LifecycleCardFrame | null>(null);

/**
 * "Does this subtree carry a FIRST-PARTY COOKIE SESSION?" (cinatra#2683, epic
 * #2564 S8f.)
 *
 * A separate context from the host and the auth, because those two answer a
 * different question and answer it UNSAFELY for this one. Both are `null` in
 * TWO distinct situations: on a properly declared cookie surface, and on a
 * BROKEN non-cookie declaration that the provider refused. Anything reading
 * "auth === null" as "cookie session" therefore treats a mis-wired widget mount
 * as first-party — and a cookie-bound server action fired from the widget frame,
 * which is same-origin to the app, answers (and records decisions) as whoever
 * else is signed in on that browser.
 *
 * This context is the answer that fails the right way: TRUE only when a
 * COOKIE_SESSION_HOSTS host is declared with no credential — the one shape that
 * really does travel by cookie. No provider, a refused declaration, or any
 * credential-bearing host all read FALSE, so a caller that gates a cookie-bound
 * affordance on it draws nothing and issues no request rather than guessing.
 */
const LifecycleCardCookieSessionContext = createContext<boolean>(false);

/**
 * The hosts whose identity travels by COOKIE. Every other host must declare a
 * credential, and the provider refuses to mount without one.
 *
 * WHY THIS IS A CLOSED LIST AND NOT AN `auth?:` DEFAULT (codex round 0, finding
 * 2). `auth` used to be optional for every host, so
 * `<LifecycleCardSurfaceProvider host="site_widget">` — one dropped prop, one
 * refactor, one second widget mount — would have sent both the resolve and the
 * DECISION same-origin with an ambient cookie. On a surface that is same-origin
 * to the app, that is the forbidden fallback in its worst form: the server
 * would answer, and record a decision, as whoever else uses that browser. The
 * unsafe shape is removed rather than documented.
 */
const COOKIE_SESSION_HOSTS: ReadonlySet<LifecycleCardHost> =
  new Set<LifecycleCardHost>(["chat_thread", "run_card", "page_gate_region"]);

/**
 * Declare the host a subtree renders lifecycle cards on. A host opts IN; there
 * is no default. S8d (cinatra#2577) turns the widget on: the embed wraps its
 * transcript in `<LifecycleCardSurfaceProvider host="site_widget" auth={…}>`,
 * and a surface that declares nothing still renders no lifecycle card DOM at
 * all.
 *
 * FAIL-CLOSED ON THE CREDENTIAL. A cookie-session host must declare no `auth`
 * and keeps S1's exact same-origin request. Any other host MUST declare one, and
 * it must be `credentials: "omit"` — a broker surface that sent cookies would be
 * asking the server to pick between two identities. A violation declares NO host
 * at all, so the subtree renders no lifecycle card DOM and issues no request:
 * the same silence as a surface that never opted in.
 */
export function LifecycleCardSurfaceProvider({
  host,
  auth,
  frame,
  children,
}: {
  host: LifecycleCardHost;
  auth?: LifecycleCardAuth;
  /** The embedding context, for a host that renders inside another frame. A
   *  cookie-session host is first-party and declares none; one declared there
   *  is IGNORED rather than trusted, so a stray prop can never widen a
   *  first-party wall. */
  frame?: LifecycleCardFrame;
  children: ReactNode;
}): ReactElement {
  const cookieHost = COOKIE_SESSION_HOSTS.has(host);
  const credentialOk = cookieHost
    ? auth === undefined
    : auth !== undefined && auth.credentials === "omit";
  // Both fields must be present and non-empty; a half-declared frame is no
  // frame, so the island falls back to the first-party wall rather than being
  // asked to resolve half a binding.
  const frameOk =
    !cookieHost &&
    frame !== undefined &&
    typeof frame.assistant === "string" &&
    frame.assistant.length > 0 &&
    typeof frame.instanceId === "string" &&
    frame.instanceId.length > 0;
  return (
    <LifecycleCardSurfaceContext.Provider value={credentialOk ? host : null}>
      <LifecycleCardAuthContext.Provider value={credentialOk ? (auth ?? null) : null}>
        <LifecycleCardFrameContext.Provider
          value={credentialOk && frameOk ? (frame ?? null) : null}
        >
          {/* TRUE only for a well-formed cookie-session declaration — see the
              context's own note for why "no auth" is not the same question. */}
          <LifecycleCardCookieSessionContext.Provider value={cookieHost && credentialOk}>
            {children}
          </LifecycleCardCookieSessionContext.Provider>
        </LifecycleCardFrameContext.Provider>
      </LifecycleCardAuthContext.Provider>
    </LifecycleCardSurfaceContext.Provider>
  );
}

/**
 * TRUE only inside a well-formed cookie-session host declaration.
 *
 * Gate every COOKIE-BOUND affordance on this — a server action, a first-party
 * fetch that relies on the ambient session, a deep link into the app that only
 * a signed-in first-party page can follow. Outside such a declaration it is
 * FALSE, including when there is no provider at all, so the default is silence.
 */
export function useCookieSessionSurface(): boolean {
  return useContext(LifecycleCardCookieSessionContext);
}

export function useLifecycleCardHost(): LifecycleCardHost | null {
  return useContext(LifecycleCardSurfaceContext);
}

/**
 * ONE LIFECYCLE CARD PER RUN PER TURN.
 *
 * The inline run panel declares the `run_card` host and mounts the run's
 * lifecycle cards on it. Inside a chat transcript that panel is a SIBLING of
 * the conversation's own mount of the SAME card for the SAME run, so both
 * drawing it shows a person two cards for one decision.
 *
 * This is the rule that settles it, and it is a FUNCTION rather than a line of
 * JSX so the panel and the transcript's own test agree by construction instead
 * of by two copies of the same condition: when an outer CONVERSATION host is
 * already in scope, the conversation's card owns the run and the panel
 * withholds its copy — in every state, held and settled alike. Anywhere else,
 * including the run page where there is no outer host at all, the panel keeps
 * its copy.
 *
 * BOTH CONVERSATION HOSTS, not just `chat_thread` (cinatra#2790, epic #2784
 * S9f). One column serves `/chat` and the site widget, and S9f made it mount
 * the recommendation card on the widget arm too. The duplication the rule
 * exists to prevent is therefore reachable under `site_widget` exactly as it is
 * under `chat_thread`, and the answer is the same one: the transcript owns the
 * copy. Naming only the cookie host here would have made the widget the one
 * surface where a person can be shown two cards for one decision.
 *
 * Gating on the ambient host rather than on a `surface` prop is deliberate: a
 * future embedder of the panel inside a transcript inherits the rule without
 * having to remember to pass anything.
 */
export function runCardOwnsLifecycleCopy(
  ambientHost: LifecycleCardHost | null,
): boolean {
  return ambientHost !== "chat_thread" && ambientHost !== "site_widget";
}

// ---------------------------------------------------------------------------
// THE TURN'S SETTLED SCHEDULE REGISTER (cinatra#3174)
// ---------------------------------------------------------------------------
//
// The schedule card's own section says what may share its turn: "The card is
// the scheduling step, in the turn - and it is the only thing drawn", and "One
// card, five readings, and never a second card". A turn that also carried a
// run-progress panel and a second decidable card was drawing three things where
// the section draws one.
//
// WHY THE TURN CANNOT ANSWER THIS BY ITSELF. The card's payload on the wire is
// a REF and nothing else - deliberately, so a transcript states nothing about a
// gate - and which of the five readings it is in comes back from the
// authoritative resolve, inside the card. A container that wanted to know
// whether it is carrying a settled schedule card would have to resolve the ref
// a second time, on a surface that is not the card's host, which is exactly the
// second dispatch path the lifecycle wire exists to prevent.
//
// SO THE CARD REPORTS, AND THE CONTAINER LISTENS. The same shape the recommendation
// card already uses to tell its turn whether the run panel must wait, moved into
// a context because this card is mounted through the view REGISTRY - a dispatch
// that is identity-agnostic by contract and must not gain a per-kind callback
// prop.
//
// FAIL-CLOSED, LIKE EVERY OTHER DECLARATION HERE. A surface with NO provider -
// the run page, the review page, and any turn that carries no run - has no
// register, the report is a no-op, and nothing about those surfaces changes.
// ---------------------------------------------------------------------------

/** Told by a card: this card, in this container, is (or is no longer) settled. */
export type SettledScheduleRegister = (cardId: string, settled: boolean) => void;

const SettledScheduleRegisterContext = createContext<SettledScheduleRegister | null>(null);

/** Declares that this subtree's container wants to hear about settled schedule
 *  cards drawn inside it. */
export function SettledScheduleRegisterProvider({
  register,
  children,
}: {
  register: SettledScheduleRegister;
  children: ReactNode;
}): ReactElement {
  return (
    <SettledScheduleRegisterContext.Provider value={register}>
      {children}
    </SettledScheduleRegisterContext.Provider>
  );
}

/**
 * Report this card's reading to whatever container declared a register.
 *
 * REPORTED PER MOUNT, NOT PER REF (convergence). The first version keyed the
 * report on the card's own wire ref, which is wrong in the one case that
 * matters: two mounts carrying the SAME ref - a view appended twice into one
 * turn - collapsed into one entry, so the first of them to unmount answered
 * `false` for the other and gave the container back a turn that still draws a
 * settled card. The key is therefore the ref AND this mount's own id, so every
 * mount is counted once and answers only for itself. The ref stays in the key
 * because it is what makes a report readable in a proof.
 *
 * The cleanup reports `false` rather than deleting silently: a card that
 * unmounts, and one that leaves the settled reading, both have to give the
 * container its turn back.
 */
export function useReportSettledSchedule(cardId: string, settled: boolean): void {
  const register = useContext(SettledScheduleRegisterContext);
  const mountId = useId();
  const key = `${cardId}#${mountId}`;
  useEffect(() => {
    if (register === null) return;
    register(key, settled);
    return () => register(key, false);
  }, [register, key, settled]);
}

// ---------------------------------------------------------------------------
// COMPOSER FOCUS — which review card the chat composer is bound to
// (cinatra#2566's composer-focus deliverable; the program Done-definition is
// cinatra#2573: "multiple concurrent gates require explicit composer focus").
//
// WHY IT LIVES HERE. It is the same shape as the host declaration above and it
// has the same two-sided reach problem: the CARD (this package) offers the focus
// affordance and the COMPOSER (`@cinatra-ai/chat`, which depends on this
// package and never the other way round) reads the binding. This module is
// already the one both sides import, so the focus state sits beside the host
// declaration rather than in a third module neither could reach.
//
// WHAT FOCUS IS FOR. #2566: "composer routing engages only when exactly one
// eligible gate is active OR the user explicitly focused a card". A comment
// typed into the chat box is a real decision-module call against ONE gate, so
// the composer must never pick a gate for the reader. Two gates and no explicit
// focus is not "use the latest one" — it is a question the surface has to ask.
//
// ELIGIBILITY IS THE SERVER'S ANSWER, NOT A GUESS. A card registers itself only
// after its authoritative resolve says the gate is open AND this reader may
// comment on it (`canComment`). A reader who may read but not respond registers
// nothing, so the composer can never bind to a gate whose comment would be
// refused — the control does not exist rather than failing on press.
//
// FAIL-CLOSED, LIKE THE HOST. A surface with NO provider (the review page, the
// run-detail page — neither has a chat composer) has no store, so its cards
// register nothing and draw no focus affordance at all. Composer focus cannot
// appear on a surface that has not opted in.
// ---------------------------------------------------------------------------

/**
 * What a composer comment answers with. Deliberately NOT the review outcome
 * union: this module is the generic card runtime and must not learn the review
 * vocabulary. The CARD maps its own outcome to this, so the sentence the reader
 * reads in the transcript is written once, where the review copy already lives.
 */
export type ComposerCommentResult = {
  /** The comment reached the decision module and was recorded. */
  ok: boolean;
  /** The one line the composer surface shows back. Never carries identifiers. */
  message: string;
};

/**
 * The comment path of ONE card — the card's own action, handed to the composer
 * rather than re-implemented by it. That is what makes "a typed comment goes
 * through the same path the card's decision bar uses" true by construction: the
 * composer calls the very closure the bar calls, with the card's credential and
 * the card's post-decision re-resolve already inside it.
 */
export type ComposerCommentAction = (comment: string) => Promise<ComposerCommentResult>;

/** What the composer knows about the review gates on screen right now. */
export type ComposerFocusSnapshot = {
  /**
   * The refs of the gates that may currently take a composer comment, in the
   * order their cards registered. The ORDER is not a priority — nothing reads
   * "the latest one"; it exists only so the snapshot is stable and printable.
   */
  eligible: readonly string[];
  /** The ref the reader explicitly focused, or `null` if they have not. */
  focused: string | null;
  /**
   * The reader took the composer BACK — they pressed the bound card's control
   * to release it.
   *
   * This exists because the single-gate case binds with no press at all, and
   * without a release there would be no way out of it: a lone open review would
   * turn every chat message into a comment (which on a single-target automatic
   * gate resolves as `changes_requested` and sends the run into a repair) with
   * no affordance to stop. A binding the reader cannot decline is not a binding,
   * it is a capture.
   */
  released: boolean;
};

/** Where a composer message goes — the ONE answer every caller reads. */
export type ComposerTargetResolution =
  /** No review gate is taking composer input; the composer behaves as before. */
  | { kind: "none" }
  /**
   * The composer is bound to exactly this gate. `explicit` distinguishes the
   * reader's own choice from the single-gate case #2566 allows to bind on its
   * own, because only an EXPLICIT choice may outrank an open field gate.
   */
  | { kind: "target"; ref: string; explicit: boolean }
  /** Several gates could take it and the reader has not said which. */
  | { kind: "ambiguous"; count: number };

const EMPTY_FOCUS_SNAPSHOT: ComposerFocusSnapshot = {
  eligible: [],
  focused: null,
  released: false,
};

/**
 * The focus reducer — PURE, so the one rule the whole deliverable rests on is
 * testable without a browser.
 *
 * Precedence, in order:
 *  1. no eligible gate               → `none` (the composer is untouched);
 *  2. an explicit focus that is still eligible → that gate, explicitly;
 *  3. the reader RELEASED the composer → `none`, and no ambiguity prompt: they
 *     have answered the question the prompt asks;
 *  4. exactly one eligible gate      → that gate, implicitly (#2566);
 *  5. otherwise                      → `ambiguous`.
 *
 * A STALE EXPLICIT FOCUS IS NOT A TARGET. A ref the reader focused that is no
 * longer eligible (decided elsewhere, access lost, the card unmounted) falls
 * through to the rules below it, so a comment can never land on a gate the
 * reader focused a while ago and the surface no longer shows as open.
 */
export function resolveComposerTarget(
  snapshot: ComposerFocusSnapshot,
): ComposerTargetResolution {
  const eligible = snapshot.eligible;
  if (eligible.length === 0) return { kind: "none" };
  if (snapshot.focused !== null && eligible.includes(snapshot.focused)) {
    return { kind: "target", ref: snapshot.focused, explicit: true };
  }
  if (snapshot.released) return { kind: "none" };
  if (eligible.length === 1) return { kind: "target", ref: eligible[0]!, explicit: false };
  return { kind: "ambiguous", count: eligible.length };
}

/**
 * The focus store. An EXTERNAL store rather than component state so a focus
 * press re-renders the cards that subscribe and nothing else — the chat page
 * that owns it reads the binding imperatively at send time and never re-renders
 * a transcript because a card was focused.
 */
export type ComposerFocusStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ComposerFocusSnapshot;
  /**
   * Declare a gate able to take a composer comment, WITH the action that takes
   * it. Returns the un-register.
   *
   * REF-COUNTED: the same gate can legitimately be mounted twice (a run card and
   * a thread card for one gate, React's development double-invoke), and one
   * unmount must not strike an identity another mount is still showing. The
   * LATEST registration owns the action, so a re-registering card replaces its
   * own closure rather than accumulating stale ones.
   */
  registerEligible: (ref: string, comment: ComposerCommentAction) => () => void;
  /** The comment path of an eligible gate, or `undefined` if it is not one. */
  getCommentAction: (ref: string) => ComposerCommentAction | undefined;
  /** The reader chose this card. */
  focus: (ref: string) => void;
  /** The reader took the binding back; the composer is a chat box again. */
  clearFocus: () => void;
};

export function createComposerFocusStore(): ComposerFocusStore {
  const entries = new Map<string, { count: number; comment: ComposerCommentAction }>();
  let focused: string | null = null;
  let released = false;
  // Cached because `useSyncExternalStore` compares snapshots by identity: a
  // fresh object per read would loop forever.
  let snapshot: ComposerFocusSnapshot = EMPTY_FOCUS_SNAPSHOT;
  const listeners = new Set<() => void>();

  const publish = (): void => {
    snapshot = { eligible: Array.from(entries.keys()), focused, released };
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    getCommentAction(ref) {
      return entries.get(ref)?.comment;
    },
    registerEligible(ref, comment) {
      const existing = entries.get(ref);
      // A release is scoped to the reviews that were open when the reader made
      // it. When the last one closes and a NEW one arrives later, the composer
      // is offered again — otherwise one release early in a thread would
      // silently disable the binding for every review after it.
      if (entries.size === 0) released = false;
      entries.set(ref, { count: (existing?.count ?? 0) + 1, comment });
      publish();
      let unregistered = false;
      return () => {
        // Idempotent: a double-call must not decrement another mount's count.
        if (unregistered) return;
        unregistered = true;
        const current = entries.get(ref);
        if (!current) return;
        if (current.count > 1) entries.set(ref, { ...current, count: current.count - 1 });
        else entries.delete(ref);
        // The focus is deliberately LEFT pointing at a ref that just went away.
        // A card re-registers on every re-resolve, and clearing here would drop
        // the reader's choice on a refresh they never saw. `resolveComposerTarget`
        // already refuses to treat a non-eligible focus as a target, so the
        // stale value can never route a comment.
        publish();
      };
    },
    focus(ref) {
      if (focused === ref && !released) return;
      focused = ref;
      released = false;
      publish();
    },
    clearFocus() {
      if (focused === null && released) return;
      focused = null;
      released = true;
      publish();
    },
  };
}

const ComposerFocusContext = createContext<ComposerFocusStore | null>(null);

/**
 * Declare that this subtree's review cards may bind a composer. Mounted by the
 * chat page around the transcript; every other surface mounts nothing and its
 * cards therefore offer no focus affordance.
 */
export function LifecycleComposerFocusProvider({
  store,
  children,
}: {
  store: ComposerFocusStore;
  children: ReactNode;
}): ReactElement {
  return (
    <ComposerFocusContext.Provider value={store}>{children}</ComposerFocusContext.Provider>
  );
}

export function useComposerFocusStore(): ComposerFocusStore | null {
  return useContext(ComposerFocusContext);
}

const NOOP_UNSUBSCRIBE = (): void => {};
const noopSubscribe = (): (() => void) => NOOP_UNSUBSCRIBE;
const emptySnapshot = (): ComposerFocusSnapshot => EMPTY_FOCUS_SNAPSHOT;

/** Subscribe to the focus binding. With no provider this is always empty. */
export function useComposerFocusSnapshot(): ComposerFocusSnapshot {
  const store = useComposerFocusStore();
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
}

/** The resolved composer binding for this subtree. */
export function useComposerTarget(): ComposerTargetResolution {
  return resolveComposerTarget(useComposerFocusSnapshot());
}

/** What one card knows about its own composer binding. */
export type ComposerFocusBinding = {
  /** There is a composer to bind at all AND this gate may take a comment. */
  available: boolean;
  /**
   * The composer currently routes to THIS gate — whether because the reader
   * chose it or because it is the only one open. This is what the card must
   * SAY, because it is what a typed message will actually do.
   */
  bound: boolean;
  /** The reader chose this card themselves (the pressed state). */
  explicit: boolean;
  /** Several gates are open and none is chosen: nothing routes until one is. */
  ambiguous: boolean;
  /** Take the binding, or give it back if this card already holds it. */
  toggleFocus: () => void;
};

/**
 * Register THIS card's gate as able to take a composer comment for as long as
 * `eligible` holds, and report how the composer is currently bound.
 *
 * The registered closure is a STABLE delegator over a ref-held `comment`, and
 * that is load-bearing rather than tidy. Registering the caller's closure
 * directly would put its identity in the effect's dependencies, so a host whose
 * action is rebuilt each render (any card whose credential or submit prop is an
 * inline object) would re-register on every render — and since registering
 * publishes, and publishing re-renders every subscribed card, that is a render
 * loop, not a bit of churn. Holding the action in a ref also means the composer
 * always calls the CURRENT one rather than the one captured when the gate opened.
 */
export function useComposerFocusBinding(params: {
  ref: string;
  eligible: boolean;
  comment: ComposerCommentAction;
}): ComposerFocusBinding {
  const { ref, eligible, comment } = params;
  const store = useComposerFocusStore();
  const snapshot = useComposerFocusSnapshot();
  const commentRef = useRef(comment);
  commentRef.current = comment;
  const stableComment = useCallback<ComposerCommentAction>(
    (text) => commentRef.current(text),
    [],
  );
  useEffect(() => {
    if (!store || !eligible) return;
    return store.registerEligible(ref, stableComment);
  }, [store, eligible, ref, stableComment]);
  const target = resolveComposerTarget(snapshot);
  const bound = target.kind === "target" && target.ref === ref;
  // The press is a TOGGLE on the binding as the reader sees it, not on the
  // explicit flag underneath: a card bound because it is the only one open
  // releases on the first press, rather than needing two (one to make the
  // implicit binding explicit, one to drop it) — which would read as a control
  // that did nothing.
  const boundNow = bound;
  const toggleFocus = useCallback(() => {
    if (!store) return;
    if (boundNow) store.clearFocus();
    else store.focus(ref);
  }, [store, ref, boundNow]);
  return {
    available: store !== null && eligible,
    bound,
    explicit: bound && target.kind === "target" && target.explicit,
    ambiguous: target.kind === "ambiguous",
    toggleFocus,
  };
}

/**
 * The host's credential declaration, or `null` on a cookie-session host.
 *
 * Read by every card request that is NOT the resolve — today the review card's
 * ref-bound decision POST (cinatra#2577 / #2575). One declaration serves both,
 * deliberately: a surface that proves itself one way to read and another way to
 * decide is a surface where the two can disagree, and on the widget the
 * disagreement would be an ambient cookie deciding as somebody else.
 */
export function useLifecycleCardAuth(): LifecycleCardAuth | null {
  return useContext(LifecycleCardAuthContext);
}

/**
 * The host's embedding context, or `null` on a first-party host. Read by the
 * review card when it addresses the §III island, so the server can re-derive
 * the ancestor origin the island must admit.
 */
export function useLifecycleCardFrame(): LifecycleCardFrame | null {
  return useContext(LifecycleCardFrameContext);
}

// ---------------------------------------------------------------------------
// THE HOST'S COLOUR SCHEME (cinatra#2931, epic #2926 W4)
// ---------------------------------------------------------------------------
//
// A lifecycle card may frame a nested first-party document (the review card's
// target island). That document is a separate browsing context with its own
// theme state, and until this hook nothing told it which palette the surface
// around it is painting in. On a first-party page it landed on the right answer
// by accident — same origin, same unpartitioned theme store as the app, so it
// read the very choice the app's theme control had written. Inside a third-party
// application the frame's store is partitioned away from the app's and nothing
// ever writes it, so the nested document fell back to the app's DEFAULT palette
// and painted light inside a dark widget.
//
// So the card reads the palette of the document IT is mounted in and names it
// downstream. There is no host branch here and none downstream: every host is a
// document, every document declares its palette the same way, and the widget is
// simply the host where the declaration was never being read.

/** The two palettes the app paints in. `light` is the app's `cinatra` palette. */
export type LifecycleColorScheme = "light" | "dark";

/** The class each palette is painted with — the `.cinatra` / `.dark` token
 *  blocks in `src/app/globals.css`, which is also the attribute the app's theme
 *  provider writes on the document root. */
const PALETTE_CLASS: Record<LifecycleColorScheme, string> = {
  light: "cinatra",
  dark: "dark",
};

/**
 * The palette a document root is painting, read off its class list.
 *
 * Pure, and the ONLY rule this mechanism has. The class on the root IS the
 * palette, whoever wrote it — the app's theme provider on every shipped surface,
 * or a host that sets it directly.
 *
 * `null` is not "light": it is "this document declares no palette". A card that
 * reads null names nothing downstream, which leaves every consumer exactly where
 * it stood before this mechanism existed.
 */
export function colorSchemeOfRoot(
  root: { classList: DOMTokenList } | null | undefined,
): LifecycleColorScheme | null {
  if (!root) return null;
  if (root.classList.contains(PALETTE_CLASS.dark)) return "dark";
  if (root.classList.contains(PALETTE_CLASS.light)) return "light";
  return null;
}

function subscribeToHostPalette(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function readHostPalette(): LifecycleColorScheme | null {
  return typeof document === "undefined" ? null : colorSchemeOfRoot(document.documentElement);
}

function noHostPalette(): LifecycleColorScheme | null {
  return null;
}

/**
 * The colour scheme of the document THIS card is mounted in.
 *
 * Read synchronously on the very first client render, so a consumer that turns
 * it into an address composes that address ONCE. That matters: the review card's
 * island URL can carry a single-use credential, and a value that arrived one
 * render late would change the address after the frame had already spent it.
 *
 * It follows a live change (the app's theme control) through the same store, so
 * a surface that repaints does not leave a nested document behind in the old
 * palette. The server snapshot is `null` — a document that has not been rendered
 * yet declares nothing.
 */
export function useLifecycleCardColorScheme(): LifecycleColorScheme | null {
  return useSyncExternalStore(subscribeToHostPalette, readHostPalette, noHostPalette);
}

// ---------------------------------------------------------------------------
// The refetch hook
// ---------------------------------------------------------------------------

/**
 * Resolve the authoritative ANSWER for one lifecycle ref: the state ladder and
 * the body this kind is authorized to carry. Returns `null` until the first
 * resolve completes — the caller renders nothing while it is null.
 *
 * A failed request (offline, 5xx, a body that does not validate) leaves the
 * answer null rather than inventing one: an unresolvable card is silent, never
 * optimistic. A denial is not an error — the server answers `absent` with a
 * 200, so a reader who may not see the item is indistinguishable from one
 * looking at an item that does not exist.
 *
 * THE ENVELOPE IS PARSED, NOT TRUSTED (epic S9, slice S9c). The answer is
 * `{ kind, state, body }`, and it goes through the protocol's one parse seam
 * with the kind THIS card asked for. An answer to another kind, an unknown
 * kind, a body beside `absent`, or a missing body on a kind that must carry one
 * are all refused — and a refused parse leaves the card exactly where it was
 * before the first resolve landed, drawing nothing. That is how the two
 * invariants survive a richer answer: no DOM before an authorized resolve, and
 * an `absent` that says nothing about the target.
 *
 * `reloadToken` (S2) lets a card force a re-resolve without remounting: after a
 * decision lands, or when the reader presses the §IV "no longer open" Refresh,
 * the card bumps the token and the SAME identity is re-resolved through the
 * same monotonic-request guard.
 */
export function useLifecycleCardResolve<K extends LifecycleDataPartViewType>(params: {
  viewType: K;
  ref: string;
  enabled: boolean;
  reloadToken?: number;
}): LifecycleResolveAnswerFor<K> | null {
  const { viewType, ref, enabled, reloadToken = 0 } = params;
  // The host's credential declaration (cinatra#2577). Read here so the resolve
  // callback closes over ONE value; a host that declares none keeps S1's exact
  // same-origin cookie request.
  const auth = useContext(LifecycleCardAuthContext);
  // State is stored WITH the identity it was resolved for, and read back only
  // when that identity still matches. A passive reset effect is not enough: on
  // the render where `ref` changes, the effect has not run yet, so the previous
  // card's authorized state would paint for one frame under the NEW ref.
  // An ACTIVATION generation, bumped on every transition back into `enabled`.
  // Without it, a card that is disabled and then re-enabled produces the identity
  // string it had the first time, so the state resolved under the PREVIOUS
  // activation would be read back and painted before the new resolve answers —
  // a card asserting an authorization it has not re-established. Derived during
  // render (not in an effect) so there is no frame where the stale answer shows.
  // This is React's documented "adjust state when a prop changes" shape. It is
  // not concurrency-pure: a render that is thrown away can still have bumped the
  // generation, costing one extra re-resolve. That is the right side to be wrong
  // on — an extra authorized resolve, never a repaint of an unauthorized one.
  const activationRef = useRef(0);
  const previousEnabledRef = useRef(enabled);
  if (previousEnabledRef.current !== enabled) {
    previousEnabledRef.current = enabled;
    if (enabled) activationRef.current += 1;
  }
  // `reloadToken` is deliberately NOT part of the identity: a forced re-resolve
  // of the SAME identity keeps the last authorized answer on screen until the
  // new one lands (S1's documented refresh posture), so a decision settles the
  // card without a frame of blankness in between.
  const identity = `${viewType}\u0000${ref}\u0000${enabled ? "1" : "0"}\u0000${activationRef.current}`;
  const [resolved, setResolved] = useState<{
    identity: string;
    envelope: LifecycleResolveAnswerFor<K>;
  } | null>(null);
  // Monotonic request id. Mount and focus can overlap, and a slow earlier
  // answer must never overwrite a fresher one — otherwise a card could settle
  // on a state the server has already superseded, which is precisely the stale
  // decision the refetch exists to prevent.
  const latestRequestRef = useRef(0);

  const resolve = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      const requestId = ++latestRequestRef.current;
      // The identity is CLOSURE-CAPTURED, not read at commit time: a response
      // must be stamped with the identity its request was ISSUED for. Reading a
      // ref at commit time would let a slow request for the old ref be filed
      // under the new one during the window before the effect cleanup aborts it.
      const requestIdentity = identity;
      try {
        const response = await fetch(LIFECYCLE_VIEW_RESOLVE_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(auth?.headers() ?? {}) },
          body: JSON.stringify({ viewType, ref }),
          credentials: auth?.credentials ?? "same-origin",
          signal,
        });
        if (!response.ok) return;
        const payload: unknown = await response.json();
        // Parsed against the kind THIS request asked for. Anything else — an
        // answer to another kind, an unknown kind, a body where `absent` allows
        // none — is refused, and a refused answer never reaches state.
        const envelope = parseLifecycleResolveEnvelope(viewType, payload);
        if (envelope === null) return;
        if (signal.aborted || requestId !== latestRequestRef.current) return;
        setResolved({ identity: requestIdentity, envelope });
      } catch {
        // Aborted or transport-failed — stay silent (see the doc above).
      }
    },
    [viewType, ref, identity, auth],
  );

  // Mount + focus load, mirroring `PendingToolConfirmationCards` — the chat
  // surface's established self-healing refresh shape. A failed REFRESH of the
  // SAME identity deliberately keeps the last authorized answer (the sibling
  // cards' documented posture); a CHANGED identity drops it via the read guard
  // below, with no frame in between.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void resolve(controller.signal);
    // Focus is the cheap stand-in for "the user came back to this tab after
    // deciding elsewhere" — the page-vs-card race the epic cares about.
    const onFocus = () => void resolve(controller.signal);
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, resolve, reloadToken]);

  return resolved !== null && resolved.identity === identity ? resolved.envelope : null;
}

// ---------------------------------------------------------------------------
// THE MOMENT THE RUN STANDS AT, AND THE CARD THAT MOMENT OWES (cinatra#3044).
//
// ONE SLOT, TWO READINGS. The drawing gives a run ONE place in the turn it was
// started from: the placeholder while it works, the moment's card when a moment
// opens, then that card's settled reading — nothing above it and nothing
// between. So the conversation has to know WHICH moment a run stands at before
// it decides what to draw in that place, and the only thing that knows is the
// run's own row.
//
// AND THE OPEN PAGE HAS TO HEAR ABOUT IT. The turn that started the run was
// STREAMED into this tab; the platform writes the moment's part into the
// STORED turn afterwards, so this tab's copy of that turn can never carry it.
// A person sitting in the conversation that started the run would therefore
// wait in silence until they navigated or reloaded — which is exactly the
// silent wait the plan forbids. The run's own read is the channel that is
// already live on that page (it is what turns "queued" into "Awaiting input"),
// so the moment reaches the open page on it, and the card mounts with no
// reload.
//
// BOUNDED, LIKE THE REVIEW SLOT BESIDE IT. The cadence backs off and a belt
// ends it: a run that never parks must not leave a conversation polling for
// ever, and a run that has settled is read once and left alone.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHAT THE SCHEDULE CARD IS READING, TOLD TO THE TURN AROUND IT (cinatra#3044)
// ---------------------------------------------------------------------------
//
// "Where the sentence and the card could disagree, the card is right." The line
// above a schedule card is the platform's, minted at dispatch and frozen into
// the turn, and the conversation already re-reads it against the RUN'S OWN ROW
// while the run stands at its schedule. After the schedule has been spent the
// row cannot answer any more: it names no schedule at all, and it never said
// whether the schedule was a one-off or a recurring one.
//
// AND THAT DIFFERENCE DECIDES THE SENTENCE. The ratified drawing's section VI
// gives the spent reading its own words -- "It ran at the time you set. A
// one-time schedule is spent once it fires..." -- and rules out saying them of
// anything else: "Only a one-off -- Run right after setup or Schedule for
// later -- reaches this reading. A recurring schedule is never spent by
// firing: its past runs are history and its runs still to come stay
// changeable." A turn that guessed from the row would say "spent" over a
// recurring schedule that is still live, which is the same class of untruth the
// correction exists to remove.
//
// So the CARD reports it. The card is the one thing that resolved the reading
// -- the released stamp and the trigger type are in its own body -- and this is
// the seam it says so through: a sink the enclosing turn provides, written by
// the card and read by the block that renders the turn's prose. It carries a
// READING, never a sentence: what the words are is the run-status leaf's, and
// what is true of this schedule is the card's.
//
// PASSIVE. A turn that provides no sink gets no report and the card behaves
// exactly as it did before this seam existed.

/**
 * The readings a schedule card's own body can settle into, for the questions
 * the turn's sentence turns on.
 *
 * A THIRD VALUE (cinatra#3174 fix leg 3, criterion 4). Section VI gives the
 * fired-recurring reading its own line above the card — "It is still recurring,
 * so the rows below still take a change — it applies to the runs still to
 * come." — and with two values that reading was reported as `other`, the same
 * answer a schedule that has never run gives, so the turn drew the never-fired
 * sentence over a schedule that had fired. The readings the turn has a sentence
 * for are named; everything else is still `other`.
 *
 * AND A FOURTH (cinatra#3174 fix leg 8, criterion 4). Section VI's Cancel
 * schedule "stops the recurring schedule and then leaves the rows no longer
 * editable", and that reading gets its own sentence too — see
 * `RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE`. With three values a stopped
 * schedule was still reported as `fired-recurring`, because the firing that
 * elects that reading stays true after the stop, so the turn kept the
 * still-recurring claim standing over a card that had just gone read-only.
 */
export type ScheduleCardReading =
  | "spent-one-off"
  | "fired-recurring"
  | "stopped-recurring"
  | "other";

const ScheduleReadingSinkContext = createContext<
  ((reading: ScheduleCardReading) => void) | null
>(null);

/**
 * The scope a schedule card's reading is reported into — mounted by the turn
 * around the card, never by the card.
 */
export function ScheduleReadingReport({
  onReading,
  children,
}: {
  onReading: (reading: ScheduleCardReading) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <ScheduleReadingSinkContext.Provider value={onReading}>
      {children}
    </ScheduleReadingSinkContext.Provider>
  );
}

/**
 * The card's own side of the report.
 *
 * A CARD THAT LEAVES TAKES ITS ANSWER WITH IT: the cleanup reports the neutral
 * reading, so a turn is never left saying "spent" over a card that has been
 * unmounted or has re-resolved into something else.
 */
export function useReportScheduleReading(reading: ScheduleCardReading): void {
  const sink = useContext(ScheduleReadingSinkContext);
  useEffect(() => {
    if (sink === null) return;
    sink(reading);
    if (reading === "other") return;
    return () => sink("other");
  }, [sink, reading]);
}

/** The run's moment, and the card reference that moment was stated with. */
export type RunMomentCard = {
  /** The run's own status, so a settled run is read once rather than watched. */
  status: string | null;
  /** The lifecycle moment the run stands at, as the row records it. */
  moment: string | null;
  /** The card kind that moment was stated with. */
  kind: string | null;
  /** The server-minted reference that card is addressed by. */
  ref: string | null;
};

export const RUN_MOMENT_UNREAD: RunMomentCard = Object.freeze({
  status: null,
  moment: null,
  kind: null,
  ref: null,
});

/**
 * Reads the run with the SURFACE'S OWN credential, and with the caller's abort
 * signal so a look that outlives its deadline is really cancelled. A surface
 * that cannot say who is asking passes `null` and nothing is read — the same
 * fail-closed posture the review slot's reader takes.
 */
export type RunMomentCardReader = (
  signal: AbortSignal,
) => Promise<RunMomentCard | null>;

/** Parse the run route's answer. Shared, so a surface cannot invent a shape the
 *  route does not send. */
export function parseRunMomentCard(data: unknown): RunMomentCard | null {
  if (data === null || typeof data !== "object") return null;
  const row = data as {
    status?: unknown;
    lifecycleMoment?: unknown;
    lifecycleCard?: { kind?: unknown; ref?: unknown } | null;
  };
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  // A RUN SAYS WHAT IT IS DOING. Without a status this is not the run's answer
  // — an empty body, a proxy's courtesy page, a shape from another route — and
  // reading it as "this run states no moment" would take a card off a turn that
  // really carries one. No status, no answer: the caller keeps looking and
  // keeps drawing what it was drawing.
  if (text(row.status) === null) return null;
  return {
    status: text(row.status),
    moment: text(row.lifecycleMoment),
    kind: text(row.lifecycleCard?.kind),
    ref: text(row.lifecycleCard?.ref),
  };
}

/** The DEFAULT reader: the run's own seed route, same-origin. */
export function defaultRunMomentCardReader(runId: string): RunMomentCardReader {
  return async (signal) => {
    const response = await fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) return null;
    return parseRunMomentCard(await response.json());
  };
}

/**
 * WHICH MOMENTS A CONVERSATION DRAWS A CARD FOR, and which card each one is.
 *
 * A map rather than a condition, so the transcript's mount and the rule that
 * stands the run's progress reading down cannot drift into two answers about
 * the same moment. It names exactly the kinds a conversation already renders
 * from the run's own reading; a moment that is not in it leaves the run's
 * progress reading exactly as it was.
 */
const CONVERSATION_MOMENT_CARDS: Readonly<Record<string, string>> = Object.freeze({
  schedule: "trigger_schedule_proposal",
});

/** Is this kind one a conversation draws from the run's own moment? */
export function isConversationMomentCardKind(kind: unknown): boolean {
  return (
    typeof kind === "string" &&
    Object.values(CONVERSATION_MOMENT_CARDS).includes(kind)
  );
}

/**
 * Does this reading say the run is standing at a moment whose card the
 * conversation draws? Fails closed: an unread run, a moment with no reference,
 * or a kind that does not match the moment answers `false`, and the run keeps
 * the progress reading it has always had.
 */
export function runMomentCardIsOpen(card: RunMomentCard): boolean {
  if (card.moment === null || card.ref === null) return false;
  return CONVERSATION_MOMENT_CARDS[card.moment] === card.kind;
}

/**
 * Statuses that end the watch: the run has settled and cannot open, close or
 * move a moment again.
 *
 * `armed` IS NOT ONE OF THEM (convergence finding, cinatra#3044). It reads like
 * one — the person has answered the card and cannot answer it again — and the
 * watch used to stop there. But the person is not the only writer of that row:
 * the release job is, and what it writes is exactly the change this watch
 * exists to see. `armed` is the run WAITING FOR THE INSTANT it was given
 * (`SCHEDULE_PARK_STATUSES` in the coordinator states the schedule moment in
 * `pending_trigger` AND `armed`, and the release job clears it when it fires),
 * so a watch that ends there is a page that can never learn its one-off fired:
 * the row goes on naming a schedule for ever, the run's own next reading never
 * comes back, and the spent card never reaches the settled election below.
 * That is the whole delayed one-off road — "Schedule for later" — and it is
 * the road the drawing's own fired example is drawn on.
 *
 * TAKEN FROM THE STATE MACHINE, not written out again. A hand-copied set is how
 * a status that does not exist gets watched for ever while a real terminal one
 * is missed — and the run vocabulary is one module away, typed.
 */
const RUN_MOMENT_WATCH_ENDS: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>(
  TERMINAL_RUN_STATUSES,
);

/**
 * Is this run standing at a moment A PERSON is about to act on?
 *
 * The brisk cadence below is bought by that question and not by "a card is on
 * screen". `pending_trigger` is the card as a CONTROL: somebody is looking at
 * the thing they are about to press, and the reading that replaces it is one
 * gesture away. `armed` is the same card as a WAIT — the answer is given, and
 * what changes it is an instant that may be days out. Polling that every two
 * seconds for as long as a tab stays open would buy nothing and cost a request
 * a second per parked run, which is why the wait takes the ordinary backed-off
 * belt instead.
 */
function runMomentAwaitsAPerson(card: RunMomentCard): boolean {
  return runMomentCardIsOpen(card) && card.status !== "armed";
}

/**
 * HOW FAR APART THE LOOKS ARE, AND WHAT ENDS THEM.
 *
 * THE CADENCE BACKS OFF but does NOT expire, and that is the whole point of
 * this watch: a run reaches its schedule moment when it reaches it — after the
 * setup gate is answered, after the work in front of it is done — and a belt
 * measured in minutes would put the silent wait back for every run slower than
 * the belt. So the tail is a STEADY long interval, and what ends the watch is
 * the run itself settling, which is an answer rather than a timer.
 *
 * It is also cheaper than what the surface already does: the run panel beside
 * this watch polls the same route every two seconds for a working run.
 *
 * TWO BELTS, AND THEY ANSWER DIFFERENT QUESTIONS. `UNANSWERED` is for a
 * transport that never answered at all — a dead endpoint must not be asked for
 * ever, and a watch that has never had an answer has nothing to show for the
 * asking. `MISSES` is for one that answered and then stopped: a credential that
 * expired mid-conversation, or a route that started failing. Without it a
 * brisk watch on an open moment would retry every two seconds for as long as
 * the tab stays open. Both leave the LAST answer on screen; what they end is
 * the asking.
 */
const MOMENT_UNANSWERED_LIMIT = 20;
const MOMENT_MISS_LIMIT = 10;
const MOMENT_READ_TIMEOUT_MS = 8000;

/**
 * AND IT IS BRISK WHILE THE RUN IS STANDING AT THE MOMENT. That is the one
 * state where the answer is about to change and somebody is looking at it: the
 * card on screen is the control they are about to press, and the reading that
 * replaces it is the run's own. A backed-off watch would leave the slot empty
 * for a whole interval after the press — the card takes itself away on its own
 * re-resolve, and the run's reading would not be back yet.
 *
 * It costs nothing net: the run panel this stands down polls the same route
 * every two seconds for a live run, so while the moment's card owns the slot
 * this watch is that poll rather than a second one.
 */
function momentReadDelay(reads: number, momentAwaitsAPerson: boolean): number {
  if (momentAwaitsAPerson) return 2000;
  if (reads < 5) return 2000;
  if (reads < 15) return 5000;
  return 10_000;
}

/**
 * Keep a run's open moment current, for the surface that draws its slot.
 *
 * The first look is IMMEDIATE — a conversation opened onto a run that is
 * already parked must not draw the progress reading over the moment's card for
 * a tick — and every later one backs off until the belt ends it.
 */
export function useRunMomentCard({
  read,
}: {
  read: RunMomentCardReader | null;
}): { card: RunMomentCard; answered: boolean; gaveUp: boolean } {
  const [card, setCard] = useState<RunMomentCard>(RUN_MOMENT_UNREAD);
  const [probe, setProbe] = useState<{
    answered: boolean;
    reads: number;
    misses: number;
  }>({ answered: false, reads: 0, misses: 0 });
  // A DIFFERENT READER IS A DIFFERENT SUBJECT — another run, or the same run
  // asked for with another credential — and the previous answer says nothing
  // about it. Adjusted during render (React's documented "adjust state when a
  // prop changes" shape) so no frame paints the previous run's moment.
  //
  // HELD IN A BOX, and that is not decoration: the reader IS a function, and
  // `useState` reads a bare function as a lazy INITIALIZER while a setter reads
  // one as an UPDATER — so storing it directly would call it, on every render,
  // and compare the reader against whatever it returned.
  const [seenRead, setSeenRead] = useState<{ read: RunMomentCardReader | null }>(
    { read },
  );
  if (seenRead.read !== read) {
    setSeenRead({ read });
    setCard(RUN_MOMENT_UNREAD);
    setProbe({ answered: false, reads: 0, misses: 0 });
  }

  const watchEnded =
    probe.answered &&
    card.status !== null &&
    // The row's status is free text on the wire; the SET is the typed
    // vocabulary, and membership is what decides — an unknown status is simply
    // not a settled one and the watch goes on.
    (RUN_MOMENT_WATCH_ENDS as ReadonlySet<string>).has(card.status);

  useEffect(() => {
    if (read === null) return;
    if (watchEnded) return;
    if (!probe.answered && probe.reads >= MOMENT_UNANSWERED_LIMIT) return;
    if (probe.misses >= MOMENT_MISS_LIMIT) return;
    let cancelled = false;
    // HOISTED OUT OF THE TIMER so the cleanup can really end the look. Scoped
    // inside it, an unmount — or a change of run or of credential — left an
    // authorized request running to its own deadline with nobody to receive it,
    // and a conversation with several run turns leaves several.
    const abort = new AbortController();
    // ONE LOOK AT A TIME. The focus signal below can arrive while a look is
    // still out, and two overlapping looks would share one abort controller and
    // count themselves twice against the backoff.
    let inFlight = false;
    const look = () => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        const deadline = window.setTimeout(
          () => abort.abort(),
          MOMENT_READ_TIMEOUT_MS,
        );
        let landed = false;
        try {
          const next = await read(abort.signal);
          if (cancelled) return;
          if (next) {
            setCard(next);
            landed = true;
          }
        } catch {
          // Transport failure or the deadline. The look does not count as an
          // ANSWER, so the surface keeps whatever it was drawing and the loop
          // retries on the backoff.
        } finally {
          window.clearTimeout(deadline);
          inFlight = false;
          if (!cancelled) {
            setProbe((prev) => ({
              answered: prev.answered || landed,
              reads: prev.reads + 1,
              // CONSECUTIVE misses, reset by any answer: what this ends is a
              // transport that has stopped answering, not one that hiccupped.
              misses: landed ? 0 : prev.misses + 1,
            }));
          }
        }
      })();
    };
    const timer = window.setTimeout(
      look,
      probe.reads === 0 ? 0 : momentReadDelay(probe.reads, runMomentAwaitsAPerson(card)),
    );
    // THE PERSON COMING BACK TO THE TAB is the cheap stand-in for "something
    // may have happened while nobody was looking" — the same signal the card
    // resolve beside this uses — and it costs one read rather than a faster
    // interval for every tab that is not being looked at.
    const onFocus = () => {
      if (!cancelled) look();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      abort.abort();
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [read, probe.answered, probe.reads, probe.misses, watchEnded, card]);

  return {
    card,
    answered: probe.answered,
    // THE WATCH IS OVER AND IT NEVER GOT AN ANSWER — a surface that cannot say
    // who is asking, or a transport that never answered. A caller that is
    // WITHHOLDING something until this read lands has to be able to stop
    // withholding it, or a dead endpoint would empty a turn for ever.
    gaveUp:
      !probe.answered &&
      (read === null || probe.reads >= MOMENT_UNANSWERED_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// THE RUN'S REVIEW SLOT (cinatra#2997) — one reader for both run panels.
//
// The maintainer's request for changes on pull request 2890, verbatim:
//
//   "The 'Agentic Run Progress' card should basically just be a card (maybe even
//    an empty review screen) with a spinning icon which is a temporary
//    placeholder for the review screen. Once the agent is done and the output
//    generated, that 'Agentic Run Progress' card is being automatically replaced
//    with the 'Review requested' screen. On the run page, the same is true."
//
// AUTOMATICALLY is the load-bearing word: the replacement may not wait for a
// model to mention the review, and it may not wait for the person to ask for it
// in a new turn. So the surface goes and looks — and BOTH run panels do, which
// is why the looking lives here rather than inside either of them.
//
// THE RUN SHAPE THIS IS FOR. The reviewed run does not park: it produces its
// artifact, reaches `completed`, and the shipped sweeper opens the review gate
// on the produced output a moment later. There is therefore a real window in
// which the run is done and its review does not exist yet, and this hook is what
// holds the placeholder across it.
// ---------------------------------------------------------------------------

/** The run's review slot: the server-minted ticket for its review screen, and
 *  whether a produced output's review question is still open. */
export type RunReviewSlot = { ref: string | null; awaiting: boolean };

/**
 * Reads the slot with the surface's OWN credential, and with the caller's abort
 * signal so a look that outlives its deadline is really cancelled rather than
 * merely ignored. A surface that cannot say who is asking answers `null` and
 * nothing is read.
 */
export type RunReviewSlotReader = (
  signal: AbortSignal,
) => Promise<RunReviewSlot | null>;

export const EMPTY_RUN_REVIEW_SLOT: RunReviewSlot = { ref: null, awaiting: false };

/**
 * How often the slot is re-read while it is waiting for a gate, how many times,
 * and how long one look may take.
 *
 * THE CADENCE BACKS OFF because the two cases have different shapes. The normal
 * one is a sweeper a second or two behind the run, and it wants a brisk look.
 * The pathological one is a sweeper that is not running at all, where a
 * two-second poll for minutes is just load — so the interval widens, and the
 * COUNT is the belt that ends it.
 *
 * TWO BUDGETS, NOT ONE, and they answer different questions. `SLOT_READ_LIMIT`
 * is how long the surface keeps LOOKING; `SLOT_HOLD_LIMIT` is how long it keeps
 * a placeholder up while it has never had an answer at all. They differ because
 * a dead transport must not hold a spinner in front of a finished run for
 * minutes — the surface falls back to the run's own terminal rendering after a
 * few seconds of silence, and the reader goes on looking behind it, so a late
 * answer still swaps the review in.
 *
 * The per-look DEADLINE exists for the same reason as the belt. The count only
 * advances when a look finishes, so a request that never settles would never be
 * counted; the deadline aborts it, which both frees the request and lets the
 * count move.
 */
const SLOT_READ_LIMIT = 30;
const SLOT_HOLD_LIMIT = 5;
const SLOT_READ_TIMEOUT_MS = 8000;

function slotReadDelay(reads: number): number {
  if (reads < 5) return 2000;
  if (reads < 15) return 5000;
  return 10_000;
}

/** Parse the seed route's answer into a slot. Shared by every reader so a
 *  surface cannot invent a shape the route does not send. */
export function parseRunReviewSlot(data: unknown): RunReviewSlot | null {
  const slot = (data as { reviewGate?: { ref?: unknown; awaiting?: unknown } })
    ?.reviewGate;
  if (!slot) return null;
  return {
    ref: typeof slot.ref === "string" && slot.ref.length > 0 ? slot.ref : null,
    awaiting: Boolean(slot.awaiting),
  };
}

/**
 * The DEFAULT reader: the run's own seed route, same-origin. Used by every
 * first-party surface (the run page). A surface that asks with something other
 * than a cookie — the embedded widget, which holds a broker credential and must
 * never send an ambient cookie — passes its own reader instead.
 */
export function defaultRunReviewSlotReader(runId: string): RunReviewSlotReader {
  return async (signal) => {
    const response = await fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) return null;
    return parseRunReviewSlot(await response.json());
  };
}

/**
 * Keep a run's review slot current, for the surface that draws it.
 *
 * `initial` is the answer the MOUNT was handed (the run screen reads it
 * server-side; the chat card gets it on its seed), so a run that already has a
 * review draws it on the first paint with no tick of placeholder in front.
 *
 * FRESHNESS IS KEYED TO THE RUN'S STATUS, AND IT IS ADJUSTED DURING RENDER. An
 * answer read while the run was `running` says nothing about the run once it is
 * `completed`, and the caller has to see it go stale IN THE SAME FRAME the
 * status changes — an effect runs after that frame, which is long enough to
 * paint one frame of a completion notice in front of a review that is about to
 * open. So this uses React's own "adjusting state when a prop changes" shape: a
 * comparison against the last status this hook saw, resolved during render.
 *
 * AND THE ANSWER IS DROPPED, not just marked stale. A run can complete, be
 * retried, and complete again; the ticket from the first completion is not the
 * second completion's review, and keeping it would draw the previous review's
 * settled card over a run that is about to open a new one.
 */
export function useRunReviewSlot({
  status,
  initial,
  read,
}: {
  status: string;
  initial?: RunReviewSlot | null;
  read: RunReviewSlotReader;
}): { slot: RunReviewSlot; answered: boolean; mayStillOpen: boolean } {
  const [seenStatus, setSeenStatus] = useState(status);
  const [slot, setSlot] = useState<RunReviewSlot>(initial ?? EMPTY_RUN_REVIEW_SLOT);
  const [probe, setProbe] = useState<{ answered: boolean; reads: number }>({
    answered: initial != null,
    reads: 0,
  });
  if (seenStatus !== status) {
    setSeenStatus(status);
    setSlot(EMPTY_RUN_REVIEW_SLOT);
    setProbe({ answered: false, reads: 0 });
  }
  const answered = probe.answered;

  useEffect(() => {
    // Only after the work is done. While the run is still working there is
    // nothing to find, and the placeholder is already the right drawing.
    if (status !== "completed") return;
    // Answered under this status, with nothing further owed.
    if (answered && !slot.awaiting) return;
    if (probe.reads >= SLOT_READ_LIMIT) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        void (async () => {
          const abort = new AbortController();
          const deadline = window.setTimeout(() => abort.abort(), SLOT_READ_TIMEOUT_MS);
          let landed = false;
          try {
            const next = await read(abort.signal);
            if (cancelled) return;
            if (next) {
              setSlot(next);
              landed = true;
            }
          } catch {
            // Transport failure or the deadline: `landed` stays false, so this
            // look does not count as an ANSWER — the loop retries on the backoff
            // until the belt ends it, and the surface falls back to the run's own
            // terminal rendering while it does.
          } finally {
            window.clearTimeout(deadline);
            if (!cancelled) {
              setProbe((prev) => ({
                answered: prev.answered || landed,
                reads: prev.reads + 1,
              }));
            }
          }
        })();
      },
      // The first look under a new status is immediate — the gate is usually
      // already open by the time the run reports done.
      probe.reads === 0 ? 0 : slotReadDelay(probe.reads),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, slot.awaiting, answered, probe.reads, read]);

  return {
    slot,
    answered,
    // The window between "the run reports done" and "its review exists": the
    // outbox still holds an unanswered review question, or this surface has not
    // heard back yet under the current status.
    //
    // THE UNHEARD WINDOW IS SHORT, AND ITS LENGTH IS WHAT IS KNOWN. Every
    // completed mount holds it for its FIRST look, which is immediate — that is
    // what stops a completion notice being painted in front of a review nobody
    // has asked about yet, and it costs one request. A mount that ALSO arrived
    // with a slot has been told a review is expected here, so it holds through a
    // few transport failures rather than falling back on the first one. Neither
    // holds indefinitely: past the budget the surface draws the run's own
    // terminal rendering and the reader goes on looking behind it, so a late
    // answer still swaps the review in.
    mayStillOpen:
      status === "completed" &&
      probe.reads < SLOT_READ_LIMIT &&
      (slot.awaiting ||
        (!answered && probe.reads < (initial != null ? SLOT_HOLD_LIMIT : 1))),
  };
}
