// ---------------------------------------------------------------------------
// THE FILL ROAD (cinatra#2934, lifecycle-b W5c).
//
// From the plan (PLAN: Agents Lifecycle (B), §4):
//
//   "Filling a form without submitting it is kept by name. Today, on the run and
//    schedule screens, you can describe what you want, watch the values appear
//    in the fields in front of you, and press the button yourself. That is a
//    real capability and it survives: the assistant fills the fields with what
//    you asked for — it is what you want, not a suggestion. It needs a mechanism
//    of its own, because the fields live in the page in front of you while the
//    assistant works on the server: the assistant returns the filled values, the
//    screen writes them into its own fields, and nothing is submitted until you
//    press the button."
//
// AND: "the fill-without-submit side does not [have a door], which is why the
// fill mechanism above is defined as its own road."
//
// SO IT IS ITS OWN ROAD, AND THAT IS THE WHOLE DESIGN. A fill PRESSES NOTHING.
// It does not touch the gate, does not resume the run, does not write a form
// value anywhere the run reads. It records, beside the run's own conversation,
// the values the assistant placed in the screen the person is looking at — and
// the screen writes them into its fields. That is why it is NOT gated by the
// single-use lent-action grant the way a press is: consuming a grant to fill
// would make "fill, then submit when asked" impossible in one message, which is
// exactly what the plan asks for. What it IS gated by is stated below.
//
// FIVE GATES, IN THIS ORDER, EVERY ONE FAIL-CLOSED:
//
//   1. THE MESSAGE WAS SENT WITH THIS SCREEN BOUND. The turn's grant is read off
//      the request frame and matched to the person, the organization and the
//      CARD — but never spent and never matched on its control. A turn that
//      carries no grant fills nothing, so a model reached by text out of the
//      run's own content cannot place values in a screen nobody bound.
//   2. THE PERSON'S OWN CREDENTIAL, resolved live from the store — never the
//      delegated chat token, exactly as the lent action resolves it.
//   3. THE CARD IS STILL THERE AND IS A SCREEN THAT LENDS `fill`, AND THIS
//      PERSON MAY OPERATE THAT RUN. Through the read-only, actor-checked
//      bound-reference resolver, under that credential — and then the RUN's own
//      `respondToHitl`, because the resolver authorizes a screen on run READ and
//      reading a screen is not permission to place values on it (convergence
//      round 1, finding 3). A review lends no fill; an absent card lends nothing.
//   4. ONLY THE CONTROLS THE SCREEN DRAWS. The drawn set is the closed set;
//      a key the form does not declare is dropped rather than stored, so a model
//      cannot invent a field, and the run's own reserved keys are never writable
//      from here.
//   5. IT IS RECORDED, NOT APPLIED. One append-only row on the run's window
//      conversation. Nothing in this module writes to the gate.
// ---------------------------------------------------------------------------

import "server-only";

import {
  appendRunWindowMessage,
  readRunWindowMessages,
  type RunWindowFill,
  type RunWindowSurface,
} from "@cinatra-ai/agents/run-window-conversation-store";
import {
  controlsLentBy,
  resolveBoundReference,
  type BoundReferenceResolution,
} from "@/lib/lifecycle/bound-reference-resolver";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import { canActorRespondToRun } from "@/lib/lifecycle/run-window-turn";
import {
  classifyDrawnFillValues,
  drawnScreenControls,
} from "@/lib/lifecycle/bound-screen-controls";

// THE PURE CLOSED SET LIVES NEXT DOOR (cinatra#2934, repaired after the picture
// leg). `bound-screen-controls.ts` holds the reserved keys, the bounds, the
// no-op rule and — new — the DRAWN-control projection, with no imports at all,
// because the turn that names a screen's rows to the assistant reads the same
// rule and must not pull this module's store graph in for it. Re-exported here
// so every existing reader of this module is unchanged.
export {
  classifyDrawnFillValues,
  describeDrawnRows,
  nowForDrawnForm,
  FILL_MAX_FIELDS,
  FILL_MAX_SERIALIZED_CHARS,
  FILL_RESERVED_KEYS,
  drawnScreenControls,
  drawnScreenForm,
  fillableFieldNames,
  selectDrawnFillValues,
  selectFillableValues,
  type BoundScreenForm,
} from "@/lib/lifecycle/bound-screen-controls";

