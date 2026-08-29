"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  HitlConversationPanel,
  type HitlConversationEntry,
} from "@cinatra-ai/agents/hitl-conversation-panel";
import { useRunWindowConversation } from "@cinatra-ai/agents/use-run-window-conversation";
import type { ReviewDisposition } from "@/lib/artifacts/artifact-review-decision";
import type { ReviewSubmitOutcome } from "@/lib/artifacts/review-surface-model";

export type SubmitReviewDecisionAction = (input: {
  disposition: ReviewDisposition;
  comment: string | null;
}) => Promise<ReviewSubmitOutcome>;

/**
 * The REAL conversational prompt window on the review surface (cinatra#2063):
 * the same live PromptField conversation the
 * pre-migration review HITL used (§X's reading for this surface: "Ask Cinatra
 * about this review…"), NOT the decision-bar rationale box. It mounts the shared
 * `HitlConversationPanel` (sticky, portalled into <main>) and files what is typed
 * through the Comment path (`submitReviewDecisionAction` with the `comment`
 * action).
 *
 * WHAT IS TYPED HERE IS A NOTE, AND ONLY A NOTE (cinatra#3080). Until this slice
 * a non-empty sentence on a single-target lifecycle gate was resolved as
 * `changes_requested` — the gate closed and a repair opened, from a window whose
 * whole promise is that it decides nothing. Asking for another go is
 * REGENERATE's, on the floor above, where it carries the right a terminal
 * decision needs and a note it refuses to be pressed without. So this window
 * annotates: the gate stays pending, the run stays parked, the frozen revision
 * is unchanged and no successor gate opens.
 *
 * It is not a fourth decision affordance either — the floor is Comment ·
 * Regenerate · Continue and this is the conversational reading of the first.
 */
export function ReviewPromptWindow({
  submitAction,
  storageKey,
  canComment,
  runId,
  boundCardRef,
}: {
  submitAction: SubmitReviewDecisionAction;
  storageKey: string;
  canComment: boolean;
  /** The run this review belongs to — the conversation is kept with it (cinatra#2933). */
  runId: string;
  /**
   * The gate's own server-minted reference, carried with the message as W5a's
   * CLAIM so the runtime can re-resolve it under this reader's access. The page
   * concludes nothing from it.
   */
  boundCardRef?: string | null;
}) {
  const router = useRouter();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  // cinatra#2933 (lifecycle-b W5b) — the exchange is the RUN's, stored server
  // side per turn and read on mount, so it is there after a reload.
  const runWindow = useRunWindowConversation({
    runId,
    surface: "review",
    ...(boundCardRef
      ? { boundCard: { candidateRefs: [boundCardRef], focusedRef: boundCardRef } }
      : {}),
  });
  // The PLATFORM's own line about what the filing did. It is not the
  // assistant's answer and is not stored with the conversation: #2934 moves the
  // filing itself onto the card's Comment control, where the outcome becomes
  // part of the answer. Until then it is shown after the stored exchange so the
  // reviewer still sees what happened to their request.
  const [outcomeLines, setOutcomeLines] = useState<HitlConversationEntry[]>([]);
  const [promptPending, setPromptPending] = useState(false);
  // Monotonic id source for conversation entries — a ref (not state) so two
  // appends in one handler can never collide on a stale counter (which would
  // mint duplicate React keys).
  const idRef = useRef(0);

  useEffect(() => {
    setPortalTarget(document.querySelector("main"));
  }, []);

  const appendOutcome = (content: string) => {
    // Offset well past the stored positions so a platform line can never take a
    // stored entry's React key.
    const id = 1_000_000 + ++idRef.current;
    setOutcomeLines((prev) => [...prev, { id, role: "assistant", content }]);
  };

  const handleSubmit = async (prompt: string) => {
    // THE ONE ROAD: what was typed goes to the run's conversation with the
    // assistant. The direct comment-submit below is today's behaviour, kept
    // until #2934 retires it together with the review page's typed road.
    void runWindow.send(prompt);
    setPromptPending(true);
    let refresh = false;
    try {
      const outcome = await submitAction({ disposition: "comment", comment: prompt });
      const { reply, refreshToLive } = describeOutcome(outcome);
      appendOutcome(reply);
      refresh = refreshToLive;
    } catch {
      appendOutcome("The change request could not be recorded — please try again.");
    } finally {
      setPromptPending(false);
    }
    // A COMMENT LEAVES THE GATE OPEN (cinatra#3080), so there is nothing to
    // refresh to: the surface the reviewer is looking at is still the live one.
    // Only an UNEXPECTED block (the gate moved under the reviewer, decided
    // elsewhere) refreshes to live.
    if (refresh) router.refresh();
  };

  return (
    // The conversational prompt window (cinatra#2063).
    // The anchor marks this mount for the run-embedded conformance closed set;
    // `handleSubmit` files the typed sentence through the Comment path, which
    // since cinatra#3080 records the note and changes nothing else. Asking for
    // another go is the floor's Regenerate.
    <div data-conformance-id="review-prompt-window" data-action="comment-review -> annotated">
      <HitlConversationPanel
        portalTarget={portalTarget}
        // WHICH READING OF THE ONE WINDOW THIS IS (design `458fb7ffce6c`,
        // `app-artifact-review.html` §X): the mount names its surface and the
        // window reads the drawing's own sentence for it.
        surface="review"
        visible={canComment && !!portalTarget}
        conversation={[...runWindow.entries, ...outcomeLines]}
        promptPending={promptPending || runWindow.pending}
        storageKey={storageKey}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

/** Map the review submit outcome to a conversational reply + whether the surface
 * should refresh to the live gate. A landed comment keeps the EXCHANGE visible
 * and the gate open (no refresh); only an unexpected block refreshes. The copy
 * mirrors the decision bar's own notices.
 *
 * The `changes-requested` arm stays because the OUTCOME type carries it — the
 * floor's Regenerate produces it — even though nothing typed in this window can
 * reach it any more. A window that could not read an outcome the surface can
 * produce would be a silent gap the day the two paths are wired together again. */
function describeOutcome(outcome: ReviewSubmitOutcome): { reply: string; refreshToLive: boolean } {
  switch (outcome.kind) {
    case "changes-requested":
      return outcome.status === "requested"
        ? {
            reply:
              "Changes requested. The reviewed work has been turned back for repair — a repair is now in flight.",
            refreshToLive: false,
          }
        : {
            reply:
              "Changes requested. The reviewed work has been turned back — escalated because no automatic repair is available; the effect stays held.",
            refreshToLive: false,
          };
    case "annotated":
      return {
        reply: "Comment recorded. The gate stays open — nothing has resumed.",
        refreshToLive: false,
      };
    case "decided":
      return {
        reply: "Recorded. The gate is resolved.",
        refreshToLive: false,
      };
    case "blocked":
      return {
        reply: "This review is no longer open — the gate was already decided or the run moved on.",
        refreshToLive: true,
      };
    case "not-permitted":
      return { reply: outcome.message, refreshToLive: false };
    case "error":
      return { reply: `${outcome.message} The request did not commit — you can retry.`, refreshToLive: false };
  }
}
