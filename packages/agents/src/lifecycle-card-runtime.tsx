"use client";

// ---------------------------------------------------------------------------
// The lifecycle card RUNTIME — host declaration + authoritative refetch
// (cinatra#2566, epic #2564 S2; moved verbatim out of S1's
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
// Two properties this module owns, restated because every host depends on them:
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
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  lifecycleCardStateSchema,
  type LifecycleCardHost,
  type LifecycleCardState,
  type LifecycleDataPartViewType,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

/** The server route that re-authorizes a ref and answers with the card state. */
export const LIFECYCLE_VIEW_RESOLVE_PATH = "/api/lifecycle-views/resolve";

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
          {children}
        </LifecycleCardFrameContext.Provider>
      </LifecycleCardAuthContext.Provider>
    </LifecycleCardSurfaceContext.Provider>
  );
}

export function useLifecycleCardHost(): LifecycleCardHost | null {
  return useContext(LifecycleCardSurfaceContext);
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
// The refetch hook
// ---------------------------------------------------------------------------

/**
 * Resolve the authoritative state for one lifecycle ref. Returns `null` until
 * the first resolve completes — the caller renders nothing while it is null.
 *
 * A failed request (offline, 5xx, a body that does not validate) leaves the
 * state null rather than inventing one: an unresolvable card is silent, never
 * optimistic. A denial is not an error — the server answers `absent` with a
 * 200, so a reader who may not see the item is indistinguishable from one
 * looking at an item that does not exist.
 *
 * `reloadToken` (S2) lets a card force a re-resolve without remounting: after a
 * decision lands, or when the reader presses the §IV "no longer open" Refresh,
 * the card bumps the token and the SAME identity is re-resolved through the
 * same monotonic-request guard.
 */
export function useLifecycleCardState(params: {
  viewType: LifecycleDataPartViewType;
  ref: string;
  enabled: boolean;
  reloadToken?: number;
}): LifecycleCardState | null {
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
    state: LifecycleCardState;
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
        const body: unknown = await response.json();
        const parsed = lifecycleCardStateSchema.safeParse(
          (body as { state?: unknown } | null)?.state,
        );
        if (!parsed.success) return;
        if (signal.aborted || requestId !== latestRequestRef.current) return;
        setResolved({ identity: requestIdentity, state: parsed.data });
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

  return resolved !== null && resolved.identity === identity ? resolved.state : null;
}
