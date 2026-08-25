"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { HitlConversationPanel } from "@cinatra-ai/agents/hitl-conversation-panel";
import { useRunWindowConversation } from "@cinatra-ai/agents/use-run-window-conversation";

/**
 * The review page's prompt window, ON THE ONE ROAD (cinatra#2934, lifecycle-b W5c).
 *
 * From the plan (PLAN: Agents Lifecycle (B), §4):
 *
 *   "On the review page, what you type goes to the assistant — and only a
 *    request for changes requests changes. Today the box under a review is not a
 *    conversation. Whatever you type there is filed at once, with no model
 *    reading it, as a request for changes: the review closes and the work goes
 *    back for repair — a question is treated exactly like an instruction …
 *    Afterwards what you type goes to the assistant, like everywhere else. When
 *    you ask for a change — 'tighten the opening paragraph' — the assistant
 *    files it through the card's own Comment control, word for word, exactly as
 *    pressing Comment with that text does today, and the work goes back for
 *    repair. When you ask a question, you get an answer and nothing is filed.
 *    The card's own buttons — Approve, Reject, Comment — keep working as they do
 *    today, with no assistant in the way."
 *
 * WHAT WENT, AND WHAT REPLACED IT. The direct filing this component used to do
 * on every send — the typed sentence handed straight to the review's decision
 * action, before any model saw it — is GONE. The filing now happens through
 * the card's OWN Comment control, operated by the conversation's assistant under
 * the person's own credential, with the person's own words read out of the
 * server-held grant (`src/lib/lifecycle/lent-action-mcp.ts`). So a question is
 * answered and files nothing, and a request for changes lands word for word.
 *
 * AND THE CARD IS THE VISIBLE TRUTH. When the turn actually pressed the control,
 * the page re-reads its state from the server and settles — "the assistant's line
 * reports what came back and adds nothing", so the reply is the assistant's and
 * this component composes no outcome sentence of its own any more.
 *
 * The decision bar is untouched: this is not a fourth affordance.
 *
 * IT IS STILL THE SAME MOUNT. The window is the shared `HitlConversationPanel`,
 * sticky and portalled into `<main>`, and it names its own surface so the empty
 * field reads §X's sentence for a review — neither of those moves here.
 */
export function ReviewPromptWindow({
  storageKey,
  canComment,
  runId,
  boundCardRef,
}: {
  /** PromptField persistence, so a half-typed request survives a reload. */
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

  useEffect(() => {
    setPortalTarget(document.querySelector("main"));
  }, []);

  const handleSubmit = async (prompt: string) => {
    const effect = await runWindow.send(prompt);
    // THE CARD RE-READS ITSELF. A turn that pressed Comment resolved the gate and
    // sent the work back for repair, so the surface must show the state the
    // server now holds. A turn that only answered moves nothing.
    if (effect.acted) router.refresh();
  };

  return (
    // The conversational prompt window (owner ruling 2026-07-25, cinatra#2063): the
    // typed change request IS how changes are requested — there is no dedicated
    // "request changes" button (the three-affordance decision floor is unchanged).
    // The anchor marks this mount for the run-embedded conformance closed set.
    <div data-conformance-id="review-prompt-window" data-action="request-changes -> changes-requested">
      <HitlConversationPanel
        portalTarget={portalTarget}
        // WHICH READING OF THE ONE WINDOW THIS IS (design `458fb7ffce6c`,
        // `app-artifact-review.html` §X): the mount names its surface and the
        // window reads the drawing's own sentence for it.
        surface="review"
        visible={canComment && !!portalTarget}
        conversation={runWindow.entries}
        promptPending={runWindow.pending}
        storageKey={storageKey}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
