/** Positive prompt-marker guard shared by native controls and required conformance. */
export type WindowOwnershipReading = {
  rootPresent: boolean; windows: number; ownedWindows: number;
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
// so, inside `[data-run-window-host="page-chrome"]`. A window is that anchor,
// or a window drawn under another window anchor with no `run-window` inside it
// — so a second window is counted whatever it is called, also when it is drawn
// inside the page's own `run-window`, and a page window that lost its own anchor
// is not owned.
export function readRunWindowOwnership(root: Element | null): WindowOwnershipReading {
  if (root === null) return { rootPresent: false, windows: 0, ownedWindows: 0,
    cards: 0, promptsInCards: 0, composers: 0, composersInCards: 0,
    pageNotices: 0, noticesInCards: 0, interactiveNotices: 0 };
  const runWindow = '[data-conformance-id="run-window"]';
  const otherWindows = '[data-conformance-id="review-prompt-window"], [data-conformance-id="schedule-prompt-window"]';
  const composer = '[data-conversation-composer]';
  const promptMarkers = [runWindow, otherWindows, '[data-conformance-id="schedule-window-over"]', '[data-run-window-field]',
    '[data-conformance-id="chat-composer-primary"]', composer,
    '[data-testid="chat-prompt-input"]', '[aria-label="Apply AI suggestion"]'].join(',');
  const cards = Array.from(root.querySelectorAll('[data-lifecycle-card-host]'));
  const notice = '[data-conformance-id="schedule-window-over"]';
  const anchored = Array.from(root.querySelectorAll(runWindow));
  const unanchored = Array.from(root.querySelectorAll(otherWindows))
    .filter((node) => node.querySelector(runWindow) === null);
  return {
    rootPresent: true, windows: anchored.length + unanchored.length,
    ownedWindows: anchored.filter((node) => node.closest('[data-run-window-host="page-chrome"]') !== null).length,
    cards: cards.length,
    promptsInCards: cards.reduce((total, card) => total + card.querySelectorAll(promptMarkers).length, 0),
    composers: root.querySelectorAll(composer).length,
    composersInCards: cards.reduce((total, card) => total + card.querySelectorAll(composer).length, 0),
    pageNotices: root.querySelectorAll('[data-run-window-host="page-chrome"] ' + notice).length,
    noticesInCards: cards.reduce((total, card) => total + card.querySelectorAll(notice).length, 0),
    interactiveNotices: Array.from(root.querySelectorAll(notice)).reduce((total, node) =>
      total + (node.closest('[data-conformance-id="schedule-prompt-window"]') ?? node).querySelectorAll('input, textarea, button, [contenteditable="true"]').length, 0),
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
