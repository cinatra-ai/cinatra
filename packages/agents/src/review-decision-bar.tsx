"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCheck, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SuggestionDecisionPartition } from "@/lib/artifacts/artifact-review-decision";
import {
  REVIEW_FLOOR_LABELS,
  reviewDecideDisabledReason,
  type ReviewDecisionPermissions,
  type ReviewFloorAction,
  type ReviewFloorSubmission,
  type ReviewSubmitOutcome,
} from "@/lib/artifacts/review-surface-model";

import { ReviewGateBlocked } from "./review-gate-states";
import { useComposerFocusStore, useInsideConversation, useLifecycleCardHost } from "./lifecycle-card-runtime";

export type SubmitReviewDecisionAction = (input: {
  /**
   * WHICH FLOOR ACTION WAS PRESSED (cinatra#3080) — the bar sends `comment`,
   * `regenerate` or `continue`. Typed as the whole submission word set, which
   * also carries the two words already-shipped callers speak (`approve`, the
   * alias of Continue, and `reject`, refused with its reason), so every host
   * that binds this action keeps compiling; the ONE entry on the server
   * resolves the word.
   */
  disposition: ReviewFloorSubmission;
  comment: string | null;
  /**
   * ON A REVIEW THAT OPENED WITH A RECORDED PROMPT, REGENERATE SENDS THE NOTE'S
   * WORDS AGAIN HERE (cinatra#3080 item 5, as §VI draws it) — the same trimmed
   * words as `comment`, filed by the change road as what the work is made from.
   * Omitted on every other press.
   */
  regeneratePrompt?: string | null;
  /**
   * The reviewer's per-item SUGGESTION marks (cinatra#2572, epic #2564 S6c),
   * riding the ONE terminal decision (S6b). Optional because most gates surface
   * no suggestions, and `null` and an absent key mean the same thing: no
   * partition, hence the pre-#2571 decision fingerprint, byte for byte.
   *
   * §VIII: "the chips carry no submit of their own". This field IS that rule —
   * a mark exists on the reviewer's screen and reaches the server only as part
   * of the decision the floor submits, never on its own.
   */
  suggestionDecisions?: SuggestionDecisionPartition | null;
}) => Promise<ReviewSubmitOutcome>;

/**
 * The host DECISION BAR (cinatra#1795 S12 item 4; spec design@0c484154b069c6369a33c1375056126289888997 §IV/§V,
 * redrawn by cinatra#3080): one bar at the foot of the gate governing EVERY
 * target under it. Exactly three affordances, and no fourth — Comment (ghost,
 * the note that decides nothing), Regenerate (the words go back to the step that
 * produced the work, which opens the review again on the next revision) and
 * Continue (primary, the run goes on with the frozen revision) — plus the ONE
 * note field they all write into. There is no Reject: a person who wants
 * neither outcome leaves the run as it is.
 *
 * The decision is display + DECIDE only (epic #1620 ADR): the client submits only
 * the disposition + rationale; the server re-validates the whole gate, resolves
 * it atomically, and derives provenance from the type. A gate that changed under
 * the reviewer does not slip through — the surface shows a BLOCKED state (§V),
 * never a silent commit. Submitting the same decision twice is safe (idempotent).
 *
 * Permission-gated (§V): Continue AND Regenerate need decision access — both
 * settle the gate — while Comment needs only respond access. A reviewer who may
 * see but not act gets the affordances DISABLED with a one-line reason, never a
 * live control that fails on click.
 *
 * Conformance anchors: `review-decision-bar`; the disabled sub-state is
 * `review-decision-disabled`; a post-submit block reuses `review-gate-blocked`.
 */
