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
// was written, the assistant reported "Placed in the fields on the person's
// screen" — and the `Idea` box in front of the person stayed empty, because
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
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

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
 * what makes "placed in the fields on the person's screen" true.
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
  const [, year, month, day, hour, minute] = parts as unknown as string[];
  const m = Number(month);
  if (m < 1 || m > 12) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
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
    // An object that declares NO properties is not a closed set at all — it is a
    // free-form value the form takes as it comes — so it is passed through, the
    // same reading `fillableFieldNames` takes of it.
    const declaresProperties = isPlainObject(
      (row as { properties?: unknown }).properties,
    );
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
  const drawn = drawnScreenForm(form);
  const meant: Record<string, unknown> = {};
  for (const control of fillableFieldNames(drawn.schema)) {
    if (!Object.prototype.hasOwnProperty.call(requested, control)) continue;
    const value = valueForDrawnControl(
      propertySchema(drawn.schema, control),
      requested[control],
      drawn.values[control],
    );
    if (value === undefined) continue;
    meant[control] = value;
  }
  return selectFillableValues(drawn.schema, meant, drawn.values);
}
