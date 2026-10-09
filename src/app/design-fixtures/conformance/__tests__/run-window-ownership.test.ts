// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readRunWindowOwnership, assertRunWindowOwnership } from "../../../../../tests/e2e/design/conformance/run-window-ownership";
import { runWindowOwnershipHost, RUN_WINDOW_OWNERSHIP_HOSTS } from "../run-window-ownership-fixture-data";
function root(markup: string): Element {
  const root = document.createElement("section"); root.innerHTML = markup; return root;
}
const card = '<section data-lifecycle-card-host="run_card"><textarea data-testid="review-rationale" data-conformance-id="review-note-field-subordinate"></textarea><input name="subject"></section>';
const window = '<div data-run-window-host="page-chrome"><div data-conformance-id="review-prompt-window"><div data-run-window-field></div><button aria-label="Apply AI suggestion"></button></div></div>';
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
    const notice = '<div data-conformance-id="schedule-prompt-window"><div data-run-window-field aria-disabled="true"><p data-conformance-id="schedule-window-over">Over</p></div></div>';
    const page = root(card + '<div data-run-window-host="page-chrome">' + notice + '</div>');
    expect(readRunWindowOwnership(page)).toMatchObject({ pageNotices: 1, interactiveNotices: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(page), "run")).not.toThrow();
    const interactive = root(page.innerHTML.replace('</p>', '</p><button>Send</button>'));
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(interactive), "run")).toThrow(/interactive/);
    const contained = root('<section data-lifecycle-card-host="run_card">' + notice + '</section>' + window);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(contained), "run")).toThrow(/inside/);
  });
  it("refuses chat's duplicate composer or run window", () => {
    for (const markup of [card + '<div data-conversation-composer></div><div data-conversation-composer></div>', card + window + '<div data-conversation-composer></div>'])
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(markup)), "chat")).toThrow(/Chat/);
  });
});