export type BoundScreenFillOutcome =
  | { readonly kind: "filled"; readonly ref: string; readonly applied: readonly string[] }
  /** The card is not this person's, is not a screen, or lends no fill. */
  | { readonly kind: "unavailable" }
  /** The card is a screen, but nothing asked for is a field it declares. */
  | { readonly kind: "no-fields"; readonly fields: readonly string[] }
  /**
   * THE ROWS ALREADY SHOW WHAT WAS ASKED FOR (cinatra#2934, the fourth graded
   * capture). NOT a refusal, and not the sentence above: the screen draws those
   * controls, the person may fill them, and what they asked for is what the
   * fields are holding. Nothing is recorded — a placement that alters nothing a
   * person can see must not unlock a press — and the answer says so truthfully
   * rather than telling them the fields do not exist.
   */
  | { readonly kind: "already-holding"; readonly fields: readonly string[] }
  /**
   * A DRAWN ROW COULD NOT HOLD THE VALUE THE ASK GAVE IT (cinatra#2934, the
   * fourth graded capture). A UTC instant handed to a local date-time box is
   * the shipping example: reading it as a local one would move the run, so it
   * is refused — and the refusal names the ROW that refused it. The fourth
   * capture photographed this case answered with the fields-do-not-exist
   * sentence, on a screen whose Run at row is exactly the field named.
   */
  | { readonly kind: "unusable-values"; readonly rows: readonly string[]; readonly fields: readonly string[] }
  /**
   * THE ASK WAS TOO BIG TO PLACE (cinatra#2934, convergence round of the fourth
   * fix leg). The keys name real controls and the rows could hold them; the
   * serialized bound — which exists because a placement is stored and travels
   * back to a browser — refused the whole ask. It is the FOURTH of the four
   * situations the split exists for, and until this round it fell through to
   * the fields-do-not-exist sentence, which is exactly the false reason the
   * capture caught.
   */
  | { readonly kind: "too-large"; readonly fields: readonly string[] }
  /**
   * The form is there and is this person's, and it can no longer be changed
   * (cinatra#2934, the armed-trigger tab). NOT the uniform absence: every gate
   * above it passed, so the reader is looking at this very form and is owed the
   * state in words rather than a sentence that says nothing. The words are the
   * server's own — `SAVE_SCHEDULE_REFUSALS`, the table the card itself refuses
   * from — so the window and the card say one thing.
   */
  | { readonly kind: "not-editable"; readonly message: string };

/**
 * Which surface a fill row is filed under.
 *
 * The fill belongs to the RUN — every window on that run reads the whole
 * exchange back — so the surface is a LABEL for reading it beside the run, not a
 * routing decision. It is taken from the newest window row on the run so the
 * fill sits with the conversation it came out of, and falls back to the run page
 * when the fill is the run's first window row (a message typed in the chat, for
 * instance, where the window itself is the chat).
 *
 * THE SAME READ ANSWERS WHAT THIS MESSAGE HAS ALREADY PLACED (convergence round
 * 3). A turn may fill twice, and the second fill has to be computed against the
 * fields as they stand AFTER the first — otherwise an object-valued control
 * filled twice loses whatever the first fill put in it, on the screen and in
 * what the press sends. One read, both answers.
 */
async function readRunWindowState(
  runId: string,
  ref: string,
  messageId: string,
): Promise<{ surface: RunWindowSurface; placedThisMessage: Record<string, unknown> }> {
  try {
    const rows = await readRunWindowMessages(runId);
    const placedThisMessage: Record<string, unknown> = {};
    for (const row of rows) {
      if (row.messageId !== messageId) continue;
      if (!row.fill || row.fill.ref !== ref) continue;
      Object.assign(placedThisMessage, row.fill.values);
    }
    return {
      surface: rows[rows.length - 1]?.surface ?? "run-page",
      placedThisMessage,
    };
  } catch {
    return { surface: "run-page", placedThisMessage: {} };
  }
}

/**
 * Record ONE fill for the screen a message was bound to.
 *
 * Gates 3, 4 and 5 of the header live here; gates 1 and 2 belong to the caller
 * that holds the request frame (`bound-screen-fill-mcp.ts`), because they are
 * about the CALL and this is about the CARD.
 */