export function ReviewDecisionBar({
  permissions,
  submitAction,
  suggestionDecisionsFor,
  suggestionSummary,
  recordedPrompt = null,
  regenerateRefusal = null,
}: {
  permissions: ReviewDecisionPermissions;
  submitAction: SubmitReviewDecisionAction;
  /**
   * Authorized producer words from the finalized pinned revision. The note
   * field opens carrying them; Regenerate sends the field's words as the note
   * and, on a review that opened with them, as `regeneratePrompt` too.
   */
  recordedPrompt?: string | null;
  /**
   * The partition THIS decision would carry, asked PER DISPOSITION (cinatra#2572;
   * reworked by cinatra#2852). Owned by the CARD that draws the suggestions above
   * this bar — the bar does not know what a suggestion is; it carries what the
   * card answers into the one submit it already owns, which is precisely §VIII's
   * rule that the suggestions have no submit of their own.
   *
   * IT IS A QUESTION, NOT A VALUE, asked per floor action: only Continue decides
   * the items under the gate, so only Continue carries what is on screen
   * (cinatra#3080). Regenerate settles the gate as superseded and Comment
   * settles nothing; neither is asked.
   *
   * Absent on every surface that shows no suggestions, and the decision is then
   * byte-identical to what it was before this parameter existed.
   */
  suggestionDecisionsFor?: (action: ReviewFloorAction) => SuggestionDecisionPartition | null;
  /**
   * §VIII's floor line — what the decision below is about to carry. The ratified
   * drawing composes it INSIDE the decision floor, above the terminal row. It
   * replaces the shipped reject warning outright. Absent when the surface shows
   * no suggestions or the reader cannot decide.
   */
  suggestionSummary?: { accepted: number; total: number };
  /**
   * WHY REGENERATE CANNOT BE PRESSED ON THIS GATE, when it cannot (cinatra#3080
   * item 4) — the surface model's own sentence, carried verbatim. When set,
   * Regenerate is drawn disabled and the reason is drawn under the row; Comment
   * and Continue stay live. Absent on every ordinary review.
   */
  regenerateRefusal?: string | null;
}) {
  const router = useRouter();
  const insideConversation = useInsideConversation();
  const hasComposerBinding = useComposerFocusStore() !== null;
  const validatedHost = useLifecycleCardHost();
  const hasPrimaryChatInput = insideConversation || validatedHost === "site_widget" || hasComposerBinding;
  const [comment, setComment] = useState(recordedPrompt ?? "");
  const [noteEdited, setNoteEdited] = useState(false);
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<ReviewSubmitOutcome | null>(null);

  const disabledReason = reviewDecideDisabledReason(permissions);
  // The refusal is REGENERATE'S ALONE: it never disables Comment or Continue.
  const regenerateRefused = typeof regenerateRefusal === "string" && regenerateRefusal.length > 0;
  // Whether the review OPENED with recorded producer words in the note field.
  const openedWithPrompt = recordedPrompt !== null && recordedPrompt !== "";
  const decided = outcome?.kind === "decided";
  // A landed `changes-requested` (Regenerate) also RESOLVES the gate — as
  // superseded — so it settles the bar exactly like a Continue.
  const settled = decided || outcome?.kind === "changes-requested";

  function submit(action: ReviewFloorAction) {
    const words = comment.trim();
    setOutcome(null);
    startTransition(async () => {
      const result = await submitAction({
        disposition: action,
        // A producer prefill is not an annotation signed by the reader, so a
        // Comment or a Continue over an untouched field files no note. A
        // REGENERATE sends the field's words whoever wrote them — they are what
        // the producing step works from.
        comment:
          words === "" || (action !== "regenerate" && !noteEdited) ? null : words,
        // ON A REVIEW THAT OPENED WITH A RECORDED PROMPT, REGENERATE ALSO SENDS
        // THE WORDS AS THE PROMPT (§VI). Nothing else carries it.
        ...(action === "regenerate" && openedWithPrompt && words !== ""
          ? { regeneratePrompt: words }
          : {}),
        // CONTINUE ONLY, and OMITTED rather than nulled otherwise.
        //
        // A COMMENT does not resolve the gate and a REGENERATE settles it as
        // superseded rather than deciding the items under it, so neither can
        // carry the terminal per-item choices — the decision core refuses that
        // outright (#2047 row 8: a stream of comments each "accepting" items on a gate that never
        // resolves is the parallel approval pathway). Sending them anyway would
        // make Comment fail for any reviewer who had marked a chip. Nothing is
        // dropped by omitting them: a mark is LOCAL (§VIII), it stays on screen
        // and reversible after the comment lands, and it rides the terminal
        // decision when the reviewer takes one.
        //
        // The omission also keeps the pre-#2571 shape exactly: a surface with no
        // suggestions hands its action the byte-identical input it handed it
        // before this slice — the review page's server-action payload included —
        // so its decision fingerprint stays identity version 1.
        ...(() => {
          if (action !== "continue") return {};
          const suggestionDecisions = suggestionDecisionsFor?.(action) ?? null;
          return suggestionDecisions ? { suggestionDecisions } : {};
        })(),
      });
      setOutcome(result);
      // A landed Continue — or a Regenerate that resolved the gate into a
      // repair — resolves the gate; reflect the live (now blocked) state.
      if (result.kind === "decided" || result.kind === "changes-requested") router.refresh();
    });
  }

  // A gate that changed under the reviewer (§IV/V) — blocked, never a slip.
  if (outcome?.kind === "blocked") {
    return <ReviewGateBlocked reason={outcome.reason} />;
  }

  return (
    <div
      data-conformance-id="review-decision-bar"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      {suggestionSummary ? (
        <p
          data-conformance-id="suggestion-accepted-count"
          className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground"
        >
          {`${suggestionSummary.accepted} of ${suggestionSummary.total} ${
            suggestionSummary.total === 1 ? "suggestion" : "suggestions"
          } accepted — they ride this decision.`}
        </p>
      ) : null}
      {/* app-lifecycle-cards §I: a conversation's chat box is primary, so
          its card Note stays subordinate, including nested run cards.
          Without a chat box, the run/review page Note is the primary input
          and uses the boxed app-artifact-review §VI drawing. The host's
          validated conversation frame remains authoritative before the
          optional focus binding mounts, including nested run cards.
          Outside it, an actual composer binding also declares a chatbox;
          the reader's permission to submit never chooses input weight. */}
      <div data-conformance-id={hasPrimaryChatInput ? "review-note-field-subordinate" : undefined} className="px-4 pt-3">
        <label
          htmlFor="review-rationale"
          className="mb-1.5 block font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground"
        >
          Note{" "}
          <span className="normal-case tracking-normal">(optional on Continue · the words a Regenerate works from)</span>
        </label>
        <Textarea
          id="review-rationale"
          data-testid="review-rationale"
          value={comment}
          onChange={(e) => { setComment(e.target.value); setNoteEdited(true); }}
          disabled={pending || settled}
          placeholder="Add a note, or say what to change before Regenerate…"
          className={hasPrimaryChatInput
            ? "min-h-[44px] rounded-none border-0 border-b border-dashed border-line bg-transparent px-0 text-xs text-muted-foreground shadow-none focus-visible:ring-0 disabled:bg-transparent md:text-xs dark:bg-transparent dark:disabled:bg-transparent"
            : "min-h-[44px] rounded-[7px] border border-line bg-surface px-[11px] py-[9px] text-reading shadow-none md:text-reading dark:bg-surface"}
        />
      </div>

      {settled ? (
        outcome.kind === "decided" ? (
          <ReviewDecidedNotice outcome={outcome} />
        ) : (
          <ReviewChangesRequestedNotice outcome={outcome} />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 pb-3 pt-3">
            {/* COMMENT — the note that decides nothing, and the only one of the
                three that leaves the gate pending. The drawing's ghost: muted
                ink and no glyph. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              data-action="comment-review -> annotated"
              disabled={!permissions.canComment || pending}
              onClick={() => submit("comment")}
            >
              {REVIEW_FLOOR_LABELS.comment}
            </Button>
            <div className="flex items-center gap-2">
              {/* REGENERATE — the words go back to the step that produced the
                  work, which opens the review again on the next revision. It
                  settles this gate (as superseded), so it needs decision access.
                  Not destructive: nothing is thrown away. The drawing's
                  `btn outline` — a `--surface` fill inside the control stroke,
                  named for BOTH palettes because the shared outline variant
                  carries its own dark ground and stroke. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-input bg-surface text-foreground dark:border-input dark:bg-surface"
                data-action="regenerate-review -> successor-gate-opened"
                disabled={!permissions.canDecide || regenerateRefused || pending}
                aria-disabled={!permissions.canDecide || regenerateRefused}
                onClick={() => submit("regenerate")}
              >
                <RotateCcw aria-hidden="true" />
                {REVIEW_FLOOR_LABELS.regenerate}
              </Button>
              {/* CONTINUE — the run goes on with the frozen revision. Primary,
                  stroked in its own colour, the arrow AFTER the word. */}
              <Button
                type="button"
                variant="default"
                size="sm"
                className="border-primary"
                data-action="continue-review -> resolved"
                disabled={!permissions.canDecide || pending}
                aria-disabled={!permissions.canDecide}
                onClick={() => submit("continue")}
              >
                {REVIEW_FLOOR_LABELS.continue}
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </div>

          {/* ITEM 4 — WHY REGENERATE IS OUT, on screen rather than behind a
              press, under the row it is about and in the treatment the
              permission reason below uses. */}
          {regenerateRefused ? (
            <p
              data-conformance-id="review-regenerate-refused"
              data-testid="review-regenerate-refused"
              className="border-t border-line px-4 py-2.5 text-xs leading-relaxed text-muted-foreground"
            >
              {regenerateRefusal}
            </p>
          ) : null}

          {/* §V — disabled reason (a viewer who may see but not decide). */}
          {disabledReason ? (
            <p
              data-conformance-id="review-decision-disabled"
              className="border-t border-line px-4 py-2.5 text-xs leading-relaxed text-muted-foreground"
            >
              {disabledReason}
            </p>
          ) : null}

          {/* §IV — a non-terminal comment landed; the gate stays pending. */}
          {outcome?.kind === "annotated" ? (
            <p
              role="status"
              data-review-outcome="annotated"
              className="border-t border-line px-4 py-2.5 text-xs text-green"
            >
              Comment recorded. The gate stays open — nothing has resumed.
            </p>
          ) : null}
          {outcome?.kind === "not-permitted" ? (
            <p
              role="alert"
              data-review-outcome="not-permitted"
              className="border-t border-line px-4 py-2.5 text-xs text-destructive"
            >
              {outcome.message}
            </p>
          ) : null}
          {outcome?.kind === "error" ? (
            <p
              role="alert"
              data-review-outcome="error"
              className="border-t border-line px-4 py-2.5 text-xs text-destructive"
            >
              {outcome.message} The decision did not commit — you can retry.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The terminal-decision success notice (§IV) — the gate resolved and the run
 * has been released to continue. ONE reading for every decided outcome: the
 * stored disposition is still stamped on the element as a record, but Continue
 * is the only terminal decision the floor takes (cinatra#3080). */
function ReviewDecidedNotice({
  outcome,
}: {
  outcome: Extract<ReviewSubmitOutcome, { kind: "decided" }>;
}) {
  return (
    <p
      role="status"
      data-review-outcome="decided"
      data-review-disposition={outcome.disposition}
      className="flex items-center gap-2 border-t border-line px-4 py-3 text-xs text-foreground"
    >
      <CheckCheck aria-hidden="true" className="size-4 text-green" />
      Continued. The gate is resolved and the run has been released to continue.
      {outcome.idempotent ? " (This decision had already been recorded.)" : ""}
    </p>
  );
}

/** REGENERATE'S notice (cinatra#3080; the change road is cinatra#2063's): the
 * words went back to the producing step, the gate closed as `changes_requested`
 * and a repair opened. `requested` — a repair-capable producer's repair is in
 * flight; `escalated` — routed to a human / org route (or the cycle bound
 * tripped). Either way the gate is resolved and the held effect stays held until
 * the successor is Continued. NOT a fourth decision affordance. */
function ReviewChangesRequestedNotice({
  outcome,
}: {
  outcome: Extract<ReviewSubmitOutcome, { kind: "changes-requested" }>;
}) {
  return (
    <p
      role="status"
      data-review-outcome="changes-requested"
      data-changes-status={outcome.status}
      className="flex items-center gap-2 border-t border-line px-4 py-3 text-xs text-foreground"
    >
      <RotateCcw aria-hidden="true" className="size-4 text-mustard-ink" />
      {outcome.status === "requested"
        ? "Changes requested. The gate is resolved and the reviewed work has been turned back for repair — a repair is now in flight."
        : "Changes requested. The gate is resolved and the reviewed work has been turned back — escalated because no automatic repair is available; the effect stays held."}
      {outcome.idempotent ? " (This had already been recorded.)" : ""}
    </p>
  );
}
