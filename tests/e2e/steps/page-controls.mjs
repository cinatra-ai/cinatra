// What the control steps share (press, selectFrom and dispatchRun): the page's
// controls, read in the page by their role and their accessible name; the mark
// a step puts on the one control it acts on; and the reading of the document a
// press starts from.
//
// A CONTROL IS FOUND AS A PERSON WITH A SCREEN READER FINDS IT: by its role (a
// button, a link, a tab, a radio, an option) and its accessible name, read in
// this order: the text of the elements `aria-labelledby` names, `aria-label`,
// its own labels (a fieldset's legend), and, for a role that takes its name from
// its content, its text without hidden parts. Only a shown control counts:
// attached, drawn, inside nothing hidden, and not hidden from assistive
// technology (`aria-hidden`), as a picker's hidden native twin is. Names are
// compared whole, after runs of white space are made one space.
//
// A STEP NEVER ACTS ON A GUESS. When a name matches several controls, the step
// refuses and names each one by the named part of the page it sits in (a card,
// a row, a list item, a dialog, a group). A press may look within one such part
// only, named as that refusal names it; a part that several carry is refused
// too. The one control it acts on carries the mark (CONTROL_MARK) for the press
// only, and loses it right after.
import { randomUUID } from "node:crypto";

/** One press or one selection: how long the control may take to take it. */
export const CONTROL_ACTION_BOUND_MS = 10_000;
/** How often a control step reads the page while it waits. */
export const CONTROL_POLL_MS = 100;
/** The most names a refusal lists; the others are counted. */
export const CONTROL_NAMES_LISTED = 10;
/** The attribute that marks the one control a step acts on, for that act only. */
export const CONTROL_MARK = "data-step-control";

/** The most characters of a name read from the page that a line carries. */
const NAME_LENGTH = 60;

/** A fresh value for the mark. */
export const newMark = () => randomUUID().replace(/-/g, "");

/**
 * The selector of what carries `value` in the mark.
 * @param {string} value
 */
export const markedBy = (value) => `[${CONTROL_MARK}="${value}"]`;

/**
 * A name as a query compares it: runs of white space made one space, trimmed.
 * @param {unknown} name
 */
export const plainName = (name) => String(name ?? "").replace(/\s+/g, " ").trim();

/**
 * A name read from the page, for a line: without an address, without double
 * quotes, at most NAME_LENGTH characters, and quoted; a control without a name
 * is said to be one.
 * @param {string} name
 */
