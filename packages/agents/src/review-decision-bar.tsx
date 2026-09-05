"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCheck, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SuggestionDecisionPartition } from "@/lib/artifacts/artifact-review-decision";
import {
  REVIEW_FLOOR_LABELS,
  type ReviewFloorAction,
  type ReviewFloorSubmission,
} from "@/lib/artifacts/review-surface-model";
import {
  reviewDecideDisabledReason,
  type ReviewDecisionPermissions,
  type ReviewSubmitOutcome,
} from "@/lib/artifacts/review-surface-model";

import { ReviewGateBlocked } from "./review-gate-states";

export type SubmitReviewDecisionAction = (input: {
  /**
   * WHICH FLOOR ACTION WAS PRESSED (cinatra#3080) — `comment`, `regenerate` or
   * `continue`. The field keeps its name because every host binds this same
   * action; what changed is the vocabulary, which the ONE entry on the server
   * resolves (Continue → the stored `approve`, unchanged; `reject` refused).
   */
  disposition: ReviewFloorSubmission;
  comment: string | null;
  /**
   * FOR A PICTURE, THE EDITED PROMPT (item 5) — its own value beside the note,
   * carried only by Regenerate and never folded into the comment.
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
 * The host DECISION BAR (cinatra#1795 S12 item 4, spec §IV/§V, redrawn by
 * cinatra#3080 against the ratified review and cards drawings at the revision
 * the conformance suite pins):
 * one bar at the foot of the gate governing EVERY target under it. Exactly three
 * affordances, and no fourth — Comment (ghost, the note that decides nothing),
 * Regenerate (the words go back to the step that produced the work, which then
 * opens the review again on the next revision), Continue (primary, the run goes
 * on with the frozen revision) — plus the note field they all write into, and,
 * for a picture, the prompt as its own pre-filled field beside it.
 *
 * THERE IS NO REJECT. A person who wants neither outcome leaves the run as it
 * is, so the affordance is gone rather than disabled — and gone at the decision
 * operation too, not only here, so nothing that can post a decision can produce
 * one. Approve is Continue now: the same transition, the same stored `approve`
 * disposition, no migration; a settled gate decided before the relabel reads as
 * Continued.
 *
 * REGENERATE LIVES ONLY HERE. No artifact renderer carries one — not the
 * artifact page, not a display inside a card, not the display island inside a
 * third-party application. A picture's prompt is edited on this floor, where
 * Regenerate is.
 *
 * The decision is display + DECIDE only (epic #1620 ADR): the client submits only
 * the disposition + rationale; the server re-validates the whole gate, resolves
 * it atomically, and derives provenance from the type. A gate that changed under
 * the reviewer does not slip through — the surface shows a BLOCKED state (§V),
 * never a silent commit. Submitting the same decision twice is safe (idempotent).
 *
 * Permission-gated (§V): Continue AND Regenerate need approve access — both
 * settle the gate, Regenerate as superseded — while Comment needs only respond
 * access. A reviewer who may see but not act gets the affordances DISABLED with
 * a one-line reason, never a live control that fails on click.
 *
 * Conformance anchors: `review-decision-bar`; the disabled sub-state is
 * `review-decision-disabled`; a post-submit block reuses `review-gate-blocked`.
 */
export function ReviewDecisionBar({
  permissions,
  submitAction,
  suggestionDecisionsFor,
  suggestionSummary,
  picturePrompt,
}: {
  permissions: ReviewDecisionPermissions;
  submitAction: SubmitReviewDecisionAction;
  /**
   * THE PICTURE'S PROMPT, PRE-FILLED (cinatra#3080 item 5) — the prompt recorded
   * on the reviewed revision's ledger row, resolved by the SURFACE and handed
   * down. Absent for everything that is not a picture, and the bar is then
   * byte-identical to one that never had the field.
   *
   * IT IS EDITABLE AND IT IS NOT THE NOTE. The note says what to change; the
   * prompt says what to make. Regenerate carries both, separately, so the
   * producing step never has to take one sentence apart again. The DISPLAY is
   * never handed either.
   */
  picturePrompt?: string | null;
  /**
   * The partition THIS decision would carry, asked PER DISPOSITION (cinatra#2572;
   * reworked by cinatra#2852). Owned by the CARD that draws the suggestions above
   * this bar — the bar does not know what a suggestion is; it carries what the
   * card answers into the one submit it already owns, which is precisely §VIII's
   * rule that the suggestions have no submit of their own.
   *
   * IT IS A QUESTION, NOT A VALUE, because an approve and a reject do not carry
   * the same thing: with §VIII's accepted-by-default row, an approve carries what
   * is on screen and a reject records every surfaced suggestion as NOT TAKEN. A
   * bar handed one fixed partition would have to either refuse the reject or send
   * accepts into a decision that tombstones the revisions they would apply to.
   *
   * Absent on every surface that shows no suggestions, and the decision is then
   * byte-identical to what it was before this parameter existed.
   */
  suggestionDecisionsFor?: (action: ReviewFloorAction) => SuggestionDecisionPartition | null;
  /**
   * §VIII's floor line — what the decision below is about to carry. The ratified
   * drawing composes it INSIDE the decision floor, above the terminal row. It
   * replaces the shipped reject warning outright: a reject is no longer refused,
   * it records the surfaced suggestions as not taken. Absent when the surface
   * shows no suggestions or the reader cannot decide.
   */
  suggestionSummary?: { accepted: number; total: number };
}) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  // The prompt is SEEDED from the ledger row and then owned by the reviewer. A
  // `useState` initializer (not a controlled prop) is what makes it editable
  // without the surface having to hold the draft.
  const [prompt, setPrompt] = useState(picturePrompt ?? "");
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<ReviewSubmitOutcome | null>(null);

  const disabledReason = reviewDecideDisabledReason(permissions);
  const decided = outcome?.kind === "decided";
  // A landed `changes-requested` (Regenerate) also RESOLVES the gate — as
  // superseded — so it settles the bar exactly like a Continue.
  const settled = decided || outcome?.kind === "changes-requested";

  function submit(action: ReviewFloorAction) {
    setOutcome(null);
    startTransition(async () => {
      const result = await submitAction({
        disposition: action,
        comment: comment.trim() === "" ? null : comment.trim(),
        // THE PROMPT RIDES REGENERATE AND NOTHING ELSE. A Comment decides
        // nothing and a Continue goes on with the frozen revision, so neither
        // has anywhere to put a re-ask; sending it anyway would put an edited
        // prompt into a decision that never reaches a producing step.
        ...(action === "regenerate" && prompt.trim() !== ""
          ? { regeneratePrompt: prompt.trim() }
          : {}),
        // CONTINUE ONLY, and OMITTED rather than nulled otherwise.
        //
        // A COMMENT does not resolve the gate and a REGENERATE settles it as
        // superseded rather than deciding the items under it, so neither can
        // carry the terminal per-item choices — the decision core refuses that outright (#2047 row
        // 8: a stream of comments each "accepting" items on a gate that never
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
      {/* The note (§IV) — optional on Continue, the words a Regenerate works
          from, the
          substance of a comment. Travels into the audit trail + the resume note.

          §I INPUT HIERARCHY — SUBORDINATE (design specs/app-lifecycle-cards.html
          §I, the `.notefield` / `.nf-input` rules). A conversation carrying this
          card has two places a reader could type — this note field and the
          conversation's chat box — and drawn at the same weight they read as a
          choice. They are not a choice: the chat box is the ONE primary input.
          So the note field gives up the three things that make an input read as
          somewhere to type — the enclosing box, the raised ground and the send
          affordance — and keeps a single quiet dashed baseline under its mono
          label. Nothing is hidden and nothing is disabled; only the weight
          moves, and the label and placeholder are unchanged.

          DISABLED / SETTLED. A disabled or settled note field keeps the SAME
          dashed rule and takes the platform's standard disabled opacity. It
          never falls back to the stock filled, boxed disabled treatment, which
          would put back the box the hierarchy just took out. */}
      <div data-conformance-id="review-note-field-subordinate" className="px-4 pt-3">
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
          onChange={(e) => setComment(e.target.value)}
          disabled={pending || settled}
          placeholder="Add a note, or say what to change before Regenerate…"
          className="min-h-[44px] rounded-none border-0 border-b border-dashed border-line bg-transparent px-0 text-xs text-muted-foreground shadow-none focus-visible:ring-0 disabled:bg-transparent md:text-xs dark:bg-transparent dark:disabled:bg-transparent"
        />
      </div>

      {/* THE PICTURE'S PROMPT (cinatra#3080 item 5) — its OWN field, beside the
          note, pre-filled with the prompt on the reviewed revision's ledger row.
          Two fields because they answer two questions: the note says what to
          change about this go, the prompt says what to make. Regenerate carries
          them as separate values so the producing step is never handed one
          sentence to take apart.

          It takes the SAME subordinate treatment as the note (§I): one quiet
          dashed baseline under a mono label, no box, no raised ground, no send
          affordance — a second primary-looking input beside the first would put
          back exactly the choice the hierarchy removes.

          DRAWN ONLY WHERE THERE IS A PROMPT. A revision that is not a picture,
          or one whose ledger row records none, draws the note alone. */}
      {picturePrompt ? (
        <div data-conformance-id="review-regenerate-prompt-field" className="px-4 pt-3">
          <label
            htmlFor="review-regenerate-prompt"
            className="mb-1.5 block font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground"
          >
            Picture prompt{" "}
            <span className="normal-case tracking-normal">(sent with Regenerate)</span>
          </label>
          <Textarea
            id="review-regenerate-prompt"
            data-testid="review-regenerate-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={pending || settled || !permissions.canDecide}
            placeholder="What the picture should show…"
            className="min-h-[44px] rounded-none border-0 border-b border-dashed border-line bg-transparent px-0 text-xs text-muted-foreground shadow-none focus-visible:ring-0 disabled:bg-transparent md:text-xs dark:bg-transparent dark:disabled:bg-transparent"
          />
        </div>
      ) : null}

      {settled ? (
        outcome.kind === "decided" ? (
          <ReviewDecidedNotice outcome={outcome} />
        ) : (
          <ReviewChangesRequestedNotice outcome={outcome} />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 pb-3 pt-3">
            {/* COMMENT — the note that decides nothing. Ghost, on the reader's
                own respond access, and the only one of the three that leaves the
                gate pending.

                ITS TREATMENT, OFF THE DRAWING (cinatra#3080, fix leg 8). The
                ratified markup for this control is one line:
                `<button class="btn ghost" style="…color:var(--muted);">Comment</button>`
                — the ghost ground, the MUTED ink, and NO GLYPH. The shipped
                control drew a speech bubble in front of the word and took the
                ghost variant's inherited ink, which read as a third weight
                beside Regenerate rather than as the quietest of the three. The
                glyph is gone and the ink is the drawing's own token. */}
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
                  SETTLES this gate (as superseded), so it carries the terminal
                  right and the secondary weight of an act that is not the
                  expected end of the review. It is NOT destructive: nothing is
                  turned back or thrown away, and drawing it in the retired
                  Reject's colour would say otherwise. */}
              {/* ITS GROUND IS OUTLINED, NOT FILLED (cinatra#3080, fix leg 8).
                  The drawing gives this control `class="btn outline"`, and the
                  page's own rule for that class is
                  `background: var(--surface); color: var(--ink);
                   border-color: var(--line-strong)` — a page-surface fill inside
                  a strong stroke. The shipped control took `.btn.secondary`'s
                  shape instead (`background: var(--surface-muted);
                  border-color: transparent`), a FILLED muted plate, which is
                  what the ninth round's pixels caught. The stock outline variant
                  strokes `--border` (= `--line`) on `--background`, so the two
                  tokens the drawing actually names are asked for by name. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                // AND IN BOTH PALETTES. The shared outline variant carries
                // its own DARK ground and stroke (`dark:border-input`,
                // `dark:bg-input-fill/30`), which would take this control
                // off the drawing's tokens in the dark reading only. The
                // drawing names one pair for both — `.btn.outline` is
                // `var(--surface)` inside `var(--line-strong)`, and those two
                // tokens are themselves redefined per palette — so the same
                // two are asked for in the dark reading as well.
                className="border-line-strong bg-surface text-foreground dark:border-line-strong dark:bg-surface"
                data-action="regenerate-review -> changes-requested"
                disabled={!permissions.canDecide || pending}
                aria-disabled={!permissions.canDecide}
                onClick={() => submit("regenerate")}
              >
                <RotateCcw aria-hidden="true" />
                {REVIEW_FLOOR_LABELS.regenerate}
              </Button>
              {/* CONTINUE — the run goes on with the frozen revision. The former
                  Approve, primary as it always was, storing the same
                  disposition. */}
              <Button
                type="button"
                variant="default"
                size="sm"
                // AND ITS STROKE IS THE BLUE (cinatra#3080, fix leg 8). The
                // drawing's `.btn.primary` is `background: var(--blue); color:
                // var(--surface-strong); BORDER-COLOR: var(--blue)` — one
                // colour, edge to edge. The shared default variant strokes
                // `--line-strong` (the product's ordinary primary edge), which
                // draws a dark rule around the indigo plate. Asked for here,
                // on this one control, rather than by moving every primary
                // button in the product.
                className="border-primary"
                data-action="continue-review -> resolved"
                disabled={!permissions.canDecide || pending}
                aria-disabled={!permissions.canDecide}
                onClick={() => submit("continue")}
              >
                {/* THE ARROW FOLLOWS THE WORD (cinatra#3080, fix leg 8). The
                    drawing sets it after the label —
                    `<button class="btn primary">Continue<svg …/></button>` —
                    which is what an arrow means here: the run goes ON from this
                    word. The shipped control led with it. */}
                {REVIEW_FLOOR_LABELS.continue}
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </div>

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

/**
 * The terminal-decision success notice (§IV) — the gate resolved and the run has
 * been released to continue.
 *
 * ONE READING, because there is one terminal decision left. `disposition` is
 * still the STORED value (`approve`, unmigrated) and is still stamped on the
 * element, so a settled gate decided before the relabel reads identically to one
 * decided after it — the word on screen changed, the row did not. A stored
 * `reject` cannot appear here: the operation refuses to produce one, and a gate
 * decided as a reject before the retirement is read by the SETTLED card, which
 * has its own copy for it.
 */
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

/** REGENERATE'S notice (cinatra#3080; the change road is cinatra#2063's). The
 * words went back to the producing step: this gate settled as superseded and the
 * review reopens on the next revision. `requested` — a repair-capable producer is
 * making it now; `escalated` — routed to a person (no automatic repair, or the
 * cycle bound tripped). Either way the gate is resolved and the held effect stays
 * held until the successor is Continued. It is the third of three floor actions,
 * not a fourth affordance. */
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
        ? "Sent back to be made again. This review is closed and reopens on the next revision — the step that produced the work is on it now."
        : "Sent back to be made again. This review is closed; nothing can make it automatically, so a person has been asked to pick it up and the effect stays held."}
      {outcome.idempotent ? " (This had already been recorded.)" : ""}
    </p>
  );
}
