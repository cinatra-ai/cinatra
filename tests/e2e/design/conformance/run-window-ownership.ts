/** Positive prompt-marker guard shared by native controls and required conformance. */
export type WindowOwnershipReading = {
  rootPresent: boolean; windows: number; ownedWindows: number; unownedPrompts: number; malformedHolders: number; messageEditors: number;
  cards: number; promptsInCards: number; composers: number; composersInCards: number;
  notices: number; pageNotices: number; noticesInCards: number; noticeWindowBreaches: number;
};
// Self-contained so Playwright evaluates this exact reader in the page. Native
// tests run it on DOM produced by the real components — the fixtures route's
// hosts, the review route module and the run page's `SetupScreen` (cinatra#3487
// item 3) — and on adversarial DOM.
//
// THE WINDOW IS READ BY ITS OWN ANCHOR, `run-window` (cinatra#3487 item 3): the
// drawing of the run page's window (`app-artifact-review.html` §I.6) anchors it
// so, inside `[data-run-window-host="page-chrome"]`.
//
// THE ANCHOR IS THE NODE THAT ITSELF HOLDS EXACTLY ONE CONTROL. WHAT THIS DOES NOT
// READ, below, names the shapes outside this rule. A window is an anchor; or a `review-prompt-window` or
// `schedule-prompt-window` node, unless that node stands strictly inside the page
// chrome and wraps an anchor; or a prompt control that no holder holds
// (`unownedPrompts`). A legacy window node holds nothing: a control beside the
// anchor in it is unowned. The holders are the anchor, the composer, a lifecycle
// card and chat's message editor.
//
// A window anchor or a composer is well formed when, strictly inside it, it holds
// no other holder and exactly one control, and that control is a text-entry control
// or the spent field: a field marker with aria-disabled="true" that carries the
// notice. The node itself carries no field marker, no send label and no text entry,
// empty or populated. An empty anchor and a live field marker with no typed control
// in it each refuse. Each message editor holds exactly
// one textarea as a direct child, and any editor anchor is refused on run and
// review. A lifecycle card may hold any unmarked field.
//
// TEXT ENTRY IS READ BY ONE RULE, ON RAW CONTROLS. A text-entry control is an input
// of any type but the non-text types below, a textarea, a node whose contenteditable
// attribute is present and not "false", or a node whose role attribute lists textbox
// or searchbox. Each one counts by itself. A named field marker counts only when no
// text-entry control and no other marker stands inside it under the same nearest
// holder. The window's send label also counts outside the holders, unless a field
// marker holds it or it is already a text-entry control.
//
// A NOTICE stands in the page's own anchor. Its window, which is its nearest legacy
// node or else its anchor, is closed: each element in it, the window's own node
// included, is a div, p or span, and carries only class, data-*, aria-disabled and
// role="status". Anything else there is a breach, so no list of controls is needed.
// The rule reads elements and attributes: a script listener or a script property
// on an allowed element is not read.
//
// WHAT THIS DOES NOT READ: outside a notice's window, a send button with another
// label and a control that takes no text, such as a select, a button or a non-input
// node with role=combobox or role=spinbutton; a node editable only by inheritance or
// by a script property; document.designMode, a frame's or a shadow root's inside.
// An unmarked field inside a lifecycle card is not read, and chat takes any number of well-formed message editors.
//
// EVERY ANCHOR IS READ ON ITS OWN NODE: an owned window sits strictly inside the
// page chrome (an anchor on the chrome node itself is not owned), and a lifecycle
// card's own root node counts as inside the card.
//
// THE ROOT: its own markers are read like any other node's. A page chrome, window
// anchor, composer or message editor above the root is not read. A lifecycle card
// is the one exception, read in the whole document: a card above the root puts
// every prompt marker, composer and notice of the root inside a card. An unmarked
// text-entry control there counts as an unowned prompt, not as inside a card.
export function readRunWindowOwnership(root: Element | null): WindowOwnershipReading {
  if (root === null) return { rootPresent: false, windows: 0, ownedWindows: 0, unownedPrompts: 0, malformedHolders: 0, messageEditors: 0,
    cards: 0, promptsInCards: 0, composers: 0, composersInCards: 0,
    notices: 0, pageNotices: 0, noticesInCards: 0, noticeWindowBreaches: 0 };
  const runWindow = '[data-conformance-id="run-window"]';
  const otherWindows = '[data-conformance-id="review-prompt-window"], [data-conformance-id="schedule-prompt-window"]';
  const composer = '[data-conversation-composer]';
  const card = '[data-lifecycle-card-host]';
  const pageChrome = '[data-run-window-host="page-chrome"]';
  const promptMarkers = [runWindow, otherWindows, '[data-conformance-id="schedule-window-over"]', '[data-run-window-field]',
    '[data-conformance-id="chat-composer-primary"]', composer,
    '[data-testid="chat-prompt-input"]', '[aria-label="Apply AI suggestion"]'].join(',');
  const messageEditor = '[data-chat-message-editor]';
  const promptFieldMarkers = ['[data-run-window-field]', '[data-testid="chat-prompt-input"]', '[data-conformance-id="chat-composer-primary"]'].join(',');
  const sendLabel = '[aria-label="Apply AI suggestion"]';
  const textEntryCandidates = 'input, textarea, [contenteditable], [role]';
  const nonTextInputTypes = ["hidden", "checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color"];
  const isTextEntry = (node: Element): boolean => {
    if (node.matches("textarea")) return true;
    if ((node.getAttribute("role") ?? "").toLowerCase().split(/\s+/).some((role) => role === "textbox" || role === "searchbox")) return true;
    if (node.matches("[contenteditable]") && (node.getAttribute("contenteditable") ?? "").toLowerCase() !== "false") return true;
    return node.matches("input") && !nonTextInputTypes.includes((node.getAttribute("type") ?? "text").toLowerCase());
  };
  // The closed rule of a notice's window: only these elements, with only these attributes.
  const allowedInNoticeWindow = (node: Element): boolean => node.matches("div, p, span") && node.getAttributeNames().every((name) =>
    name === "class" || name === "aria-disabled" || name.startsWith("data-") || (name === "role" && (node.getAttribute("role") ?? "").toLowerCase() === "status"));
  const holders = [runWindow, card, composer, messageEditor].join(',');
  const top: Element = root;
  const all = (selector: string): Element[] =>
    [...(top.matches(selector) ? [top] : []), ...Array.from(top.querySelectorAll(selector))];
  // The nearest match from the node up to the root, both included.
  const closestInRoot = (node: Element, selector: string): Element | null => {
    for (let at: Element | null = node; at !== null; at = at === top ? null : at.parentElement) if (at.matches(selector)) return at;
    return null;
  };
  // Strictly inside the page chrome, within the root.
  const inChrome = (node: Element): boolean =>
    node !== top && node.parentElement !== null && closestInRoot(node.parentElement, pageChrome) !== null;
  // The node itself and every descendant that matches.
  const within = (node: Element, selector: string): number =>
    (node.matches(selector) ? 1 : 0) + node.querySelectorAll(selector).length;
  const cards = all(card);
  const notice = '[data-conformance-id="schedule-window-over"]';
  const anchored = all(runWindow);
  const unanchored = all(otherWindows)
    .filter((node) => !inChrome(node) || node.querySelector(runWindow) === null);
  const nodesWithin = (node: Element, selector: string): Element[] =>
    [...(node.matches(selector) ? [node] : []), ...Array.from(node.querySelectorAll(selector))];
  const rawEntries = (node: Element): Element[] => nodesWithin(node, textEntryCandidates).filter(isTextEntry);
  const nearestHolder = (node: Element): Element | null => closestInRoot(node, holders);
  // The one count: every raw control, plus each marker with no control or marker
  // of its own holder inside it.
  const controls = (node: Element): Element[] => [...rawEntries(node), ...nodesWithin(node, promptFieldMarkers).filter((marker) =>
    !isTextEntry(marker) && ![...Array.from(marker.querySelectorAll(promptFieldMarkers)), ...rawEntries(marker)]
      .some((inner) => inner !== marker && nearestHolder(inner) === nearestHolder(marker)))];
  const looseSendLabels = nodesWithin(top, sendLabel).filter((node) =>
    !isTextEntry(node) && (node.parentElement === null || closestInRoot(node.parentElement, promptFieldMarkers) === null));
  const unownedPrompts = [...controls(top), ...looseSendLabels].filter((node) => closestInRoot(node, holders) === null).length;
  const editors = all(messageEditor);
  // The one rule for a window anchor and a composer: strictly inside the node, no
  // other holder and exactly one control, typed or the spent field.
  const holdsOneControl = (node: Element): boolean => {
    const held = controls(node).filter((control) => control !== node);
    if (node.matches(`${promptFieldMarkers}, ${sendLabel}`) || isTextEntry(node)) return false;
    if (node.querySelector(holders) !== null || held.length !== 1) return false;
    return isTextEntry(held[0]!) || (held[0]!.getAttribute("aria-disabled") === "true" && within(held[0]!, notice) === 1);
  };
  const malformedWindows = all([runWindow, composer].join(',')).filter((node) => !holdsOneControl(node)).length;
  const malformedEditors = editors.filter((node) => {
    const held = controls(node);
    return held.length !== 1 || !held[0]!.matches("textarea") || held[0]!.parentElement !== node;
  }).length;
  // A lifecycle card anywhere above the root, read in the whole document.
  const belowCard = top.parentElement !== null && top.parentElement.closest(card) !== null;
  const aboveCard = (selector: string): number => (belowCard ? within(top, selector) : 0);
  return {
    rootPresent: true, windows: anchored.length + unanchored.length + unownedPrompts,
    ownedWindows: anchored.filter(inChrome).length,
    unownedPrompts,
    malformedHolders: malformedWindows + malformedEditors,
    messageEditors: editors.length,
    cards: cards.length,
    promptsInCards: aboveCard(promptMarkers) + cards.reduce((total, node) => total + within(node, promptMarkers), 0),
    composers: all(composer).length,
    composersInCards: aboveCard(composer) + cards.reduce((total, node) => total + within(node, composer), 0),
    notices: all(notice).length,
    pageNotices: all(notice).filter((node) => {
      const anchor = closestInRoot(node, runWindow);
      return anchor !== null && inChrome(anchor);
    }).length,
    noticesInCards: aboveCard(notice) + cards.reduce((total, node) => total + within(node, notice), 0),
    noticeWindowBreaches: all(notice).reduce((total, node) =>
      total + nodesWithin(closestInRoot(node, otherWindows) ?? closestInRoot(node, runWindow) ?? node, "*").filter((inner) => !allowedInNoticeWindow(inner)).length, 0),
  };
}
export function assertRunWindowOwnership(reading: WindowOwnershipReading, host: "run" | "review" | "chat"): void {
  if (!reading.rootPresent || reading.cards === 0) throw new Error("Missing real fixture/card root");
  if (reading.promptsInCards !== 0 || reading.composersInCards !== 0 || reading.noticesInCards !== 0)
    throw new Error("Prompt window/composer/notice is inside a lifecycle card");
  if (reading.noticeWindowBreaches !== 0) throw new Error("A read-only notice's window holds an element outside its allow-list");
  if (host === "chat") {
    if (reading.windows !== 0 || reading.composers !== 1) throw new Error("Chat must own one composer and no run window");
  } else if (reading.windows !== 1 || reading.ownedWindows !== 1 || reading.composers !== 0 || reading.messageEditors !== 0) {
    throw new Error("Page must own exactly one run window in its chrome");
  }
  if (reading.malformedHolders !== 0) throw new Error("A window anchor or composer does not hold exactly one control, or a message editor is not one textarea");
  if (reading.notices !== reading.pageNotices) throw new Error("A read-only notice stands outside the page's own window anchor");
}
