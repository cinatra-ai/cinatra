// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readRunWindowOwnership, assertRunWindowOwnership } from "../../../../../tests/e2e/design/conformance/run-window-ownership";
import { runWindowOwnershipHost, RUN_WINDOW_OWNERSHIP_HOSTS } from "../run-window-ownership-fixture-data";
function root(markup: string): Element {
  const root = document.createElement("section"); root.innerHTML = markup; return root;
}
function marked(marker: string, markup: string): Element {
  const wrap = document.createElement("div"); wrap.innerHTML = "<section " + marker + ">" + markup + "</section>"; return wrap.firstElementChild!;
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
  // cinatra#3487 item 3, the SC of pre-review 2: the root element's own markers
  // are read, and nothing above the root is. A real root is a plain wrapper.
  it.each(["div", "section"])("accepts a plain <%s> root attached to the document", (tag) => {
    const node = document.createElement(tag);
    node.innerHTML = card + window;
    document.body.append(node);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).not.toThrow();
    node.remove();
  });
  it("refuses a root that itself carries the composer marker", () => {
    const node = marked("data-conversation-composer", card + window);
    expect(readRunWindowOwnership(node)).toMatchObject({ composers: 1 });
    for (const host of ["run", "review"] as const)
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), host)).toThrow(/exactly one/);
  });
  it("refuses a root that itself carries the run-window anchor", () => {
    const composer = '<div data-conversation-composer></div>';
    const chat = marked('data-conformance-id="run-window"', card + composer);
    expect(readRunWindowOwnership(chat)).toMatchObject({ windows: 1, composers: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(chat), "chat")).toThrow(/Chat/);
    const page = marked('data-conformance-id="run-window"', card);
    expect(readRunWindowOwnership(page)).toMatchObject({ windows: 1, ownedWindows: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(page), "run")).toThrow(/chrome/);
  });
  it("refuses a root that itself carries the field marker", () => {
    const node = marked("data-run-window-field", card + window);
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 2, ownedWindows: 1, unownedPrompts: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/exactly one/);
  });
  it("refuses a root that itself carries the card marker around a window", () => {
    const node = marked('data-lifecycle-card-host="run_card"', card + window);
    expect(readRunWindowOwnership(node).promptsInCards).toBeGreaterThan(0);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/inside/);
  });
  it("does not own a window by a page chrome above the root", () => {
    const outer = document.createElement("div");
    outer.setAttribute("data-run-window-host", "page-chrome");
    outer.innerHTML = '<section>' + card + '<div data-conformance-id="run-window"><p data-conformance-id="schedule-window-over"></p></div></section>';
    const reading = readRunWindowOwnership(outer.firstElementChild);
    expect(reading).toMatchObject({ windows: 1, ownedWindows: 0, pageNotices: 0 });
    expect(() => assertRunWindowOwnership(reading, "run")).toThrow(/chrome/);
  });
  it("counts an unanchored prompt control although a card stands above the root", () => {
    const outer = document.createElement("div");
    outer.setAttribute("data-lifecycle-card-host", "run_card");
    outer.innerHTML = '<section>' + card + window + '<textarea></textarea></section>';
    const reading = readRunWindowOwnership(outer.firstElementChild);
    expect(reading).toMatchObject({ windows: 2, ownedWindows: 1, unownedPrompts: 1 });
    expect(() => assertRunWindowOwnership(reading, "run")).toThrow(/inside/);
  });
  // cinatra#3487 item 3, pre-review 2, finding 4: "never a descendant of a lifecycle
  // card" holds in the whole document, so a card above the root also counts.
  it("refuses a page whose whole root stands inside a lifecycle card", () => {
    const outer = document.createElement("section");
    outer.setAttribute("data-lifecycle-card-host", "outer");
    outer.innerHTML = '<div><section data-lifecycle-card-host="inner"></section><div data-run-window-host="page-chrome"><div data-conformance-id="run-window"><div data-run-window-field></div></div></div></div>';
    const reading = readRunWindowOwnership(outer.firstElementChild);
    expect(reading.promptsInCards).toBeGreaterThan(0);
    expect(() => assertRunWindowOwnership(reading, "run")).toThrow(/inside/);
    const chat = document.createElement("section");
    chat.setAttribute("data-lifecycle-card-host", "outer");
    chat.innerHTML = '<div>' + card + '<div data-conversation-composer></div></div>';
    expect(readRunWindowOwnership(chat.firstElementChild)).toMatchObject({ windows: 0, composersInCards: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(chat.firstElementChild), "chat")).toThrow(/inside/);
  });
  // Pre-review 2, finding 1: the reader is default-deny for text entry. Any
  // text-entry control that no declared holder holds is a prompt, whatever its label.
  it.each([
    '<input aria-label="Ask Cinatra">', '<input type="search">', '<input type="TEXT">', '<input type="email">', '<input type="number">',
    '<div contenteditable="true"></div>', '<div contenteditable=""></div>', '<div role="textbox"></div>',
  ])("counts a text-entry control outside every holder as a prompt: %s", (control) => {
    const reading = readRunWindowOwnership(root(card + window + '<aside>' + control + '<button aria-label="Send message">Send</button></aside>'));
    expect(reading).toMatchObject({ windows: 2, ownedWindows: 1, unownedPrompts: 1 });
    for (const host of ["run", "review"] as const) expect(() => assertRunWindowOwnership(reading, host)).toThrow(/exactly one/);
    const chat = readRunWindowOwnership(root(card + '<div data-conversation-composer></div><aside>' + control + '</aside>'));
    expect(chat).toMatchObject({ windows: 1, composers: 1, unownedPrompts: 1 });
    expect(() => assertRunWindowOwnership(chat, "chat")).toThrow(/Chat/);
  });
  it.each(["hidden", "checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color"])("does not read an input of the non-text type %s as a prompt", (type) => {
    const reading = readRunWindowOwnership(root(card + window + '<aside><input type="' + type + '"></aside>'));
    expect(reading).toMatchObject({ windows: 1, unownedPrompts: 0 });
    expect(() => assertRunWindowOwnership(reading, "run")).not.toThrow();
  });
  it("does not read a contenteditable=false node as a prompt", () => {
    const reading = readRunWindowOwnership(root(card + window + '<aside><div contenteditable="false"></div></aside>'));
    expect(reading).toMatchObject({ windows: 1, unownedPrompts: 0 });
  });
  it("names the limit: a lone send button with another label is not read", () => {
    const reading = readRunWindowOwnership(root(card + window + '<aside><button aria-label="Send message">Send</button></aside>'));
    expect(reading).toMatchObject({ windows: 1, unownedPrompts: 0 });
  });
  // Pre-review 2, finding 2: a holder takes one prompt control.
  it("refuses a second prompt control inside the legacy anchor around the page's window", () => {
    const node = root(card + '<div data-run-window-host="page-chrome"><div data-conformance-id="review-prompt-window"><div data-conformance-id="run-window"><div data-run-window-field></div></div><aside class="second-window"><textarea></textarea><button aria-label="Apply AI suggestion"></button></aside></div></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, ownedWindows: 1, overfullHolders: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "review")).toThrow(/more than one/);
  });
  it("refuses a second text-entry control inside the page's run-window", () => {
    const node = root(card + '<div data-run-window-host="page-chrome"><div data-conformance-id="run-window"><div data-run-window-field></div><input></div></div>');
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/more than one/);
  });
  it("refuses two prompt controls inside chat's composer, and takes one", () => {
    const two = root(card + '<div data-conversation-composer><div role="textbox" data-testid="chat-prompt-input"></div><textarea></textarea></div>');
    expect(readRunWindowOwnership(two)).toMatchObject({ composers: 1, overfullHolders: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(two), "chat")).toThrow(/more than one/);
    const one = root(card + '<div data-conversation-composer><div role="textbox" data-testid="chat-prompt-input"></div></div>');
    expect(readRunWindowOwnership(one)).toMatchObject({ composers: 1, overfullHolders: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(one), "chat")).not.toThrow();
  });
  // Pre-review 2, finding 3: the chat message editor is one declared exception.
  const composerOnly = '<div data-conversation-composer><div role="textbox"></div></div>';
  const editor = '<div data-chat-message-editor><textarea></textarea><button>Save</button></div>';
  it("accepts chat's message editor beside its composer, and on chat only", () => {
    const reading = readRunWindowOwnership(root(card + composerOnly + editor));
    expect(reading).toMatchObject({ windows: 0, composers: 1, messageEditors: 1, unownedPrompts: 0, overfullHolders: 0 });
    expect(() => assertRunWindowOwnership(reading, "chat")).not.toThrow();
    for (const host of ["run", "review"] as const)
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + window + editor)), host)).toThrow(/exactly one/);
  });
  it.each([
    ["two textareas", '<div data-chat-message-editor><textarea></textarea><textarea></textarea></div>'],
    ["a nested textarea", '<div data-chat-message-editor><div><textarea></textarea></div></div>'],
    ["another text-entry control", '<div data-chat-message-editor><div role="textbox"></div></div>'],
    ["no textarea", '<div data-chat-message-editor></div>'],
  ])("refuses a message editor anchor with %s", (_name, markup) => {
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + composerOnly + markup)), "chat")).toThrow(/more than one|message editor/);
  });
  // Pre-review 2, note 7: a read-only notice stands in the page chrome.
  it("refuses a read-only notice outside the page chrome and outside every card", () => {
    const stray = '<p data-conformance-id="schedule-window-over">Over</p>';
    const page = readRunWindowOwnership(root(card + window + stray));
    expect(page).toMatchObject({ windows: 1, ownedWindows: 1, notices: 1, pageNotices: 0, noticesInCards: 0 });
    expect(() => assertRunWindowOwnership(page, "run")).toThrow(/notice/);
    const chat = readRunWindowOwnership(root(card + composerOnly + stray));
    expect(() => assertRunWindowOwnership(chat, "chat")).toThrow(/notice/);
  });
  it("refuses chat's duplicate composer or run window", () => {
    for (const markup of [card + '<div data-conversation-composer></div><div data-conversation-composer></div>', card + window + '<div data-conversation-composer></div>'])
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(markup)), "chat")).toThrow(/Chat/);
  });
});
