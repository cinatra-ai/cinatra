"use client";

import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { undoDeepLink } from "@/components/data-safety/undo-toast";
import { AppRouteLink } from "./app-route-link";
import {
  brokerRequestInit,
  useConversationCredential,
  type ConversationCredential,
} from "./conversation-credential";
import { recentUndoableChangeSetForRunAction } from "./undo-actions";

// Inline "Undo last action" chip under an agent_run card.
// Bounded polling: a mount check plus a few
// short retries within the undo window — NOT a live/tight loop. When a recent
// CLOSED restorable change-set produced by the run appears, render a link to
// the consolidated undo surface via `undoDeepLink` (carrying the change-set id
// in ?openRestore so THAT change-set's restore modal auto-opens),
// which runs the existing restore confirm + per-event authz on open/confirm.
const POLL_DELAYS_MS = [0, 3000, 6000]; // mount, +3s, +6s, then stop.

/** The widget's door onto the SAME §VI eligibility gate the action runs. */
const UNDO_CANDIDATE_ROUTE = "/api/chat/undo-candidate";

/**
 * Ask whether this run left a change-set THIS reader may still reverse, with
 * whichever credential the host declared.
 *
 * `refused` asks nothing: an unclear surface must not learn a change-set id,
 * which is an identifier for data it cannot prove it may see.
 */
async function fetchUndoCandidate(
  credential: ConversationCredential,
  runId: string,
): Promise<{ changeSetId: string } | null> {
  if (credential.kind === "refused") return null;
  if (credential.kind === "cookie") {
    return recentUndoableChangeSetForRunAction({ runId });
  }
  const res = await fetch(
    `${UNDO_CANDIDATE_ROUTE}?runId=${encodeURIComponent(runId)}`,
    brokerRequestInit(credential.auth),
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { changeSetId?: string | null };
  return body.changeSetId ? { changeSetId: body.changeSetId } : null;
}

export type UndoActionChipProps = { runId: string };

export function UndoActionChip({ runId }: UndoActionChipProps) {
  // THE CREDENTIAL THIS SURFACE ASKS WITH (cinatra#2683, epic #2564 S8f).
  //
  // The chip's read used to be a COOKIE-BOUND server action, so on the widget —
  // a frame same-origin to the app — it would have answered for whoever else is
  // signed in on that browser, and the answer is a change-set id: an identifier
  // for somebody else's data, rendered into a deep link inside a third-party
  // site's chrome. It now asks with the host's own credential, through the same
  // §VI eligibility gate, in ONE place. A host that cannot say who it is asks
  // nothing.
  const credential = useConversationCredential();

  // THE ANSWER IS STORED WITH THE RUN AND THE CREDENTIAL IT WAS RESOLVED FOR,
  // and read back only while both still hold (codex round 1, finding 3).
  //
  // A change-set id identifies somebody's data and is rendered into a deep link,
  // so a subtree that stops being able to prove who it is must stop showing one
  // — with no frame in between, which a passive reset effect cannot promise.
  const [resolved, setResolved] = useState<{
    runId: string;
    credential: ConversationCredential;
    changeSetId: string;
  } | null>(null);
  const changeSetId =
    resolved && resolved.runId === runId && resolved.credential === credential
      ? resolved.changeSetId
      : null;

  useEffect(() => {
    let cancelled = false;
    let found = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of POLL_DELAYS_MS) {
      timers.push(
        setTimeout(async () => {
          if (cancelled || found) return;
          try {
            const result = await fetchUndoCandidate(credential, runId);
            if (cancelled || !result) return;
            found = true;
            setResolved({ runId, credential, changeSetId: result.changeSetId });
          } catch {
            // Best-effort affordance — never throw into the chat render.
          }
        }, delay),
      );
    }
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [runId, credential]);

  // §VI: the chip renders ONLY when the actor is eligible (the read returns a
  // changeSetId only for an eligible actor); an ineligible actor renders
  // nothing — the `not-eligible` conformance state is the affordance's absence.
  if (!changeSetId) return null;

  return (
    <div
      className="mt-1"
      data-conformance-id="artifacts-undo-entry"
      data-state="eligible"
    >
      <Button asChild variant="outline" size="xs">
        {/* THE DESTINATION IS UNCHANGED AND THE TARGET ADAPTS (the column's
            shared link policy). Restoring happens on the first-party surface,
            under the reader's own session, through the per-event authorization
            it always ran — so inside the sandboxed widget frame, which cannot
            become an app page, the link opens that page in a new tab instead.
            No second undo path, and no reduction. */}
        <AppRouteLink href={undoDeepLink(changeSetId)}>
          <Undo2 data-icon="inline-start" />
          Undo last action
        </AppRouteLink>
      </Button>
    </div>
  );
}
