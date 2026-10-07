// pressWithoutName: the one control without an accessible name pressed by a
// selector, the fault said, and the page's next settled state.
//
// WHY IT EXISTS. A site's widget may draw its launcher as a button that holds
// an icon alone, with no accessible name: `press` finds a control by its name,
// so it has nothing to name there, and the run that needs the launcher wrote
// its own selector and pressed whatever it found first. This step is
// pressByTestId's sibling for such a control: it presses only the one shown
// element of a CSS selector, looked for through open shadow roots, whose role
// is one `press` presses and whose accessible name, read from Chromium's
// accessibility tree as the control steps read names, is empty.
//
// NEVER A GUESS. No shown element of the selector is refused, naming how many
// match; several are refused, naming where each sits.
//
// THE ACCESSIBLE ROAD FIRST. An element of the selector that has a name is
// `press`'s: it is refused, naming its role and its name, and nothing is
// pressed.
//
// THE FAULT SAID. Before the press it writes one line: the page's path, the
// selector, the role, and that the control has no accessible name and was found
// by its selector. A person who uses a screen reader finds it by no name, and
// every record of a run that needs the step says so.
//
// SETTLED. The press is read as `press` reads it (press-settle.mjs), within the
// bounds of `press`.
import { CONTROL_HYDRATION_BOUND_MS, CONTROL_MARK, CONTROL_NAMES_LISTED, describePart, newMark, quotedName, readPageControls, waitForPageHydration } from "./page-controls.mjs";
import { PRESS_BOUNDS, PRESS_ROLES, ROLE_WORDS } from "./press.mjs";
import { pressAndSettle } from "./press-settle.mjs";
import { READING_BOUND_MS, pathOf, readBounds, refuse, refuseStaleScope, requireRecord, within } from "./step-kit.mjs";

const STEP = "pressWithoutName";

/** Every bound of the step, by the name `bounds` overrides it with: the bounds of press. */
export const PRESS_WITHOUT_NAME_BOUNDS = PRESS_BOUNDS;

// These run IN THE PAGE: nothing of this module may be used inside them.

/**
 * The shown elements `query.selector` matches, looked for through open shadow
 * roots, each with its role (its own, or the one its tag gives it), its
 * accessible name as the accessibility tree reads it (`accessibility`, empty
 * where it reads none) and the named part of the page it sits in; `matched`
 * counts the attached elements it matches, shown or not. The one shown element,
 * when it carries a role of `query.roles` and no name, takes the mark.
 */
function readNameless(query, accessibility) {
  const all = [];
  const walk = (root) => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      all.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  // Up the tree, across the edge of a shadow root to its host.
  const up = (node) => node.parentElement || (node.parentNode && node.parentNode.host) || null;
  const shown = (element) => {
    if (!element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = up(node)) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  const exposed = (element) => {
    for (let node = element; node; node = up(node)) if (node.getAttribute("aria-hidden") === "true") return false;
    return true;
  };
  const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const roleOf = (element) => {
    const explicit = text(element.getAttribute("role")).split(" ")[0].toLowerCase();
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === "button") return "button";
    if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : "";
    if (tag === "input") {
      const type = String(element.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "radio" || type === "checkbox") return type;
    }
    if (tag === "fieldset") return "group";
    if (tag === "dialog") return "dialog";
    if (tag === "nav") return "navigation";
    if (tag === "section" || tag === "aside" || tag === "main") return "region";
    return "";
  };
  const nameOf = (element) => (accessibility.get(element) || { name: "" }).name;
  const PARTS = ["dialog", "alertdialog", "group", "radiogroup", "toolbar", "region", "navigation", "form", "listitem", "row", "menu"];
  const partOf = (element) => {
    for (let node = up(element); node && node !== document.documentElement; node = up(node)) {
      const role = roleOf(node);
      const title = PARTS.includes(role) ? nameOf(node) : "";
      if (title) return { kind: role === "listitem" ? "list item" : role, title };
    }
    return null;
  };
  const matched = all.filter((element) => element.matches(query.selector));
  const found = matched.filter((element) => shown(element) && exposed(element));
  const matches = found.map((element) => {
    let href = null;
    if (element.localName === "a" && element.hasAttribute("href")) {
      try {
        const url = new URL(element.getAttribute("href"), location.href);
        href = { origin: url.origin, path: url.pathname };
      } catch {
        href = null;
      }
    }
    return { role: roleOf(element), name: nameOf(element), part: partOf(element), href };
  });
  if (found.length === 1 && query.roles.includes(matches[0].role) && matches[0].name === "") found[0].setAttribute(query.attribute, query.mark);
  return { path: location.pathname, matched: matched.length, matches };
}

/** Removes the mark `mark` from every element that carries it, inside open shadow roots too. */
function unmarkDeep({ attribute, mark }) {
  const walk = (root) => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.getAttribute(attribute) === mark) element.removeAttribute(attribute);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return true;
}

