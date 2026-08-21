"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactElement,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import {
  useLifecycleCardAuth,
  useLifecycleCardHost,
} from "./lifecycle-card-runtime";
import type { RecommendedSkillForChip } from "./server-actions";
import { getRunRecommendedSkillsAction } from "./server-actions";
import {
  confirmRunRecommendationAction,
  getRunRecommendationHoldStateAction,
  skipRunRecommendationAction,
  type RunRecommendationHoldState,
} from "./run-recommendation-actions";

// ---------------------------------------------------------------------------
// RunRecommendationChipRow — the SHARED run-start recommendation chip-row
// (cinatra#2067, epic #2037 C3). ONE component serving BOTH the canonical run
// view (instance-screens.tsx) and the chat-mounted run panel (agentic-run-panel
// .tsx) — issue #2067 item 5 (chat parity is not assumed; it uses the SAME
// component). Reuses the HitlSkillChips visual language (a collapsible chip row
// + a per-skill detail Sheet) and adds the confirm / adjust / skip affordances:
//
//   ADJUST  — toggle a chip on/off (a recommended chip starts selected; a
//             non-recommended candidate starts unselected and rides
//             `forcedRevisions` when turned on).
//   CONFIRM — write the currently-selected set as the authoritative per-run
//             selection and release the run-start hold (the run dispatches).
//   SKIP    — proceed with the computed default set (durable skip evidence).
//
// These are skill-selection affordances, NOT a review decision — the review
// floor (Approve/Reject/Comment) is untouched (issue #2067 AC-8).
//
// `decision` drives the two visual modes:
//   "pending"   → the interactive chip-row (a live parked hold).
//   a summary   → the read-only decided state (a released hold) — confirmed
//                 (labeled skills) or skipped.
// ---------------------------------------------------------------------------

export type RunRecommendationDecision =
  | { kind: "pending" }
  | { kind: "confirmed"; skillNames: string[] }
  | { kind: "skipped" };

type Props = {
  runId: string;
  agentPackageName: string;
  /** JSON-serialized run intent (inputParams) for request-aware scoring. */
  promptText?: string;
  /** Server-prefetched candidates (run view). Omit to fetch on mount (chat). */
  initialRecommendations?: RecommendedSkillForChip[];
  /**
   * OPAQUE handle to the hold this row is showing (cinatra#2568). Handed back on
   * confirm/skip so the decision binds to the hold it was taken against: a run
   * that was decided, dispatched and held AGAIN refuses a decision meant for the
   * previous hold instead of applying it to the new one. Absent on surfaces that
   * do not (yet) carry it — the action then keeps its pre-#2568 run-scoped
   * behaviour.
   */
  holdRef?: string;
  decision: RunRecommendationDecision;
  /** Compact styling for the inline chat mount. */
  variant?: "panel" | "inline";
  /**
   * Fired after a confirm/skip SUCCEEDS (cinatra#2568 AC-1). The card host
   * re-reads the authoritative hold state so the row settles into its decided
   * summary on the spot. Without it the only thing that could flip the row was
   * the retired 4-second poll: `router.refresh()` below re-renders the SERVER
   * tree (which is what the run-detail mount needs) but says nothing to a
   * client-resolved card. Both fire — they serve different mounts, and a
   * refresh a mount does not need is a no-op, never a wrong state.
   */
  onDecided?: () => void;
};

