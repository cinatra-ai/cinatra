// ---------------------------------------------------------------------------
// THE ANSWERED INPUT STEP, READ BACK (cinatra#3068, fix leg 2).
//
// The ratified drawing, in the section that draws the run surface: "A resolved
// gate opens read-only: what was decided, and the one target it froze, kept for
// the run's audit trail." Its own worked example of the same idea is the Skills
// step, which "opened once the run has started" carries "the same pills
// read-only, with no Continue".
//
// WHY A READING OF ITS OWN, and not the run detail the other input rows fall
// back to. Every input step falls back to the ONE run detail, and that detail
// holds the form the run is asking RIGHT NOW. A settled "Idea" row that fell
// back would select Idea and display the live "Audience" question, which breaks
// the rail's one contract: the selected step shows THAT step's screen. So the
// settled step gets a screen, and the first leg's answer -- close the row --
// is replaced by the drawing's answer: open it read-only.
//
// IT IS NOT THE CARD, DELIBERATELY. `agent_hitl_screen` settles to an ABSENCE
// (`settledIsAbsence`, scripts/ci/lib/capture-record-contract.mjs): a question
// that has been answered is not a question the surface should keep asking, so
// this reading carries NEITHER the card root `[data-lifecycle-card=…]` NOR the
// decision region `[data-conformance-id="hitl-screen-fields"]`. It is a
// history reading with its own anchor, and it draws nothing to press.
//
// NO DIRECTIVE, deliberately: `instance-screens.tsx` is a server component and
// composes this, and there is nothing here that needs the client.
// ---------------------------------------------------------------------------

import type { RunInputStepAnswer } from "./run-input-steps";

/**
 * One answered input form, drawn read-only.
 *
 * `label` is the form's own declared title -- the same word the rail row
 * carries, so the step and its screen name the same thing.
 */
export function RunInputStepAnsweredReading({
  label,
  answers,
}: {
  label: string;
  answers: readonly RunInputStepAnswer[];
}) {
  // THE FIELD'S LABEL IS GIVEN ONCE (cinatra#3068 fix leg 3). A form that asks
  // ONE field is named by that field, so the step's own heading and the field's
  // own label are the same word -- and the card drew it twice, heading and
  // label, over a single value. The drawing gives the label once.
  //
  // A DEFINITION LIST NEEDS A TERM. Where every label restates the heading there
  // is no term left to define, so the values are drawn as values under the
  // heading that already names them; where a label says something the heading
  // does not -- a grouped form, or a field with no declared title of its own --
  // the pairs are drawn exactly as before. Each value keeps its own per-field
  // anchor in both readings, so one conformance walk reads either the same way.
  const labelsRestateHeading =
    answers.length > 0 && answers.every((answer) => answer.label === label);
  return (
    <section
      className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4"
      data-conformance-id="run-input-step-answered"
      data-run-input-step-reading="answered"
    >
      <h2 className="text-sm font-semibold text-foreground">{label}</h2>
      {labelsRestateHeading ? (
        <div className="flex flex-col gap-3">
          {answers.map((answer) => (
            <p
              key={answer.field}
              className="text-sm text-foreground whitespace-pre-wrap break-words"
              data-run-input-answer={answer.field}
            >
              {answer.value}
            </p>
          ))}
        </div>
      ) : (
        <dl className="flex flex-col gap-3">
          {answers.map((answer) => (
            <div
              key={answer.field}
              className="flex flex-col gap-1"
              data-run-input-answer={answer.field}
            >
              <dt className="text-xs font-medium text-muted-foreground">
                {answer.label}
              </dt>
              <dd className="text-sm text-foreground whitespace-pre-wrap break-words">
                {answer.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
