// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readRunWindowOwnership, assertRunWindowOwnership } from "../../../../../tests/e2e/design/conformance/run-window-ownership";
import { runWindowOwnershipHost, RUN_WINDOW_OWNERSHIP_HOSTS } from "../run-window-ownership-fixture-data";
function root(markup: string): Element {
  const root = document.createElement("section"); root.innerHTML = markup; return root;
}
const card = '<section data-lifecycle-card-host="run_card"><textarea data-testid="review-rationale" data-conformance-id="review-note-field-subordinate"></textarea><input name="subject"></section>';
// The page window as the chrome draws it (cinatra#3487 item 3): §VI's
// `review-prompt-window` around the page window's own `run-window` anchor.
const window = '<div data-run-window-host="page-chrome"><div data-conformance-id="review-prompt-window"><div data-conformance-id="run-window"><div data-run-window-field></div><button aria-label="Apply AI suggestion"></button></div></div></div>';
describe("#3487 positive ownership guard", () => {
  it("declares only the three static query hosts and preserves the default route", () => {
    expect(RUN_WINDOW_OWNERSHIP_HOSTS).toEqual(["run", "review", "chat"]);
    for (const host of RUN_WINDOW_OWNERSHIP_HOSTS) expect(runWindowOwnershipHost(host)).toBe(host);
    for (const value of [undefined, "other", ["run", "chat"], ""]) expect(runWindowOwnershipHost(value)).toBeNull();
  });
  it.each(["run", "review"] as const)("accepts one page-owned %s window and preserves drawn subordinate fields", (host) => {
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + window)), host)).not.toThrow();
  });
  it("accepts chat's own composer outside its real card and no run window", () => {
    const node = root(card + '<div data-conversation-composer><textarea data-testid="chat-prompt-input"></textarea></div>');
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "chat")).not.toThrow();
  });
  it.each([null, "", window])("refuses missing/empty/card-less roots", (markup) => {
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(markup === null ? null : root(markup)), "run")).toThrow(/Missing/);
  });
  it("refuses a missing or duplicate page window", () => {
    for (const node of [root(card), root(card + window + window)])
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/exactly one/);
  });
  it("refuses a window outside page chrome", () => {
    const node = root(card + '<div data-conformance-id="review-prompt-window"></div>');
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "review")).toThrow(/chrome/);
  });
  // cinatra#3487 item 3: the window is read by its own anchor, `run-window`.
  it.each(["run", "review"] as const)("refuses a %s page window in the chrome that carries no run-window anchor", (host) => {
    const legacy = '<div data-run-window-host="page-chrome"><div data-conformance-id="review-prompt-window"><div data-run-window-field></div></div></div>';
    const reading = readRunWindowOwnership(root(card + legacy));
    expect(reading).toMatchObject({ windows: 1, ownedWindows: 0 });
    expect(() => assertRunWindowOwnership(reading, host)).toThrow(/exactly one/);
  });
  it("refuses a run-window anchor outside page chrome", () => {
    const node = root(card + '<div data-conformance-id="run-window"><div data-run-window-field></div></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, ownedWindows: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/chrome/);
  });
  it("refuses a second window of another anchor beside the page's own", () => {
    for (const stray of ['<div data-conformance-id="review-prompt-window"></div>', '<div data-conformance-id="schedule-prompt-window"></div>']) {
      const node = root(card + window + stray);
      expect(readRunWindowOwnership(node)).toMatchObject({ windows: 2, ownedWindows: 1 });
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "review")).toThrow(/exactly one/);
    }
  });
  it.each(["review-prompt-window", "schedule-prompt-window"])("refuses a second window anchor (%s) drawn inside the page's own run-window", (id) => {
    const nested = '<div data-run-window-host="page-chrome"><div data-conformance-id="review-prompt-window"><div data-conformance-id="run-window"><div data-run-window-field></div><div data-conformance-id="' + id + '"></div></div></div></div>';
    const reading = readRunWindowOwnership(root(card + nested));
    expect(reading).toMatchObject({ windows: 2, ownedWindows: 1 });
    expect(() => assertRunWindowOwnership(reading, "review")).toThrow(/exactly one/);
  });
  it("refuses a run-window anchor inside a lifecycle card", () => {
    const node = root('<section data-lifecycle-card-host="run_card"><div data-conformance-id="run-window"></div></section>' + window);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/inside/);
  });
  it.each([
    '<div data-conformance-id="review-prompt-window"></div>', '<div data-conformance-id="schedule-prompt-window"></div>', '<p data-conformance-id="schedule-window-over"></p>', '<div data-run-window-field></div>',
    '<textarea data-conformance-id="chat-composer-primary"></textarea>',
    '<div data-conversation-composer></div>', '<textarea data-testid="chat-prompt-input"></textarea>',
    '<button aria-label="Apply AI suggestion"></button>',
  ])("refuses each real prompt marker inside a lifecycle card: %s", (marker) => {
    const node = root('<section data-lifecycle-card-host="run_card">' + marker + '</section>' + window);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/inside/);
  });
  it("accepts a page-owned read-only schedule notice but refuses interactive or card-owned notice", () => {
    const notice = '<div data-conformance-id="schedule-prompt-window"><div data-conformance-id="run-window"><div data-run-window-field aria-disabled="true"><p data-conformance-id="schedule-window-over">Over</p></div></div></div>';
    const page = root(card + '<div data-run-window-host="page-chrome">' + notice + '</div>');
    expect(readRunWindowOwnership(page)).toMatchObject({ pageNotices: 1, interactiveNotices: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(page), "run")).not.toThrow();
    const interactive = root(page.innerHTML.replace('</p>', '</p><button>Send</button>'));
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(interactive), "run")).toThrow(/interactive/);
    const contained = root('<section data-lifecycle-card-host="run_card">' + notice + '</section>' + window);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(contained), "run")).toThrow(/inside/);
  });
  // cinatra#3487 item 3, pre-review 1: a prompt field, a textarea or the
  // window's send control that no window anchor, lifecycle card or composer
  // holds is a window of its own, so one page window plus such a sibling is two.
  it.each([
    '<div data-run-window-field></div>', '<textarea></textarea>', '<button aria-label="Apply AI suggestion"></button>',
    '<div data-testid="chat-prompt-input" contenteditable="true"></div>', '<textarea data-conformance-id="chat-composer-primary"></textarea>',
  ])("refuses an unanchored prompt control beside the page's own window: %s", (stray) => {
    for (const host of ["run", "review"] as const) {
      const reading = readRunWindowOwnership(root(card + window + '<div>' + stray + '</div>'));
      expect(reading).toMatchObject({ windows: 2, ownedWindows: 1, unownedPrompts: 1 });
      expect(() => assertRunWindowOwnership(reading, host)).toThrow(/exactly one/);
    }
  });
  it("counts each unanchored prompt control once, and a field with its own send control as one", () => {
    const loose = '<div><div data-run-window-field></div><textarea></textarea><button aria-label="Apply AI suggestion"></button></div>';
    expect(readRunWindowOwnership(root(card + window + loose))).toMatchObject({ windows: 4, ownedWindows: 1, unownedPrompts: 3 });
    const field = '<div data-run-window-field><textarea></textarea><button aria-label="Apply AI suggestion"></button></div>';
    const reading = readRunWindowOwnership(root(card + window + field));
    expect(reading).toMatchObject({ windows: 2, ownedWindows: 1, unownedPrompts: 1 });
    for (const host of ["run", "review"] as const) expect(() => assertRunWindowOwnership(reading, host)).toThrow(/exactly one/);
  });
  it("keeps a subordinate field in a card and the page window's own field out of the unanchored count", () => {
    expect(readRunWindowOwnership(root(card + window))).toMatchObject({ windows: 1, ownedWindows: 1, unownedPrompts: 0 });
  });
  it("refuses a composer beside the run or review page's own window", () => {
    const node = root(card + window + '<div data-conversation-composer><textarea data-testid="chat-prompt-input"></textarea></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, composers: 1, unownedPrompts: 0 });
    for (const host of ["run", "review"] as const)
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), host)).toThrow(/exactly one/);
  });
  it("refuses an unanchored prompt control beside chat's own composer", () => {
    const composer = '<div data-conversation-composer><textarea data-testid="chat-prompt-input"></textarea></div>';
    for (const stray of ['<textarea></textarea>', '<div data-run-window-field></div>', '<button aria-label="Apply AI suggestion"></button>']) {
      const reading = readRunWindowOwnership(root(card + composer + stray));
      expect(reading).toMatchObject({ windows: 1, composers: 1, unownedPrompts: 1 });
      expect(() => assertRunWindowOwnership(reading, "chat")).toThrow(/Chat/);
    }
  });
  // An anchor is read on the right node: the window is a strict descendant of the
  // page chrome, and a card's own root node is inside the card.
  it("refuses a run-window anchor drawn on the page chrome node itself", () => {
    const node = root(card + '<div data-run-window-host="page-chrome" data-conformance-id="run-window"><div data-run-window-field></div></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, ownedWindows: 0 });
    for (const host of ["run", "review"] as const)
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), host)).toThrow(/chrome/);
  });
  it("refuses a lifecycle card whose own root node carries the run-window anchor and the field", () => {
    const node = root('<div data-run-window-host="page-chrome"><section data-lifecycle-card-host="run_card" data-conformance-id="run-window" data-run-window-field></section></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ cards: 1, promptsInCards: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/inside/);
  });
  it.each([
    'data-conformance-id="run-window"', 'data-run-window-field', 'data-conversation-composer', 'data-conformance-id="schedule-window-over"',
  ])("refuses a prompt marker on a lifecycle card's own root node: %s", (marker) => {
    const node = root('<section data-lifecycle-card-host="run_card" ' + marker + '></section>' + window);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/inside/);
  });
  it("refuses a read-only notice that is itself an interactive control", () => {
    const node = root(card + window.replace('</div></div></div>', '</div></div><button data-conformance-id="schedule-window-over">Over</button></div>'));
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, ownedWindows: 1, pageNotices: 1, interactiveNotices: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/interactive/);
  });
  it("refuses chat's duplicate composer or run window", () => {
    for (const markup of [card + '<div data-conversation-composer></div><div data-conversation-composer></div>', card + window + '<div data-conversation-composer></div>'])
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(markup)), "chat")).toThrow(/Chat/);
  });
});