export function RunRecommendationChipRow({
  runId,
  agentPackageName,
  promptText,
  initialRecommendations,
  holdRef,
  decision,
  variant = "panel",
  onDecided,
}: Props) {
  const router = useRouter();
  const [recs, setRecs] = useState<RecommendedSkillForChip[]>(
    initialRecommendations ?? [],
  );
  const [loaded, setLoaded] = useState(initialRecommendations != null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((initialRecommendations ?? []).filter((r) => r.recommended).map((r) => r.skillId)),
  );
  const [detail, setDetail] = useState<RecommendedSkillForChip | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Chat mount: fetch candidates on mount when not server-prefetched.
  useEffect(() => {
    if (loaded || decision.kind !== "pending") return;
    let cancelled = false;
    getRunRecommendedSkillsAction({ agentPackageName, promptText })
      .then((r) => {
        if (cancelled) return;
        setRecs(r);
        setSelected(new Set(r.filter((s) => s.recommended).map((s) => s.skillId)));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, decision.kind, agentPackageName, promptText]);

  // ── Read-only decided state (a released hold) ────────────────────────────
  if (decision.kind === "confirmed") {
    return (
      <div
        data-run-recommendation-decision="confirmed"
        className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface-muted px-4 py-3"
      >
        <Check className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-muted-foreground">
          Skills confirmed ({decision.skillNames.length})
        </span>
        {decision.skillNames.map((n) => (
          <Badge key={n} variant="secondary" className="rounded-chip text-xs">
            {n}
          </Badge>
        ))}
      </div>
    );
  }
  if (decision.kind === "skipped") {
    return (
      <div
        data-run-recommendation-decision="skipped"
        className="flex items-center gap-2 rounded-panel border border-line bg-surface-muted px-4 py-3"
      >
        <span className="text-xs font-medium text-muted-foreground">
          Skill recommendation skipped — running with the default set.
        </span>
      </div>
    );
  }

  // ── Interactive chip-row (a live parked hold) ────────────────────────────
  const toggle = (skillId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  };

  const onConfirm = () => {
    setError(null);
    const confirmedSkillIds = [...selected];
    // Forced revisions: a SELECTED skill that was NOT recommended is a
    // human-forced addition — pin its exact revision.
    const forcedRevisions: Record<string, string> = {};
    for (const r of recs) {
      if (!r.recommended && selected.has(r.skillId)) forcedRevisions[r.skillId] = r.skillRevisionId;
    }
    startTransition(async () => {
      const res = await confirmRunRecommendationAction({
        runId,
        agentPackageName,
        confirmedSkillIds,
        promptText,
        forcedRevisions: Object.keys(forcedRevisions).length ? forcedRevisions : undefined,
        ...(holdRef ? { holdRef } : {}),
      });
      if (!res.ok) {
        setError(res.error || "Could not confirm the skill selection.");
        return;
      }
      onDecided?.();
      router.refresh();
    });
  };

  const onSkip = () => {
    setError(null);
    startTransition(async () => {
      const res = await skipRunRecommendationAction({
        runId,
        ...(holdRef ? { holdRef } : {}),
      });
      if (!res.ok) {
        setError(res.error || "Could not skip.");
        return;
      }
      onDecided?.();
      router.refresh();
    });
  };

  return (
    <div
      data-run-recommendation-chip-row=""
      data-conformance-id="run-chip-row"
      data-action="confirm-skill -> confirmed"
      data-variant={variant}
      className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-4"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          Confirm the skills for this run
        </span>
        <span className="text-xs text-muted-foreground">
          Recommended for your request. Adjust the selection, then confirm — or skip to run
          with the default set.
        </span>
      </div>

      <Collapsible defaultOpen>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 rounded-chip text-muted-foreground hover:text-foreground"
            >
              <span className="text-xs font-medium">
                Skills ({selected.size}/{recs.length})
              </span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="flex flex-wrap gap-2 pt-2">
            {!loaded ? (
              <span className="text-xs text-muted-foreground">Loading recommendations…</span>
            ) : recs.length === 0 ? (
              <span className="text-xs text-muted-foreground">No candidate skills.</span>
            ) : (
              recs.map((skill) => {
                const isSelected = selected.has(skill.skillId);
                return (
                  <div key={skill.skillId} className="flex items-center">
                    <Button
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      className="rounded-chip gap-1.5 text-xs"
                      aria-pressed={isSelected}
                      data-skill-id={skill.skillId}
                      data-selected={isSelected ? "true" : "false"}
                      data-forced={!skill.recommended ? "true" : undefined}
                      onClick={() => toggle(skill.skillId)}
                      onDoubleClick={() => {
                        setDetail(skill);
                        setSheetOpen(true);
                      }}
                      title={
                        skill.recommended
                          ? `Recommended (rank ${skill.rank})`
                          : "Not recommended — adding forces this skill"
                      }
                    >
                      {isSelected ? <Check className="h-3 w-3" /> : null}
                      {skill.name}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={onConfirm}
          disabled={pending || !loaded}
          data-action="confirm-run-recommendation"
        >
          {pending ? "Working…" : "Confirm"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onSkip}
          disabled={pending}
          data-action="skip-run-recommendation"
        >
          Skip
        </Button>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-foreground">{detail?.name ?? ""}</SheetTitle>
            <SheetDescription className="text-muted-foreground">
              {detail?.recommended
                ? `Recommended · rank ${detail?.rank} · score ${detail?.score?.toFixed?.(2) ?? detail?.score}`
                : "Not among the recommendations for this request."}
            </SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="mt-4 flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">Scored on</span>
              <ul className="flex flex-col gap-1">
                {(detail.scoredFeatures ?? []).map((f, i) => (
                  <li key={i} className="text-xs text-foreground">
                    <span className="text-muted-foreground">{f.kind}</span> · {f.detail}{" "}
                    <span className="text-muted-foreground">(+{f.contribution})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ===========================================================================
// COLOCATED ON PURPOSE (route-graph ratchet). The card below is the ONE
// renderer of `recommendation_hold`, and it lives in this module rather than
// its own because a separate file added a module to five ratcheted routes
// (/chat, /sign-in, /api/a2a, /api/mcp, /api/llm-bridge) whose ceilings may
// only ever shrink. Colocating costs nothing structurally: the card composes
// exactly the row above it and nothing else composes the card, so the two are
// one interaction's rendering in one place.
// ===========================================================================
// ---------------------------------------------------------------------------
// `RecommendationHoldCard` — THE renderer of `recommendation_hold`
// (cinatra#2568 AC-1 + AC-5, epic #2564 S4 riders).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §IV (the card states), §IX (where a card
// appears).
//
// WHAT THIS FILE FINISHES. S1 (#2565) declared `recommendation_hold` in the
// lifecycle registry with carriage `interrupt` — the one kind the run is
// genuinely BLOCKED on. S4 (#2568) put that interrupt on the wire: a typed
// discriminator, a reconnect-authoritative live-state snapshot, and confirm/skip
// routing that never touches `approveReviewTask`. What S4 deliberately left for
// LAST — "the 4s poll is retired LAST, after replay + routing exist" — is this:
// the interaction stops being a hand-rolled 4-second poll beside the panel and
// becomes a CARD, mounted the same way `ReviewGateCard` is, gated by the same
// host declaration, resolved by the same authoritative-refetch discipline.
//
// THE THREE RULES IT INHERITS FROM `lifecycle-card-runtime`, restated because
// this card resolves through a server ACTION rather than the `/resolve` route
// (the hold is an interrupt kind — it has no `DATA_PART` ref envelope to POST):
//
//  1. FAIL-CLOSED SURFACE GATING. A host opts IN via
//     `LifecycleCardSurfaceProvider`. No provider ⇒ no host ⇒ no DOM, and that
//     declaration is the ONLY gate: every declared host draws this card,
//     including the site widget (corrected 2026-08-11 — a signed-in widget
//     reader is the same person with the same rights as inside Cinatra, so the
//     "a widget visitor never shapes a run's skills" row is gone).
//
//  2. NOTHING WITHOUT AN AUTHORIZED RESOLVE. `getRunRecommendationHoldStateAction`
//     is the authority, not the wire. It runs the run-access door and intersects
//     the candidate set against the VIEWER (cinatra#2148). Until it answers,
//     this renders nothing — not a skeleton. The wire only ever says "something
//     changed"; it never says what this reader may see.
//
//  3. NO TIMER, AT ALL. The card re-resolves on exactly the events that can
//     change the answer: mount, a change in the typed hold interrupt on the wire
//     (announcement or its paired RESUME), window focus (the reader came back
//     after deciding elsewhere), and its own decision landing. A run that is
//     parked, decided, dispatched and parked AGAIN moves the wire ref, so the
//     re-park is picked up without a schedule. That is what makes AC-1's "the
//     poll code path is deleted" a structural property of this file rather than
//     a promise — and the suite reads this file to prove it.
//
// ONE COMPONENT, EVERY HOST. The chip-row drawing itself is UNCHANGED — this
// card composes the shipped `RunRecommendationChipRow` exactly as `ReviewGateCard`
// composes the shipped `ReviewDecisionBar`. No pixel is invented and no second
// chip-row implementation exists; what the card owns is WHETHER the row appears,
// WHICH state it is in, and WHEN that answer is re-read.
// ---------------------------------------------------------------------------
/**
 * The FAILURE-ONLY retry schedule (ms). Bounded, self-terminating, and armed
 * exclusively when a resolve threw — a successful resolve schedules nothing, so
 * the card's steady state is zero timers. Short enough that a transient 5xx
 * heals inside the window a human would notice, small enough that a genuinely
 * down backend is asked four times and then left alone until the reader or the
 * wire says something new.
 */
const RESOLVE_RETRY_DELAYS_MS = [400, 1_500, 4_000] as const;

/**
 * Resolve the authoritative hold state for one run.
 *
 * Returns `null` until the first resolve completes — the caller draws nothing
 * while it is null (rule 2 above). A transport failure leaves the last
 * authorized answer in place rather than inventing one; a REFUSAL is not a
 * failure, because the action answers `{ state: "none" }` for a reader who may
 * not see the run, which is indistinguishable from a run that was never held.
 *
 * `wireRef` is the typed hold interrupt's opaque ref (or `null` for "no hold is
 * live"). It is a CHANGE SIGNAL only: nothing is read out of it, and a forged
 * one buys nothing, because the resolve below re-authorizes from scratch.
 *
 * THE IDENTITY IS THE RUN; THE WIRE REF IS A REFRESH TRIGGER. The resolved
 * answer is filed under `runId` and read back only while that still matches, so
 * a wire change re-resolves WITHOUT blanking the card — the last authorized
 * answer stays on screen until the new one lands. That is deliberate and it is
 * the review card's shipped posture for a forced re-resolve of the same identity
 * (`useLifecycleCardResolve`'s `reloadToken`, which is likewise excluded from the
 * identity): a decision or a re-park settles the row without a frame of
 * blankness. Treating the ref as part of the identity would buy nothing — it is
 * the SAME run and the SAME reader either way — and would cost a blank frame on
 * every hold transition.
 *
 * A RE-PARK ALWAYS MOVES THE REF, by construction. The ref is AES-256-GCM over
 * `{runId, parkId}` under a fresh random IV (`encodeRecommendationHoldRef`), so
 * two mints never produce the same string even for the same park. There is no
 * "a new hold happens to reuse the old ref" case to defend against; the worst
 * the randomness costs is one extra authorized resolve when a reconnect
 * re-announces a hold that was already on screen.
 */
function useRecommendationHoldState(params: {
  runId: string;
  wireRef: string | null;
  reloadToken: number;
}): RunRecommendationHoldState | null {
  const { runId, wireRef, reloadToken } = params;
  const [resolved, setResolved] = useState<{
    runId: string;
    state: RunRecommendationHoldState;
  } | null>(null);
  // Monotonic request id — mount, a wire change and a focus can overlap, and a
  // slow earlier answer must never overwrite a fresher one. Same guard shape as
  // `useLifecycleCardResolve`; the reason is identical (a superseded answer is
  // exactly the staleness the refetch exists to prevent).
  const latestRequestRef = useRef(0);

  /**
   * One resolve attempt. `true` means "this trigger is done" — either an answer
   * was filed, or a NEWER request has taken over the chain. `false` means the
   * attempt FAILED and nothing was filed, which is the only case the retry
   * schedule below acts on.
   */
  const resolve = useCallback(async (): Promise<boolean> => {
    const requestId = ++latestRequestRef.current;
    // The run id is CLOSURE-CAPTURED so an answer is filed under the run its
    // request was ISSUED for, never under whichever run the card shows by the
    // time it lands.
    const requestRunId = runId;
    try {
      const state = await getRunRecommendationHoldStateAction({ runId: requestRunId });
      // Superseded: a newer trigger owns the answer now. Not a failure — and it
      // must NOT arm a retry, or a burst of wire changes would fan out into a
      // pile of competing retry chains.
      if (requestId !== latestRequestRef.current) return true;
      setResolved({ runId: requestRunId, state });
      return true;
    } catch {
      // Transport/server/serialization failure — stay with the last authorized
      // answer (or with NO answer, which draws nothing). A failed resolve is
      // never turned into a state: an unresolvable card is silent, never
      // optimistic.
      return false;
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    // A TRIGGER, ITS FAILURE BUDGET, AND NOTHING ELSE.
    //
    // Every trigger below gets ONE resolve. If that resolve FAILS, it gets a
    // small, bounded, self-terminating retry chain — because the failure is the
    // one case where the card is left asserting a state the server has already
    // moved past, with no further event guaranteed to arrive. Concretely: a
    // hold is created, its ref lands, the resolve 500s, the stream stays healthy
    // and emits nothing more, and the reader never leaves the tab — without the
    // budget the run sits parked behind a card that draws nothing, forever. The
    // mirror case (a RESUME whose resolve fails, leaving a decided row showing
    // as pending) is the same defect.
    //
    // THIS IS NOT THE POLL COMING BACK, and the difference is structural rather
    // than a matter of degree: a SUCCESSFUL resolve schedules nothing at all, so
    // the steady state of this card is zero timers. The retired interval ran
    // forever on the success path; this runs only while the card is failing, at
    // most `RESOLVE_RETRY_DELAYS_MS.length` times, and stops on the first
    // answer. It also cannot accumulate: a new trigger clears the pending retry
    // and starts its own budget, and a superseded request returns `true`.
    const run = async (): Promise<void> => {
      if (cancelled) return;
      clearRetry();
      const settled = await resolve();
      if (cancelled || settled) {
        if (settled) attempt = 0;
        return;
      }
      if (attempt >= RESOLVE_RETRY_DELAYS_MS.length) return;
      const delay = RESOLVE_RETRY_DELAYS_MS[attempt];
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void run();
      }, delay);
    };

    void run();

    // THE WAKE CHANNEL. Beyond the retry budget, the three events that correlate
    // with "the last answer may be wrong, or was never obtained" re-resolve:
    //
    //   focus            — the reader came back after deciding somewhere else
    //                      (the page-vs-card race the epic cares about);
    //   visibilitychange — the same, for a tab restored without a window focus;
    //   online           — connectivity returned, which is a common cause of a
    //                      swallowed resolve.
    //
    // None fires on an idle, connected, focused tab, so they add no steady-state
    // traffic. A wake resets the failure budget, which is exactly right: the
    // reader coming back is new evidence that another attempt is worth making.
    const onWake = () => {
      if (document.visibilityState === "hidden") return;
      attempt = 0;
      void run();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      cancelled = true;
      clearRetry();
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
    // `wireRef` is in the dependency list precisely so the typed interrupt (and
    // its paired RESUME, which nulls it) triggers a re-resolve. That is the
    // whole replacement for the retired 4-second interval.
  }, [runId, wireRef, reloadToken, resolve]);

  // Read the answer back only while it still belongs to the run on screen.
  return resolved !== null && resolved.runId === runId ? resolved.state : null;
}

export function RecommendationHoldCard({
  runId,
  agentPackageName,
  wireRef,
}: {
  runId: string;
  /** Fallback package name for the DECIDED summary (the held state carries its own). */
  agentPackageName?: string;
  /**
   * The typed `recommendation_hold` interrupt's ref off the run wire, or `null`
   * when no hold is live. A pure change signal — see `useRecommendationHoldState`.
   * Hosts with no stream pass `null` and still get mount/focus/decision resolves.
   */
  wireRef?: string | null;
}): ReactElement | null {
  // Fail-closed: no declared host ⇒ no card DOM at all. A declared host draws
  // it — the per-surface matrix that withheld this card from the widget is gone.
  const host = useLifecycleCardHost();
  // …with ONE credential-keyed exception, and it is not a surface rule (codex
  // round 0, finding 4). This card does not resolve or decide through the
  // lifecycle endpoints: it calls COOKIE-BOUND server actions
  // (`getRunRecommendationHoldStateAction`, and Confirm/Skip), which resolve
  // their identity from the ambient session and cannot carry a host credential.
  // On a host that declares one — a broker surface, same-origin to the app — a
  // drawn card would therefore read, and act, as whoever else is signed in on
  // that browser. That is exactly the ambient-session fallback the contract
  // forbids, so the card draws NOTHING until its actions are broker-aware.
  //
  // Stated plainly because it is a shortfall, not a design: this is the one
  // lifecycle card whose widget parity is not yet complete end to end. It is
  // ALSO unreachable there today — a lifecycle interrupt is dropped by the chat
  // reducer and the embed mounts no run panel — so nothing regresses; when the
  // broker-aware entry lands, this guard is what gets deleted.
  const auth = useLifecycleCardAuth();
  const present = host !== null && auth === null;

  // A decision taken IN the row is the one state change the wire cannot be
  // relied on to announce first (the RESUME is published after the action
  // succeeds, and a host may have no stream at all), so the row tells the card
  // directly and the card re-reads the authority.
  const [reloadToken, setReloadToken] = useState(0);
  const onDecided = useCallback(() => setReloadToken((n) => n + 1), []);

  // Hooks run unconditionally (rules of hooks); the resolve itself is cheap and
  // the ABSENT host is enforced on the render below, so a surface that has not
  // declared itself still draws nothing.
  const state = useRecommendationHoldState({
    runId: present ? runId : "",
    wireRef: wireRef ?? null,
    reloadToken,
  });

  if (!present) return null;
  if (state === null || state.state === "none") return null;

  return (
    // THE CARD'S OWN IDENTITY ROOT — kind, host and state, on the one component
    // rather than on either mount's wrapper.
    //
    // Both authorized mounts (the chat transcript's `chat_thread` mount and the
    // run panel's `run_card` mount) render THIS component, so putting the
    // attributes here is what makes each mount's values host-CORRECT by
    // construction: the host is read from the provider the mount declared, so a
    // mount cannot label itself as a host it is not, and a third mount cannot
    // appear without one. Putting them on a wrapper instead would have meant two
    // wrappers to keep in agreement, and the run panel would have carried none.
    //
    // `display: contents` so the identity costs no box: the element is in the
    // DOM for the anchor set to read, and neither mount's layout moves.
    <div
      className="contents"
      data-lifecycle-card="recommendation_hold"
      data-lifecycle-card-host={host}
      data-lifecycle-card-state={state.state}
      // The chat transcript's evidence anchor rides the card's OWN root rather
      // than a wrapper the transcript renders. That is what makes the mount
      // FAIL OPEN: a turn with no live hold draws no card, so it adds no marker
      // and no node, and a conversation without a hold is byte-identical to one
      // from before this mount existed. A wrapper rendered by the transcript
      // would have been there whether or not anything was inside it.
      {...(host === "chat_thread" ? { "data-chat-thread-recommendation-hold": "" } : {})}
    >
    <RunRecommendationChipRow
      runId={runId}
      agentPackageName={
        state.state === "held" ? state.agentPackageName : (agentPackageName ?? "")
      }
      promptText={state.state === "held" ? state.promptText : undefined}
      initialRecommendations={state.state === "held" ? state.recommendations : undefined}
      holdRef={state.state === "held" ? state.holdRef : undefined}
      decision={
        state.state === "held"
          ? { kind: "pending" }
          : state.state === "confirmed"
            ? { kind: "confirmed", skillNames: state.skillNames }
            : { kind: "skipped" }
      }
      variant="inline"
      onDecided={onDecided}
    />
    </div>
  );
}
