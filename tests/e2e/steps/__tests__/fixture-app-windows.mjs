// More pages of the fixture app, for typeInWindow, waitForTurn, reloadPage,
// sendInComposer and openAddress: run windows, a conversation's composer, pages
// to open by their address and pages to reload. fixture-app.mjs hands every
// request under /window/, /composer/, /address/ and /reload/ to
// `serveWindowPage`.
//
// A window is drawn as the product draws one: its entries, each marked
// `data-run-window-entry` (`person` or `assistant`), above its field, a box whose
// content is editable (role textbox, named by `aria-label`) and a send control of
// the same name. What the page's own handlers do with a window is declared as
// JSON (`fixture-windows`, by the name in `data-fixture-window-box` and
// `data-fixture-window-send`). In a browser the page's inline script runs the two
// handlers below on the page's own events; the page double (page-double.mjs)
// runs the same two functions on its own document. One declaration and one
// source feed both.
//
// Nothing here is a credential of anything, and no page carries an address.

/** The accessible name of a run window's box and of its send control, spelled here so a changed default in the steps fails these cases. */
export const RUN_WINDOW_NAME = "Apply AI suggestion";
/** The conversation composer's name, and its send control's. */
export const COMPOSER_NAME = "Send message";
/** What the assistant answers in a window. */
export const WINDOW_ANSWER = "The title is filled from your message.";
/** The text a window's box or the composer holds before a step types into it. */
export const DRAFT = "An earlier draft";

// The two handlers of a window. They run IN THE PAGE: the page's inline script
// runs them in a browser, and the page double runs the same two on its own
// document, so nothing of this module may be used inside them.

/**
 * Text typed into a window's box. The page keeps its send control disabled while
 * the box is empty, as the product's field does, and a box marked
 * `data-fixture-digits` keeps only the digits of what was typed into it.
 */
export function inputInFixtureWindow(box) {
  const document = box.ownerDocument;
  const name = box.getAttribute("data-fixture-window-box");
  const send = document.querySelector('[data-fixture-window-send="' + name + '"]');
  if (box.hasAttribute("data-fixture-digits")) {
    const digits = box.textContent.replace(/[^0-9]/g, "");
    if (digits !== box.textContent) box.textContent = digits;
  }
  if (send && box.getAttribute("contenteditable") !== "false") send.disabled = box.textContent.trim() === "";
}

/**
 * A press on a window's send control, as the window declares it in
 * `fixture-windows`:
 *   - a window that takes no message (`takes: false`) does nothing;
 *   - otherwise the box is emptied, the person's entry joins `entries` (and the
 *     message joins the list `echo`), and then, by `pending`:
 *       - `none`: the answer comes at once, and the window never waits;
 *       - `until-answer`: the window waits (its box is locked and its send
 *         control reads "Stop") until the answer comes, `answerMs` later;
 *       - `forever`: the window waits and never stops waiting; the answer, when
 *         one is declared, comes `answerMs` later all the same;
 *   - the answer is an entry of the assistant (`answer.entry`), or markup put
 *     at the end of `answer.into` (`answer.html`): a card, a run, a toast.
 * `later(run, ms)` runs `run` after `ms`.
 */
export function sendInFixtureWindow(send, later) {
  const document = send.ownerDocument;
  const name = send.getAttribute("data-fixture-window-send");
  const own = JSON.parse(document.getElementById("fixture-windows").textContent)[name];
  const box = document.querySelector('[data-fixture-window-box="' + name + '"]');
  if (!own || !box || own.takes === false || box.getAttribute("contenteditable") === "false") return;
  const text = box.textContent.replace(/\u00a0/g, " ").trim();
  if (text === "") return;
  box.textContent = "";
  send.disabled = true;
  const entries = own.entries ? document.getElementById(own.entries) : null;
  const entry = function (who, words) {
    if (!entries) return;
    const node = document.createElement("div");
    node.setAttribute("data-run-window-entry", who);
    node.textContent = words;
    entries.appendChild(node);
  };
  const echo = own.echo ? document.getElementById(own.echo) : null;
  if (echo) {
    const item = document.createElement("li");
    item.textContent = text;
    echo.appendChild(item);
  }
  const waiting = function (on) {
    box.setAttribute("contenteditable", on ? "false" : "true");
    send.setAttribute("aria-label", on ? "Stop" : own.name);
    send.textContent = on ? "Stop" : "Send";
  };
  const answer = function () {
    if (!own.answer) return;
    if (own.answer.entry) entry("assistant", own.answer.entry);
    if (own.answer.html) {
      const into = document.querySelector(own.answer.into);
      if (into) into.insertAdjacentHTML("beforeend", own.answer.html);
    }
  };
  entry("person", text);
  if (own.pending === "none") {
    answer();
    return;
  }
  waiting(true);
  later(function () {
    answer();
    if (own.pending === "until-answer") waiting(false);
  }, own.answerMs || 0);
}

