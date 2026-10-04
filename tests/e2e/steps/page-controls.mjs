// What the control steps share (press, pressByTestId, selectFrom, dispatchRun,
// readControlNames, and the window steps typeInWindow, waitForTurn and
// sendInComposer): the page's controls, read in the page by their role and
// their browser-computed accessible name (and, for pressByTestId, the elements of a test id);
// the mark a step puts on the one control it acts on; and the reading of the
// document a press starts from.
//
// A CONTROL IS FOUND AS A PERSON WITH A SCREEN READER FINDS IT: by its role (a
// button, a link, a tab, a radio, an option) and its accessible name, read from
// Chromium's accessibility tree through Playwright. Only a shown control counts:
// attached, drawn, inside nothing hidden, and not hidden from assistive
// technology (`aria-hidden`), as a picker's hidden native twin is. Names are
// compared whole, after runs of white space are made one space; when no name
// reads the same, a name that reads the same once all white space is removed
// matches, as parts drawn with no white space between them read ("3Select blog
// idea" for "3 Select blog idea"). A name that reads the same exactly wins.
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

/** Read names and their winning sources from Chromium's accessibility tree.
 * CDP is the platform reading exposed by Playwright; unsupported drivers throw
 * and the calling step reports its ordinary driver-failure. No DOM-name fallback.
 * Backend node ids resolve to actual elements, never an index or a name match,
 * so two identically named controls remain two controls. The remote handles and
 * the session belong to this reading only and leave no attributes on the page.
 */
export async function readPageControls(page, query) {
  const context = page.context();
  const browser = context.browser()?.browserType?.().name();
  if (typeof context.newCDPSession !== "function" || (browser && browser !== "chromium")) {
    const error = new Error("Control-name readings require Chromium's accessibility tree");
    error.name = "UnsupportedBrowserError";
    throw error;
  }
  const session = await context.newCDPSession(page);
  const objectGroup = `step-controls-${randomUUID()}`;
  try {
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    const { object: document } = await session.send("DOM.resolveNode", { backendNodeId: root.backendNodeId, objectGroup });
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    // Text fragments carry backend ids too, but only DOM elements can be the
    // controls/parts this reader selects. Their names already include fragments.
    const elements = nodes.filter((node) => !node.ignored && node.backendDOMNodeId && node.name && !["StaticText", "InlineTextBox", "LineBreak"].includes(node.role?.value));
    const names = elements.map((node) => {
      const name = plainName(node.name.value);
      const source = node.name.sources?.find((one) => !one.superseded && !one.invalid && one.value !== undefined);
      let from = "";
      if (name) {
        if (["aria-labelledby", "aria-label", "title"].includes(source?.attribute)) from = source.attribute;
        else if (["label", "labelfor", "labelwrapped", "legend"].includes(source?.nativeSource)) from = "label";
        else if (source?.type === "placeholder") from = "placeholder";
        else from = "text";
      }
      return { name, from };
    });
    const handles = await Promise.all(elements.map(async (node) => {
      const { object } = await session.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId, objectGroup });
      if (!object.objectId) throw new Error("The accessibility node no longer resolves");
      return { objectId: object.objectId };
    }));
    const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
      objectId: document.objectId,
      functionDeclaration: `function(query, names, ...elements) {
        if (this !== document) throw new Error("The accessibility document changed");
        const accessibility = new Map();
        elements.forEach((element, index) => {
          if (!element.isConnected || (element !== document && element.ownerDocument !== document))
            throw new Error("The accessibility document changed");
          accessibility.set(element, names[index]);
        });
        return (${readControls.toString()})(query, accessibility);
      }`,
      arguments: [{ value: query }, { value: names }, ...handles],
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error("The browser could not read its controls");
    return result.value;
  } finally {
    // Detach even if a navigation already destroyed the object group.
    try {
      await session.send("Runtime.releaseObjectGroup", { objectGroup });
    } finally {
      await session.detach();
    }
  }
}

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
 * A name read from the page, for a line: an address in it is written as "an
 * address", since a line never carries one.
 * @param {string} name
 */
export const withoutAddress = (name) => String(name).replace(/\b[a-z][a-z\d+.-]*:\/\/\S*/gi, "an address");

/**
 * A name read from the page, for a line: without an address, without double
 * quotes, at most NAME_LENGTH characters, and quoted; a control without a name
 * is said to be one.
 * @param {string} name
 */
