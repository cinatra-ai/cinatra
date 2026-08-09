// ---------------------------------------------------------------------------
// The lifecycle CARD stub + its authoritative-refetch seam (cinatra#2565,
// epic #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` v0.1.0.
//
// This is the ONE component the card registry dispatches every lifecycle
// viewType to. It is deliberately a SHELL: S1 owns the wire, the producer bind
// and the state contract; the drawn card (target panel, capture pair, decision
// floor) is S2's (#2566). What is fully implemented here is the part every
// later slice depends on and none of them should re-invent:
//
//  1. THE PAYLOAD IS A REF. The DATA_PART carries `{ viewType, schemaVersion,
//     ref }` and nothing else. Nothing about the gate — not its subject, not
//     its state, not whether it exists — is readable from the transcript.
//
//  2. AUTHORITATIVE REFETCH. The card resolves live state SERVER-SIDE from the
//     ref on mount, on window focus, and (by virtue of a fresh mount) on
//     reload. A persisted turn therefore never shows yesterday's answer: a gate
//     decided after the turn was written renders as settled the moment the
//     thread is reopened.
//
//  3. NOTHING WITHOUT AN AUTHORIZED RESOLVE. Before the first successful
//     resolve the card renders NO DOM — not even a skeleton. A snapshot-
//     restored shell must not assert that something exists before the server
//     has re-authorized the reader, and a placeholder that appears and then
//     vanishes for a reader who may not see the item is exactly the existence
//     oracle §IV's `absent` state forbids ("no card DOM at all").
//
//  4. FAIL-CLOSED SURFACE GATING. The host declares itself via
//     `LifecycleCardSurfaceProvider`. With NO provider there is no host, and a
//     card renders nothing — so a surface that has not been reviewed for
//     lifecycle cards (the site widget, whose enablement is S8d's) cannot start
//     drawing them by inheriting a default. §IX's presence matrix is then
//     consulted per (kind, host).
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
  LIFECYCLE_CARD_PRESENCE,
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
 * Declare the host a subtree renders lifecycle cards on. A host opts IN; there
 * is no default. S8d turns the widget on by wrapping the embed transcript in
 * `<LifecycleCardSurfaceProvider host="site_widget">` — until then the embed
 * declares nothing and renders no lifecycle card DOM at all.
 */
export function LifecycleCardSurfaceProvider({
  host,
  children,
}: {
  host: LifecycleCardHost;
  children: ReactNode;
}): ReactElement {
  return (
    <LifecycleCardSurfaceContext.Provider value={host}>
      {children}
    </LifecycleCardSurfaceContext.Provider>
  );
}

export function useLifecycleCardHost(): LifecycleCardHost | null {
  return useContext(LifecycleCardSurfaceContext);
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
 */
export function useLifecycleCardState(params: {
  viewType: LifecycleDataPartViewType;
  ref: string;
  enabled: boolean;
}): LifecycleCardState | null {
  const { viewType, ref, enabled } = params;
  // State is stored WITH the identity it was resolved for, and read back only
  // when that identity still matches. A passive reset effect is not enough: on
  // the render where `ref` changes, the effect has not run yet, so the previous
  // card's authorized state would paint for one frame under the NEW ref.
  const identity = `${viewType}\u0000${ref}\u0000${enabled ? "1" : "0"}`;
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ viewType, ref }),
          credentials: "same-origin",
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
    [viewType, ref, identity],
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
  }, [enabled, resolve]);

  return resolved !== null && resolved.identity === identity ? resolved.state : null;
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

const CARD_TITLES: Record<LifecycleDataPartViewType, string> = {
  artifact_review_gate: "Review",
  verification_summary: "Verification",
  trigger_schedule_proposal: "Schedule proposal",
};

/**
 * The one-line summary per state. Deliberately identifier-free: the shell says
 * what the reader can do, never what the item is. S2 replaces the body of the
 * review card with the drawn target + floor; these lines stay the floor of the
 * never-blank ladder for a card whose renderer is not built.
 */
function stateLine(state: LifecycleCardState): string | null {
  switch (state.state) {
    case "loading":
      return "Loading…";
    case "pending":
      return "Waiting for your decision.";
    case "restricted":
      return state.reason;
    case "settled":
      return "No longer open.";
    case "advisory":
      return "Advisory reading.";
    case "absent":
      return null;
  }
}

/**
 * The registry's component for every lifecycle viewType. Renders nothing until
 * an authorized resolve says otherwise; renders nothing, ever, for `absent`.
 */
export function LifecycleCard({
  view,
}: {
  view: { viewType: LifecycleDataPartViewType; schemaVersion: number; ref: string };
}): ReactElement | null {
  const host = useLifecycleCardHost();
  // §IX presence: no declared host, or a host this kind does not appear on →
  // the card is not part of this surface at all.
  const present = host !== null && LIFECYCLE_CARD_PRESENCE[view.viewType][host];
  const state = useLifecycleCardState({
    viewType: view.viewType,
    ref: view.ref,
    enabled: present,
  });

  if (!present || state === null) return null;
  const line = stateLine(state);
  if (line === null) return null; // `absent` — no card DOM at all (§IV)

  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface-muted p-3 text-xs text-muted-foreground"
      data-lifecycle-card={view.viewType}
      data-lifecycle-card-state={state.state}
    >
      <div className="font-semibold text-foreground">{CARD_TITLES[view.viewType]}</div>
      <div className="mt-1">{line}</div>
    </div>
  );
}
