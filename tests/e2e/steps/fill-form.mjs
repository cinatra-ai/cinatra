// fillForm: named fields of a form filled by their labels, and the form sent.
//
// WHY IT EXISTS. A form filled by hand for each run found its fields by
// selectors that drifted from the page, and a field left empty surfaced only
// later, as a run that went on with a gap. This step fills each field by the
// label a person reads, refuses at once a label the form does not have (naming
// the labels it has), and, when it sends the form, refuses a required field left
// empty with the page's own error text.
//
// THE FIELDS. A field is a shown input (not a button, a file or a hidden one),
// textarea or select inside the form, named by its label: the text of its
// `aria-labelledby` elements, else its `aria-label`, else the text of its
// `<label>` elements. The form is the element `form` selects, the whole page by
// default. Values are never written to a line: a field may hold a credential.
// One reading of the form (readForm) names the fields, for the labels a refusal
// lists and for the field a fill resolves alike, so the two cannot differ. A
// label names a field when both read the same without their white space: the
// reading puts a space where a label's inline parts meet ("Idea (optional)"),
// which the page's text may lack ("Idea(optional)"), and either names the field.
// A label that names two fields is refused, naming both. The control that sends
// the form is resolved by the same reading and the same match, so the names a
// `no-submit` refusal lists are names the step takes; a name that two controls
// carry is refused, naming both, and a control hidden from assistive technology
// is neither listed nor pressed.
//
// A REQUIRED FIELD LEFT EMPTY. After the press, a field that is still empty is
// a required field left empty when the page marks it (`aria-invalid="true"`) or
// shows an error for it, or when it declares itself required (`required` or
// `aria-required="true"`). The error text is the page's own: the element its
// `aria-errormessage` names, else an error its `aria-describedby` names, else an
// error in the field's own box (FIELD_ERROR_SELECTOR, the markers the product's
// forms draw their errors with). A form whose fields are all filled (a disabled
// one aside) is not read after the press at all; with an empty one, the form is
// read until the page marks a field, the form is gone, or the error bound runs
// out.
import { listed, quoted } from "./control-kit.mjs";
import { CONTROL_HYDRATION_BOUND_MS, CONTROL_MARK, markedBy, newMark, unmarkControls, waitForPageHydration } from "./page-controls.mjs";
import { READING_BOUND_MS, errorClass, pathOf, pollUntilSettled, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "fillForm";

/** The form the fields are looked for in, when the caller names none: the whole page. */
export const FORM_SCOPE_SELECTOR = "body";
/**
 * An error the page draws for a field: an alert, the shared form message, the
 * field error, and the destructive text the step forms draw beside a field.
 */
export const FIELD_ERROR_SELECTOR =
  '[role="alert"], [aria-live="assertive"], [data-slot="form-message"], [data-slot="field-error"], .text-destructive';
/** How long the form may take to show every named field. */
export const FORM_FIELDS_BOUND_MS = 15_000;
/** One fill, or the press that sends the form. */
export const FORM_ACTION_BOUND_MS = 30_000;
/** From the press to the page's error for a field left empty. The page validates at once; a longer wait only delays a form that went through. */
export const FORM_ERROR_BOUND_MS = 5_000;
/** How often the form is read. */
export const FORM_POLL_MS = 100;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const FORM_BOUNDS = Object.freeze({
  fieldsMs: FORM_FIELDS_BOUND_MS,
  actionMs: FORM_ACTION_BOUND_MS,
  errorMs: FORM_ERROR_BOUND_MS,
  pollMs: FORM_POLL_MS,
});

// These run IN THE PAGE: nothing of this module may be used inside them.

/**
 * The form's shown, labelled fields (label, empty, required, marked invalid,
 * the page's error text) and the names of its shown controls, those hidden from
 * assistive technology left out. The state says whether every `need`ed label
 * names one field (`ready`), one of them names none (`missing`, those in
 * `missing`) or several (`ambiguous`, each in `ambiguous` with the labels of
 * the fields it names), or, after the press, whether a `watch`ed field the page
 * marks is still empty (`refused`), none of them is there any more (`gone`), or
 * neither (`open`). With `pick`, the one field its label names takes the mark;
 * `picked` lists the labels of every field that label names. With `press`, the
 * one control its name names takes the mark; `pressed` lists the names of every
 * control that name names. A label names a field, and a name a control, when
 * both read the same without their white space.
 */
function readForm({ scope, errors, need, watch, pick, press }) {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const shown = (element) => {
    if (!element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  const textOf = (node) => {
    let found = "";
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let at = walker.nextNode(); at; at = walker.nextNode()) {
      if (at.parentElement && at.parentElement.closest('[aria-hidden="true"]')) continue;
      found += ` ${at.nodeValue}`;
    }
    return text(found);
  };
  const byIds = (element, attribute) =>
    text(element.getAttribute(attribute))
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  const labelOf = (control) => {
    const labelledBy = byIds(control, "aria-labelledby");
    if (labelledBy.length > 0) return text(labelledBy.map(textOf).join(" "));
    return text(control.getAttribute("aria-label")) || text(Array.from(control.labels || [], textOf).join(" "));
  };
  const nameOf = (control) => {
    const labelledBy = byIds(control, "aria-labelledby");
    if (labelledBy.length > 0) return text(labelledBy.map(textOf).join(" "));
    const own = control.localName === "input" ? text(control.value) : textOf(control);
    return text(control.getAttribute("aria-label")) || own || text(control.getAttribute("title"));
  };
  const root = document.querySelector(scope);
  const errorOf = (control) => {
    const quote = (nodes) => text(nodes.filter(shown).map(textOf).join(" "));
    const message = quote(byIds(control, "aria-errormessage"));
    if (message) return message;
    const described = quote(byIds(control, "aria-describedby").filter((node) => node.matches(errors)));
    if (described) return described;
    // The field's own box: the nearest ancestor, past a label, that holds its labels too.
    const labels = Array.from(control.labels || []);
    let box = control.parentElement;
    while (box && box !== root && (box.localName === "label" || !labels.every((label) => box.contains(label)))) box = box.parentElement;
    // The whole form is no field's own box: an error there may be another field's.
    if (!box || box === root) return "";
    return quote(Array.from(box.querySelectorAll(errors)).filter((node) => !node.contains(control)));
  };
  if (!root) return { state: watch ? "gone" : "absent", fields: [], controls: [] };
  const fillable =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]), textarea, select';
  const labelled = Array.from(root.querySelectorAll(fillable))
    .filter(shown)
    .map((control) => ({ control, label: labelOf(control) }))
    .filter((field) => field.label !== "");
  const keyOf = (label) => String(label).replace(/\s+/g, "");
  const named = (label) => labelled.filter((field) => keyOf(field.label) === keyOf(label));
  const fields = labelled.map(({ control, label }) => ({
    label,
    empty: String(control.value || "").trim() === "",
    disabled: control.disabled === true,
    required: control.required === true || control.getAttribute("aria-required") === "true",
    invalid: control.getAttribute("aria-invalid") === "true",
    error: errorOf(control),
  }));
  const buttons = Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
    .filter((control) => shown(control) && !control.closest('[aria-hidden="true"]'))
    .map((control) => ({ control, name: nameOf(control) }));
  const controls = buttons.map((button) => button.name);
  let state = "present";
  let missing = [];
  let ambiguous = [];
  if (need) {
    missing = need.filter((label) => named(label).length === 0);
    ambiguous = need.map((label) => ({ label, labels: named(label).map((field) => field.label) })).filter((one) => one.labels.length > 1);
    state = ambiguous.length > 0 ? "ambiguous" : missing.length > 0 ? "missing" : "ready";
  }
  if (watch) {
    const watched = fields.filter((field) => watch.includes(field.label));
    state = watched.length === 0 ? "gone" : watched.some((field) => field.empty && (field.invalid || field.error)) ? "refused" : "open";
  }
  let picked = [];
  if (pick) {
    const found = named(pick.label);
    if (found.length === 1) found[0].control.setAttribute(pick.attribute, pick.mark);
    picked = found.map((field) => field.label);
  }
  let pressed = [];
  if (press) {
    const found = buttons.filter((button) => keyOf(button.name) === keyOf(press.name));
    if (found.length === 1) found[0].control.setAttribute(press.attribute, press.mark);
    pressed = found.map((button) => button.name);
  }
  return { state, fields, controls, missing, ambiguous, picked, pressed };
}

