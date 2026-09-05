// ---------------------------------------------------------------------------
// WHAT A BOUND SCREEN DRAWS, AND WHAT A FILL MAY PLACE IN IT (cinatra#2934,
// lifecycle-b W5c — extracted from `bound-screen-fill.ts` and repaired after the
// picture leg).
//
// PURE, AND ALONE IN THIS MODULE ON PURPOSE. The closed-set rule is read by the
// fill road AND by the turn that names the screen's rows to the assistant, and
// the second of those must not drag the window store into its module graph for
// one projection. Nothing here imports anything.
//
// THE DEFECT THIS REPAIRS. The closed set used to be read from the interrupt's
// own `properties`, and for a SETUP-LOOP screen those are not the controls the
// screen draws. The setup loop parks on ONE property of the template's schema
// and stores that property's INNER schema as the gate's `input_schema` with the
// property's name beside it in `fieldName` — so for a screen whose one field is
// an object (`idea`, declaring `{title, summary, outline}` and an
// `x-object-text-property`), the closed set read that way is
// `title / summary / outline` while the screen renders ONE control called
// `idea`. Measured on the run page: the fill placed `{"title": "…"}`, the row
// was written, the assistant reported that the values had been placed in the
// fields on the person's screen — and the `Idea` box in front of them stayed
// empty, because
// `title` names nothing the screen draws.
//
// SO THE SET IS WHAT IS DRAWN. `drawnScreenForm` puts the setup loop's single
// property back into the envelope the screen actually renders, and every screen
// that already declares its own properties — the grouped setup form, an ordinary
// mid-run gate, the scheduler form — passes through byte for byte.
//
// AND AN OBJECT-VALUED CONTROL IS FILLED THROUGH ITS OWN TEXT PROPERTY. A
// control declared `type: "object"` with `x-object-text-property: "title"` draws
// ONE text box whose text becomes that property (`schema-field-renderer.tsx`),
// so a text ask lands as `{idea: {title: …}}` — further keys only when the ask
// names them — and the companions the field already holds survive, exactly as
// the control's own editing does. That is what makes the answer's sentence true
// of the screen.
// ---------------------------------------------------------------------------

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

/** The `x-object-text-property` extension, named by the renderer that reads it. */
export const OBJECT_TEXT_PROPERTY_KEY = "x-object-text-property";

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

/** A bound screen's form, as the resolver answers it. */
export type BoundScreenForm = {
  readonly schema: Record<string, unknown>;
  readonly values: Record<string, unknown>;
  /** Setup-loop screens only — the single property the form writes back. */
  readonly fieldName?: string;
};

/**
 * The form AS DRAWN: the schema whose `properties` are the controls on screen.
 *
 * A `fieldName` is the setup loop saying "this gate is ONE property of the
 * template's schema, and what you hold is that property's own schema". The
 * screen re-wraps it to render, and so does this: the drawn control is the
 * property, named by `fieldName`, and its schema is the whole stored schema.
 */
export function drawnScreenForm(form: BoundScreenForm): {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
} {
  const name = typeof form?.fieldName === "string" ? form.fieldName.trim() : "";
  const schema = form?.schema ?? {};
  const values = form?.values ?? {};
  if (name === "") return { schema, values };
  return { schema: { type: "object", properties: { [name]: schema } }, values };
}

/** The controls the screen in view actually draws. */
export function drawnScreenControls(form: BoundScreenForm): readonly string[] {
  return fillableFieldNames(drawnScreenForm(form).schema);
}

