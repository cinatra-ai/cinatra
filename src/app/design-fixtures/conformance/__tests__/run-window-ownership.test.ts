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
const window = '<div data-run-window-host="page-chrome"><div data-conformance-id="review-prompt-window"><div data-conformance-id="run-window"><div data-run-window-field><textarea></textarea><button aria-label="Apply AI suggestion"></button></div></div></div></div>';
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
    expect(reading).toMatchObject({ windows: 2, ownedWindows: 0, unownedPrompts: 1 });
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
    expect(readRunWindowOwnership(page)).toMatchObject({ pageNotices: 1, noticeWindowBreaches: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(page), "run")).not.toThrow();
    const interactive = root(page.innerHTML.replace('</p>', '</p><button>Send</button>'));
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(interactive), "run")).toThrow(/notice's window/);
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
    const node = root(card + window.replace('</button></div></div>', '</button></div><button data-conformance-id="schedule-window-over">Over</button></div>'));
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, ownedWindows: 1, pageNotices: 1 });
    expect(readRunWindowOwnership(node).noticeWindowBreaches).toBeGreaterThan(0);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/notice's window/);
  });
  // cinatra#3487 item 3, the SC of pre-review 2: the root element's own markers
  // are read. Above the root only a lifecycle card is read. A real root is a plain wrapper.
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
    '<div contenteditable="true"></div>', '<div contenteditable=""></div>', '<div contenteditable="plaintext-only"></div>', '<div role="textbox"></div>',
    '<div role="searchbox" tabindex="0"></div>', '<div role="textbox searchbox" tabindex="0"></div>', '<div role="TextBox"></div>',
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
  // The roles named in the reader's limits are not read as text entry.
  it.each(["combobox", "spinbutton"])("names the limit: role=%s on a node that is no input is not read", (role) => {
    const reading = readRunWindowOwnership(root(card + window + '<aside><div role="' + role + '"></div></aside>'));
    expect(reading).toMatchObject({ windows: 1, unownedPrompts: 0 });
  });
  // Pre-review 3, finding 1: raw controls are counted before any collapse, so a
  // marker holds no second control unseen.
  it("refuses two text-entry controls hidden under one field marker in the page's run-window", () => {
    const node = root(card + '<div data-run-window-host="page-chrome"><div data-conformance-id="run-window"><div data-run-window-field><textarea></textarea><input aria-label="second prompt"></div></div></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, ownedWindows: 1, malformedHolders: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/holds? /);
  });
  it("refuses two text-entry controls hidden under one marker in chat's composer", () => {
    const node = root(card + '<div data-conversation-composer><div data-testid="chat-prompt-input"><textarea></textarea><input></div></div>');
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "chat")).toThrow(/holds? /);
  });
  it("counts each text-entry control under a marker that no holder holds", () => {
    const node = root(card + window + '<aside><div data-run-window-field><textarea></textarea><input></div></aside>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 3, ownedWindows: 1, unownedPrompts: 2 });
  });
  it("counts a field marker around one control, with its send button, once", () => {
    const node = root(card + window + '<aside><div data-run-window-field><textarea></textarea><button aria-label="Apply AI suggestion"></button></div></aside>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 2, unownedPrompts: 1 });
  });
  it("takes one control under a field marker in the page's run-window", () => {
    const node = root(card + '<div data-run-window-host="page-chrome"><div data-conformance-id="run-window"><div data-run-window-field><div role="textbox" contenteditable="true"></div><button aria-label="Apply AI suggestion"></button></div></div></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 1, unownedPrompts: 0, malformedHolders: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).not.toThrow();
  });
  // Pre-review 3, finding 3: an editable notice is interactive, by the same text-entry rule.
  it.each(['contenteditable=""', 'contenteditable="plaintext-only"', 'role="searchbox"'])("refuses a read-only notice that is itself editable: %s", (attribute) => {
    const node = root(card + '<div data-run-window-host="page-chrome"><div data-conformance-id="schedule-prompt-window"><div data-conformance-id="run-window"><div data-run-window-field data-conformance-id="schedule-window-over" ' + attribute + '></div></div></div></div>');
    expect(readRunWindowOwnership(node).noticeWindowBreaches).toBeGreaterThan(0);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/notice's window/);
  });
  // Pre-review 3, finding 4: a card above the root counts the root's prompt
  // markers, composers and notices. An unmarked field there stays an unowned prompt.
  it("reads an unmarked field under a card above the root as unowned, not as inside a card", () => {
    const outer = document.createElement("section");
    outer.setAttribute("data-lifecycle-card-host", "outer");
    outer.innerHTML = '<div>' + card + '<input></div>';
    expect(readRunWindowOwnership(outer.firstElementChild)).toMatchObject({ promptsInCards: 0, unownedPrompts: 1 });
  });
  // Pre-review 3, note: named in the body's limits.
  it("names the limit: chat takes more than one well-formed message editor", () => {
    const editors = '<div data-chat-message-editor><textarea></textarea></div>';
    const reading = readRunWindowOwnership(root(card + '<div data-conversation-composer><div role="textbox"></div></div>' + editors + editors));
    expect(reading).toMatchObject({ messageEditors: 2, malformedHolders: 0 });
    expect(() => assertRunWindowOwnership(reading, "chat")).not.toThrow();
  });
  // Pre-review 2, finding 2: a holder takes one prompt control.
  it("refuses a second prompt control beside the anchor, inside the legacy node around the page's window", () => {
    const node = root(card + '<div data-run-window-host="page-chrome"><div data-conformance-id="review-prompt-window"><div data-conformance-id="run-window"><div data-run-window-field><textarea></textarea></div></div><aside class="second-window"><textarea></textarea><button aria-label="Apply AI suggestion"></button></aside></div></div>');
    expect(readRunWindowOwnership(node)).toMatchObject({ windows: 3, ownedWindows: 1, unownedPrompts: 2 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "review")).toThrow(/exactly one/);
  });
  it("refuses a second text-entry control inside the page's run-window", () => {
    const node = root(card + '<div data-run-window-host="page-chrome"><div data-conformance-id="run-window"><div data-run-window-field></div><input></div></div>');
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(node), "run")).toThrow(/holds? /);
  });
  it("refuses two prompt controls inside chat's composer, and takes one", () => {
    const two = root(card + '<div data-conversation-composer><div role="textbox" data-testid="chat-prompt-input"></div><textarea></textarea></div>');
    expect(readRunWindowOwnership(two)).toMatchObject({ composers: 1, malformedHolders: 1 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(two), "chat")).toThrow(/holds? /);
    const one = root(card + '<div data-conversation-composer><div role="textbox" data-testid="chat-prompt-input"></div></div>');
    expect(readRunWindowOwnership(one)).toMatchObject({ composers: 1, malformedHolders: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(one), "chat")).not.toThrow();
  });
  // Pre-review 2, finding 3: the chat message editor is one declared exception.
  const composerOnly = '<div data-conversation-composer><div role="textbox"></div></div>';
  const editor = '<div data-chat-message-editor><textarea></textarea><button>Save</button></div>';
  it("accepts chat's message editor beside its composer, and on chat only", () => {
    const reading = readRunWindowOwnership(root(card + composerOnly + editor));
    expect(reading).toMatchObject({ windows: 0, composers: 1, messageEditors: 1, unownedPrompts: 0, malformedHolders: 0 });
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
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + composerOnly + markup)), "chat")).toThrow(/holds? |message editor/);
  });
  // Pre-review 5: THE INVERSION. The anchor is the node that itself holds exactly
  // one control. A shape where it does not is refused, whatever the reason it is
  // wrong. The named limits below are what the reader does not read.
  const page = (inner: string): string => '<div data-run-window-host="page-chrome">' + inner + '</div>';
  const anchor = (inner: string): string => '<div data-conformance-id="run-window">' + inner + '</div>';
  const legacy = (inner: string): string => '<div data-conformance-id="review-prompt-window">' + inner + '</div>';
  const typed = '<div data-run-window-field><div role="textbox" contenteditable="true"></div><input type="file"><button aria-label="Apply AI suggestion"></button></div>';
  const spentField = '<div data-run-window-field aria-disabled="true"><p data-conformance-id="schedule-window-over" role="status">Over</p></div>';
  const spent = (inner: string): string => page('<div data-conformance-id="schedule-prompt-window"><div data-run-window-placement="floating">' + anchor(inner) + '</div></div>');
  it.each([
    ["the live window, as PromptField draws it", page(legacy(anchor(typed)))],
    ["the live window with no legacy node", page(anchor(typed))],
    ["the spent window, as the chrome draws it", spent(spentField)],
    ["the exchange above the field", page(anchor('<div data-run-window-scroll><p>Exchange</p></div>' + typed))],
  ])("takes %s", (_name, markup) => {
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + markup)), "run")).not.toThrow();
  });
  it.each([
    ["an empty anchor, the field its sibling (review 5, finding 1)", page(legacy('<div data-conformance-id="run-window"></div><div data-run-window-field><textarea></textarea></div>'))],
    ["an empty anchor, a raw textarea its sibling", page(legacy('<div data-conformance-id="run-window"></div><textarea></textarea>'))],
    ["an empty anchor alone", page(anchor(''))],
    ["an empty anchor in the legacy node", page(legacy(anchor('')))],
    ["an anchor with only a send button", page(anchor('<button aria-label="Apply AI suggestion"></button>'))],
    ["an anchor with only a text paragraph", page(anchor('<p>Text</p>'))],
    ["a live field marker with no typed control in it", page(anchor('<div data-run-window-field></div>'))],
    ["a live field marker with only its send button", page(anchor('<div data-run-window-field><button aria-label="Apply AI suggestion"></button></div>'))],
    ["a field marker with no control, disabled, with no notice", page(anchor('<div data-run-window-field aria-disabled="true"></div>'))],
    ["a field with a notice, not disabled", page(anchor('<div data-run-window-field><p data-conformance-id="schedule-window-over">Over</p></div>'))],
    ["a composer marker's field in the anchor", page(anchor('<div data-conformance-id="chat-composer-primary"></div>'))],
    ["the anchor on the field node itself", page('<div data-conformance-id="run-window" data-run-window-field></div>')],
    ["the anchor on the text-entry node itself", page('<textarea data-conformance-id="run-window"></textarea>')],
    ["the anchor on the field node, holding a typed control", page('<div data-conformance-id="run-window" data-run-window-field><textarea></textarea></div>')],
    ["the anchor on the field node, holding the real field's editor and send button", page('<div data-conformance-id="run-window" data-run-window-field><div role="textbox" contenteditable="true"></div><button aria-label="Apply AI suggestion"></button></div>')],
    ["the anchor on the field node, disabled, holding the notice", page('<div data-conformance-id="run-window" data-run-window-field aria-disabled="true"><p data-conformance-id="schedule-window-over">Over</p></div>')],
    ["the anchor on the prompt test id, holding a typed control", page('<div data-conformance-id="run-window" data-testid="chat-prompt-input"><textarea></textarea></div>')],
    ["the anchor on the send label, holding a typed control", page('<div data-conformance-id="run-window" aria-label="Apply AI suggestion"><textarea></textarea></div>')],
    ["the anchor on an editable node, holding a typed control", page('<div data-conformance-id="run-window" contenteditable="true"><textarea></textarea></div>')],
    ["the anchor with a textbox role, holding a typed control", page('<div data-conformance-id="run-window" role="textbox"><textarea></textarea></div>')],
    ["a field marker around the anchor", page('<div data-run-window-field>' + anchor(typed) + '</div>')],
    ["a field marker on the legacy node around the anchor", page('<div data-conformance-id="review-prompt-window" data-run-window-field>' + anchor(typed) + '</div>')],
    ["the anchor's one control inside a card in the anchor", page(anchor('<section data-lifecycle-card-host="inner"><textarea></textarea></section>'))],
    ["the anchor's one control inside a message editor in the anchor", page(anchor('<div data-chat-message-editor><textarea></textarea></div>'))],
    ["the anchor's one control inside a composer in the anchor", page(anchor('<div data-conversation-composer><textarea></textarea></div>'))],
    ["a second anchor around the anchor", page(anchor(anchor(typed)))],
    ["two controls in the anchor", page(anchor(typed + '<textarea></textarea>'))],
    ["a field beside a typed field in the anchor", page(anchor(typed + '<div data-run-window-field></div>'))],
    ["a typed field and a spent field in the anchor", page(anchor(typed + spentField))],
    ["a field beside the anchor, in the chrome", page(anchor(typed) + '<div data-run-window-field></div>')],
    ["a textarea beside the anchor, in the chrome", page(anchor(typed) + '<textarea></textarea>')],
    ["a send label beside the anchor, in the legacy node", page(legacy(anchor(typed) + '<button aria-label="Apply AI suggestion"></button>'))],
    ["a text-entry control beside the anchor, in the legacy node", page(legacy(anchor(typed) + '<div contenteditable="true"></div>'))],
    ["a legacy node around the chrome", legacy(page(anchor(typed)))],
    ["a second legacy node inside the first, beside the anchor", page(legacy(anchor(typed) + legacy('')))],
  ])("refuses %s", (_name, markup) => {
    for (const host of ["run", "review"] as const)
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + markup)), host)).toThrow();
  });
  // The composer is read by the same rule as the anchor.
  it.each([
    ["an empty composer", '<div data-conversation-composer></div>'],
    ["a composer with a field marker and no typed control", '<div data-conversation-composer><div data-conformance-id="chat-composer-primary"></div></div>'],
    ["a composer with only a send button", '<div data-conversation-composer><button aria-label="Apply AI suggestion"></button></div>'],
    ["a composer whose one control is inside a card in it", '<div data-conversation-composer><section data-lifecycle-card-host="inner"><textarea></textarea></section></div>'],
    ["a composer on the field node, holding a typed control", '<div data-conversation-composer data-run-window-field><textarea></textarea></div>'],
    ["a composer on the prompt test id, holding a typed control", '<div data-conversation-composer data-testid="chat-prompt-input"><textarea></textarea></div>'],
    ["a composer whose one control is its own node", '<textarea data-conversation-composer></textarea>'],
  ])("refuses %s on chat", (_name, markup) => {
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + markup)), "chat")).toThrow();
  });
  // Pre-review 5, finding 2: a notice's window is closed. It holds only elements of a
  // small allow-list, so a kind of control that no list names is refused too.
  it.each([
    '<select><option>Change</option></select>', '<button>Change</button>', '<a href="/x">Change</a>', '<input type="hidden">', '<input type="file">', '<input type="checkbox">',
    '<textarea></textarea>', '<details><summary>More</summary></details>', '<label>Change</label>', '<div tabindex="0">Change</div>', '<div tabindex="-1">Change</div>',
    '<div contenteditable="true"></div>', '<div role="button">Change</div>', '<div role="BUTTON">Change</div>', '<div role="presentation link">Change</div>', '<div role="combobox"></div>', '<div role="spinbutton"></div>',
    '<div role="listbox"></div>', '<div role="option"></div>', '<div role="checkbox"></div>', '<div role="radio"></div>', '<div role="switch"></div>', '<div role="slider"></div>',
    '<div role="menuitem"></div>', '<div role="tab"></div>', '<div role="searchbox"></div>', '<video controls></video>', '<audio controls></audio>', '<iframe></iframe>', '<div onclick="x()">Change</div>',
    '<div role="treegrid"></div>', '<div role="toolbar"></div>', '<div role="application"></div>', '<div role="radiogroup"></div>', '<div role="dialog"></div>', '<div role="alertdialog"></div>',
    '<option>Change</option>', '<dialog></dialog>', '<menu></menu>', '<datalist></datalist>', '<img src="x">', '<svg></svg>', '<section>Change</section>', '<div draggable="true">Change</div>',
    '<div onfocus="x()">Change</div>', '<div aria-label="Change"></div>', '<div id="change"></div>', '<div style="color: red"></div>', '<div role="status link"></div>', '<custom-control></custom-control>',
  ])("refuses a spent window that holds %s", (control) => {
    for (const markup of [
      spent(spentField.replace('</p>', '</p>' + control)),
      spent(spentField + control),
      spent(spentField).replace('</div></div></div></div>', '</div></div>' + control + '</div></div>'),
      spent(spentField.replace('Over', 'Over' + control)),
    ]) {
      const reading = readRunWindowOwnership(root(card + markup));
      expect(reading.noticeWindowBreaches).toBeGreaterThan(0);
      expect(() => assertRunWindowOwnership(reading, "run")).toThrow(/notice's window/);
    }
  });
  it("reads a notice in any window by the same rule, and a notice that is no anchor's", () => {
    const live = root(card + page(legacy(anchor(typed + '<p data-conformance-id="schedule-window-over">Over</p>'))));
    expect(readRunWindowOwnership(live).noticeWindowBreaches).toBeGreaterThan(0);
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(live), "run")).toThrow(/notice's window/);
    const beside = root(card + page(anchor(typed) + '<p data-conformance-id="schedule-window-over">Over</p>'));
    expect(readRunWindowOwnership(beside)).toMatchObject({ notices: 1, pageNotices: 0 });
    expect(() => assertRunWindowOwnership(readRunWindowOwnership(beside), "run")).toThrow(/notice/);
  });
  it("takes the allow-list's own elements and attributes in a spent window", () => {
    const reading = readRunWindowOwnership(root(card + spent(spentField.replace('Over', '<span class="x" data-y="z" role="STATUS">Over</span>') + '<div class="x"><p>More</p></div>')));
    expect(reading).toMatchObject({ pageNotices: 1 });
    expect(() => assertRunWindowOwnership(reading, "run")).not.toThrow();
  });
  it("takes the spent window's own status role and an inert notice text", () => {
    const reading = readRunWindowOwnership(root(card + spent(spentField.replace('Over', '<span>Over</span>'))));
    expect(reading).toMatchObject({ pageNotices: 1, noticeWindowBreaches: 0 });
    expect(() => assertRunWindowOwnership(reading, "run")).not.toThrow();
  });
  it("names the limit: outside a notice's window a control that takes no text is no control", () => {
    for (const other of ['<select><option>A</option></select>', '<div role="combobox"></div>', '<button>Other</button>'])
      expect(() => assertRunWindowOwnership(readRunWindowOwnership(root(card + page(anchor(typed + other)))), "run")).not.toThrow();
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