/** @param {string} value */
const normal = (value) => value.replace(/\s+/g, " ").trim();

/** @param {string[]} filled */
const soFar = (filled) => (filled.length > 0 ? ` — filled before it: ${listed(filled, "")}` : " — nothing was filled");

/**
 * Fill `fields` (`{ label: value }`) in the form `form` selects on the caller's
 * page, each by its label, and, with `submit`, press the control of the form
 * named so. Resolves `{ filled, submitted, path }`: the labels it filled, in
 * order, whether it pressed, and the page's path. Refuses, as a StepRefusal:
 * `input` (nothing was filled), `unknown-label` (no field has the label within
 * the bound, naming the labels the form has), `ambiguous` (a label names
 * several fields, or the `submit` name several controls, naming them),
 * `driver-failure` (a fill or the press failed), `no-submit` (no shown control
 * with the `submit` name in the form, naming its controls) and `required-empty`
 * (the press left a required field empty, with the page's own error text).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   fields: Record<string, string>,
 *   record: import("./step-kit.mjs").StepRecord,
 *   form?: string,
 *   submit?: string,
 *   bounds?: Partial<Record<keyof typeof FORM_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ filled: string[], submitted: boolean, path: string }>}
 */
export async function fillForm(page, { fields, record, form = FORM_SCOPE_SELECTOR, submit, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was filled";
  const entries = fields && typeof fields === "object" && !Array.isArray(fields) ? Object.entries(fields) : [];
  if (entries.length === 0 || entries.some(([label, value]) => normal(label) === "" || typeof value !== "string")) {
    throw refuse(STEP, record, "input", `hand the step the fields to fill, each a label with a text value — ${nothing}`);
  }
  if (typeof form !== "string" || form.trim() === "") {
    throw refuse(STEP, record, "input", `name the form by a selector, such as form — ${nothing}`);
  }
  if (submit !== undefined && (typeof submit !== "string" || normal(submit) === "")) {
    throw refuse(STEP, record, "input", `name the control that sends the form by its accessible name, such as Save — ${nothing}`);
  }
  const bound = readBounds(STEP, record, FORM_BOUNDS, bounds, nothing);
  const wanted = entries.map(([label, value]) => /** @type {[string, string]} */ ([normal(label), value]));
  const need = wanted.map(([label]) => label);
  const at = pathOf(page.url());
  /** A label that names several fields, for a line, with the label of each. */
  const several = (/** @type {string} */ label, /** @type {string[]} */ labels) =>
    `the label ${quoted(label)} matches ${labels.length} shown fields in the form on ${at}: ${listed(labels, "")}`;

  // Every named field, shown: a form the app draws after the page may take a moment.
  const { reading, settled } = await pollUntilSettled(page, {
    read: readForm,
    arg: { scope: form, errors: FIELD_ERROR_SELECTOR, need },
    isSettled: (state) => state === "ready" || state === "ambiguous",
    bound: bound.fieldsMs,
    pollMs: bound.pollMs,
  });
  const found = /** @type {{ state: string, fields?: { label: string }[], missing?: string[], ambiguous?: { label: string, labels: string[] }[] }} */ (reading);
  if (!settled) {
    const labels = found.fields ? found.fields.map((field) => field.label) : null;
    const unknown = found.missing ?? need;
    const has = labels ? `its labels: ${listed(labels, "none")}` : "its labels could not be read";
    throw refuse(
      STEP,
      record,
      "unknown-label",
      `no field in the form on ${at} is labelled ${unknown.map(quoted).join(" or ")} within ${bound.fieldsMs} ms; ${has} — ${nothing}`,
    );
  }
  if (found.state === "ambiguous") {
    const each = (found.ambiguous ?? []).map((one) => several(one.label, one.labels));
    throw refuse(STEP, record, "ambiguous", `${each.join("; ")} — ${nothing}, since a fill never guesses`);
  }

  // Marked only once the page has hydrated: a mark written before React has compared its element is a hydration mismatch.
  if (!(await waitForPageHydration(page))) {
    throw refuse(STEP, record, "driver-failure", `the page on ${at} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — ${nothing}`);
  }
  /** @type {string[]} */
  const filled = [];
  for (const [label, value] of wanted) {
    // The field is resolved by the reading that listed the labels, and carries the mark for its fill only.
    const mark = newMark();
    try {
      const picking = await within(page.evaluate(readForm, { scope: form, errors: FIELD_ERROR_SELECTOR, pick: { label, attribute: CONTROL_MARK, mark } }), READING_BOUND_MS);
      const picked = /** @type {string[]} */ (picking?.picked ?? []);
      if (picked.length > 1) throw refuse(STEP, record, "ambiguous", `${several(label, picked)}${soFar(filled)}, since a fill never guesses`);
      if (picked.length === 0) {
        throw refuse(STEP, record, "unknown-label", `no shown field labelled ${quoted(label)} in the form on ${at} can be filled by its label${soFar(filled)}`);
      }
      try {
        await page.locator(markedBy(mark)).fill(value, { timeout: bound.actionMs });
      } catch (error) {
        // Playwright's own message can repeat the value it was given to fill: only the class is kept.
        throw refuse(STEP, record, "driver-failure", `the field ${quoted(label)} could not be filled (${errorClass(error)})${soFar(filled)}`);
      }
    } finally {
      await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
    }
    filled.push(label);
  }
  if (submit === undefined) {
    record(`${STEP}: filled ${listed(filled, "")} in the form on ${at}`);
    return { filled, submitted: false, path: at };
  }

  const sender = normal(submit);
  const pressedNothing = `the fields were filled (${listed(filled, "")}), and nothing was pressed`;
  /** @type {string[]} */
  let empty = [];
  // The control is resolved by the reading that lists the form's controls, and carries the mark for its press only.
  const mark = newMark();
  try {
    const picking = await within(page.evaluate(readForm, { scope: form, errors: FIELD_ERROR_SELECTOR, press: { name: sender, attribute: CONTROL_MARK, mark } }), READING_BOUND_MS);
    const named = /** @type {string[]} */ (picking?.pressed ?? []);
    if (named.length === 0) {
      const controls = picking ? `its controls: ${listed(picking.controls, "none")}` : "its controls could not be read";
      throw refuse(STEP, record, "no-submit", `no shown control named ${quoted(sender)} in the form on ${at}; ${controls} — ${pressedNothing}`);
    }
    if (named.length > 1) {
      throw refuse(
        STEP,
        record,
        "ambiguous",
        `the control ${quoted(sender)} matches ${named.length} shown controls in the form on ${at}: ${listed(named, "")} — ${pressedNothing}, since a press never guesses`,
      );
    }
    // The fields still empty (a disabled one takes no answer): only one of them can be a required field left empty.
    let before;
    try {
      before = await page.evaluate(readForm, { scope: form, errors: FIELD_ERROR_SELECTOR });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the form on ${at} could not be read before the press (${errorClass(error)}) — ${pressedNothing}`);
    }
    empty = before.fields.filter((field) => field.empty && !field.disabled).map((field) => field.label);
    try {
      await page.locator(markedBy(mark)).click({ timeout: bound.actionMs });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the control ${quoted(sender)} could not be pressed (${errorClass(error)}) — the fields were filled (${listed(filled, "")})`);
    }
  } finally {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }
  if (empty.length > 0) {
    const after = await pollUntilSettled(page, {
      read: readForm,
      arg: { scope: form, errors: FIELD_ERROR_SELECTOR, watch: empty },
      isSettled: (state) => state === "refused" || state === "gone",
      bound: bound.errorMs,
      pollMs: bound.pollMs,
    });
    const now = /** @type {{ fields?: { label: string, empty: boolean, required: boolean, invalid: boolean, error: string }[] }} */ (after.reading).fields ?? [];
    const left = now.filter((field) => empty.includes(field.label) && field.empty && (field.invalid || field.error !== "" || field.required));
    if (left.length > 0) {
      const each = left.map((field) => `${quoted(field.label)} (${field.error ? `the page says ${quoted(field.error)}` : "the page shows no error text for it"})`);
      throw refuse(
        STEP,
        record,
        "required-empty",
        `the press on ${quoted(sender)} in the form on ${at} left ${left.length === 1 ? "a required field" : "required fields"} empty: ${each.join(", ")}`,
      );
    }
  }
  record(`${STEP}: filled ${listed(filled, "")} in the form on ${at} and pressed ${quoted(sender)}`);
  return { filled, submitted: true, path: at };
}
