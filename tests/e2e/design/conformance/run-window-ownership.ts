/** Positive prompt-marker guard shared by native controls and required conformance. */
export type WindowOwnershipReading = {
  rootPresent: boolean; windows: number; ownedWindows: number; unownedPrompts: number;
  cards: number; promptsInCards: number; composers: number; composersInCards: number;
  pageNotices: number; noticesInCards: number; interactiveNotices: number;
};
// Self-contained so Playwright evaluates this exact reader in the page. Native
// tests run it on DOM produced by the real components — the fixtures route's
// hosts, the review route module and the run page's `SetupScreen` (cinatra#3487
// item 3) — and on adversarial DOM.
//
// THE WINDOW IS READ BY ITS OWN ANCHOR, `run-window` (cinatra#3487 item 3): the
// drawing of the run page's window (`app-artifact-review.html` §I.6) anchors it
// so, inside `[data-run-window-host="page-chrome"]`. A window is that anchor;
// or a window drawn under another window anchor with no `run-window` inside it,
// also when it is drawn inside the page's own `run-window`; or a prompt field,
// a textarea or the window's send control that no window anchor, lifecycle card
// or composer holds (`unownedPrompts`, each outermost one counted once). A page
// window that lost its own anchor is not owned.
//
// EVERY ANCHOR IS READ ON ITS OWN NODE: an owned window sits strictly inside
// the page chrome (an anchor on the chrome node itself is not owned), and a
// lifecycle card's own root node counts as inside the card.
//
// THE READING STOPS AT THE ROOT: the root element's own markers are read like
// any other node's, and nothing above the root is read, so a page chrome or a
// card above it neither owns a window nor holds a prompt.
export function readRunWindowOwnership(root: Element | null): WindowOwnershipReading {
  if (root === null) return { rootPresent: false, windows: 0, ownedWindows: 0, unownedPrompts: 0,
    cards: 0, promptsInCards: 0, composers: 0, composersInCards: 0,
    pageNotices: 0, noticesInCards: 0, interactiveNotices: 0 };
  const runWindow = '[data-conformance-id="run-window"]';
  const otherWindows = '[data-conformance-id="review-prompt-window"], [data-conformance-id="schedule-prompt-window"]';
  const composer = '[data-conversation-composer]';
  const card = '[data-lifecycle-card-host]';
  const pageChrome = '[data-run-window-host="page-chrome"]';
  const promptMarkers = [runWindow, otherWindows, '[data-conformance-id="schedule-window-over"]', '[data-run-window-field]',
    '[data-conformance-id="chat-composer-primary"]', composer,
    '[data-testid="chat-prompt-input"]', '[aria-label="Apply AI suggestion"]'].join(',');
  const promptControls = ['[data-run-window-field]', 'textarea', '[aria-label="Apply AI suggestion"]',
    '[data-testid="chat-prompt-input"]', '[data-conformance-id="chat-composer-primary"]'].join(',');
  const holders = [runWindow, otherWindows, card, composer].join(',');
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
  const loose = all(promptControls).filter((node) => closestInRoot(node, holders) === null);
  const unownedPrompts = loose.filter((node) => !loose.some((other) => other !== node && other.contains(node))).length;
  return {
    rootPresent: true, windows: anchored.length + unanchored.length + unownedPrompts,
    ownedWindows: anchored.filter(inChrome).length,
    unownedPrompts,
    cards: cards.length,
    promptsInCards: cards.reduce((total, node) => total + within(node, promptMarkers), 0),
    composers: all(composer).length,
    composersInCards: cards.reduce((total, node) => total + within(node, composer), 0),
    pageNotices: all(notice).filter(inChrome).length,
    noticesInCards: cards.reduce((total, node) => total + within(node, notice), 0),
    interactiveNotices: all(notice).reduce((total, node) =>
      total + within(closestInRoot(node, '[data-conformance-id="schedule-prompt-window"]') ?? node, 'input, textarea, button, [contenteditable="true"]'), 0),
  };
}
export function assertRunWindowOwnership(reading: WindowOwnershipReading, host: "run" | "review" | "chat"): void {
  if (!reading.rootPresent || reading.cards === 0) throw new Error("Missing real fixture/card root");
  if (reading.promptsInCards !== 0 || reading.composersInCards !== 0 || reading.noticesInCards !== 0)
    throw new Error("Prompt window/composer/notice is inside a lifecycle card");
  if (reading.interactiveNotices !== 0) throw new Error("Read-only notice contains an interactive prompt");
  if (host === "chat") {
    if (reading.windows !== 0 || reading.composers !== 1) throw new Error("Chat must own one composer and no run window");
  } else if (reading.windows !== 1 || reading.ownedWindows !== 1 || reading.composers !== 0) {
    throw new Error("Page must own exactly one run window in its chrome");
  }
}
