/** Positive prompt-marker guard shared by native controls and required conformance. */
export type WindowOwnershipReading = {
  rootPresent: boolean; windows: number; ownedWindows: number; unownedPrompts: number; overfullHolders: number; messageEditors: number;
  cards: number; promptsInCards: number; composers: number; composersInCards: number;
  notices: number; pageNotices: number; noticesInCards: number; interactiveNotices: number;
};
// Self-contained so Playwright evaluates this exact reader in the page. Native
// tests run it on DOM produced by the real components — the fixtures route's
// hosts, the review route module and the run page's `SetupScreen` (cinatra#3487
// item 3) — and on adversarial DOM.
//
// THE WINDOW IS READ BY ITS OWN ANCHOR, `run-window` (cinatra#3487 item 3): the
// drawing of the run page's window (`app-artifact-review.html` §I.6) anchors it
// so, inside `[data-run-window-host="page-chrome"]`. A window is that anchor; or
// a `review-prompt-window` or `schedule-prompt-window` node with no `run-window`
// inside it, also when it is drawn inside the page's own `run-window`; or a
// prompt control that no declared holder holds (`unownedPrompts`, see below). A
// page window that lost its own anchor is not owned.
//
// TEXT ENTRY IS READ BY ONE RULE, ON RAW CONTROLS, BEFORE ANY COLLAPSE. A text-entry
// control is an input of any type but the non-text types below, a textarea, a
// node whose contenteditable attribute is present and not "false", or a node
// whose role attribute lists textbox or searchbox. Each one counts by itself. A
// named field marker counts only when no text-entry control and no other marker
// stands inside it under the same nearest holder. The window's send label also
// counts outside the holders, unless a field marker holds it or it is already a
// text-entry control.
//
// The declared holders are a window anchor, a lifecycle card, the composer and
// chat's message editor. A card may hold any fields. A window anchor or a composer
// holds at most one control by that count. Each message editor holds exactly one
// textarea as a direct child, and any editor anchor is refused on run and review.
//
// WHAT THIS DOES NOT READ: a send button with another label; a control that takes
// no text, such as a select or a button; role=combobox or role=spinbutton on a node
// that is no input; a node editable only by inheritance or by a script property;
// document.designMode, a frame or a shadow root. Fields inside a lifecycle card are
// not read, and chat takes any number of well-formed message editors.
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
  if (root === null) return { rootPresent: false, windows: 0, ownedWindows: 0, unownedPrompts: 0, overfullHolders: 0, messageEditors: 0,
    cards: 0, promptsInCards: 0, composers: 0, composersInCards: 0,
    notices: 0, pageNotices: 0, noticesInCards: 0, interactiveNotices: 0 };
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
  const holders = [runWindow, otherWindows, card, composer, messageEditor].join(',');
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
    .filter((node) => node.querySelector(runWindow) === null);
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
  const overfullWindows = all([runWindow, otherWindows, composer].join(',')).filter((node) => controls(node).length > 1).length;
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
    overfullHolders: overfullWindows + malformedEditors,
    messageEditors: editors.length,
    cards: cards.length,
    promptsInCards: aboveCard(promptMarkers) + cards.reduce((total, node) => total + within(node, promptMarkers), 0),
    composers: all(composer).length,
    composersInCards: aboveCard(composer) + cards.reduce((total, node) => total + within(node, composer), 0),
    notices: all(notice).length,
    pageNotices: all(notice).filter(inChrome).length,
    noticesInCards: aboveCard(notice) + cards.reduce((total, node) => total + within(node, notice), 0),
    interactiveNotices: all(notice).reduce((total, node) =>
      total + nodesWithin(closestInRoot(node, '[data-conformance-id="schedule-prompt-window"]') ?? node, `button, ${textEntryCandidates}`)
        .filter((control) => control.matches("input, button") || isTextEntry(control)).length, 0),
  };
}
export function assertRunWindowOwnership(reading: WindowOwnershipReading, host: "run" | "review" | "chat"): void {
  if (!reading.rootPresent || reading.cards === 0) throw new Error("Missing real fixture/card root");
  if (reading.promptsInCards !== 0 || reading.composersInCards !== 0 || reading.noticesInCards !== 0)
    throw new Error("Prompt window/composer/notice is inside a lifecycle card");
  if (reading.interactiveNotices !== 0) throw new Error("Read-only notice contains an interactive prompt");
  if (host === "chat") {
    if (reading.windows !== 0 || reading.composers !== 1) throw new Error("Chat must own one composer and no run window");
  } else if (reading.windows !== 1 || reading.ownedWindows !== 1 || reading.composers !== 0 || reading.messageEditors !== 0) {
    throw new Error("Page must own exactly one run window in its chrome");
  }
  if (reading.overfullHolders !== 0) throw new Error("A window or composer holds more than one prompt control, or a message editor is not one textarea");
  if (reading.notices !== reading.pageNotices) throw new Error("A read-only notice stands outside the page chrome");
}