export function quotedName(name) {
  if (!name) return "one without a name";
  const plain = withoutAddress(name).replace(/"/g, "'");
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

/**
 * For a refusal of several matches of one wanted name: when they matched only
 * once white space is removed, how the page reads their names, since none of
 * them reads as the name wanted.
 * @param {boolean} unspaced
 * @param {{ names: string[], more: number }} named
 */
export const unspacedNote = (unspaced, named) => (unspaced ? ` once white space is removed (the page reads ${describeNames(named)})` : "");

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
 *   - `picker`: the shown pickers (a select, a combobox, a search field, a
 *     listbox, a radio group) and those named `picker`, and in the one picker,
 *     its entries and those whose text is `entry`; a combobox's entries, and a
 *     search field's, are those of the list it controls, once that list is
 *     shown, and a search list names each by its row's first text. When no
 *     picker is named `picker`, a combobox or a search field with no accessible
 *     name is found by the text that stands in for its name, road by road
 *     (`by`): the placeholder it shows, the value it shows, or the label element
 *     before it in its form group. With `marked`, the picker is the one that
 *     carries the mark, by no name (`by` is `mark`). For a search field whose
 *     list is shown, `drawn` counts the texts the page draws for each entry of
 *     the list, for the reading after the choice. `shows` is the entry the
 *     picker shows as chosen (a select's selected option, a radio group's
 *     checked radio, a listbox's first option marked selected or checked, a
 *     combobox's own text, empty while it shows its placeholder, and a search
 *     field's value), or the empty string when it shows none;
 *   - `reflected`: whether the marked entry reads as selected, and the text of
 *     a live region that names `entry` and was not there before (`before`); for
 *     a search field, whether the field (its list closed) or a text the page
 *     draws beyond `drawn` shows `entry`, or another entry of the list instead;
 *   - `composer`: the shown text boxes and those named `composer`, and the shown
 *     buttons of that same name, the composer's send control;
 *   - `names`: every shown control of the page, or of the one shown part of
 *     the page named `within` (found as `press` finds it, and `scope` as it
 *     comes back there), in the page's order: its role, its name, where the
 *     name comes from (`from`) and the text `aria-describedby` names; at most
 *     `limit` of them, and `more` counts the rest. Beside the roles of controls
 *     it reads the parts a person moves between: a region (a section with a
 *     name), a group, a dialog or an alert dialog, a form with a name, a
 *     navigation and a search landmark. A control without a name is read with
 *     an empty name;
 *   - `window`: the shown text boxes (role textbox) and those named `field`,
 *     within the one shown part of the page named `within` when the query
 *     names one (found as `press` finds it). For the one box: whether it takes
 *     text (`editable`: a text field neither disabled nor read-only, or an
 *     element whose content is editable, and not marked disabled or read-only
 *     for assistive technology), the text it holds (`text`, a non-breaking
 *     space read as a space), and its send control: the shown buttons of the
 *     box's own name, looked for from the box outwards and taken from the
 *     nearest part of the page that holds one (`sends` counts them there), and
 *     the names of the shown buttons nearest to the box (`beside`). With a
 *     `mark`, the box takes it (`<mark>t`), and so does the send control when
 *     there is one (`<mark>s`); the marks of an earlier reading of the same
 *     act come off first. `entries` counts the shown elements that carry the
 *     `entry` attribute, `person` and `assistant` apart, in the same part of
 *     the page. `note` keeps a count in the page's document for the wait that
 *     follows a send, under `noteKey`, by the field and the part: `set` notes
 *     the counts of this reading, `forget` removes the note; `noted` is the
 *     note there is, or null;
 *   - `testid`: the shown elements that carry the test id `testId` in the
 *     attribute `testIdAttribute`, within the one shown part of the page named
 *     `within` when the query names one (found as `press` finds it), and those
 *     whose own text is `text`: the text the element draws (its text nodes,
 *     without a hidden part, a script or a style), runs of white space made one
 *     space, compared whole. Each match comes back with its role, and, for a
 *     role of `roles`, its accessible name. The one match takes the mark when
 *     it carries no role of `roles` with a name: such a control is `press`'s.
 * Lists of names come back bounded: `{ names, more }`.
 */
function readControls(query, accessibility) {
  const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  // THE ONE COMPARISON of a wanted name with the names the page reads, for every
  // step and every scope. A name names a candidate when both read the same, runs
  // of white space made one space; or, when no candidate reads the same, when
  // both read the same once all white space is removed, as parts drawn with no
  // white space between them read ("3Select blog idea" for "3 Select blog
  // idea"). A name that reads the same exactly wins. `unspaced` says that the
  // candidates found read the same only without white space.
  const squeezed = (value) => String(value == null ? "" : value).replace(/\s+/g, "");
  const readsAs = (name, wanted, unspaced) => (unspaced ? squeezed(wanted) !== "" && squeezed(name) === squeezed(wanted) : name === wanted);
  const matching = (candidates, nameOfCandidate, wanted) => {
    for (const unspaced of [false, true]) {
      const found = candidates.filter((candidate) => readsAs(nameOfCandidate(candidate), wanted, unspaced));
      if (found.length > 0) return { found, unspaced };
    }
    return { found: [], unspaced: false };
  };
  const sameName = (name, wanted) => matching([name], (one) => one, wanted).found.length > 0;
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
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      return ["", "text", "email", "tel", "url"].includes(type) ? "textbox" : "";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (tag === "option") return "option";
    if (tag === "fieldset") return "group";
    if (tag === "nav") return "navigation";
    if (tag === "dialog") return "dialog";
    if (tag === "search") return "search";
    // A section is a region, and a form a form, only once it has a name.
    if (tag === "section") return namedBy(element, "region").name ? "region" : "";
    if (tag === "form") return namedBy(element, "form").name ? "form" : "";
    return "";
  };
  const FROM_CONTENT = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "radio", "checkbox", "switch", "treeitem"];
  // The roles of a field: what a person fills in, picks from or sets.
  const FIELD_ROLES = ["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton"];
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
  // The browser, not a second implementation of the accessible-name algorithm,
  // owns this value. Missing AX entries are unnamed, never a DOM-text fallback.
  const namedBy = (element) => accessibility.get(element) || { name: "", from: "" };
  const nameOf = (element) => namedBy(element).name;
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
    const computed = namedBy(part);
    if (computed.name && ["aria-labelledby", "aria-label", "label"].includes(computed.from)) return computed.name;
    const own = text(byIds(part, "aria-labelledby").map((node) => contentOf(node, null)).join(" ")) || text(part.getAttribute("aria-label"));
    if (own) return own;
    if (part.localName === "fieldset" && legendOf(part)) return text(contentOf(legendOf(part), null));
    const title = part.querySelector(TITLE);
    return title ? nameOf(title) || text(contentOf(title, null)) : "";
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
  // The one shown part of the page named `within` (a landmark, or a section
  // named by its label or its heading): `root` is that part, or null when no
  // part or several parts carry the name, and `scope` says how many carry it,
  // where each sits, and the named parts the page shows.
  const scopeOf = (within) => {
    const parts = Array.from(document.querySelectorAll(PARTS.map(([, selector]) => selector).join(", ")))
      .filter(exposed)
      .map((element) => ({ element, kind: PARTS.find(([, selector]) => element.matches(selector))[0], name: titleOf(element) }))
      .filter((part) => part.name);
    const match = matching(parts, (part) => part.name, within);
    const found = innermost(match.found);
    return {
      root: found.length === 1 ? found[0].element : null,
      scope: {
        found: found.length,
        kind: found.length === 1 ? found[0].kind : "",
        parts: listOf(parts.map((part) => part.name)),
        matches: found.map((part) => ({ kind: part.kind, part: partOf(part.element) })),
        unspaced: match.unspaced,
        named: listOf(found.map((part) => part.name)),
      },
    };
  };
  // The controls of the press query's role and those of its name: within the one
  // shown part of the page named `within` when it names one, and none when no
  // part or several parts carry that name.
  const pressable = () => {
    let root = document;
    let scope = null;
    if (query.within) {
      ({ root, scope } = scopeOf(query.within));
      if (!root) return { scope, controls: [], matches: [], unspaced: false };
    }
    const controls = controlsIn(root, [query.role]);
    const { found, unspaced } = matching(controls, nameOf, query.name);
    return { scope, controls, matches: found, unspaced };
  };
  // The list a combobox or a search field controls (`aria-controls`, `aria-owns`), while it is shown.
  const controlledList = (element) =>
    [...byIds(element, "aria-controls"), ...byIds(element, "aria-owns")]
      .map((node) => (roleOf(node) === "listbox" ? node : node.querySelector("[role='listbox']")))
      .find((node) => node && exposed(node)) || null;
  // A search list draws each entry as a row: the entry's name first, then what
  // tells it apart (a detail line, a status). The row is named by that first
  // text, unless it is named on its own (`aria-labelledby`, `aria-label`).
  const firstTextOf = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let hidden = false;
      for (let at = node.parentElement; at && at !== element; at = at.parentElement) {
        if (at.hasAttribute("hidden") || at.getAttribute("aria-hidden") === "true" || ["script", "style", "template"].includes(at.localName)) hidden = true;
      }
      if (!hidden && text(node.nodeValue)) return text(node.nodeValue);
    }
    return "";
  };
  const rowNameOf = (element) =>
    ((element.hasAttribute("aria-labelledby") || element.hasAttribute("aria-label")) && nameOf(element)) || firstTextOf(element);
  // How many shown texts of the page read as each of `names`, outside `field`,
  // the list it controls and every option: what a page draws for a choice (a
  // row, a chip), counted before the choice and after it.
  const drawnCounts = (names, field) => {
    const list = field ? controlledList(field) : null;
    const counts = names.map(() => 0);
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = names.indexOf(text(node.nodeValue));
      const parent = node.parentElement;
      if (at < 0 || !parent || parent.closest("script, style, template, [role='option']")) continue;
      if ((field && field.contains(parent)) || (list && list.contains(parent)) || !shown(parent)) continue;
      counts[at] += 1;
    }
    return counts;
  };
  const LIVE = "[role='status'], [role='alert'], [aria-live], [data-sonner-toast]";
  const liveTexts = () =>
    Array.from(document.querySelectorAll(LIVE))
      .filter((element) => shown(element) && element.getAttribute("aria-live") !== "off")
      .map((element) => text(contentOf(element, null)))
      .filter(Boolean);

  if (query.mode === "press") {
    const { scope, controls, matches, unspaced } = pressable();
    if (matches.length === 1 && !disabled(matches[0])) mark(matches[0], query.mark);
    return { path: location.pathname, scope, present: listOf(controls.map(nameOf)), matches: matches.map(describe), unspaced, named: listOf(matches.map(nameOf)) };
  }

  if (query.mode === "checked") {
    const control = document.querySelector(`[${query.attribute}="${query.mark}"]`);
    return { path: location.pathname, checked: control ? checkedOf(control) : null };
  }

  if (query.mode === "card") {
    const cards = Array.from(document.querySelectorAll(CARD))
      .filter(exposed)
      .map((element) => ({ element, name: titleOf(element) }));
    const cardMatch = matching(cards, (card) => card.name, query.card);
    const found = innermost(cardMatch.found);
    const read = {
      path: location.pathname,
      cards: listOf(cards.map((card) => card.name)),
      found: found.length,
      unspaced: cardMatch.unspaced,
      named: listOf(found.map((card) => card.name)),
    };
    if (found.length !== 1) return read;
    const controls = controlsIn(found[0].element, ["button", "link"]);
    const { found: matches, unspaced } = matching(controls, nameOf, query.control);
    if (matches.length === 1 && !disabled(matches[0])) mark(matches[0], query.mark);
    return { ...read, controls: listOf(controls.map(nameOf)), matches: matches.map(describe), controlUnspaced: unspaced, controlNamed: listOf(matches.map(nameOf)) };
  }

  if (query.mode === "picker") {
    const radiosOf = (group) => Array.from(group.querySelectorAll("input, [role='radio']")).filter((element) => roleOf(element) === "radio" && exposed(element));
    const optionsOf = (list, named = nameOf) =>
      Array.from(list.querySelectorAll("[role='option']"))
        .filter(exposed)
        .map((element) => ({ element, name: named(element) }));
    const kindOf = (element) => {
      if (element.localName === "select") return "select";
      const role = roleOf(element);
      // A combobox that is a text input is a search field: its list opens once text is typed into it.
      if (role === "combobox") return element.localName === "input" ? "search" : "combobox";
      if (role === "listbox") return "listbox";
      if (role === "radiogroup" || role === "group") return radiosOf(element).length > 0 ? "radiogroup" : "";
      return "";
    };
    const pickers = Array.from(document.querySelectorAll("select, [role='combobox'], [role='listbox'], [role='radiogroup'], fieldset, [role='group']"))
      .filter(exposed)
      .map((element) => ({ element, kind: kindOf(element) }))
      .filter((picker) => picker.kind)
      .map((picker) => ({ ...picker, name: nameOf(picker.element) }));
    // A combobox without an explicit accessible name shows its placeholder (the shared select
    // marks it `data-placeholder`) until it holds a value, and then that value. A
    // search field shows its own placeholder while it is empty, and then its text.
    const placeholderOf = (element) => {
      if (element.localName === "input") return text(element.value) ? "" : text(element.getAttribute("placeholder"));
      return element.hasAttribute("data-placeholder") ? text(contentOf(element, null)) : "";
    };
    const valueOf = (element) => {
      if (element.localName === "input") return text(element.value);
      return element.hasAttribute("data-placeholder") ? "" : text(contentOf(element, null));
    };
    // The label element before a combobox in its form group, the nearest element
    // that holds one before it: a label of no other control, with no other shown
    // field between the two.
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
    let found = query.marked ? markedPicker() : [];
    let unspaced = false;
    let named = listOf([]);
    if (!query.marked) {
      // By its name, then by the text that stands in for one, road by road: a
      // reading that is the same exactly, on any of them, wins over one that is
      // the same only once white space is removed.
      const unnamed = pickers.filter((picker) =>
        (picker.kind === "combobox" || picker.kind === "search") && (picker.name === "" || namedBy(picker.element).from === "placeholder"),
      );
      tiers: for (const loose of [false, true]) {
        found = innermost(pickers.filter((picker) => readsAs(picker.name, query.picker, loose)));
        if (found.length > 0) {
          unspaced = loose;
          named = listOf(found.map((picker) => picker.name));
          break;
        }
        for (const [road, standIn] of ROADS) {
          const matched = unnamed.filter((picker) => readsAs(standIn(picker.element), query.picker, loose));
          if (matched.length > 0) {
            by = road;
            found = matched;
            unspaced = loose;
            named = listOf(matched.map((picker) => standIn(picker.element)));
            break tiers;
          }
        }
      }
    }
    const read = {
      path: location.pathname, pickers: listOf(pickers.map((picker) => picker.name)), found: found.length, by, unspaced, named,
      // Placeholder-derived platform names do not remove the established
      // shown-value / preceding-label road, but its record must tell the truth.
      fallbackNamed: by !== "name" && by !== "mark" && found.some((picker) => picker.name !== ""),
    };
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
      // A combobox's entries, and a search field's, are those of the list it
      // controls, once that list is shown; a search list names each by its row.
      const list = controlledList(picker);
      open = Boolean(list);
      entries = list ? optionsOf(list, kind === "search" ? rowNameOf : nameOf) : [];
    }
    const { found: matches, unspaced: entryUnspaced } = matching(entries, (entry) => entry.name, query.entry);
    const chosen = matches.length === 1 ? matches[0] : null;
    if (chosen && kind !== "select") {
      // One entry carries the mark: a list read again may have drawn its rows anew.
      for (const other of Array.from(document.querySelectorAll(`[${query.attribute}="${query.mark}e"]`))) other.removeAttribute(query.attribute);
      mark(chosen.element, `${query.mark}e`);
    }
    // What the page draws for each entry of a search field's list, before the choice.
    const names = Array.from(new Set(entries.map((entry) => entry.name)));
    // The entry the picker shows as chosen: a select's selected option, a radio
    // group's checked radio, a listbox's first option marked selected or checked,
    // a combobox's or a search field's own text.
    let shows = "";
    if (kind === "select") {
      const option = picker.selectedOptions && picker.selectedOptions[0];
      shows = option ? text(option.label || option.text) : "";
    } else if (kind === "radiogroup") {
      const radio = entries.find((entry) => checkedOf(entry.element) === true);
      shows = radio ? radio.name : "";
    } else if (kind === "listbox") {
      const option = entries.find((entry) => entry.element.getAttribute("aria-selected") === "true" || entry.element.getAttribute("aria-checked") === "true");
      shows = option ? option.name : "";
    } else {
      shows = valueOf(picker);
    }
    return {
      ...read,
      kind,
      open,
      disabled: disabled(picker),
      entries: listOf(entries.map((entry) => entry.name)),
      entryFound: matches.length,
      entryUnspaced,
      entryNamed: listOf(matches.map((entry) => entry.name)),
      // The one entry's name as the page reads it: the reading after the choice looks for that.
      chosen: chosen ? chosen.name : "",
      entryDisabled: chosen ? disabled(chosen.element) : false,
      index: chosen && kind === "select" ? chosen.index : -1,
      native: Boolean(chosen && chosen.element.localName === "input"),
      live: liveTexts(),
      drawn: kind === "search" && open ? { names, counts: drawnCounts(names, picker) } : null,
      shows,
    };
  }

  if (query.mode === "reflected") {
    const picker = document.querySelector(`[${query.attribute}="${query.mark}p"]`);
    if (query.kind === "search") {
      // A search field's choice is read back from the page, never from its list:
      // the row a list marks selected is its active one, which a key press would
      // choose. The field shows the entry once its list has closed, or the page
      // draws it (a row, a chip) more often than before; the field or the page
      // showing another entry of the list is a choice taken otherwise (`instead`).
      const { names, counts } = query.drawn || { names: [], counts: [] };
      const now = drawnCounts(names, picker);
      const grew = names.map((name, at) => now[at] > counts[at]);
      const closed = !picker || !controlledList(picker);
      const value = picker && picker.localName === "input" ? text(picker.value) : "";
      const other = names.find((name, at) => name !== query.entry && grew[at]);
      let instead = null;
      let shows = "";
      if (other !== undefined) instead = { where: "page", text: other };
      else if (closed && value !== "" && value !== query.entry) instead = { where: "field", text: value };
      else if (grew[names.indexOf(query.entry)]) shows = "page";
      else if (closed && value === query.entry) shows = "field";
      return { path: location.pathname, state: shows !== "", shows, instead, confirmation: "" };
    }
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
    if (!state && query.kind === "combobox" && picker) state = sameName(text(contentOf(picker, null)), query.entry);
    // A live region names the entry when it holds it, white space aside: the page spells it in its own words.
    const confirmation = liveTexts().find((line) => squeezed(line).includes(squeezed(query.entry)) && !query.before.includes(line)) || "";
    return { path: location.pathname, state, confirmation };
  }

  if (query.mode === "composer") {
    const boxes = controlsIn(document, ["textbox", "searchbox"]);
    const { found: matches, unspaced } = matching(boxes, nameOf, query.composer);
    const { found: sends, unspaced: sendsUnspaced } = matching(controlsIn(document, ["button"]), nameOf, query.composer);
    if (matches.length === 1) mark(matches[0], `${query.mark}t`);
    if (sends.length === 1) mark(sends[0], `${query.mark}s`);
    return {
      path: location.pathname,
      boxes: listOf(boxes.map(nameOf)),
      found: matches.length,
      unspaced,
      named: listOf(matches.map(nameOf)),
      sends: sends.length,
      sendsUnspaced,
      sendsNamed: listOf(sends.map(nameOf)),
    };
  }

  if (query.mode === "names") {
    // The roles a reading lists: those of the controls this reader knows, and
    // the parts of a page a person moves between.
    const LISTED = [...new Set([...FROM_CONTENT, ...FIELD_ROLES, "radiogroup", "group", "region", "dialog", "alertdialog", "form", "navigation", "search"])];
    let root = document;
    let scope = null;
    if (query.within) {
      ({ root, scope } = scopeOf(query.within));
      if (!root) return { path: location.pathname, scope, controls: [], more: 0 };
    }
    const found = [];
    for (const element of Array.from(root.querySelectorAll("*"))) {
      const role = roleOf(element);
      if (LISTED.includes(role) && exposed(element)) found.push({ element, role });
    }
    // A control without a name is read all the same, with an empty name.
    const controls = found.slice(0, query.limit).map(({ element, role }) => ({
      role,
      ...namedBy(element, role),
      description: text(byIds(element, "aria-describedby").map((node) => contentOf(node, element)).join(" ")),
    }));
    return { path: location.pathname, scope, controls, more: found.length - controls.length };
  }

  if (query.mode === "window") {
    // The marks of an earlier reading of the same act come off first: the page may have drawn the window anew.
    if (query.mark) {
      for (const node of Array.from(document.querySelectorAll(`[${query.attribute}]`))) {
        if (String(node.getAttribute(query.attribute)).startsWith(query.mark)) node.removeAttribute(query.attribute);
      }
    }
    let root = document;
    let scope = null;
    if (query.within) ({ root, scope } = scopeOf(query.within));
    // The window's entries, by the product's own marker: the person's and the assistant's apart.
    const entries = { person: 0, assistant: 0 };
    if (root) {
      for (const node of Array.from(root.querySelectorAll(`[${query.entry}]`))) {
        const who = node.getAttribute(query.entry);
        if ((who === "person" || who === "assistant") && shown(node)) entries[who] += 1;
      }
    }
    // The note a send leaves in the document for the wait that follows it, by the window it was sent in.
    const key = `${query.field}\n${query.within}`;
    const held = window[query.noteKey];
    const notes = held && typeof held === "object" ? held : {};
    const read = {
      path: location.pathname,
      scope,
      entries,
      noted: Object.hasOwn(notes, key) ? notes[key] : null,
      boxes: listOf([]),
      found: 0,
      unspaced: false,
      named: listOf([]),
      matches: [],
    };
    if (query.note === "forget") {
      delete notes[key];
      read.noted = null;
    }
    if (!root) return read;
    const boxes = controlsIn(root, ["textbox"]);
    const { found, unspaced } = matching(boxes, nameOf, query.field);
    Object.assign(read, { boxes: listOf(boxes.map(nameOf)), found: found.length, unspaced, named: listOf(found.map(nameOf)), matches: found.map(describe) });
    if (found.length !== 1) return read;
    const box = found[0];
    // It takes text: a text field neither disabled nor read-only, or an element whose content is editable.
    const editableOf = (element) => {
      if (disabled(element) || element.getAttribute("aria-readonly") === "true") return false;
      if (element.localName === "input" || element.localName === "textarea") return !element.readOnly;
      for (let node = element; node; node = node.parentElement) {
        const editable = node.getAttribute("contenteditable");
        if (editable !== null) return editable.toLowerCase() !== "false";
      }
      return false;
    };
    // The text it holds, as a person reads it: a non-breaking space is a space.
    const boxText = box.localName === "input" || box.localName === "textarea" ? box.value : box.textContent;
    // Its send control: the shown buttons of the box's own name, from the box outwards, at the nearest part that holds one.
    const boxName = nameOf(box);
    const top = root === document ? document.documentElement : root;
    let sends = [];
    let beside = null;
    for (let node = box.parentElement; node; node = node.parentElement) {
      const buttons = controlsIn(node, ["button"]);
      if (beside === null && buttons.length > 0) beside = buttons;
      const match = matching(buttons, nameOf, boxName).found;
      if (match.length > 0) {
        sends = match;
        break;
      }
      if (node === top) break;
    }
    if (query.mark) {
      mark(box, `${query.mark}t`);
      if (sends.length === 1) mark(sends[0], `${query.mark}s`);
    }
    if (query.note === "set") {
      notes[key] = entries;
      window[query.noteKey] = notes;
      read.noted = entries;
    }
    return {
      ...read,
      editable: editableOf(box),
      text: String(boxText || "").replace(/\u00a0/g, " "),
      sends: sends.length,
      beside: listOf((beside || []).map(nameOf)),
    };
  }

  if (query.mode === "testid") {
    let root = document;
    let scope = null;
    if (query.within) {
      ({ root, scope } = scopeOf(query.within));
      if (!root) return { path: location.pathname, scope, carriers: 0, texts: listOf([]), matches: [] };
    }
    // The text the element draws: its text nodes, without a hidden part, a script or a style.
    const drawnText = (element) => {
      let out = "";
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let drawn = getComputedStyle(node.parentElement).visibility !== "hidden";
        for (let at = node.parentElement; drawn && at && at !== element.parentElement; at = at.parentElement) {
          if (at.hasAttribute("hidden") || ["script", "style", "template"].includes(at.localName) || getComputedStyle(at).display === "none") drawn = false;
        }
        if (drawn) out += node.nodeValue;
      }
      return text(out);
    };
    // The attribute is compared as a value, never written into a selector.
    const carriers = Array.from(root.querySelectorAll(`[${query.testIdAttribute}]`)).filter(
      (element) => element.getAttribute(query.testIdAttribute) === query.testId && shown(element),
    );
    const texts = carriers.map(drawnText);
    const found = carriers.filter((element, at) => texts[at] === query.text);
    const matches = found.map((element) => {
      const described = describe(element);
      return { ...described, name: query.roles.includes(described.role) ? nameOf(element) : "" };
    });
    if (found.length === 1 && !(query.roles.includes(matches[0].role) && matches[0].name)) mark(found[0], query.mark);
    return { path: location.pathname, scope, carriers: carriers.length, texts: listOf(texts), matches };
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