// The page's own handlers, as a browser runs them: the two above on the page's
// own events, and the declared timeline.
const WINDOW_RUNNER = `<script>
(function () {
  var inputInFixtureWindow = ${inputInFixtureWindow};
  var sendInFixtureWindow = ${sendInFixtureWindow};
  JSON.parse(document.getElementById("fixture-timeline").textContent).forEach(function (op) {
    setTimeout(function () {
      var el = document.querySelector(op.target);
      if (el) el.innerHTML = op.html;
    }, op.at);
  });
  document.addEventListener("input", function (event) {
    var box = event.target && event.target.closest ? event.target.closest("[data-fixture-window-box]") : null;
    if (box) inputInFixtureWindow(box);
  });
  document.addEventListener("click", function (event) {
    var send = event.target && event.target.closest ? event.target.closest("[data-fixture-window-send]") : null;
    if (send && !send.disabled) sendInFixtureWindow(send, function (run, ms) { setTimeout(run, ms); });
  });
})();
</script>`;

/** JSON for a script element: a `<` inside it could end the element. */
const inScript = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

function windowPage(title, body, { windows = {}, timeline = [] } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
${body}
<script type="application/json" id="fixture-windows">${inScript(windows)}</script>
<script type="application/json" id="fixture-timeline">${inScript(timeline)}</script>
${WINDOW_RUNNER}
</body></html>`;
}

// A box drawn with a size of its own: an empty box takes no room, and a browser presses nothing without a size.
const BOX_STYLE = "display:inline-block;min-width:240px;min-height:24px;border:1px solid";

/**
 * A window's box, holding `text`, and its send control, both named `name`; a
 * locked window reads "Stop" on its send control, and with `send: false` the box
 * has none.
 */
function field(window, name, { text = "", locked = false, extra = "", send = true } = {}) {
  const box = `<div role="textbox" contenteditable="${locked ? "false" : "true"}" aria-multiline="false" aria-label="${name}" data-fixture-window-box="${window}" style="${BOX_STYLE}"${extra}>${text}</div>`;
  if (!send) return box;
  const control = `<button type="button" aria-label="${locked ? "Stop" : name}" data-fixture-window-send="${window}"${text && !locked ? "" : " disabled"}>${locked ? "Stop" : "Send"}</button>`;
  return `${box} ${control}`;
}

/** A run window as the product draws one: its entries above its field, and the sentence of the empty field hidden from every name. */
function runWindow(window, { entries = [], draft = "", locked = false } = {}) {
  const drawn = entries.map(([who, words]) => `<div data-run-window-entry="${who}">${words}</div>`).join("");
  return (
    `<div data-run-window-placement="in-flow"><div id="${window}-entries">${drawn}</div>` +
    `<div data-run-window-field=""><span aria-hidden="true">Ask Cinatra to fill the fields above, or ask about this step…</span> ` +
    `${field(window, RUN_WINDOW_NAME, { text: draft, locked })}</div></div>`
  );
}

/** How a run window answers a message: after `answerMs`, with the assistant's entry. */
const answers = (answerMs, pending = "until-answer") => ({ name: RUN_WINDOW_NAME, pending, answerMs, answer: { entry: WINDOW_ANSWER } });
const EARLIER = [
  ["person", "What does this step need?"],
  ["assistant", "A title and a summary."],
];
/** The step a run page shows above its window: a form whose own text box, named "Title", is no window's box. */
const STEP_FORM = '<section aria-label="Step form"><h2>Research brief</h2><label>Title <input name="title"></label></section>';

/**
 * The window pages, by the second segment of their path:
 *   - `turn`: a run page, its step's form and its window, which shows an
 *     earlier exchange and answers a message 300 ms after it is sent;
 *   - `slow`: the same, answering a second after it;
 *   - `at-once`: a window that answers at once and never waits, as the
 *     product's window does on a screen with no run yet;
 *   - `never`: a window that takes a message and waits for an answer that
 *     never comes;
 *   - `stuck`: a window whose answer comes, and which never stops waiting;
 *   - `draft`: a window whose box holds a draft;
 *   - `locked`: a window that waits for an answer when the page loads: its box
 *     is locked and its send control reads "Stop";
 *   - `late`: a window the page mounts 300 ms after it loads.
 */
export const WINDOW_SCENARIOS = Object.freeze({
  turn: { entries: EARLIER, window: answers(300) },
  slow: { entries: EARLIER, window: answers(1000) },
  "at-once": { entries: [], window: { ...answers(0), pending: "none" } },
  never: { entries: EARLIER, window: { name: RUN_WINDOW_NAME, pending: "forever", answer: null } },
  stuck: { entries: EARLIER, window: answers(300, "forever") },
  draft: { entries: [], draft: DRAFT, window: answers(300) },
  locked: { entries: EARLIER, locked: true, window: answers(300) },
  late: { entries: [], late: 300, window: answers(300) },
});

function windowScenarioPage(name, scenario) {
  const drawn = runWindow(name, { entries: scenario.entries, draft: scenario.draft, locked: scenario.locked });
  const windows = { [name]: { ...scenario.window, entries: `${name}-entries` } };
  if (scenario.late) {
    const body = `<main aria-label="Run">${STEP_FORM}<div id="window-slot"></div></main>`;
    return windowPage("Run", body, { windows, timeline: [{ at: scenario.late, target: "#window-slot", html: drawn }] });
  }
  return windowPage("Run", `<main aria-label="Run">${STEP_FORM}${drawn}</main>`, { windows });
}

/** Two windows of one name on one page: the step's and the review's, each in a region of its own. */
function twoWindowsPage() {
  const body =
    `<main aria-label="Run"><section aria-label="Step">${runWindow("step")}</section>` +
    `<section aria-label="Review">${runWindow("review")}</section></main>`;
  const windows = { step: { ...answers(300), entries: "step-entries" }, review: { ...answers(300), entries: "review-entries" } };
  return windowPage("Run", body, { windows });
}

/**
 * Three more boxes, each in a region of its name: "Notes", with no send control
 * beside it; "Budget", whose page keeps only the digits typed into it; and
 * "Feedback", whose page takes no message sent from it.
 */
function fieldsPage() {
  const body =
    `<main aria-label="Fields"><section aria-label="Notes">${field("notes", "Notes", { send: false })}</section>` +
    `<section aria-label="Budget">${field("budget", "Budget", { extra: " data-fixture-digits" })}</section>` +
    `<section aria-label="Feedback">${field("feedback", "Feedback")}</section></main>`;
  const windows = {
    budget: { name: "Budget", pending: "none", answer: null },
    feedback: { name: "Feedback", takes: false },
  };
  return windowPage("Fields", body, { windows });
}

// ---------------------------------------------------------------------------
// The conversation's composer, and what answers a message sent through it.
// ---------------------------------------------------------------------------

const inThread = (html) => ({ html: `<li>${html}</li>`, into: "#composer-thread" });
/** A lifecycle card, as the conversation draws a schedule's proposal. */
const SCHEDULE_CARD =
  '<div data-lifecycle-card="trigger_schedule_proposal" data-lifecycle-card-state="proposed"><h3>Schedule</h3><p>Every Monday at nine.</p></div>';
/** A renderable view, as the conversation draws a preview of an item. */
const PREVIEW_CARD = '<div data-view-type="artifact_preview"><p>Brief.md</p><p>text/markdown · 2 KB</p></div>';
/** A renderable view, as the conversation draws the sources of an answer. */
const SOURCES_CARD = '<div data-view-type="citation_group"><p>Two sources.</p></div>';
/** The run panel the conversation draws for a run it started. */
const RUN_PANEL = '<section data-run-progress-panel=""><span data-slot="status-pill" data-status="queued" data-glyph="dot">queued</span></section>';

/**
 * The composer pages, by the second segment of their path. Each answers a
 * message 300 ms after it is sent:
 *   - `card`: with a lifecycle card;
 *   - `view`: with a renderable view;
 *   - `thread`: a conversation that shows a card of sources already, whose
 *     composer holds a draft, and which answers with a second card of sources;
 *   - `run`: with the run panel of a run the message started;
 *   - `notify`: with a notification that a run started;
 *   - `quiet`: with text, and no card;
 *   - `error`: with the conversation's error card.
 */
export const COMPOSER_SCENARIOS = Object.freeze({
  card: { answer: inThread(SCHEDULE_CARD) },
  view: { answer: inThread(PREVIEW_CARD) },
  thread: { thread: `<li>An earlier question.</li><li>${SOURCES_CARD}</li>`, draft: DRAFT, answer: inThread(SOURCES_CARD) },
  run: { answer: inThread(RUN_PANEL) },
  notify: { answer: { html: '<li data-sonner-toast="" data-type="success">Run started: Research assistant</li>', into: "#composer-toasts" } },
  quiet: { answer: inThread("Here is what I found.") },
  error: { answer: inThread('<div data-chat-error-card="">The assistant could not answer.</div>') },
});

function composerPage(scenario) {
  const body =
    `<main><h1>Good evening</h1><ol aria-label="Messages" id="composer-thread">${scenario.thread ?? ""}</ol>` +
    `<div class="prompt-field"><span aria-hidden="true">Ask anything...</span> ${field("chat", COMPOSER_NAME, { text: scenario.draft ?? "" })}</div>` +
    '<ol data-sonner-toaster="" id="composer-toasts"></ol></main>';
  const windows = { chat: { name: COMPOSER_NAME, echo: "composer-thread", pending: "until-answer", answerMs: 300, answer: scenario.answer } };
  return windowPage("Chat", body, { windows });
}

// ---------------------------------------------------------------------------
// Pages to open by their address, and pages to reload.
// ---------------------------------------------------------------------------

const plainPage = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body></html>`;

/** The not-found page, as the product draws it for an address no page has. */
export const NOT_FOUND_HEADING = "404 — Page not found";
const NOT_FOUND_PAGE = plainPage(
  "Page not found",
  `<main><h1>${NOT_FOUND_HEADING}</h1><p>The page you are looking for does not exist or may have moved.</p><a href="/chat">Back to app</a></main>`,
);

/**
 * The address pages, by the second segment of their path: `start` links to
 * `linked`, and to `hidden-only` by a link that is not shown; `slow` answers
 * after three seconds. Every other path under /address/ is the not-found page.
 */
const ADDRESS_PAGES = Object.freeze({
  start: '<nav aria-label="Main"><a href="/address/linked">Linked</a> <a href="/address/hidden-only" hidden>Hidden</a></nav>',
  linked: "<p>A page a link leads to.</p>",
  "hidden-only": "<p>A page only a link that is not shown leads to.</p>",
});

/**
 * The reload pages, by the second segment of their path: `page` reloads as it
 * loaded; `moves` sends a reload elsewhere (every load after its first is sent
 * on to `elsewhere`); `slow` answers every load after its first after three
 * seconds.
 */
const RELOAD_PAGES = Object.freeze(["page", "moves", "slow", "elsewhere"]);

/**
 * Answer one request under /window/, /composer/, /address/ or /reload/. `loads`
 * counts the loads of each path, for the pages whose later loads differ.
 * @param {{ method: string, url: URL, response: import("node:http").ServerResponse, loads: Map<string, number> }} request
 */
export function serveWindowPage({ url, response, loads }) {
  const html = (status, text) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(text);
  };
  const [, kind, name] = /^\/([a-z]+)\/([a-z-]+)$/.exec(url.pathname) ?? [];
  if (kind === "window") {
    if (name === "two") return html(200, twoWindowsPage());
    if (name === "fields") return html(200, fieldsPage());
    if (Object.hasOwn(WINDOW_SCENARIOS, name)) return html(200, windowScenarioPage(name, WINDOW_SCENARIOS[name]));
  }
  if (kind === "composer" && Object.hasOwn(COMPOSER_SCENARIOS, name)) return html(200, composerPage(COMPOSER_SCENARIOS[name]));
  if (kind === "address") {
    if (name === "slow") {
      setTimeout(() => html(200, plainPage("Slow", "<p>Slow.</p>")), 3000);
      return;
    }
    if (Object.hasOwn(ADDRESS_PAGES, name)) return html(200, plainPage(url.pathname, ADDRESS_PAGES[name]));
  }
  if (kind === "reload" && RELOAD_PAGES.includes(name)) {
    const seen = (loads.get(url.pathname) ?? 0) + 1;
    loads.set(url.pathname, seen);
    if (name === "moves" && seen > 1) {
      response.writeHead(302, { location: "/reload/elsewhere" });
      response.end();
      return;
    }
    if (name === "slow" && seen > 1) {
      setTimeout(() => html(200, plainPage("Slow", "<p>Reloaded slowly.</p>")), 3000);
      return;
    }
    return html(200, plainPage(url.pathname, `<main><h1>${name}</h1><p>A page to reload.</p></main>`));
  }
  html(404, NOT_FOUND_PAGE);
}
