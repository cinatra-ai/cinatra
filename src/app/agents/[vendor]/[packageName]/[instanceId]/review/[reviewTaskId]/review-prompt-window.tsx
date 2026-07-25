"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  HitlConversationPanel,
  type HitlConversationEntry,
} from "@cinatra-ai/agents/hitl-conversation-panel";
import type { ReviewDisposition } from "@/lib/artifacts/artifact-review-decision";
import type { ReviewSubmitOutcome } from "@/lib/artifacts/review-surface-model";

export type SubmitReviewDecisionAction = (input: {
  disposition: ReviewDisposition;
  comment: string | null;
}) => Promise<ReviewSubmitOutcome>;

/**
 * The REAL conversational prompt window on the review surface (owner ruling
 * 2026-07-25 (1), cinatra#2063): the changes-request channel is the same live
 * PromptField conversation the pre-migration review HITL used
 * ("Ask Cinatra to suggest edits to the fields above…"), NOT the decision-bar
 * rationale box. It mounts the shared `HitlConversationPanel` (sticky, portalled
 * into <main>) and routes a typed request through the EXISTING Comment path
 * (`submitReviewDecisionAction` with disposition "comment") — which, on a fenced
 * single-target lifecycle gate, the action resolves as `changes_requested` and a
 * repair. It is NOT a fourth decision affordance: the Approve/Reject/Comment floor
 * is untouched; this is where the human asks for changes, and the exchange (the
 * typed request + the resulting repair/annotation state) is shown as conversation
 * entries. When the request resolves the gate (changes-requested / blocked) the
 * page is refreshed to the now-resolved live gate.
 */
export function ReviewPromptWindow({
  submitAction,
  storageKey,
  canComment,
}: {
  submitAction: SubmitReviewDecisionAction;
  storageKey: string;
  canComment: boolean;
}) {
  const router = useRouter();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [conversation, setConversation] = useState<HitlConversationEntry[]>([]);
  const [promptPending, setPromptPending] = useState(false);
  // Monotonic id source for conversation entries — a ref (not state) so two
  // appends in one handler can never collide on a stale counter (which would
  // mint duplicate React keys).
  const idRef = useRef(0);

  useEffect(() => {
    setPortalTarget(document.querySelector("main"));
  }, []);

  const appendEntry = (role: "user" | "assistant", content: string) => {
    const id = ++idRef.current;
    setConversation((prev) => [...prev, { id, role, content }]);
  };

  const handleSubmit = async (prompt: string) => {
    appendEntry("user", prompt);
    setPromptPending(true);
    let refresh = false;
    try {
      const outcome = await submitAction({ disposition: "comment", comment: prompt });
      const { reply, refreshToLive } = describeOutcome(outcome);
      appendEntry("assistant", reply);
      refresh = refreshToLive;
    } catch {
      appendEntry(
        "assistant",
        "The change request could not be recorded — please try again.",
      );
    } finally {
      setPromptPending(false);
    }
    // A landed changes-request RESOLVES the base gate, but the EXCHANGE (the typed
    // request + the repair/lineage reply) must stay visible per the ruling — so we
    // do NOT blank the surface to the resolved/blocked state here. Only an
    // UNEXPECTED block (the gate moved under the reviewer) refreshes to live.
    if (refresh) router.refresh();
  };

  return (
    // The conversational prompt window (owner ruling 2026-07-25, cinatra#2063): the
    // typed change request IS how changes are requested — there is no dedicated
    // "request changes" button (the three-affordance decision floor is unchanged).
    // The anchor marks this mount for the run-embedded conformance closed set;
    // `handleSubmit` routes the typed feedback through the Comment path, which on a
    // fenced single-target lifecycle gate resolves as `changes_requested`.
    <div data-conformance-id="review-prompt-window" data-action="request-changes -> changes-requested">
      <HitlConversationPanel
        portalTarget={portalTarget}
        visible={canComment && !!portalTarget}
        conversation={conversation}
        promptPending={promptPending}
        storageKey={storageKey}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

/** Map the review submit outcome to a conversational reply + whether the surface
 * should refresh to the live gate. A landed changes-request keeps the EXCHANGE
 * visible (no refresh); only an unexpected block refreshes. The copy mirrors the
 * decision bar's changes-requested / annotated / blocked notices. */
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