export async function recordBoundScreenFill(input: {
  readonly ref: string;
  readonly values: Record<string, unknown>;
  readonly actorCtx: ReviewActorContext;
  /** The turn this fill belongs to — the grant's own message identity. */
  readonly messageId: string;
  readonly deps?: {
    readonly resolve?: typeof resolveBoundReference;
    readonly append?: typeof appendRunWindowMessage;
    readonly canRespond?: typeof canActorRespondToRun;
    readonly surface?: RunWindowSurface;
  };
  /**
   * Claim the turn's grant, ATOMICALLY and WITHOUT spending it, immediately
   * before the row is written (convergence round 2, finding 6). It is the LAST
   * thing asked, so the gap between "the grant is still unspent" and "the values
   * are recorded" is one statement rather than the whole handler.
   */
  readonly claimGrant?: () => Promise<boolean>;
}): Promise<BoundScreenFillOutcome> {
  const resolve = input.deps?.resolve ?? resolveBoundReference;
  const bound: BoundReferenceResolution = await resolve({
    ref: input.ref,
    actorCtx: input.actorCtx,
  });
  // THE TWO SCREENS A FILL MAY REACH: the screen an agent is waiting on, and
  // the SCHEDULER FORM the schedule surface sits under (cinatra#2934, repaired
  // after the picture leg). Both answer the same question below — does this card
  // lend `fill` — and a review, an absence and anything else lend nothing.
  if (
    bound.kind !== "hitl_screen" &&
    bound.kind !== "schedule_form" &&
    bound.kind !== "armed_schedule_form"
  ) {
    return { kind: "unavailable" };
  }
  if (!controlsLentBy(bound).includes("fill")) return { kind: "unavailable" };

  // THE RUN'S OWN RIGHT TO ANSWER, asked separately from the right to read it.
  // Same answer, same helper and same order as every prompt window's own gate.
  const canRespond = input.deps?.canRespond ?? canActorRespondToRun;
  const mayOperate = await canRespond(
    bound.runId,
    input.actorCtx.actor,
    // An actor context with no hints is one whose standing could not be
    // resolved; an EMPTY hint set is the narrowest reading of it, so the run's
    // own rule refuses rather than falling through on a wider default.
    input.actorCtx.roleHints ?? {},
  ).catch(() => false);
  if (!mayOperate) return { kind: "unavailable" };

  // AND, FOR AN ARMED SCHEDULE, THE FORM'S OWN PREDICATE (cinatra#2934, the
  // armed-trigger tab). Issue 2934's acceptance is "an armed one-off changed
  // before firing and REFUSED AFTER", and the reading that refuses is the one
  // the form's **Save changes** is gated by — `canSave`, carried by the resolve
  // rather than re-derived here. A fill into rows nobody can save would place
  // values the person cannot act on and cannot see saved.
  if (bound.kind === "armed_schedule_form" && !bound.canSave) {
    return {
      kind: "not-editable",
      message: bound.refusal ?? "This schedule can no longer be changed.",
    };
  }

  // THE SCREEN'S OWN DRAWN CONTROLS, never the schema's raw properties (see the
  // note atop `bound-screen-controls.ts`): a setup-loop screen draws ONE control
  // named by the gate's `fieldName`, and placing that control's INNER keys wrote
  // a row the screen in front of the person could not read.
  // WHAT THE FIELDS ARE SHOWING RIGHT NOW: the screen's own values with
  // everything THIS MESSAGE has already placed over them. That is what the
  // person can see, so it is what a further fill is computed against and what
  // the no-op rule compares to.
  const state = await readRunWindowState(bound.runId, input.ref, input.messageId);
  const shown = { ...bound.form.values, ...state.placedThisMessage };
  const read = classifyDrawnFillValues({ ...bound.form, values: shown }, input.values);
  const values = read.values;
  const applied = Object.keys(values);
  if (applied.length === 0) {
    // WHICH REASON, AND NEVER THE WRONG ONE (cinatra#2934, the fourth graded
    // capture). These four outcomes used to be one, and the one sentence they
    // shared was true of only the first of them. They are asked in the order a
    // reader would ask them: a row that refused the value is the most specific
    // thing that happened, then a row already showing it, then a key that names
    // no control at all.
    const fields = drawnScreenControls(bound.form);
    if (read.unusable.length > 0) {
      return { kind: "unusable-values", rows: read.unusable, fields };
    }
    if (read.tooLarge) {
      return { kind: "too-large", fields };
    }
    if (read.unchanged.length > 0 && read.notFields.length === 0) {
      return { kind: "already-holding", fields: read.unchanged };
    }
    return { kind: "no-fields", fields };
  }

  // THE GRANT, CLAIMED LAST. Everything above is a read; this is the moment
  // before the write, and a grant already spent by a press stops the fill here.
  if (input.claimGrant && !(await input.claimGrant().catch(() => false))) {
    return { kind: "unavailable" };
  }

  const fill: RunWindowFill = { ref: input.ref, values };
  const append = input.deps?.append ?? appendRunWindowMessage;
  await append({
    runId: bound.runId,
    role: "assistant",
    surface: input.deps?.surface ?? state.surface,
    // A FILL IS NOT A BUBBLE. The assistant's own answer is what the person
    // reads; the row exists so the SCREEN can write the values into its fields
    // and so the submit can read back what was shown.
    text: "",
    fill,
    messageId: input.messageId,
    // WHOSE PLACEMENT THIS IS (cinatra#2934, the armed-schedule change road).
    // The armed form's save carries a placement forward into the NEXT turn —
    // "you place the change, then you ask to save it" — so the row has to name
    // the person, not only the message. Nothing else reads it, and no road
    // widens because of it: the carry is refused unless this name matches the
    // person asking.
    placedBy: input.actorCtx.actor.userId ?? null,
  });
  return { kind: "filled", ref: input.ref, applied };
}