function propertySchema(
  schema: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const declared = (props as Record<string, unknown>)[key];
  return isPlainObject(declared) ? declared : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Does this object row draw a fixed set of controls, or take what it is given? */
function isClosedObjectRow(row: Record<string, unknown>): boolean {
  const additional = (row as { additionalProperties?: unknown }).additionalProperties;
  if (additional === false) return true;
  if (additional !== undefined) return false;
  const properties = (row as { properties?: unknown }).properties;
  return isPlainObject(properties) && Object.keys(properties).length > 0;
}

/** The two formats a row may declare, and what each control accepts. */
export const IANA_TIMEZONE_FORMAT = "iana-timezone";
export const LOCAL_DATE_TIME_FORMAT = "local-date-time";
/**
 * The spellings the local date-time box accepts, and the ONE it holds.
 *
 * A `datetime-local` control holds `YYYY-MM-DDTHH:mm` read in the timezone row
 * beside it. The seconds a caller may append are dropped, and a single space
 * instead of the `T` is the same writing — but a ZONE DESIGNATOR is not: trimming
 * the `Z` off `2026-08-28T09:00Z` would silently re-read a UTC instant as a local
 * one and move the run (convergence round 2, finding 3). Anything carrying one is
 * refused, and so is a date the calendar does not have.
 */
const LOCAL_DATE_TIME_SPELLING =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

let ianaZones: Set<string> | null | undefined;
function isIanaTimezone(value: string): boolean {
  if (ianaZones === undefined) {
    try {
      ianaZones = new Set(
        (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf!(
          "timeZone",
        ),
      );
    } catch {
      // A runtime that cannot list the zones cannot contradict one either; the
      // control's own list is the browser's, and refusing every value here would
      // take the timezone row away rather than keep it honest.
      ianaZones = null;
    }
  }
  return ianaZones === null ? value.trim() !== "" : ianaZones.has(value);
}

/**
 * The value as the control would HOLD it, where the row says how it is written.
 *
 * The date-time row is a local `YYYY-MM-DDTHH:mm` box, and an ask that spelled
 * the same moment with seconds or a space is the same moment; normalising it
 * here means the row records exactly the characters the box will show, which is
 * what makes "Placed in the fields on your screen" true.
 */
function normalizeForRow(row: Record<string, unknown> | null, value: unknown): unknown {
  if (row?.format === LOCAL_DATE_TIME_FORMAT && typeof value === "string") {
    return readLocalDateTime(value) ?? value;
  }
  return value;
}

/**
 * The value the local date-time box would hold for this spelling, or `null`.
 *
 * ONE function for both questions — what the box shows, and whether the box
 * could show it — so a spelling can never be accepted by the check and then
 * written differently by the normalisation. A date the calendar does not have is
 * `null`, so `2026-99-99T99:99` is refused rather than merely reshaped.
 */
function readLocalDateTime(value: string): string | null {
  const parts = LOCAL_DATE_TIME_SPELLING.exec(value.trim());
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts as unknown as string[];
  const m = Number(month);
  if (m < 1 || m > 12) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  // THE SECONDS ARE DROPPED, SO THEY ARE ALSO CHECKED (convergence round 3): a
  // spelling this reshapes must be a time to begin with, or `09:00:99` would be
  // silently accepted as `09:00`.
  if (second !== undefined && Number(second) > 59) return null;
  // Year zero is not a year this box can hold.
  if (Number(year) < 1) return null;
  const daysInMonth = new Date(Date.UTC(Number(year), m, 0)).getUTCDate();
  const d = Number(day);
  if (d < 1 || d > daysInMonth) return null;
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Is this value one the row's own control could hold?
 *
 * A row that declares an `enum` draws a chooser, so a value outside it is not a
 * value the person could ever have selected; a bounded integer row draws a
 * number the same way, and a text row draws text. Dropping those is the same
 * rule as dropping an undeclared key, applied one level in: the closed set is
 * what the screen can show. Recording a value the control cannot display and
 * then reporting it as placed is exactly the defect the picture leg found, one
 * level down (convergence round 1, finding 2).
 */
function valueFitsRow(row: Record<string, unknown> | null, value: unknown): boolean {
  if (!row) return true;
  const declaredEnum = row.enum;
  if (Array.isArray(declaredEnum)) {
    if (Array.isArray(value)) {
      return value.every((entry) => declaredEnum.includes(entry as never));
    }
    return declaredEnum.includes(value as never);
  }
  if (row.type === "string") {
    if (typeof value !== "string") return false;
    if (row.format === IANA_TIMEZONE_FORMAT) return isIanaTimezone(value);
    if (row.format === LOCAL_DATE_TIME_FORMAT) {
      // THE VALUE MUST ALREADY BE THE ONE THE BOX HOLDS. `normalizeForRow` ran
      // first and returned the caller's own string unchanged when it could not
      // be read as a real local date and time, so anything that is not its own
      // canonical form here is a spelling this box cannot show.
      return readLocalDateTime(value) === value;
    }
    return true;
  }
  if (row.type === "boolean") return typeof value === "boolean";
  if (row.type === "integer" || row.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (row.type === "integer" && !Number.isInteger(value)) return false;
    if (typeof row.minimum === "number" && value < row.minimum) return false;
    if (typeof row.maximum === "number" && value > row.maximum) return false;
    return true;
  }
  if (row.type === "array") {
    if (!Array.isArray(value)) return false;
    const items = isPlainObject(row.items) ? row.items : null;
    return value.every((entry) => valueFitsRow(items, entry));
  }
  if (row.type === "object") {
    if (!isPlainObject(value)) return false;
    // THE CLOSED SET HOLDS AT EVERY DEPTH (convergence round 2, finding 2). An
    // object that DECLARES its properties is a closed set, so a key it does not
    // declare has no control behind it at any depth and the whole value is
    // refused — the top level drops such a key because it iterates them; here
    // there is one value to answer about, and the fail-closed answer is no.
    //
    // WHICH OBJECTS ARE CLOSED, in JSON Schema's own terms (convergence round 3):
    // `additionalProperties: false` closes an object even when it names no
    // properties at all, and any other `additionalProperties` — `true` or a
    // schema — opens one that does. An object that simply declares a non-empty
    // `properties` and says nothing about the rest is read as closed here, which
    // is narrower than JSON Schema validation and is the right reading for a
    // FORM: what is drawn is what is declared, and a key with no control behind
    // it is not one a person could have filled.
    const declaresProperties = isClosedObjectRow(row);
    for (const [key, inner] of Object.entries(value)) {
      const declared = propertySchema(row, key);
      if (!declared) {
        if (declaresProperties) return false;
        continue;
      }
      // And a declared property the control draws as text must not be handed a
      // number, or the box renders empty while the answer says it was filled.
      if (!valueFitsRow(declared, inner)) return false;
    }
    return true;
  }
  return true;
}

/**
 * What an ask means for ONE drawn control.
 *
 * `undefined` when the ask cannot be placed in that control at all — which is
 * the same answer as naming a control the screen does not draw, and for the same
 * reason.
 */
function valueForDrawnControl(
  row: Record<string, unknown> | null,
  requested: unknown,
  current: unknown,
): unknown {
  if (row?.type === "object") {
    const textProperty = row[OBJECT_TEXT_PROPERTY_KEY];
    const hasTextProperty = typeof textProperty === "string" && textProperty !== "";
    const carried = isPlainObject(current) ? current : {};
    // CLEARING IS A REAL THING TO ASK FOR (convergence round 1, finding 4), and
    // it is what the control's OWN empty box emits: the companions it was
    // holding, with the text property gone. `selectFillableValues` has always
    // said `null` is kept; an object control has to mean the same thing by it.
    if (requested === null) {
      const cleared: Record<string, unknown> = { ...carried };
      if (hasTextProperty) delete cleared[textProperty as string];
      return cleared;
    }
    if (typeof requested === "string" && hasTextProperty) {
      // ONE TEXT BOX. The control writes its text into the declared property and
      // keeps the companions it was holding — the renderer's own contract.
      return { ...carried, [textProperty as string]: requested };
    }
    if (isPlainObject(requested)) {
      // FURTHER KEYS ONLY WHEN THE ASK NAMES THEM, and only keys the object
      // itself declares; the companions the field already holds survive.
      const named: Record<string, unknown> = {};
      for (const key of fillableFieldNames(row)) {
        if (!Object.prototype.hasOwnProperty.call(requested, key)) continue;
        if (requested[key] === undefined) continue;
        if (!valueFitsRow(propertySchema(row, key), requested[key])) continue;
        named[key] = requested[key];
      }
      if (Object.keys(named).length === 0) return undefined;
      return { ...carried, ...named };
    }
    return undefined;
  }
  // A PLAIN TEXT ROW can be emptied too, and its box shows the empty; a CHOOSER
  // or a number cannot be un-chosen, so `null` there is not a value the control
  // could hold and is dropped like any other.
  if (requested === null) {
    return row && row.type === "string" && !Array.isArray(row.enum) && !row.format
      ? null
      : undefined;
  }
  const normalized = normalizeForRow(row, requested);
  if (!valueFitsRow(row, normalized)) return undefined;
  return normalized;
}

/**
 * WHY AN ASK PLACED NOTHING, PER KEY (cinatra#2934, the fourth graded capture).
 *
 * THE DEFECT THIS CLOSES, said plainly. `selectDrawnFillValues` answered ONE
 * empty object for four different situations — a key the screen draws no
 * control for, a control whose row cannot hold the value the ask gave it, a
 * control already showing exactly what was asked for, and an ask so large the
 * bound refused it — and the fill road turned every one of them into the single
 * sentence "None of those are fields on this screen". The fourth capture
 * photographed that sentence answering an ask that named the form's OWN Run at
 * row, moments after five identical-in-kind asks had moved it: the stated
 * reason was false, and the reader could disprove it by looking at the screen.
 *
 * A REASON IS NOT A REFUSAL. Splitting them here is what lets the road say the
 * true one for each, and it is done in this pure module so the split is pinned
 * by a test rather than by reading a model's mind.
 */
export type DrawnFillClassification = {
  /** What may actually be placed — `selectDrawnFillValues`, unchanged. */
  readonly values: Record<string, unknown>;
  /** Keys the ask named that this screen draws no control for. */
  readonly notFields: readonly string[];
  /** Drawn controls whose own row cannot hold the value the ask gave them. */
  readonly unusable: readonly string[];
  /** Drawn controls already showing exactly what the ask asked for. */
  readonly unchanged: readonly string[];
  /** There WAS something to place and the size bound refused all of it. */
  readonly tooLarge: boolean;
};

/** The ask, read against the screen in view, with a reason for every key. */
export function classifyDrawnFillValues(
  form: BoundScreenForm,
  requested: Record<string, unknown>,
): DrawnFillClassification {
  const drawn = drawnScreenForm(form);
  const controls = fillableFieldNames(drawn.schema);
  const meant: Record<string, unknown> = {};
  const unusable: string[] = [];
  for (const control of controls) {
    if (!Object.prototype.hasOwnProperty.call(requested, control)) continue;
    const value = valueForDrawnControl(
      propertySchema(drawn.schema, control),
      requested[control],
      drawn.values[control],
    );
    // `undefined` here is the control saying "not a value I could show", which
    // is a different sentence from "not a control I draw".
    if (value === undefined) {
      unusable.push(control);
      continue;
    }
    meant[control] = value;
  }
  const unchanged = Object.keys(meant).filter((key) =>
    sameValue(meant[key], drawn.values[key]),
  );
  const values = selectFillableValues(drawn.schema, meant, drawn.values);
  const notFields = Object.keys(requested).filter((key) => !controls.includes(key));
  return {
    values,
    notFields,
    unusable,
    unchanged,
    // Something was placeable and nothing was placed: the only remaining rule
    // that can do that is the serialized bound.
    tooLarge:
      Object.keys(meant).length > unchanged.length &&
      Object.keys(values).length === 0,
  };
}

/**
 * The values a fill may place in the DRAWN controls of the screen in view.
 *
 * Composed rather than forked: the closed-set, reserved-key, no-op and bound
 * rules are `selectFillableValues`'s, unchanged and still pure; this decides
 * what each ask MEANS for the control it names before that rule runs.
 */
export function selectDrawnFillValues(
  form: BoundScreenForm,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  return classifyDrawnFillValues(form, requested).values;
}

// ---------------------------------------------------------------------------
// WHAT THE SCREEN'S ROWS ARE, IN WORDS (cinatra#2934, the fourth graded
// capture).
//
// THE OTHER HALF OF THE SAME DEFECT. The turn that names a bound screen to the
// assistant named its rows and nothing else — not the spelling a row holds, not
// what it is holding now — so "make it half past twelve tomorrow" had to be
// turned into a value with no ground truth to turn it against. The same
// described change therefore reached the road spelled differently from one turn
// to the next, and a spelling the row cannot hold was dropped in silence.
//
// So the rows are described rather than listed: the shape the control holds and
// the characters it is showing right now. That is a DETERMINISTIC input, and it
// is the structural half of the repeat fix — the road stops depending on a
// guess it never had to be a guess.
// ---------------------------------------------------------------------------

/** How ONE row writes its value, in the reader's own words, or `null`. */
function describeRowShape(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  if (Array.isArray(row.enum)) {
    return `one of ${row.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  if (row.type === "string") {
    if (row.format === LOCAL_DATE_TIME_FORMAT) {
      return (
        "a local date and time written YYYY-MM-DDTHH:mm, read in the timezone " +
        "row beside it — never a UTC instant, never a zone letter and never seconds"
      );
    }
    if (row.format === IANA_TIMEZONE_FORMAT) return "an IANA timezone name";
    return "text";
  }
  if (row.type === "boolean") return "true or false";
  if (row.type === "integer" || row.type === "number") {
    const bounds: string[] = [];
    if (typeof row.minimum === "number") bounds.push(`at least ${row.minimum}`);
    if (typeof row.maximum === "number") bounds.push(`at most ${row.maximum}`);
    const kind = row.type === "integer" ? "a whole number" : "a number";
    return bounds.length > 0 ? `${kind}, ${bounds.join(" and ")}` : kind;
  }
  if (row.type === "array") return "a list";
  return null;
}

/**
 * HOW MUCH OF A ROW'S CURRENT VALUE IS ECHOED BACK TO THE TURN.
 *
 * WHAT IT IS FOR (cinatra#2934, the convergence round of the fourth fix leg).
 * Naming what a row is holding is what makes a described change computable —
 * and the value is text a PERSON typed, on an arbitrary screen, travelling into
 * the turn's own instructions. So it travels bounded: enough to recognise the
 * row's current state, never enough to be a payload. The echo is always
 * JSON-quoted, which keeps a newline a newline and cannot open a section of its
 * own, and the whole description is capped as well as each value, so no screen
 * can make this fragment grow without limit.
 */
export const ROW_VALUE_ECHO_MAX_CHARS = 120;
/** The whole description's cap — a screen with very many rows is cut, not carried. */
export const ROWS_DESCRIPTION_MAX_CHARS = 4_000;

/**
 * Rows whose value is NEVER echoed: a secret is not state the turn needs.
 *
 * Read from the row's own schema where it says so (`writeOnly`, a password
 * format) and from its name otherwise, because a JSON-schema form on an
 * arbitrary screen is not obliged to say either.
 */
function rowValueIsSecret(control: string, schema: Record<string, unknown> | null): boolean {
  if (schema) {
    if (schema.writeOnly === true) return true;
    const format = typeof schema.format === "string" ? schema.format.toLowerCase() : "";
    if (format === "password") return true;
  }
  return /pass(word|phrase)|secret|token|credential|api[_-]?key|private[_-]?key/i.test(
    control,
  );
}

/** One line per drawn control: its name, how it is written, what it holds. */
export function describeDrawnRows(form: BoundScreenForm): readonly string[] {
  const drawn = drawnScreenForm(form);
  const out: string[] = [];
  let budget = ROWS_DESCRIPTION_MAX_CHARS;
  for (const control of fillableFieldNames(drawn.schema)) {
    const parts: string[] = [];
    const rowSchema = propertySchema(drawn.schema, control);
    const shape = describeRowShape(rowSchema);
    if (shape) parts.push(shape);
    const held = drawn.values[control];
    if (typeof held === "string" || typeof held === "number" || typeof held === "boolean") {
      if (rowValueIsSecret(control, rowSchema)) {
        // NAMED, NOT SHOWN. The turn still knows the row is holding something,
        // which is all it needs to reason about whether to change it.
        parts.push("now set (not shown)");
      } else {
        const text = String(held);
        const shown =
          text.length > ROW_VALUE_ECHO_MAX_CHARS
            ? `${text.slice(0, ROW_VALUE_ECHO_MAX_CHARS)}…`
            : text;
        parts.push(`now ${JSON.stringify(shown)}`);
      }
    }
    const line = parts.length > 0 ? `${control} (${parts.join("; ")})` : control;
    // THE WHOLE DESCRIPTION IS BOUNDED TOO. A row that does not fit is named
    // without its shape rather than dropped — the turn must still be able to
    // address every control the screen draws.
    if (line.length > budget) {
      out.push(control);
      budget -= control.length;
      if (budget <= 0) budget = 0;
      continue;
    }
    out.push(line);
    budget -= line.length;
  }
  return out;
}

/**
 * The instant a local-date-time row would be showing for "now", or `null`.
 *
 * NAMED SO "TOMORROW" IS COMPUTABLE. A described change is almost always
 * relative — tomorrow, this evening, in an hour — and a row that says only what
 * it holds leaves the arithmetic to a guess about what day it is. The zone is
 * the form's OWN timezone row, so the answer is in the same clock the row is
 * read in; a form with no such row, or a zone the runtime cannot resolve, gets
 * `null` rather than a moment in the wrong clock.
 */
export function nowForDrawnForm(form: BoundScreenForm, at: Date): string | null {
  const drawn = drawnScreenForm(form);
  let zone: string | null = null;
  for (const control of fillableFieldNames(drawn.schema)) {
    const row = propertySchema(drawn.schema, control);
    if (row?.format !== IANA_TIMEZONE_FORMAT) continue;
    const held = drawn.values[control];
    if (typeof held === "string" && held.trim() !== "") zone = held;
  }
  if (!zone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    const value = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
    return readLocalDateTime(value) === value ? value : null;
  } catch {
    return null;
  }
}
