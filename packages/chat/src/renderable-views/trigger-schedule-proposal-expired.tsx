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
// and back. Re-proposing writes nothing — it mints a new token with a new
// consume identity — which is why the button needs no authority and can never
// half-arm a schedule.
//
// THE FRESH PROPOSAL IS HELD LOCALLY, exactly as propose-purity requires: a
// proposal has no server record until Confirm, so the re-proposed card lives
// for this screen and this TTL. Reloading returns to the transcript's own ref,
// which reads `expired` — permanently and honestly — rather than blank.
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";

import type { TriggerScheduleProposalExpiredView } from "@cinatra-ai/agent-ui-protocol/renderable-views";

/** What the card says happened. Names no id, no org and no policy. */
const EXPIRED_LINE = "This proposal expired before it was confirmed.";

export function TriggerScheduleProposalExpired({
  view,
  cardRef,
  onReproposed,
}: {
  view: TriggerScheduleProposalExpiredView;
  /** The ref this card resolved under — the expired proposal itself. */
  cardRef: string;
  /** Hand the freshly minted proposal back so the card re-resolves under it. */
  onReproposed: (token: string) => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdjust = useCallback(async () => {
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
      onReproposed(result.token);
    } catch {
      // A transport failure is not a refusal: say the neutral thing and leave
      // the expired card exactly as it was, still pressable.
      setError("Couldn't propose that again just now. Try again.");
    } finally {
      setBusy(false);
    }
  }, [cardRef, onReproposed]);

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
          disabled={busy}
          data-lifecycle-action="adjust"
        >
          {busy ? "Proposing…" : "Adjust"}
        </Button>
      </div>
      {error === null ? null : (
        <div className="mt-2 text-destructive" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
