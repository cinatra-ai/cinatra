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
//   4. ONLY FIELDS THE FORM ASKS FOR. The screen's own schema is the closed set;
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

/**
 * Keys no fill may ever write, whatever the schema says.
 *
 * `approved` is the interrupt approval flag — pressing Continue is the SUBMIT
 * road and a fill must not be able to smuggle one. `lifecycleCardRef` is a
 * server-minted opaque ticket that lives in the gate's values and is not a field
 * a human edits; the run and schedule screens already strip it before anything
 * leaves the page, and the same rule holds coming back the other way.
 */
export const FILL_RESERVED_KEYS: readonly string[] = [
  "approved",
  "lifecycleCardRef",
];

/** How many fields one fill may place, and how large the placed values may be. */
export const FILL_MAX_FIELDS = 40;
export const FILL_MAX_SERIALIZED_CHARS = 100_000;

/**
 * The screen's own field names, read out of the form schema it published.
 *
 * A JSON-Schema `properties` object is the shape every HITL screen's interrupt
 * carries; a schema without one declares no editable field and therefore lends
 * no fill at all — refusing is the honest answer, never "fill whatever you were
 * given".
 */
export function fillableFieldNames(
  schema: Record<string, unknown> | null | undefined,
): readonly string[] {
  const props = (schema as { properties?: unknown } | null | undefined)?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return [];
  return Object.keys(props as Record<string, unknown>).filter(
    (k) => !FILL_RESERVED_KEYS.includes(k),
  );
}

/**
 * The values a fill may actually place: the intersection of what was asked for
 * and what the form declares, in the FORM's order, bounded.
 *
 * PURE, so the closed-set property is pinned by a test rather than by reading a
 * model's mind. `undefined` values are dropped (there is nothing to place);
 * `null` is kept, because clearing a field is a real thing to ask for.
 */
export function selectFillableValues(
  schema: Record<string, unknown> | null | undefined,
  requested: Record<string, unknown>,
  /**
   * What the fields ALREADY hold. A "fill" that places a value the field already
   * has changes nothing a person could see, and is dropped (convergence round 2,
   * finding 2): the press this road allows requires a fill in the same message,
   * so a fill that alters nothing must not be able to unlock one. An induced
   * press therefore has to visibly change the person's own fields first.
   */
  current: Record<string, unknown> = {},
): Record<string, unknown> {
  const allowed = fillableFieldNames(schema);
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(requested, key)) continue;
    const value = requested[key];
    if (value === undefined) continue;
    if (sameValue(value, current[key])) continue;
    if (count >= FILL_MAX_FIELDS) break;
    out[key] = value;
    count += 1;
  }
  // The placed values are stored and travel back to a browser; an unbounded
  // payload is a cost the model would be choosing on the person's behalf.
  if (JSON.stringify(out).length > FILL_MAX_SERIALIZED_CHARS) return {};
  return out;
}

/**
 * Is the placed value the one the field already holds?
 *
 * TRUE structural equality, not `JSON.stringify` (convergence round 3): a plain
 * stringify is KEY-ORDER SENSITIVE, so the same object with its keys written in
 * another order would read as a change — and a "change" that alters nothing a
 * person can see is exactly what must not unlock a press. Keys are sorted at
 * every depth before the comparison, and arrays keep their order because their
 * order is content.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (b === undefined) return false;
  try {
    return stableJson(a) === stableJson(b);
  } catch {
    return false;
  }
}

/** JSON with every object's keys in sorted order, at every depth. */
function stableJson(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilize);
  if (!value || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) out[key] = stabilize(src[key]);
  return out;
}

export type BoundScreenFillOutcome =
  | { readonly kind: "filled"; readonly ref: string; readonly applied: readonly string[] }
  /** The card is not this person's, is not a screen, or lends no fill. */
  | { readonly kind: "unavailable" }
  /** The card is a screen, but nothing asked for is a field it declares. */
  | { readonly kind: "no-fields"; readonly fields: readonly string[] };

/**
 * Which surface a fill row is filed under.
 *
 * The fill belongs to the RUN — every window on that run reads the whole
 * exchange back — so the surface is a LABEL for reading it beside the run, not a
 * routing decision. It is taken from the newest window row on the run so the
 * fill sits with the conversation it came out of, and falls back to the run page
 * when the fill is the run's first window row (a message typed in the chat, for
 * instance, where the window itself is the chat).
 */
async function surfaceForFill(runId: string): Promise<RunWindowSurface> {
  try {
    const rows = await readRunWindowMessages(runId);
    const last = rows[rows.length - 1];
    return last?.surface ?? "run-page";
  } catch {
    return "run-page";
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
  if (bound.kind !== "hitl_screen") return { kind: "unavailable" };
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

  const values = selectFillableValues(bound.form.schema, input.values, bound.form.values);
  const applied = Object.keys(values);
  if (applied.length === 0) {
    return { kind: "no-fields", fields: fillableFieldNames(bound.form.schema) };
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
    surface: input.deps?.surface ?? (await surfaceForFill(bound.runId)),
    // A FILL IS NOT A BUBBLE. The assistant's own answer is what the person
    // reads; the row exists so the SCREEN can write the values into its fields
    // and so the submit can read back what was shown.
    text: "",
    fill,
    messageId: input.messageId,
  });
  return { kind: "filled", ref: input.ref, applied };
}