export function quotedName(name) {
  if (!name) return "one without a name";
  const plain = name.replace(/\b[a-z][a-z\d+.-]*:\/\/\S*/gi, "an address").replace(/"/g, "'");
  return `"${plain.length > NAME_LENGTH ? `${plain.slice(0, NAME_LENGTH - 1).trimEnd()}…` : plain}"`;
}

/**
 * A bounded list of names, as the page answered it: `{ names, more }`.
 * @param {{ names: string[], more: number }} list
 */
export function describeNames(list) {
  if (!list || list.names.length === 0) return "none";
  const named = list.names.map(quotedName).join(", ");
  return list.more > 0 ? `${named} and ${list.more} more` : named;
}

/**
 * The named part of the page a control sits in, for a line.
 * @param {{ kind: string, title: string } | null} part
 */
export const describePart = (part) => (part ? `in the ${part.kind} ${quotedName(part.title)}` : "in no named part of the page");

/**
 * Where each of several matches sits, for the refusal that names them.
 * @param {{ part: { kind: string, title: string } | null }[]} matches
 */
export const describeMatches = (matches) => matches.map((match, index) => `${index + 1} ${describePart(match.part)}`).join(", ");

// These run IN THE PAGE. Playwright sends each one's source text, so none of
// them may use anything of this module.

/**
 * Reads the page's controls for one query and marks the one control the step
 * will act on, when exactly one matches. `query.mode` is:
 *   - `press`: the shown controls of `role` and those named `name`, within the
 *     one shown part of the page named `within` when the query names one (the
 *     parts of that name come back as `scope`); a checkbox's, a radio's or a
 *     switch's checked state comes back with it;
 *   - `checked`: the checked state of the marked control (null once the page
 *     no longer holds it);
 *   - `card`: the shown cards and those named `card`, and in the one card, its
 *     buttons and links and those named `control`;
 *   - `picker`: the shown pickers (a select, a combobox, a listbox, a radio
 *     group) and those named `picker`, and in the one picker, its entries and
 *     those whose text is `entry`; a combobox's entries are those of the list it
 *     controls, once that list is shown. When no picker is named `picker`, a
 *     combobox with no accessible name is found by the text that stands in for
 *     its name, road by road (`by`): the placeholder it shows, the value it
 *     shows, or the label element before it in its form group. With `marked`,
 *     the picker is the one that carries the mark, by no name (`by` is `mark`);
 *   - `reflected`: whether the marked entry reads as selected, and the text of
 *     a live region that names `entry` and was not there before (`before`);
 *   - `composer`: the shown text boxes and those named `composer`, and the shown
 *     buttons of that same name, the composer's send control. A text box's
 *     placeholder is never its name.
 * Lists of names come back bounded: `{ names, more }`.
 */
export function readControls(query) {
  const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  // Shown: attached and drawn, and inside nothing hidden.
  const shown = (element) => {
    if (!element || !element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  // Exposed: shown, and not hidden from assistive technology. Controls are found among these only.
  const exposed = (element) => shown(element) && !element.closest("[aria-hidden='true']");
  const typeOf = (element) => String(element.getAttribute("type") || "").toLowerCase();
  const BUTTON_TYPES = ["button", "submit", "reset", "image"];
  const roleOf = (element) => {
    const explicit = text(element.getAttribute("role")).split(" ")[0].toLowerCase();
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === "button") return "button";
    if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : "";
    if (tag === "input") {
      const type = typeOf(element);
      if (BUTTON_TYPES.includes(type)) return "button";
      if (type === "radio" || type === "checkbox") return type;
      if (type === "search") return "searchbox";
      return ["", "text", "email", "tel", "url"].includes(type) ? "textbox" : "";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (tag === "option") return "option";
    if (tag === "fieldset") return "group";
    return "";
  };
  const FROM_CONTENT = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "radio", "checkbox", "switch", "treeitem"];
  // The text a node gives a name: its text without hidden parts, an image's
  // alternative text, and a field's value; `skip` is the control being named.
  const contentOf = (node, skip) => {
    if (node === skip) return "";
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return "";
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return "";
    const tag = node.localName;
    if (tag === "script" || tag === "style" || tag === "template") return "";
    if (tag === "img") return ` ${node.getAttribute("alt") || ""} `;
    if (tag === "select") return ` ${Array.from(node.selectedOptions || []).map((option) => option.text).join(" ")} `;
    if (tag === "textarea") return ` ${node.value} `;
    if (tag === "input") return ["radio", "checkbox", "hidden", "file"].includes(typeOf(node)) ? "" : ` ${node.value || ""} `;
    let out = "";
    for (const child of Array.from(node.childNodes)) out += contentOf(child, skip);
    return out;
  };
  const byIds = (element, attribute) =>
    text(element.getAttribute(attribute))
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  const legendOf = (element) => Array.from(element.children).find((child) => child.localName === "legend") || null;
  const nameOf = (element) => {
    const labelledBy = text(byIds(element, "aria-labelledby").map((node) => contentOf(node, element)).join(" "));
    if (labelledBy) return labelledBy;
    const label = text(element.getAttribute("aria-label"));
    if (label) return label;
    const labels = element.labels ? text(Array.from(element.labels).map((node) => contentOf(node, element)).join(" ")) : "";
    if (labels) return labels;
    if (element.localName === "fieldset" && legendOf(element)) return text(contentOf(legendOf(element), null));
    if (element.localName === "input" && BUTTON_TYPES.includes(typeOf(element))) {
      return text(typeOf(element) === "image" ? element.getAttribute("alt") : element.value) || text(element.getAttribute("title"));
    }
    if (FROM_CONTENT.includes(roleOf(element))) {
      const content = text(contentOf(element, null));
      if (content) return content;
    }
    return text(element.getAttribute("title"));
  };
  const disabled = (element) =>
    (typeof element.matches === "function" && element.matches(":disabled")) || element.getAttribute("aria-disabled") === "true";
  // A checkbox, a radio or a switch reads as checked (true), not (false) or `mixed`.
  const TOGGLES = ["checkbox", "radio", "switch"];
  const checkedOf = (element) => {
    if (element.localName === "input" && ["checkbox", "radio"].includes(typeOf(element))) return element.indeterminate ? "mixed" : element.checked;
    const state = text(element.getAttribute("aria-checked")).toLowerCase();
    return state === "mixed" ? "mixed" : state === "true";
  };
  const listOf = (names) => {
    const unique = Array.from(new Set(names));
    return { names: unique.slice(0, query.listed), more: Math.max(0, unique.length - query.listed) };
  };
  const mark = (element, value) => element.setAttribute(query.attribute, value);

  // A card, and the named parts of a page a control can sit in, innermost first.
  const CARD = "article, [role='article'], [data-slot='card'], [data-slot$='-card']";
  const TITLE = "[data-slot$='card-name'], [data-slot$='card-title'], h1, h2, h3, h4, h5, h6, [role='heading']";
  const PARTS = [
    ["dialog", "dialog, [role='dialog'], [role='alertdialog']"],
    ["card", CARD],
    ["row", "tr, [role='row']"],
    ["list item", "li, [role='listitem']"],
    ["group", "fieldset, [role='group'], [role='radiogroup'], [role='toolbar'], [role='tablist']"],
    ["menu", "[role='menu'], [role='menubar']"],
    ["form", "form"],
    ["navigation", "nav, [role='navigation']"],
    ["region", "section, aside, main, header, footer, [role='region'], [role='tabpanel']"],
  ];
  const titleOf = (part) => {
    const own = text(byIds(part, "aria-labelledby").map((node) => contentOf(node, null)).join(" ")) || text(part.getAttribute("aria-label"));
    if (own) return own;
    if (part.localName === "fieldset" && legendOf(part)) return text(contentOf(legendOf(part), null));
    const title = part.querySelector(TITLE);
    return title ? text(contentOf(title, null)) : "";
  };
  const partOf = (element) => {
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const part = PARTS.find(([, selector]) => node.matches(selector));
      const title = part ? titleOf(node) : "";
      if (title) return { kind: part[0], title };
    }
    return null;
  };
  // Of several matches, one inside another is the same thing named twice: the innermost stands.
  const innermost = (found) => found.filter((one) => !found.some((other) => other !== one && one.element.contains(other.element)));
  const CONTROLS = "a[href], area[href], button, input, select, textarea, [role]";
  const controlsIn = (root, roles) => Array.from(root.querySelectorAll(CONTROLS)).filter((element) => roles.includes(roleOf(element)) && exposed(element));
  const describe = (element) => {
    let href = null;
    if (element.localName === "a" && element.hasAttribute("href")) {
      try {
        const url = new URL(element.getAttribute("href"), location.href);
        href = { origin: url.origin, path: url.pathname };
      } catch {
        href = null;
      }
    }
    const role = roleOf(element);
    return { role, part: partOf(element), disabled: disabled(element), href, checked: TOGGLES.includes(role) ? checkedOf(element) : null };
  };
  // The controls of the press query's role and those of its name: within the one
  // shown part of the page named `within` when it names one, and none when no
  // part or several parts carry that name.
  const pressable = () => {
    let root = document;
    let scope = null;
    if (query.within) {
      const parts = Array.from(document.querySelectorAll(PARTS.map(([, selector]) => selector).join(", ")))
        .filter(exposed)
        .map((element) => ({ element, kind: PARTS.find(([, selector]) => element.matches(selector))[0], name: titleOf(element) }))
        .filter((part) => part.name);
      const found = innermost(parts.filter((part) => part.name === query.within));
      scope = {
        found: found.length,
        kind: found.length === 1 ? found[0].kind : "",
        parts: listOf(parts.map((part) => part.name)),
        matches: found.map((part) => ({ kind: part.kind, part: partOf(part.element) })),
      };
      if (found.length !== 1) return { scope, controls: [], matches: [] };
      root = found[0].element;
    }
    const controls = controlsIn(root, [query.role]);
    return { scope, controls, matches: controls.filter((element) => nameOf(element) === query.name) };
  };
  const LIVE = "[role='status'], [role='alert'], [aria-live], [data-sonner-toast]";
  const liveTexts = () =>
    Array.from(document.querySelectorAll(LIVE))
      .filter((element) => shown(element) && element.getAttribute("aria-live") !== "off")
      .map((element) => text(contentOf(element, null)))
      .filter(Boolean);

  if (query.mode === "press") {
    const { scope, controls, matches } = pressable();
    if (matches.length === 1 && !disabled(matches[0])) mark(matches[0], query.mark);
    return { path: location.pathname, scope, present: listOf(controls.map(nameOf)), matches: matches.map(describe) };
  }

  if (query.mode === "checked") {
    const control = document.querySelector(`[${query.attribute}="${query.mark}"]`);
    return { path: location.pathname, checked: control ? checkedOf(control) : null };
  }

  if (query.mode === "card") {
    const cards = Array.from(document.querySelectorAll(CARD))
      .filter(exposed)
      .map((element) => ({ element, name: titleOf(element) }));
    const found = innermost(cards.filter((card) => card.name === query.card));
    const read = { path: location.pathname, cards: listOf(cards.map((card) => card.name)), found: found.length };
    if (found.length !== 1) return read;
    const controls = controlsIn(found[0].element, ["button", "link"]);
    const matches = controls.filter((element) => nameOf(element) === query.control);
    if (matches.length === 1 && !disabled(matches[0])) mark(matches[0], query.mark);
    return { ...read, controls: listOf(controls.map(nameOf)), matches: matches.map(describe) };
  }

  if (query.mode === "picker") {
    const radiosOf = (group) => Array.from(group.querySelectorAll("input, [role='radio']")).filter((element) => roleOf(element) === "radio" && exposed(element));
    const optionsOf = (list) => Array.from(list.querySelectorAll("[role='option']")).filter(exposed).map((element) => ({ element, name: nameOf(element) }));
    const kindOf = (element) => {
      if (element.localName === "select") return "select";
      const role = roleOf(element);
      if (role === "combobox") return element.localName === "input" ? "" : "combobox";
      if (role === "listbox") return "listbox";
      if (role === "radiogroup" || role === "group") return radiosOf(element).length > 0 ? "radiogroup" : "";
      return "";
    };
    const pickers = Array.from(document.querySelectorAll("select, [role='combobox'], [role='listbox'], [role='radiogroup'], fieldset, [role='group']"))
      .filter(exposed)
      .map((element) => ({ element, kind: kindOf(element) }))
      .filter((picker) => picker.kind)
      .map((picker) => ({ ...picker, name: nameOf(picker.element) }));
    // A combobox with no accessible name shows its placeholder (the shared select
    // marks it `data-placeholder`) until it holds a value, and then that value.
    const placeholderOf = (element) => (element.hasAttribute("data-placeholder") ? text(contentOf(element, null)) : "");
    const valueOf = (element) => (element.hasAttribute("data-placeholder") ? "" : text(contentOf(element, null)));
    // The label element before a combobox in its form group, the nearest element
    // that holds one before it: a label of no other control, with no other shown
    // field between the two.
    const FIELD_ROLES = ["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton"];
    const isField = (node) => (["input", "select", "textarea"].includes(node.localName) ? typeOf(node) !== "hidden" : FIELD_ROLES.includes(roleOf(node)));
    const before = (node, other) => Boolean(node.compareDocumentPosition(other) & 4);
    const labelBefore = (element) => {
      for (let group = element.parentElement; group; group = group.parentElement) {
        const labels = Array.from(group.querySelectorAll("label")).filter((label) => before(label, element));
        if (labels.length === 0) continue;
        const label = labels[labels.length - 1];
        if (label.control || !shown(label)) return "";
        const fields = Array.from(group.querySelectorAll("input, select, textarea, [role]"));
        const between = fields.some((node) => node !== element && before(label, node) && before(node, element) && isField(node) && exposed(node));
        return between ? "" : text(contentOf(label, null));
      }
      return "";
    };
    const ROADS = [
      ["placeholder", placeholderOf],
      ["value", valueOf],
      ["label", labelBefore],
    ];
    // Once the step has opened a combobox, it reads it by the mark it put on it
    // before, never by a name: while the list is open, the shared select hides
    // everything outside it from assistive technology, the combobox included.
    const markedPicker = () => {
      const element = document.querySelector(`[${query.attribute}="${query.mark}p"]`);
      const kind = element ? kindOf(element) : "";
      return kind ? [{ element, kind }] : [];
    };
    let by = query.marked ? "mark" : "name";
    let found = query.marked ? markedPicker() : innermost(pickers.filter((picker) => picker.name === query.picker));
    if (found.length === 0 && !query.marked) {
      const unnamed = pickers.filter((picker) => picker.kind === "combobox" && picker.name === "");
      for (const [road, standIn] of ROADS) {
        const matched = unnamed.filter((picker) => standIn(picker.element) === query.picker);
        if (matched.length > 0) {
          by = road;
          found = matched;
          break;
        }
      }
    }
    const read = { path: location.pathname, pickers: listOf(pickers.map((picker) => picker.name)), found: found.length, by };
    if (found.length !== 1) return read;
    const { element: picker, kind } = found[0];
    mark(picker, `${query.mark}p`);
    let entries = [];
    let open = true;
    if (kind === "select") {
      entries = Array.from(picker.options).map((element, index) => ({ element, name: text(element.label || element.text), index }));
    } else if (kind === "listbox") {
      entries = optionsOf(picker);
    } else if (kind === "radiogroup") {
      entries = radiosOf(picker).map((element) => ({ element, name: nameOf(element) }));
    } else {
      // A combobox's entries are those of the list it controls, once that list is shown.
      const list = [...byIds(picker, "aria-controls"), ...byIds(picker, "aria-owns")]
        .map((node) => (roleOf(node) === "listbox" ? node : node.querySelector("[role='listbox']")))
        .find((node) => node && exposed(node));
      open = Boolean(list);
      entries = list ? optionsOf(list) : [];
    }
    const matches = entries.filter((entry) => entry.name === query.entry);
    const chosen = matches.length === 1 ? matches[0] : null;
    if (chosen && kind !== "select") mark(chosen.element, `${query.mark}e`);
    return {
      ...read,
      kind,
      open,
      disabled: disabled(picker),
      entries: listOf(entries.map((entry) => entry.name)),
      entryFound: matches.length,
      entryDisabled: chosen ? disabled(chosen.element) : false,
      index: chosen && kind === "select" ? chosen.index : -1,
      native: Boolean(chosen && chosen.element.localName === "input"),
      live: liveTexts(),
    };
  }

  if (query.mode === "reflected") {
    const picker = document.querySelector(`[${query.attribute}="${query.mark}p"]`);
    const entry = document.querySelector(`[${query.attribute}="${query.mark}e"]`);
    let state = false;
    if (query.kind === "select") {
      state = Boolean(picker && picker.options && picker.options[query.index] && picker.options[query.index].selected);
    } else if (entry) {
      state =
        entry.localName === "input"
          ? entry.checked
          : entry.getAttribute("aria-selected") === "true" || entry.getAttribute("aria-checked") === "true" || entry.getAttribute("data-state") === "checked";
    }
    // A combobox shows the entry it holds; its list may be gone once the choice is made.
    if (!state && query.kind === "combobox" && picker) state = text(contentOf(picker, null)) === query.entry;
    const confirmation = liveTexts().find((line) => line.includes(query.entry) && !query.before.includes(line)) || "";
    return { path: location.pathname, state, confirmation };
  }

  if (query.mode === "composer") {
    const boxes = controlsIn(document, ["textbox", "searchbox"]);
    const matches = boxes.filter((element) => nameOf(element) === query.composer);
    const sends = controlsIn(document, ["button"]).filter((element) => nameOf(element) === query.composer);
    if (matches.length === 1) mark(matches[0], `${query.mark}t`);
    if (sends.length === 1) mark(sends[0], `${query.mark}s`);
    return { path: location.pathname, boxes: listOf(boxes.map(nameOf)), found: matches.length, sends: sends.length };
  }

  throw new Error("readControls: no such mode");
}

/** Removes the mark `mark` (and the marks that start with it) from the page. */
export function unmarkControls({ attribute, mark }) {
  for (const element of Array.from(document.querySelectorAll(`[${attribute}]`))) {
    if (String(element.getAttribute(attribute)).startsWith(mark)) element.removeAttribute(attribute);
  }
  return true;
}

/**
 * The document a press starts from: `set` notes this document under `key`, and
 * a later reading says whether the page still shows the same one, its path and
 * its load state. A new document never carries the note.
 */
export function readDocument({ key, set }) {
  if (set) window[key] = true;
  return { same: window[key] === true, path: location.pathname, state: document.readyState };
}

/** Removes the note of `key` from this document, when it still carries it. */
export function forgetDocument({ key }) {
  delete window[key];
  return true;
}