/**
 * Press the one shown element of the CSS `selector` on the caller's page or
 * frame scope, looked for through open shadow roots, whose role is one `press`
 * presses and whose accessible name is empty, and resolve
 * `{ name: "", role, selector, from, path, navigated, elapsedMs }` once the page
 * has settled, as `press` resolves. Before the press it writes one line that the
 * control has no accessible name and was found by its selector. Refuses, as a
 * StepRefusal: `input` (the page was not touched), `unreadable`, `no-control`
 * (no shown element of the selector, naming how many match, or one of no role
 * `press` presses), `ambiguous` (several, naming where each sits), `has-name`
 * (an element with a name, which is `press`'s; nothing pressed),
 * `driver-failure` and `unsettled`.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   selector: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof PRESS_WITHOUT_NAME_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ name: string, role: string, selector: string, from: string, path: string, navigated: boolean, elapsedMs: number }>}
 */
export async function pressWithoutName(page, { selector, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (typeof selector !== "string" || selector.trim() === "") {
    throw refuse(STEP, record, "input", `name the control by a CSS selector, such as button.cw-circle — ${nothing}`);
  }
  const bound = readBounds(STEP, record, PRESS_WITHOUT_NAME_BOUNDS, bounds, nothing);
  refuseStaleScope(STEP, record, page, nothing);
  const named = quotedName(selector.replace(/\s+/g, " ").trim());

  const from = pathOf(page.url());
  // Read only once the page has hydrated: a mark written before React has compared its element is a hydration mismatch.
  if (!(await waitForPageHydration(page))) {
    throw refuse(STEP, record, "unreadable", `the page on ${from} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — ${nothing}`);
  }
  const mark = newMark();
  const query = { selector, roles: PRESS_ROLES, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED };
  try {
    const reading = await within(readPageControls(page, query, readNameless), READING_BOUND_MS);
    if (!reading) throw refuse(STEP, record, "unreadable", `the elements of the selector ${named} on ${from} could not be read — ${nothing}`);
    const { matches } = reading;
    if (matches.length === 0) {
      const attached = reading.matched === 0 ? "no attached element matches it" : `${reading.matched} attached ${reading.matched === 1 ? "element matches" : "elements match"} it, none of them shown`;
      throw refuse(STEP, record, "no-control", `no shown element on ${from} matches the selector ${named} — ${attached}; ${nothing}`);
    }
    if (matches.length > 1) {
      const where = matches.map((/** @type {any} */ match, /** @type {number} */ index) => `${index + 1} ${describePart(match.part)}`).join(", ");
      throw refuse(STEP, record, "ambiguous", `${matches.length} shown elements on ${from} match the selector ${named}: ${where} — ${nothing}, since a press never guesses`);
    }
    const [control] = matches;
    if (!PRESS_ROLES.includes(control.role)) {
      const reads = control.role ? `the role ${control.role}, which press does not press` : "no role";
      throw refuse(STEP, record, "no-control", `the one shown element on ${from} that matches the selector ${named} carries ${reads} — ${nothing}`);
    }
    const [word] = ROLE_WORDS[control.role];
    if (control.name) {
      throw refuse(
        STEP,
        record,
        "has-name",
        `the ${word} of the selector ${named} on ${from} is named ${quotedName(control.name)} — press is the step for it, by its role and its name; ${nothing}`,
      );
    }

    // The fault the press rests on, said before the press: a person finds this control by no name.
    record(`${STEP}: on ${from}, the ${word} of the selector ${named} has no accessible name; it was found by its selector`);
    const { settled, elapsedMs } = await pressAndSettle(page, {
      step: STEP,
      record,
      mark,
      from,
      href: control.href,
      bound,
      what: `the ${word} of the selector ${named} on ${from}`,
      nothing,
    });
    if (!settled) {
      throw refuse(
        STEP,
        record,
        "unsettled",
        `the press on the ${word} of the selector ${named} started a navigation from ${from} that did not land within ${bound.settleMs} ms (the page is on ${pathOf(page.url())})`,
      );
    }
    const startBound = Math.min(bound.startMs, bound.settleMs);
    record(
      settled.navigated
        ? `${STEP}: pressed the ${word} of the selector ${named} on ${from} — landed on ${settled.path} after ${elapsedMs} ms`
        : `${STEP}: pressed the ${word} of the selector ${named} on ${from} — no navigation started within ${startBound} ms, and the page stayed on ${settled.path}`,
    );
    return { name: "", role: control.role, selector, from, path: settled.path, navigated: settled.navigated, elapsedMs };
  } finally {
    // The mark may stand inside a shadow root, where the shared reading does not look: it comes off here, whatever happened.
    await within(page.evaluate(unmarkDeep, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }
}
