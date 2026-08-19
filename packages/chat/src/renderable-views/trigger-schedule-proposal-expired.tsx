"use client";

// ---------------------------------------------------------------------------
// The EXPIRED schedule-proposal reading, and its Adjust.
// Design: `specs/app-lifecycle-cards.html` §VI (the proposal card), §IV (the
// states, and what `absent` is reserved for).
//
// §VI, verbatim on the token's own TTL: "An expired proposal is not an error
// state — the card says so and Adjust re-proposes for free." This is the "says
// so", and the button that re-proposes.
//
// WHY IT LIVES IN THE SHELL AND NOT IN A DRAWN §VI CARD. The chat thread's
// proposal card is still S1's shell: the option rows, the duration line and the
// Confirm floor belong to the slice that draws this kind, and that slice is not
// this change. What IS this change is that the expired reading exists at all —
// so it is drawn at the ONE place the shell already draws every proposal state,
// which means it appears wherever the card appears without a single new mount.
// When the drawn card lands, this reading moves into it and this file goes;
// nothing else has to be unpicked, because nothing else learned about it.
//
// ADJUST TRAVELS THE CARD'S OWN REF, NOTHING ELSE. The expired token already
// carries the template and the schedule server-side and already proves the
// reader was minted this proposal, so no agent id and no rows go to the client
// and back. Re-proposing arms nothing — it mints a replacement token that
// INHERITS the original's consume identity, so the whole lineage addresses ONE
// primary-keyed consume row and only one member of it can ever become a run —
// which is why the button needs no authority and can never half-arm a schedule.
// It is also IDEMPOTENT WHILE LIVE: pressing it again while the replacement it
// already produced is un-expired hands the SAME token back, so a button the
// reader can keep pressing is not a way to keep minting.
//
// ADJUST IS COOKIE-BOUND, SO IT IS GATED ON THE COOKIE-SESSION SURFACE.
// `adjustExpiredScheduleProposal` is a SERVER ACTION: it proves the caller by
// the first-party session cookie and by nothing else. The card, however, draws
// on every DECLARED host — including the brokered site widget, which mounts
// with `credentials: "omit"` precisely because its embed frame is same-origin
// to the app and an ambient Cinatra cookie belonging to WHOEVER ELSE uses that
// browser would otherwise ride along. Firing a cookie-bound action from there
// is the exact shape `lifecycle-card-runtime`'s credential rule forbids: it
// either 401s, or — worse — succeeds as the wrong reader.
//
// The broker credential cannot carry this call, because a server action has no
// place to put it: the credential is a HEADER the runtime attaches to a fetch,
// and the action's transport is not ours to shape. Re-proposing over the broker
// would need its own ref-bound, broker-authenticated endpoint — a surface the
// widget does not have today and which belongs with the slice that turns the
// widget's proposal affordances on. So the honest answer here is the second one
// the shape allows: on a non-cookie surface the button is DRAWN and DISABLED
// with the reason, and no request is issued at all. The reader still sees the
// card and still learns the proposal expired; they are simply told where the
// re-proposing happens rather than handed a control that would answer as
// somebody else.
//
// THE FRESH PROPOSAL IS HELD LOCALLY, exactly as propose-purity requires: a
// proposal has no server record until Confirm, so the re-proposed card lives
// for this screen and this TTL. Reloading returns to the transcript's own ref,
// which reads `expired` — permanently and honestly — rather than blank.
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";

import { useCookieSessionSurface } from "@cinatra-ai/agents/lifecycle-card-runtime";

import type { TriggerScheduleProposalExpiredView } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

/** What the card says happened. Names no id, no org and no policy. */
const EXPIRED_LINE = "This proposal expired before it was confirmed.";

/**
 * Why Adjust is disabled off a cookie-session surface. Says where the reader
 * can do it and nothing else — no host name, no credential vocabulary, no
 * identifier. A reader on the widget learns what to do, not how we authenticate.
 */
const ADJUST_UNAVAILABLE_LINE = "You can propose this again from the full app.";

export function TriggerScheduleProposalExpired({
  view,
  cardRef,
  onReproposed,
}: {
  view: TriggerScheduleProposalExpiredView;
  /** The ref this card resolved under — the expired proposal itself. */
  cardRef: string;
  /**
   * Hand the freshly minted proposal back so the card re-resolves under it,
   * TOGETHER WITH the ref the press was issued under.
   *
   * The origin travels because the answer can outlive the question. This press
   * awaits a dynamic import and then a server action, and the card instance it
   * was made from is reused by index — so by the time the replacement arrives
   * the shell may be showing a DIFFERENT proposal, which correctly forgot this
   * one. The shell compares the origin against what it is showing now and drops
   * a completion that no longer belongs to it; this component states which
   * proposal it asked about and lets it decide.
   */
  onReproposed: (token: string, originRef: string) => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TRUE only inside a well-formed cookie-session host declaration. False for a
  // brokered host, for a refused declaration, and for no provider at all — so
  // the default is the silent one. See the header note for why the broker
  // credential cannot carry a server action.
  const cookieSession = useCookieSessionSurface();

  const onAdjust = useCallback(async () => {
    // Belt as well as braces: the button is disabled off a cookie surface, but
    // the guard is here too, because "the control was disabled" is a rendering
    // fact and this is the thing that actually issues the call.
    if (!cookieSession) return;
    setBusy(true);
    setError(null);
    try {
      // IMPORTED ON THE PRESS, not at module scope. The action module reaches
      // the session, the confirm transaction and the install outbox; a static
      // import would put that whole graph behind EVERY lifecycle card on every
      // surface that draws one — the exact cost the action file was split out
      // to avoid, and the one the route-graph ratchet measures. Nobody pays for
      // it until an expired card's Adjust is actually pressed.
      const { adjustExpiredScheduleProposal } = await import(
        "@cinatra-ai/agents/trigger-schedule-proposal-actions"
      );
      const result = await adjustExpiredScheduleProposal({ token: cardRef });
      if (!result.ok) {
        // The server's own sentence — "that time has already passed", or the
        // one generic refusal. Never a reason this component invented.
        setError(result.error);
        return;
      }
      // `cardRef` is the ref THIS press was issued under — the shell needs it
      // to tell a completion that is still about the card in front of the
      // reader from one that is not.
      onReproposed(result.token, cardRef);
    } catch {
      // A transport failure is not a refusal: say the neutral thing and leave
      // the expired card exactly as it was, still pressable.
      setError("Couldn't propose that again just now. Try again.");
    } finally {
      setBusy(false);
    }
  }, [cardRef, onReproposed, cookieSession]);

  return (
    <div data-lifecycle-card-phase="expired">
      <div className="mt-1">{EXPIRED_LINE}</div>
      <div className="mt-1 text-muted-foreground">
        {view.agentName} — {view.scheduleCopy}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void onAdjust()}
          disabled={busy || !cookieSession}
          data-lifecycle-action="adjust"
          // The REASON travels with the control, so the disabled state is never
          // a mystery to a pointer, a screen reader or a capture.
          data-lifecycle-action-disabled={cookieSession ? undefined : "no_cookie_session"}
          title={cookieSession ? undefined : ADJUST_UNAVAILABLE_LINE}
        >
          {busy ? "Proposing…" : "Adjust"}
        </Button>
      </div>
      {cookieSession ? null : (
        <div className="mt-2" role="note">
          {ADJUST_UNAVAILABLE_LINE}
        </div>
      )}
      {error === null ? null : (
        <div className="mt-2 text-destructive" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
