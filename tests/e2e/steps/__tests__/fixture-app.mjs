// A small local app the step tests drive: sign-in pages, a review island, a run
// page, pages to count on, pages to navigate between and pages that hold
// streams open. On request it also serves every page over HTTP/2.
//
// Every page carries its behaviour twice, on purpose. An inline script runs it
// in a real browser; the same behaviour is declared as JSON in the page, and the
// page double (page-double.mjs) reads that JSON and plays it on its own document.
// One declaration feeds both, so the double cannot quietly drift from what the
// browser leg drives.
//
// Nothing here is a credential of anything: the tests build their values at run
// time, and the server only records which field NAMES a request carried.
import { X509Certificate, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";

/** The loopback address, built from parts so no address literal sits in source. */
export const LOOPBACK = [127, 0, 0, 1].join(".");

/** The app's own sign-in routes, spelled here so a changed default in the step fails these cases. */
export const EMAIL_ROUTE = "/api/auth/sign-in/email";
export const USERNAME_ROUTE = "/api/auth/sign-in/username";

/** The sign-in form's field names. */
export const FORM_FIELDS = Object.freeze(["email", "password"]);

/** The review island's frame path, spelled here for the same reason as the routes. */
export const ISLAND_FRAME_PATH = "/lifecycle/review-island";

/**
 * The sign-in pages, by the first segment of their path. `hydrateAfterMs` is when
 * the page's script takes the form over and sets the hydration mark (null: never);
 * `handler` is what it then does with a submission.
 */
export const SIGN_IN_SCENARIOS = Object.freeze({
  late: { hydrateAfterMs: 500, handler: "posts" },
  never: { hydrateAfterMs: null, handler: "posts" },
  ready: { hydrateAfterMs: 0, handler: "posts" },
  username: { hydrateAfterMs: 0, handler: "posts-username" },
  // The mark without a handler that owns the form: a press here submits natively.
  unowned: { hydrateAfterMs: 0, handler: "none" },
  // A handler that submits the form natively by script, which fires no submit event.
  scripted: { hydrateAfterMs: 0, handler: "scripted" },
  "scripted-get": { hydrateAfterMs: 0, handler: "scripted", method: "get" },
  // A handler that owns the form and sends nothing.
  silent: { hydrateAfterMs: 0, handler: "silent" },
  // A form without the email field: the fill cannot happen.
  nofield: { hydrateAfterMs: 0, handler: "posts", withoutEmail: true },
});

const island = (state, framePath = ISLAND_FRAME_PATH) =>
  `<div data-conformance-id="review-target-island" data-island-load-state="${state}">` +
  `<iframe src="${framePath}?target=fixture" title="Review target"></iframe></div>`;
const ISLAND = '[data-conformance-id="review-target-island"]';
const toState = (at, value) => ({ at, target: ISLAND, attr: "data-island-load-state", value });

/** The island pages: the markup and the timeline that changes it. */
export const ISLAND_SCENARIOS = Object.freeze({
  loads: { body: island("loading"), timeline: [toState(300, "loaded")] },
  stalls: { body: island("loading"), timeline: [] },
  "times-out": { body: island("loading"), timeline: [toState(200, "timed-out")] },
  // The card's own bound passes, and the late load heals it.
  heals: { body: island("loading"), timeline: [toState(150, "timed-out"), toState(500, "loaded")] },
  absent: { body: "<p>No review card on this page.</p>", timeline: [] },
  // An island whose frame shows another document: not the island the wait names.
  elsewhere: { body: island("loaded", "/some/other/frame"), timeline: [] },
});

// The run detail is swapped whole, so a reading never falls between two halves of one change.
const runPanel = (status) =>
  `<section data-run-progress-panel=""><span data-slot="status-pill" data-status="${status}" data-glyph="dot">${status}</span></section>`;
const completionCard = (evidence) =>
  `<div data-run-completion="with-output" data-run-completion-evidence="${evidence}">Run complete</div>`;
const runSurface = (detail) =>
  '<div data-conformance-id="run-surface"><aside data-run-step-rail=""></aside>' +
  // A pill the run surface draws for something else (a made item): never the run's status.
  '<span data-slot="status-pill" data-status="approved" data-glyph="icon">Approved</span>' +
  `<div id="run-detail">${detail}</div></div>`;
const toDetail = (at, html) => ({ at, target: "#run-detail", html });

/** The run pages. `reloads` is served twice: the first load reloads itself. */
export const RUN_SCENARIOS = Object.freeze({
  settles: {
    body: runSurface(runPanel("queued")),
    timeline: [toDetail(100, runPanel("running")), toDetail(400, runPanel("needs-review"))],
  },
  completes: {
    body: runSurface(runPanel("running")),
    timeline: [
      toDetail(250, runPanel("approved") + completionCard("pending")),
      toDetail(500, runPanel("approved") + completionCard("outputs")),
    ],
  },
  moving: { body: runSurface(runPanel("queued")), timeline: [toDetail(50, runPanel("running"))] },
  absent: { body: "<p>No run on this page.</p>", timeline: [] },
  unmarked: { body: runSurface(""), timeline: [] },
  reloads: { body: runSurface(runPanel("running")), timeline: [{ at: 200, reload: true }] },
  "reloads-again": { body: runSurface(runPanel("running")), timeline: [toDetail(150, runPanel("failed"))] },
});

const rows = (n, hiddenLast = false) =>
  Array.from({ length: n }, (_, i) => `<li class="row"${hiddenLast && i === n - 1 ? " hidden" : ""}>row</li>`).join("");

/** The count pages. `growing` gains one row every 50 ms for three seconds, so it never holds still. */
export const COUNT_SCENARIOS = Object.freeze({
  steady: { body: `<ul id="rows">${rows(3, true)}</ul>`, timeline: [] },
  none: { body: '<ul id="rows"></ul>', timeline: [] },
  late: { body: '<ul id="rows"></ul>', timeline: [{ at: 300, target: "#rows", html: rows(2) }] },
  growing: {
    body: `<ul id="rows">${rows(1)}</ul>`,
    timeline: Array.from({ length: 60 }, (_, i) => ({ at: 50 * (i + 1), target: "#rows", html: rows(i + 2) })),
  },
});

/** The page the navigation cases start from. */
export const NAV_START = [
  '<nav aria-label="Main">',
  '<a href="/nav/target?from=start">Target</a>',
  '<a href="/nav/hidden-only" hidden>Hidden</a>',
  '<a href="/nav/new-tab" target="_blank">New tab</a>',
  '<a href="/nav/redirect">Redirect</a>',
  '<a href="/nav/slow">Slow</a>',
  // A link whose handler cancels every press, a press that asks for a further page included.
  '<a href="/nav/inert" data-fixture-inert>Inert</a>',
  // Links whose href is a fallback only: the handler cancels the press and opens,
  // in place, a dialog or the panel the link controls.
  '<a href="/nav/details" aria-label="View details for the target" aria-haspopup="dialog" data-fixture-opens="nav-details">Details</a>',
  '<a href="/nav/filters" aria-controls="nav-filters" aria-expanded="false" data-fixture-opens="nav-filters">Filters</a>',
  // A link whose handler navigates in place, as a client-side router does: it
  // requests the page, and moves the address once the slow answer has come.
  '<a href="/nav/slow-in-place" data-fixture-in-place>Slow in place</a>',
  "</nav>",
  '<div role="dialog" id="nav-details" aria-labelledby="nav-details-title" hidden><h2 id="nav-details-title">Target details</h2></div>',
  '<section id="nav-filters" aria-label="Filter the list" hidden><p>Filters.</p></section>',
].join("");

/** The request a stream page holds open: an event stream the server never ends. */
export const STREAM_ROUTE = "/stream/hold";

const holding = (n) => Array.from({ length: n }, () => ({ at: 0, stream: STREAM_ROUTE }));
const STREAM_BODY = '<nav aria-label="Main"><a href="/nav/target">Target</a></nav>';

/**
 * A page whose own response never ends: the server sends its first part and
 * holds the rest back. Its first part says so, for the page double.
 */
export const STREAMING_PAGE_PATH = "/stream/document";

/**
 * The pages that hold streams open, as the product's pages do: a signed-in page
 * holds one (its notifications stream), the page of an unfinished run three.
 * Each links to the navigation target, so a further page can be opened from it.
 */
export const STREAM_SCENARIOS = Object.freeze({
  one: { body: STREAM_BODY, timeline: holding(1) },
  three: { body: STREAM_BODY, timeline: holding(3) },
  // Its main thread is busy for 2.5 s from 100 ms after it loads: it cannot be read then.
  frozen: { body: STREAM_BODY, timeline: [...holding(1), { at: 100, freeze: 2500 }] },
});

// A list drawn as the shared select draws it (`data-fixture-hides-others`) does
// what the select's library does while the list is open: every element outside
// it is hidden from assistive technology, the combobox that opened it included.
// The library walks down from the body along the elements that hold the list, a
// live region or a script, and gives every other element it meets there
// `aria-hidden="true"` and its marker (`data-aria-hidden`); an element hidden
// already keeps its own value. An entry pressed in such a list
// (`data-fixture-chooses`) is taken: the list closes, the combobox that controls
// it shows the entry, and every element the list hid is shown again. A list
// that carries `data-fixture-closes-after` closes that many milliseconds after
// the choice, or never (`never`), as a list that is still closing does; the
// combobox shows the entry and the entry reads as selected at once. The Escape
// key closes every shown list a combobox opened the same way and takes no entry,
// the combobox reading collapsed again, unless the list carries
// `data-fixture-escape="ignored"`. page-double.mjs plays the same.
const TIMELINE_RUNNER = `<script>
(function () {
  var ops = JSON.parse(document.getElementById("fixture-timeline").textContent);
  function hideOthers(list) {
    var kept = [list].concat(Array.prototype.slice.call(document.querySelectorAll("[aria-live], script")));
    (function walk(parent) {
      Array.prototype.forEach.call(parent.children, function (child) {
        if (kept.indexOf(child) >= 0) return;
        if (kept.some(function (node) { return child.contains(node); })) return walk(child);
        var own = child.getAttribute("aria-hidden");
        if (own !== null && own !== "false") return;
        child.setAttribute("aria-hidden", "true");
        child.setAttribute("data-aria-hidden", "true");
      });
    })(document.body);
  }
  document.querySelectorAll("[data-fixture-inert]").forEach(function (link) {
    link.addEventListener("click", function (event) { event.preventDefault(); });
  });
  document.querySelectorAll("[data-fixture-opens]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      var opened = document.getElementById(link.getAttribute("data-fixture-opens"));
      if (opened) opened.removeAttribute("hidden");
      if (opened && opened.hasAttribute("data-fixture-hides-others")) hideOthers(opened);
      if (link.hasAttribute("aria-expanded")) link.setAttribute("aria-expanded", "true");
    });
  });
  document.querySelectorAll("[data-fixture-chooses]").forEach(function (entry) {
    entry.addEventListener("click", function (event) {
      event.preventDefault();
      var list = entry.closest("[role='listbox']");
      if (!list) return;
      function close() {
        list.setAttribute("hidden", "");
        document.querySelectorAll("[data-aria-hidden]").forEach(function (node) {
          node.removeAttribute("aria-hidden");
          node.removeAttribute("data-aria-hidden");
        });
      }
      var picker = document.querySelector("[aria-controls='" + list.id + "']");
      if (picker) {
        picker.textContent = entry.textContent;
        picker.removeAttribute("data-placeholder");
        picker.setAttribute("aria-expanded", "false");
      }
      var closesAfter = list.getAttribute("data-fixture-closes-after");
      if (closesAfter === null) close();
      else {
        entry.setAttribute("aria-selected", "true");
        if (closesAfter !== "never") setTimeout(close, Number(closesAfter));
      }
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    document.querySelectorAll("[role='listbox']").forEach(function (list) {
      if (!list.id || list.hasAttribute("hidden") || list.getAttribute("data-fixture-escape") === "ignored") return;
      var picker = document.querySelector("[data-fixture-opens='" + list.id + "'][aria-controls='" + list.id + "']");
      if (!picker) return;
      list.setAttribute("hidden", "");
      document.querySelectorAll("[data-aria-hidden]").forEach(function (node) {
        node.removeAttribute("aria-hidden");
        node.removeAttribute("data-aria-hidden");
      });
      picker.setAttribute("aria-expanded", "false");
    });
  });
  // A search field's own handlers (see PICK_SEARCH_PAGE): the page double runs the same two functions.
  var typeInSearchField = ${typeInSearchField};
  var pressSearchEntry = ${pressSearchEntry};
  document.addEventListener("input", function (event) {
    var field = event.target;
    if (!field || !field.hasAttribute || !field.hasAttribute("data-fixture-searches")) return;
    typeInSearchField(field, function (run, ms) { setTimeout(run, ms); });
  });
  document.addEventListener("click", function (event) {
    var option = event.target && event.target.closest ? event.target.closest("[data-fixture-picks]") : null;
    if (option) pressSearchEntry(option);
  });
  document.querySelectorAll("[data-fixture-in-place]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      var href = link.getAttribute("href");
      fetch(href).then(function () { history.pushState(null, "", href); });
    });
  });
  // pressByTestId: rows drawn without a role, as the upload dialog's type picker
  // draws them (see PRESS_ROWS_PAGE); page-double.mjs plays the same.
  document.querySelectorAll("[data-fixture-counts]").forEach(function (element) {
    element.addEventListener("click", function () {
      element.setAttribute("data-fixture-clicks", String(Number(element.getAttribute("data-fixture-clicks") || 0) + 1));
    });
  });
  document.querySelectorAll("[data-fixture-selects]").forEach(function (row) {
    row.addEventListener("click", function () {
      document.querySelectorAll("[data-fixture-selects]").forEach(function (other) { other.setAttribute("data-selected", String(other === row)); });
    });
  });
  document.querySelectorAll("[data-fixture-goes]").forEach(function (row) {
    row.addEventListener("click", function () { location.href = row.getAttribute("data-fixture-goes"); });
  });
  document.querySelectorAll("[data-fixture-toggles]").forEach(function (box) {
    box.addEventListener("click", function () {
      var on = box.getAttribute("aria-checked") !== "true";
      box.setAttribute("aria-checked", String(on));
      box.setAttribute("data-state", on ? "checked" : "unchecked");
    });
  });
  ops.forEach(function (op) {
    if (op.freeze) {
      // Counted from the load, so the page has loaded before its main thread is busy.
      window.addEventListener("load", function () {
        setTimeout(function () { var until = Date.now() + op.freeze; while (Date.now() < until) {} }, op.at);
      });
      return;
    }
    setTimeout(function () {
      if (op.reload) { location.reload(); return; }
      if (op.stream) { (window.fixtureStreams = window.fixtureStreams || []).push(new EventSource(op.stream)); return; }
      var el = document.querySelector(op.target);
      if (!el) return;
      if (op.attr) el.setAttribute(op.attr, op.value); else el.innerHTML = op.html;
    }, op.at);
  });
})();
</script>`;

/** A fixture page: its body, and the timeline its inline script plays (fixture-app-contexts.mjs draws its pages with it too). */
export function page(title, body, timeline = []) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
${body}
<script type="application/json" id="fixture-timeline">${JSON.stringify(timeline)}</script>
${TIMELINE_RUNNER}
</body></html>`;
}

function signInPage(scenario) {
  // The landing of signInThroughPage: where the page goes once the app has answered 200 (null: it stays).
  scenario = { ...scenario, landing: scenario.landing === undefined ? LANDING_PATH : scenario.landing };
  const email = scenario.withoutEmail ? "" : '<label>Email <input name="email" type="text" autocomplete="username"></label>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
<form id="sign-in" method="${scenario.method ?? "post"}">
  ${email}
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form>
<script type="application/json" id="fixture-scenario">${JSON.stringify(scenario)}</script>
<script>
(function () {
  var scenario = JSON.parse(document.getElementById("fixture-scenario").textContent);
  var form = document.getElementById("sign-in");
  function send(route, payload) {
    fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(function (answer) {
      if (answer.status === 200 && typeof scenario.landing === "string") location.assign(scenario.landing);
    });
  }
  function hydrate() {
    if (scenario.handler === "posts" || scenario.handler === "posts-username") {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var id = form.elements.email ? form.elements.email.value : "";
        var secret = form.elements.password.value;
        if (scenario.handler === "posts") send(${JSON.stringify(EMAIL_ROUTE)}, { email: id, password: secret });
        else send(${JSON.stringify(USERNAME_ROUTE)}, { username: id, password: secret });
      });
    } else if (scenario.handler === "silent") {
      form.addEventListener("submit", function (event) { event.preventDefault(); });
    } else if (scenario.handler === "scripted") {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        setTimeout(function () { form.submit(); }, 0);
      });
    }
    form.setAttribute("novalidate", "");
  }
  if (scenario.hydrateAfterMs !== null) setTimeout(hydrate, scenario.hydrateAfterMs);
})();
</script>
</body></html>`;
}

/**
 * A certificate for the HTTP/2 origin, made at run time and signed by its own
 * key, because a browser speaks HTTP/2 only over TLS. Neither is kept anywhere.
 */
function selfSignedCertificate() {
  const der = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    const size = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
    return Buffer.concat([Buffer.from([tag, ...size]), body]);
  };
  const sequence = (...parts) => der(0x30, ...parts);
  const oid = (hex) => der(0x06, Buffer.from(hex, "hex"));
  const time = (ms) => der(0x17, Buffer.from(`${new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // Its subject and its issuer, the same name: localhost.
  const name = sequence(der(0x31, sequence(oid("550403"), der(0x0c, Buffer.from("localhost")))));
  // Signed with ECDSA over a SHA256 digest.
  const signature = sequence(oid("2a8648ce3d040302"));
  const now = Date.now();
  const body = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // the third version of the format
    der(0x02, Buffer.from([1])), // its serial number
    signature,
    name,
    sequence(time(now - 60_000), time(now + 86_400_000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    // The one host name it is for: localhost.
    der(0xa3, sequence(sequence(oid("551d11"), der(0x04, sequence(der(0x82, Buffer.from("localhost"))))))),
  );
  const certificate = sequence(body, signature, der(0x03, Buffer.from([0]), sign("sha256", body, privateKey)));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert: new X509Certificate(certificate).toString() };
}

// readRows, the landing of signInThroughPage, dispatchRun, press and selectFrom:
// the pages their cases drive.

/** Where a sign-in page goes once the app has answered 200, unless its scenario names another landing (null: it stays). */
export const LANDING_PATH = "/landing/app";

/** The app shell a landed page draws: its link to the chat is the sign-in step's ready signal. */
export const APP_SHELL = '<nav aria-label="Main"><a href="/chat">Chat</a> <a href="/nav/target">Target</a></nav>';

/** The landing pages: the shell drawn at once, drawn late, or never. `/landing/slow` serves it after a second. */
export const LANDING_SCENARIOS = Object.freeze({
  app: { body: APP_SHELL, timeline: [] },
  late: { body: '<main id="app"><p>Loading.</p></main>', timeline: [{ at: 600, target: "#app", html: APP_SHELL }] },
  bare: { body: "<p>A page without the app shell.</p>", timeline: [] },
});

/** The sign-in pages whose landing is not the app page: it never comes, comes late, comes slowly, or draws no shell. */
export const LANDING_SIGN_IN_SCENARIOS = Object.freeze({
  stays: { hydrateAfterMs: 0, handler: "posts", landing: null },
  "lands-late": { hydrateAfterMs: 0, handler: "posts", landing: "/landing/late" },
  "lands-slow": { hydrateAfterMs: 0, handler: "posts", landing: "/landing/slow" },
  "lands-bare": { hydrateAfterMs: 0, handler: "posts", landing: "/landing/bare" },
});

/**
 * The cards a run starts from. A card's Run leads to the run page, or its
 * handler shows a notification in place, or an error, or does nothing, or it
 * leads to a page without a run; other cards have no Run, share a name, have two
 * controls named Run, or a disabled one.
 */
export const CARD_PAGE = [
  '<section aria-label="Agents">',
  // The product's agent card: its name in the card's name slot, a Run link to the launcher, and a Settings link.
  '<div data-slot="installed-extension-card"><div data-slot="extension-card-name">Research assistant</div>',
  '<a href="/cards/launch/run"><svg aria-hidden="true"></svg>Run</a> <a href="/nav/target">Settings</a></div>',
  '<div data-slot="card"><div data-slot="card-title">Blog writer</div><a href="/cards/launch/notify" data-fixture-opens="toast-started">Run</a></div>',
  '<article aria-label="Inert agent"><a href="/cards/launch/inert" data-fixture-inert>Run</a></article>',
  '<div data-slot="card"><h3>Failing agent</h3><a href="/cards/launch/fails" data-fixture-opens="toast-failed">Run</a></div>',
  '<div data-slot="card"><h3>Broken agent</h3><a href="/cards/launch/nothing">Run</a></div>',
  '<div data-slot="card"><h3>Draft agent</h3><a href="/nav/target">Open</a></div>',
  '<div data-slot="card"><h3>Twin agent</h3><a href="/cards/launch/run">Run</a></div>',
  '<div data-slot="card"><h3>Twin agent</h3><a href="/cards/launch/run">Run</a></div>',
  '<div data-slot="card"><h3>Double agent</h3><a href="/cards/launch/run">Run</a> <button type="button">Run</button></div>',
  '<div data-slot="card"><h3>Locked agent</h3><button type="button" disabled>Run</button></div>',
  // A card whose Run opens a conversation, where the run is sent through the composer.
  '<div data-slot="card"><h3>Chat agent</h3><a href="/conversation/empty">Run</a></div>',
  "</section>",
  '<ol data-sonner-toaster="">',
  '<li data-sonner-toast="" data-type="success" id="toast-started" hidden>Run started: Blog writer</li>',
  '<li data-sonner-toast="" data-type="error" id="toast-failed" hidden>Could not start the agent.</li>',
  "</ol>",
].join("");

/**
 * A composer as the product draws it: a text box and a send button, both named
 * "Send message", and beside them the placeholder, hidden from every name.
 */
const composerOf = (placeholder) =>
  `<div class="prompt-field"><span aria-hidden="true">${placeholder}</span>` +
  '<div role="textbox" contenteditable="true" aria-multiline="false" aria-label="Send message"></div>' +
  '<a href="#send" role="button" aria-label="Send message" data-fixture-opens="conversation-new-run">Send</a></div>';
const NEW_RUN = '<section data-run-progress-panel="" id="conversation-new-run" hidden><span data-slot="status-pill" data-status="queued" data-glyph="dot">queued</span></section>';

/**
 * An empty conversation, and one with messages and an earlier run: the same
 * composer, with another placeholder; and a page whose text boxes are none of
 * them the composer, one named only by a placeholder, which is never a name.
 */
export const CONVERSATION_PAGES = Object.freeze({
  empty: `<main><h1>Good evening</h1>${composerOf("Ask anything...")}${NEW_RUN}</main>`,
  thread: [
    '<main><ol aria-label="Messages"><li>Start the research assistant.</li>',
    '<li><section data-run-progress-panel=""><span data-slot="status-pill" data-status="approved" data-glyph="dot">approved</span></section></li></ol>',
    `${NEW_RUN}${composerOf("Type a message...")}</main>`,
  ].join(""),
  boxes: [
    '<main><label>Search <input type="search"></label>',
    '<div role="textbox" contenteditable="true" aria-label="Notes"></div>',
    '<textarea placeholder="Type a message..."></textarea></main>',
  ].join(""),
});

/** The controls the press cases press: links, a form's button, a button that does nothing, a tab, a menu item, and two of one name. */
export const PRESS_PAGE = [
  '<nav aria-label="Main"><a href="/nav/target">Target</a> <a href="/nav/slow">Slow</a> <a href="/nav/slow-in-place" data-fixture-in-place>Slow in place</a></nav>',
  '<form method="get" action="/press/saved" aria-label="Note"><input name="note" value="kept"> <button type="submit">Save</button></form>',
  '<button type="button">Stay</button> <button type="button" disabled>Locked</button>',
  // A twin hidden from assistive technology: never a second "Save".
  '<div aria-hidden="true"><button type="button" tabindex="-1">Save</button></div>',
  '<div role="tablist" aria-label="Views"><a href="#second" role="tab" data-fixture-opens="press-second">Second</a></div>',
  '<section role="tabpanel" id="press-second" aria-label="Second view" hidden><p>The second view.</p></section>',
  '<div role="menu" aria-label="Actions"><a href="#archive" role="menuitem" data-fixture-opens="press-archived">Archive</a></div>',
  '<p id="press-archived" hidden>Archived.</p>',
  '<ul aria-label="Rows"><li aria-label="First row"><button type="button">Delete</button></li><li aria-label="Second row"><button type="button">Delete</button></li></ul>',
  // More buttons than a refusal lists.
  `<div role="toolbar" aria-label="Tools">${Array.from({ length: 8 }, (_, i) => `<button type="button">Tool ${i + 1}</button>`).join(" ")}</div>`,
].join("");

/**
 * Agent sections, each with its own "Add skill": one section named by its
 * heading, one by its label, and two that carry one heading. A skill's pill box
 * is a checkbox the page draws itself, whose handler flips it; the handler of a
 * pinned box keeps it as it is, and a box that is a link leaves the page.
 */
export const PRESS_SECTIONS_PAGE = [
  '<main aria-label="Agents">',
  '<section><h2>Research assistant</h2>',
  '<span><button type="button" role="checkbox" aria-checked="false" data-state="unchecked" aria-labelledby="press-skill-web" data-fixture-toggles style="width:16px;height:16px"></button>',
  ' <span id="press-skill-web">Web search</span></span>',
  ' <button type="button" role="checkbox" aria-checked="true" data-state="checked" aria-label="Pinned" style="width:16px;height:16px"></button>',
  ' <a href="/nav/target" role="checkbox" aria-checked="false" aria-label="Keep drafts">Keep drafts</a>',
  ' <a href="#add-research" role="button" data-fixture-opens="press-added-research">Add skill</a><p id="press-added-research" hidden>Added to Research assistant.</p></section>',
  '<section aria-label="Blog writer"><p>Blog writer</p>',
  '<a href="#add-blog" role="button" data-fixture-opens="press-added-blog">Add skill</a><p id="press-added-blog" hidden>Added to Blog writer.</p></section>',
  '<section><h2>Twin agent</h2><button type="button">Add skill</button></section>',
  '<section><h2>Twin agent</h2><button type="button">Add skill</button></section>',
  "</main>",
].join("");

/**
 * The pickers the selection cases select from: a select, a radio group, a
 * listbox that confirms a choice in a status, a combobox that opens its list,
 * two radio groups of one name, and a combobox whose list never opens.
 */
export const PICK_PAGE = [
  '<label for="pick-size">Size</label> <select id="pick-size"><option>Small</option><option>Medium</option><option>Large</option><option disabled>Huge</option></select>',
  // A picker's native twin, drawn but hidden from assistive technology: never a picker.
  '<select aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0"><option>Small</option></select>',
  '<fieldset><legend>Colour</legend><label><input type="radio" name="colour" value="red"> Red</label> <label><input type="radio" name="colour" value="green"> Green</label></fieldset>',
  '<div role="listbox" aria-label="Fruit"><a href="#apple" role="option" data-fixture-opens="pick-apple">Apple</a> <a href="#plum" role="option" data-fixture-inert>Plum</a></div>',
  '<p role="status" id="pick-apple" hidden>Fruit: Apple</p>',
  '<a href="#vegetables" role="combobox" aria-label="Vegetable" aria-controls="pick-vegetables" aria-expanded="false" data-fixture-opens="pick-vegetables">Choose</a>',
  '<div role="listbox" id="pick-vegetables" aria-label="Vegetables" hidden><a href="#leek" role="option" data-fixture-opens="pick-leek">Leek</a></div>',
  '<p role="status" id="pick-leek" hidden>Vegetable: Leek</p>',
  '<div role="radiogroup" aria-label="Twin"><span role="radio" aria-checked="false">One</span></div>',
  '<div role="radiogroup" aria-label="Twin"><span role="radio" aria-checked="false">Two</span></div>',
  '<a href="#shut" role="combobox" aria-label="Shut" aria-controls="pick-shut" data-fixture-inert>Choose</a>',
  '<div role="listbox" id="pick-shut" aria-label="Shut list" hidden><a href="#never" role="option">Never</a></div>',
].join("");

/**
 * Comboboxes with no accessible name, as the shared select draws them: one that
 * shows its placeholder (marked `data-placeholder`), one that shows the value it
 * holds, one after a label element in its form group, and two that show one
 * placeholder. A select named by its label shares that name with the
 * placeholder of a combobox after it.
 */
export const PICK_UNNAMED_PAGE = [
  '<a href="#vegetables" role="combobox" aria-controls="unnamed-vegetables" aria-expanded="false" data-placeholder="" data-fixture-opens="unnamed-vegetables"><span>Pick a vegetable</span></a>',
  '<div role="listbox" id="unnamed-vegetables" aria-label="Vegetables" hidden><a href="#leek" role="option" data-fixture-opens="unnamed-leek">Leek</a></div>',
  '<p role="status" id="unnamed-leek" hidden>Vegetable: Leek</p>',
  '<a href="#frequencies" role="combobox" aria-controls="unnamed-frequencies" aria-expanded="false" data-fixture-opens="unnamed-frequencies"><span>Weekly</span></a>',
  '<div role="listbox" id="unnamed-frequencies" aria-label="Frequencies" hidden><a href="#daily" role="option">Daily</a> <a href="#monthly" role="option" data-fixture-opens="unnamed-monthly">Monthly</a></div>',
  '<p role="status" id="unnamed-monthly" hidden>Frequency: Monthly</p>',
  '<div role="group"><label>Repository</label> <a href="#repositories" role="combobox" aria-controls="unnamed-repositories" aria-expanded="false" data-placeholder="" data-fixture-opens="unnamed-repositories"><span>Choose a repository</span></a></div>',
  '<div role="listbox" id="unnamed-repositories" aria-label="Repositories" hidden><a href="#main-site" role="option" data-fixture-opens="unnamed-main-site">Main site</a></div>',
  '<p role="status" id="unnamed-main-site" hidden>Repository: Main site</p>',
  '<a href="#skills-one" role="combobox" aria-controls="unnamed-skills-one" data-placeholder=""><span>Add a skill</span></a>',
  '<a href="#skills-two" role="combobox" aria-controls="unnamed-skills-two" data-placeholder=""><span>Add a skill</span></a>',
  '<label for="unnamed-kind">Kind</label> <select id="unnamed-kind"><option>Plain</option><option>Rich</option></select>',
  '<a href="#kinds" role="combobox" data-placeholder=""><span>Kind</span></a>',
].join("");

/**
 * Comboboxes whose list hides the rest of the page while it is open, as the
 * shared select's list does (see TIMELINE_RUNNER): one named "Plan", and one with
 * no accessible name that shows its placeholder, inside a wrapper, so that the
 * wrapper carries `aria-hidden` for it. Pressing an entry takes it, closes the
 * list and shows the page again.
 */
export const PICK_HIDING_PAGE = [
  '<a href="#plans" role="combobox" aria-label="Plan" aria-controls="hiding-plans" aria-expanded="false" data-placeholder="" data-fixture-opens="hiding-plans"><span>Choose a plan</span></a>',
  '<div role="listbox" id="hiding-plans" aria-label="Plans" hidden data-fixture-hides-others><a href="#free" role="option" data-fixture-chooses>Free</a> <a href="#team" role="option" data-fixture-chooses>Team</a></div>',
  '<div><a href="#skills" role="combobox" aria-controls="hiding-skills" aria-expanded="false" data-placeholder="" data-fixture-opens="hiding-skills"><span>Pick a skill</span></a></div>',
  '<div role="listbox" id="hiding-skills" aria-label="Skills" hidden data-fixture-hides-others><a href="#web-search" role="option" data-fixture-chooses>Web search</a> <a href="#summary" role="option" data-fixture-chooses>Summary</a></div>',
].join("");

/**
 * Three comboboxes whose list hides the rest of the page while it is open and
 * still hides it for a while after an entry is chosen (see TIMELINE_RUNNER): the
 * list of "Hour" and of "Minute" closes 30 ms after the choice, the list of
 * "Zone" never closes. Each list has no accessible name, as the shared select's
 * list has none, so a second pick on the page finds its combobox only once the
 * first list has closed.
 */
export const PICK_CLOSING_PAGE = [
  '<a href="#hour" role="combobox" aria-label="Hour" aria-controls="closing-hour" aria-expanded="false" data-fixture-opens="closing-hour"><span>Choose</span></a>',
  '<div role="listbox" id="closing-hour" hidden data-fixture-hides-others data-fixture-closes-after="30"><a href="#h08" role="option" data-fixture-chooses>08</a> <a href="#h09" role="option" data-fixture-chooses>09</a></div>',
  '<a href="#minute" role="combobox" aria-label="Minute" aria-controls="closing-minute" aria-expanded="false" data-fixture-opens="closing-minute"><span>Choose</span></a>',
  '<div role="listbox" id="closing-minute" hidden data-fixture-hides-others data-fixture-closes-after="30"><a href="#m00" role="option" data-fixture-chooses>00</a> <a href="#m30" role="option" data-fixture-chooses>30</a></div>',
  '<a href="#zone" role="combobox" aria-label="Zone" aria-controls="closing-zone" aria-expanded="false" data-fixture-opens="closing-zone"><span>Choose</span></a>',
  '<div role="listbox" id="closing-zone" hidden data-fixture-hides-others data-fixture-closes-after="never"><a href="#utc" role="option" data-fixture-chooses>UTC</a> <a href="#cet" role="option" data-fixture-chooses>CET</a></div>',
].join("");

/**
 * Two comboboxes whose list hides the rest of the page while it is open, for
 * the reading of a picker's entries (see TIMELINE_RUNNER): "State" shows the
 * entry it holds, "Active", and lists All, Active, Locked and Archived, as the
 * installed-extensions page offers its views; the list of "Stuck" does not close
 * on the Escape key (`data-fixture-escape="ignored"`). Neither list has an
 * accessible name, as the shared select's list has none.
 */
export const PICK_OPTIONS_PAGE = [
  '<a href="#state" role="combobox" aria-label="State" aria-controls="options-state" aria-expanded="false" data-fixture-opens="options-state"><span>Active</span></a>',
  '<div role="listbox" id="options-state" hidden data-fixture-hides-others><a href="#all" role="option" data-fixture-chooses>All</a> <a href="#active" role="option" data-fixture-chooses>Active</a> <a href="#locked" role="option" data-fixture-chooses>Locked</a> <a href="#archived" role="option" data-fixture-chooses>Archived</a></div>',
  '<a href="#stuck" role="combobox" aria-label="Stuck" aria-controls="options-stuck" aria-expanded="false" data-fixture-opens="options-stuck"><span>Choose</span></a>',
  '<div role="listbox" id="options-stuck" hidden data-fixture-hides-others data-fixture-escape="ignored"><a href="#one" role="option" data-fixture-chooses>One</a> <a href="#two" role="option" data-fixture-chooses>Two</a></div>',
].join("");

/**
 * The search fields of PICK_SEARCH_PAGE, as the entity search draws one: a text
 * input with the role combobox, whose list opens once text is typed into it.
 * `searchingMs` and `answerMs` are when the list shows its "Searching…" row and
 * its answer after the typing. Each field names its list, the entries a search
 * finds (the entry's name first, then what tells it apart), and what the page
 * does with a pressed entry (`takes`):
 *   - `row`: the field is emptied and a row naming the entry joins `rows`, as
 *     the agent's Skills tab draws a chosen skill;
 *   - `chip`: a chip naming the entry takes the field's place, as a user picker
 *     draws the chosen user;
 *   - `field`: the field shows the entry;
 *   - `another-row` and `another-field`: the page takes the entry listed after
 *     the pressed one instead, into a row or into the field;
 *   - `nothing`: the field is emptied and nothing is drawn, as a page at its
 *     limit takes no further entry.
 * A field with `opens: false` opens no list.
 */
export const SEARCH_FIELDS = Object.freeze({
  searchingMs: 100,
  answerMs: 250,
  fields: {
    "search-skills": {
      list: "search-skills-list",
      takes: "row",
      rows: "search-skills-rows",
      entries: [
        ["Web search pro", "Searches more sources · by Acme", "Active"],
        ["Web search", "Searches the web · by Acme", "Active"],
        ["Web scraper", "Reads one page · by Acme", "Active"],
        ["Summary", "Sums up a text · by Acme", "Active"],
        ["Summary", "Sums up a text · by Initech", "Locked"],
      ],
    },
    "search-people": {
      list: "search-people-list",
      takes: "chip",
      entries: [
        ["Ada Lovelace", "Engineering"],
        ["Alan Turing", "Research"],
      ],
    },
    "search-reviewers": {
      list: "search-reviewers-list",
      takes: "field",
      entries: [
        ["Grace Hopper", "Platform"],
        ["Grace Kelly", "Design"],
      ],
    },
    "search-author": {
      list: "search-author-list",
      takes: "another-row",
      rows: "search-author-rows",
      entries: [
        ["Dana", "Design"],
        ["Dana Scully", "Research"],
      ],
    },
    "search-assignee": {
      list: "search-assignee-list",
      takes: "another-field",
      entries: [
        ["Dana", "Design"],
        ["Dana Scully", "Research"],
      ],
    },
    "search-editor": { list: "search-editor-list", takes: "nothing", entries: [["Eve", "Support"]] },
    "search-viewer": { list: "search-viewer-list", opens: false, entries: [] },
  },
});

// The two handlers of a search field. They run IN THE PAGE: the page's inline
// script runs them in a browser, and the page double runs the same two on its
// own document, so nothing of this module may be used inside them.

/**
 * Text typed into a search field: the list it controls opens at once, with its
 * empty state or, when it was open, with the rows it showed; then its
 * "Searching…" row, a disabled option; then its answer, the entries whose name
 * holds the typed text, each a row with the entry's name first. The first row
 * is the active one (`aria-selected`), the one a key press would choose, not a
 * chosen one. A later typing replaces what an earlier one had still to show.
 * `later(run, ms)` runs `run` after `ms`.
 */
export function typeInSearchField(field, later) {
  const document = field.ownerDocument;
  const declared = JSON.parse(document.getElementById("fixture-searches").textContent);
  const own = declared.fields[field.id];
  if (!own || own.opens === false) return;
  const list = document.getElementById(own.list);
  const turn = String(Number(field.getAttribute("data-fixture-turn") || "0") + 1);
  field.setAttribute("data-fixture-turn", turn);
  const current = () => field.getAttribute("data-fixture-turn") === turn;
  const empty = () => {
    const node = document.createElement("div");
    node.setAttribute("role", "presentation");
    node.textContent = "No matches.";
    return node;
  };
  const row = (parts, active) => {
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", active ? "true" : "false");
    option.setAttribute("data-fixture-picks", "");
    for (const part of parts) {
      const span = document.createElement("span");
      span.textContent = part;
      option.appendChild(span);
    }
    return option;
  };
  if (list.hasAttribute("hidden")) {
    list.replaceChildren(empty());
    list.removeAttribute("hidden");
  }
  field.setAttribute("aria-expanded", "true");
  field.setAttribute("aria-controls", own.list);
  const typed = field.value.trim().toLowerCase();
  later(() => {
    if (!current()) return;
    const searching = document.createElement("div");
    searching.setAttribute("role", "option");
    searching.setAttribute("aria-disabled", "true");
    searching.setAttribute("aria-selected", "false");
    searching.textContent = "Searching…";
    list.replaceChildren(searching);
  }, declared.searchingMs);
  later(() => {
    if (!current()) return;
    const found = own.entries.filter((entry) => entry[0].toLowerCase().includes(typed));
    list.replaceChildren(...(found.length > 0 ? found.map((entry, at) => row(entry, at === 0)) : [empty()]));
  }, declared.answerMs);
}

/**
 * An entry pressed in a search field's list: it becomes the active row, as the
 * pointer over it makes it, and it is taken: the list closes (keeping its rows
 * until it opens again), the field no longer controls it, and the page does with
 * the entry what the field declares (see SEARCH_FIELDS).
 */
export function pressSearchEntry(option) {
  const document = option.ownerDocument;
  const list = option.closest("[role='listbox']");
  if (!list) return;
  const declared = JSON.parse(document.getElementById("fixture-searches").textContent);
  const id = Object.keys(declared.fields).find((key) => declared.fields[key].list === list.id);
  const own = id ? declared.fields[id] : null;
  const field = id ? document.getElementById(id) : null;
  if (!own || !field) return;
  const rows = Array.from(list.querySelectorAll("[data-fixture-picks]"));
  for (const one of rows) one.setAttribute("aria-selected", one === option ? "true" : "false");
  list.setAttribute("hidden", "");
  field.setAttribute("data-fixture-turn", String(Number(field.getAttribute("data-fixture-turn") || "0") + 1));
  field.setAttribute("aria-expanded", "false");
  field.removeAttribute("aria-controls");
  const at = rows.indexOf(option);
  const partsOf = (one) => Array.from(one.children, (span) => span.textContent);
  const another = own.takes === "another-row" || own.takes === "another-field";
  const taken = partsOf(another ? rows[at + 1] || rows[at - 1] || option : option);
  const drawn = (tag, parts) => {
    const node = document.createElement(tag);
    for (const part of parts) {
      const span = document.createElement("span");
      span.textContent = part;
      node.appendChild(span);
    }
    return node;
  };
  if (own.takes === "row" || own.takes === "another-row") {
    field.value = "";
    document.getElementById(own.rows).appendChild(drawn("li", taken));
  } else if (own.takes === "chip") {
    const chip = drawn("span", taken.slice(0, 2));
    chip.setAttribute("data-fixture-chip", "");
    field.replaceWith(chip);
  } else if (own.takes === "field" || own.takes === "another-field") {
    field.value = taken[0];
  } else {
    field.value = "";
  }
}

const searchField = (id, placeholder, named = "") =>
  `<input id="${id}" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list" placeholder="${placeholder}"${named} data-fixture-searches>` +
  `<div role="listbox" id="${id}-list" hidden></div>`;

/**
 * Search fields, as the entity search draws them (see SEARCH_FIELDS): one named
 * by its label, whose chosen entries join a list of rows below it; one with no
 * accessible name that shows its placeholder, and one with no accessible name
 * after a label element in its form group; and four named by `aria-label` whose
 * page takes another entry, into a row or into the field, takes nothing, or
 * opens no list.
 */
export const PICK_SEARCH_PAGE = [
  `<label for="search-skills">Skills</label> ${searchField("search-skills", "Search installed skills…")}`,
  '<ul id="search-skills-rows" aria-label="Chosen skills"></ul>',
  `<div id="search-people-slot">${searchField("search-people", "Search people…")}</div>`,
  `<div role="group"><label>Reviewer</label> ${searchField("search-reviewers", "Search reviewers…")}</div>`,
  `${searchField("search-author", "Search authors…", ' aria-label="Author"')}<ul id="search-author-rows" aria-label="Authors"></ul>`,
  searchField("search-assignee", "Search assignees…", ' aria-label="Assignee"'),
  searchField("search-editor", "Search editors…", ' aria-label="Editor"'),
  searchField("search-viewer", "Search viewers…", ' aria-label="Viewer"'),
  `<script type="application/json" id="fixture-searches">${JSON.stringify(SEARCH_FIELDS)}</script>`,
].join("");

// readControlNames: the pages its cases read.

/** An address in a control's name, built from parts so no address literal sits in source. */
export const NAMES_ADDRESS = ["https:", "", ["docs", "example", "test"].join("."), "guide"].join("/");
/** A name of 400 characters: longer than a line carries. */
export const NAMES_LONG_NAME = "0123456789".repeat(40);
/** A name of 300 characters: as long as a line carries. */
export const NAMES_FULL_NAME = "9876543210".repeat(30);

/**
 * The pages readControlNames reads, by the second segment of their path:
 *   - `start`: controls with a name and without one, in the order a reading
 *     lists them. A navigation named by its label, with a link named by its
 *     text and one that shows only an image hidden from assistive technology;
 *     a section its heading names (`aria-labelledby`), with buttons named by
 *     their text, by `aria-label` and by their title, a button with no name,
 *     fields named by a label and by `aria-labelledby` (one described by a
 *     hint), a field whose only text is its placeholder, which is never a name,
 *     and a select with its options; a section whose heading names it for no
 *     one, so it is no region; two sections that carry one heading; a labelled
 *     section with no control in it; a form named by its label, with a group
 *     named by its legend; a form with no name, which is no form; a dialog
 *     named by its heading, an alert dialog and a search landmark; and three
 *     controls that are not shown: one hidden from assistive technology, one
 *     `hidden`, and one inside `display: none`.
 *   - `long`: a name longer than a line carries, one as long as it carries, and
 *     one that holds an address.
 *   - `many`: more controls than one reading lists.
 *   - `empty`: no shown control, only ones that are not shown.
 */
export const NAMES_PAGES = Object.freeze({
  start: [
    '<header><nav aria-label="Main"><a href="/nav/target">Target</a> <a href="/nav/start"><svg aria-hidden="true"></svg></a></nav></header>',
    "<main><h1>Plans and drafts</h1>",
    '<section aria-labelledby="names-plans-title"><h2 id="names-plans-title">Plans</h2>',
    '<button type="button">Save plan</button> <button type="button" aria-label="Delete plan"><svg aria-hidden="true"></svg></button>',
    ' <button type="button"><svg aria-hidden="true"></svg></button> <button type="button" title="Refresh"><svg aria-hidden="true"></svg></button>',
    '<label for="names-title">Title</label> <input id="names-title" aria-describedby="names-title-hint"><p id="names-title-hint">Shown on the card.</p>',
    '<span id="names-owner">Owner</span> <input aria-labelledby="names-owner"> <input placeholder="Search plans">',
    '<select aria-label="Size"><option>Small</option><option>Large</option></select></section>',
    '<section><h2>Drafts</h2><button type="button">Open draft</button></section>',
    '<section><h2>Twin</h2><button type="button">First twin</button></section>',
    '<section><h2>Twin</h2><button type="button">Second twin</button></section>',
    '<section aria-label="Notes"><p>Nothing to press here.</p></section>',
    '<form aria-label="Filters"><fieldset><legend>Colour</legend><label><input type="radio" name="colour"> Red</label></fieldset></form>',
    '<form><button type="submit">Send</button></form>',
    '<div role="dialog" aria-labelledby="names-confirm-title"><h2 id="names-confirm-title">Confirm</h2><button type="button">Close</button></div>',
    '<div role="alertdialog" aria-label="Discard the draft?"><button type="button">Discard</button></div>',
    '<search aria-label="Site"><input type="search" aria-label="Search the site"></search>',
    '<div aria-hidden="true"><button type="button">Hidden twin</button></div> <button type="button" hidden>Not drawn</button>',
    '<div style="display:none"><button type="button">Not displayed</button></div>',
    "</main>",
  ].join(""),
  long: [
    `<button type="button" aria-label="${NAMES_LONG_NAME}"></button>`,
    `<button type="button" aria-label="${NAMES_FULL_NAME}"></button>`,
    `<a href="/nav/target">Read ${NAMES_ADDRESS} first</a>`,
  ].join(""),
  many: Array.from({ length: 405 }, (_, i) => `<button type="button">Item ${i + 1}</button>`).join(" "),
  empty: '<p>No control is shown here.</p><div aria-hidden="true"><button type="button">Hidden</button></div><button type="button" hidden>Not drawn</button>',
});

// armPageTape and readPageTape: the pages their cases read.

/**
 * The tape pages, by the second segment of their path: `start` holds a link
 * whose own handler moves the address in place, as a client-side router does
 * (it asks the app for the page, then pushes the address), and a link that
 * loads another page; `moved` and `other` are where they lead.
 */
export const TAPE_PAGES = Object.freeze({
  start: '<nav aria-label="Tape"><a href="/tape/moved" data-fixture-in-place>Move in place</a> <a href="/tape/other">Other page</a></nav>',
  moved: "<p>Moved in place.</p>",
  other: "<p>Another page.</p>",
});

// Names the steps match without their white space: the page their cases read.

/**
 * A step rail as the product draws one, and what sits beside it. Each tab draws
 * a number and a label as two parts with no white space between them, so its
 * name reads "3Select blog idea"; two more tabs read "4Review draft" and
 * "4 Reviewdraft", which differ from each other, and from "4 Review draft", in
 * white space only. A button reads "Save draft" and another "Savedraft"; a
 * section is named by a heading that reads "2Draft"; and a list named "Blog"
 * and "ideas" drawn as two parts holds an entry that reads "3Select blog idea",
 * which the page confirms in a status that spells it "3 Select blog idea".
 */
export const JOINED_PAGE = [
  '<div role="tablist" aria-label="Steps">',
  '<a href="#step-1" role="tab" data-fixture-opens="joined-step-1"><span>1</span><span>Choose a topic</span></a>',
  '<a href="#step-3" role="tab" data-fixture-opens="joined-step-3"><span>3</span><span>Select blog idea</span></a>',
  '<a href="#step-4" role="tab"><span>4</span><span>Review draft</span></a>',
  '<a href="#step-4b" role="tab">4 Review<span>draft</span></a>',
  "</div>",
  '<p id="joined-step-1" hidden>The topic step.</p><p id="joined-step-3" hidden>The idea step.</p>',
  '<a href="#save" role="button" data-fixture-opens="joined-saved">Save draft</a>',
  ' <a href="#save-joined" role="button" data-fixture-opens="joined-saved-joined">Save<span>draft</span></a>',
  '<p id="joined-saved" hidden>Saved.</p><p id="joined-saved-joined" hidden>Saved the other one.</p>',
  '<section><h2><span>2</span><span>Draft</span></h2><a href="#add" role="button" data-fixture-opens="joined-added">Add</a><p id="joined-added" hidden>Added.</p></section>',
  '<span id="joined-ideas"><span>Blog</span><span>ideas</span></span>',
  '<div role="listbox" aria-labelledby="joined-ideas"><a href="#idea" role="option" data-fixture-opens="joined-idea"><span>3</span><span>Select blog idea</span></a></div>',
  '<p role="status" id="joined-idea" hidden>Idea: 3 Select blog idea</p>',
].join("");

// pressByTestId and readTitle: their pages.

/**
 * Rows drawn without a role, as the upload dialog's type picker draws them: list
 * items with a click handler, a test id and a text. Each counts its presses
 * (`data-fixture-clicks`). In the dialog: a row whose handler selects it, one
 * whose text is spread over lines, a hidden row, a row with a hidden part, a row
 * whose handler leaves the page, and a button of the same test id, which has a
 * role and a name. Below it: two lists that each hold a row of one text, and two
 * parts of one name.
 */
export const PRESS_ROWS_PAGE = [
  '<div role="dialog" aria-label="Choose a type"><ul>',
  '<li data-testid="artifacts-picker-type" data-fixture-counts data-fixture-selects data-selected="false"><span>Note <span>pack:note</span></span> <span>Pack</span></li>',
  '<li data-testid="artifacts-picker-type" data-fixture-counts data-fixture-selects data-selected="false"><span>\n    Plain\n    text  </span>\n  <span>core:text</span></li>',
  '<li data-testid="artifacts-picker-type" data-fixture-counts hidden><span>Hidden</span> <span>pack:hidden</span></li>',
  '<li data-testid="artifacts-picker-type" data-fixture-counts><span>Half</span><span style="display:none"> kept apart</span></li>',
  '<li data-testid="artifacts-picker-type" data-fixture-counts data-fixture-goes="/nav/target"><span>Open</span> <span>the target</span></li>',
  "</ul>",
  '<button type="button" data-testid="artifacts-picker-type" data-fixture-counts>Save type</button>',
  "</div>",
  '<section aria-label="First list"><ul><li data-testid="artifacts-picker-type" data-fixture-counts>Twin</li></ul></section>',
  '<section aria-label="Second list"><ul><li data-testid="artifacts-picker-type" data-fixture-counts>Twin</li></ul></section>',
  '<section aria-label="Same list"><ul><li data-testid="other-type" data-fixture-counts>Alone</li></ul></section>',
  '<section aria-label="Same list"><ul><li data-testid="other-type" data-fixture-counts>Alone</li></ul></section>',
].join("");

/**
 * The title pages: a title that holds still, one the page sets once a moment
 * after it loads, one that changes every 50 ms for three seconds, so it never
 * holds still, and an empty one.
 */
export const TITLE_SCENARIOS = Object.freeze({
  steady: { title: "Steady title", timeline: [] },
  late: { title: "Loading", timeline: [{ at: 150, target: "title", html: "Loaded title" }] },
  restless: { title: "Title 0", timeline: Array.from({ length: 60 }, (_, i) => ({ at: 50 * (i + 1), target: "title", html: `Title ${i + 1}` })) },
  empty: { title: "", timeline: [] },
});

/**
 * Start the app. `answer` is the status the sign-in routes answer. Every request
 * is recorded with the field NAMES its query string or form body carried. With
 * `secure`, every page is also served over HTTP/2 at `secureOrigin`.
 */
export async function startFixtureApp({ answer = 200, secure = false } = {}) {
  const requests = [];
  const loads = new Map();
  const streams = new Set();
  let origin = null;
  const handle = (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url, origin);
      const formBody = String(request.headers["content-type"] ?? "").includes("x-www-form-urlencoded");
      requests.push({
        method: request.method,
        path: url.pathname,
        query: [...url.searchParams.keys()],
        bodyFields: formBody ? [...new URLSearchParams(body).keys()] : [],
        body,
        at: Date.now(),
      });
      const html = (status, text) => {
        response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        response.end(text);
      };
      if (request.method === "POST" && (url.pathname === EMAIL_ROUTE || url.pathname === USERNAME_ROUTE)) {
        const headers = { "content-type": "application/json" };
        if (answer === 200) headers["set-cookie"] = "fixture_session=1; Path=/; HttpOnly";
        response.writeHead(answer, headers);
        response.end(answer === 200 ? '{"ok":true}' : '{"ok":false}');
        return;
      }
      if (url.pathname === ISLAND_FRAME_PATH) return html(200, "<!doctype html><title>Island</title><p>The work.</p>");
      if (url.pathname === STREAM_ROUTE) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.write("retry: 60000\ndata: standing\n\n");
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      if (url.pathname === STREAMING_PAGE_PATH) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.write(
          '<!doctype html>\n<html><head><meta charset="utf-8"><meta name="fixture-streaming" content="the rest never comes">' +
            `<title>Streaming</title></head>\n<body>\n${STREAM_BODY}\n`,
        );
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      if (url.pathname === "/redirects/sign-in") {
        response.writeHead(302, { location: "/setup" });
        response.end();
        return;
      }
      if (url.pathname === "/slow/sign-in") {
        setTimeout(() => html(200, signInPage(SIGN_IN_SCENARIOS.ready)), 3000);
        return;
      }
      const signIn = /^\/([a-z-]+)\/sign-in$/.exec(url.pathname);
      if (signIn && SIGN_IN_SCENARIOS[signIn[1]]) return html(200, signInPage(SIGN_IN_SCENARIOS[signIn[1]]));
      const scenePage = /^\/(island|run|count|stream)\/([a-z-]+)$/.exec(url.pathname);
      if (scenePage) {
        const [, kind, name] = scenePage;
        const table = { island: ISLAND_SCENARIOS, run: RUN_SCENARIOS, count: COUNT_SCENARIOS, stream: STREAM_SCENARIOS }[kind];
        let scene = table[name];
        if (!scene) return html(404, "<!doctype html><title>Not found</title>");
        if (kind === "run" && name === "reloads") {
          const seen = (loads.get(url.pathname) ?? 0) + 1;
          loads.set(url.pathname, seen);
          if (seen > 1) scene = RUN_SCENARIOS["reloads-again"];
        }
        return html(200, page(`${kind} ${name}`, scene.body, scene.timeline));
      }
      if (url.pathname === "/nav/start") return html(200, page("Start", NAV_START));
      if (url.pathname === "/nav/redirect") {
        response.writeHead(302, { location: "/nav/elsewhere" });
        response.end();
        return;
      }
      if (url.pathname === "/nav/slow" || url.pathname === "/nav/slow-in-place") {
        setTimeout(() => html(200, page("Slow", "<p>Slow.</p>")), 3000);
        return;
      }
      if (/^\/(nav\/[a-z-]+|setup)$/.test(url.pathname)) return html(200, page(url.pathname, "<p>A page.</p>"));
      // readRows, the landing of signInThroughPage, dispatchRun, press and selectFrom: their pages.
      const landingSignIn = /^\/([a-z-]+)\/sign-in$/.exec(url.pathname);
      if (landingSignIn && Object.hasOwn(LANDING_SIGN_IN_SCENARIOS, landingSignIn[1])) return html(200, signInPage(LANDING_SIGN_IN_SCENARIOS[landingSignIn[1]]));
      if (url.pathname === "/landing/slow") {
        setTimeout(() => html(200, page("Landing", APP_SHELL)), 1000);
        return;
      }
      const landing = /^\/landing\/([a-z-]+)$/.exec(url.pathname);
      if (landing && Object.hasOwn(LANDING_SCENARIOS, landing[1])) return html(200, page("Landing", LANDING_SCENARIOS[landing[1]].body, LANDING_SCENARIOS[landing[1]].timeline));
      const launches = { "/cards/launch/run": "/run/settles", "/cards/launch/nothing": "/cards/nothing" };
      if (Object.hasOwn(launches, url.pathname)) {
        response.writeHead(302, { location: launches[url.pathname] });
        response.end();
        return;
      }
      const pages = {
        "/cards/start": CARD_PAGE,
        "/cards/nothing": "<p>No run here.</p>",
        "/press/start": PRESS_PAGE,
        "/press/saved": "<p>Saved.</p>",
        "/press/sections": PRESS_SECTIONS_PAGE,
        "/pick/start": PICK_PAGE,
        "/pick/unnamed": PICK_UNNAMED_PAGE,
        "/pick/hiding": PICK_HIDING_PAGE,
        "/pick/closing": PICK_CLOSING_PAGE,
        "/pick/options": PICK_OPTIONS_PAGE,
        "/pick/search": PICK_SEARCH_PAGE,
        "/conversation/empty": CONVERSATION_PAGES.empty,
        "/conversation/thread": CONVERSATION_PAGES.thread,
        "/conversation/boxes": CONVERSATION_PAGES.boxes,
      };
      if (Object.hasOwn(pages, url.pathname)) return html(200, page(url.pathname, pages[url.pathname]));
      // uploadFile, fillForm, switchTheme and decideGate: their pages and routes
      // live in fixture-app-controls.mjs, so this file changes in this one place.
      if (/^\/(upload|form|theme|gate)\//.test(url.pathname)) {
        import("./fixture-app-controls.mjs").then(
          ({ serveControlPage }) => serveControlPage({ method: request.method, url, response }),
          () => html(500, "<!doctype html><title>Unavailable</title>"),
        );
        return;
      }
      // readControlNames: its pages.
      const namesPage = /^\/names\/([a-z]+)$/.exec(url.pathname);
      if (namesPage && Object.hasOwn(NAMES_PAGES, namesPage[1])) return html(200, page(url.pathname, NAMES_PAGES[namesPage[1]]));
      // armPageTape and readPageTape: their pages.
      const tapePage = /^\/tape\/([a-z]+)$/.exec(url.pathname);
      if (tapePage && Object.hasOwn(TAPE_PAGES, tapePage[1])) return html(200, page(url.pathname, TAPE_PAGES[tapePage[1]]));
      // Names the steps match without their white space: their page.
      if (url.pathname === "/joined/start") return html(200, page(url.pathname, JOINED_PAGE));
      // pressByTestId and readTitle: their pages.
      if (url.pathname === "/press/rows") return html(200, page(url.pathname, PRESS_ROWS_PAGE));
      const titlePage = /^\/title\/([a-z]+)$/.exec(url.pathname);
      if (titlePage && Object.hasOwn(TITLE_SCENARIOS, titlePage[1])) {
        const { title, timeline } = TITLE_SCENARIOS[titlePage[1]];
        return html(200, page(title, "<p>A page with a title.</p>", timeline));
      }
      // typeInWindow, waitForTurn, reloadPage, sendInComposer and openAddress:
      // their pages live in fixture-app-windows.mjs, so this file changes in this
      // one place.
      if (/^\/(window|composer|address|reload)\//.test(url.pathname)) {
        import("./fixture-app-windows.mjs").then(
          ({ serveWindowPage }) => serveWindowPage({ method: request.method, url, response, loads }),
          () => html(500, "<!doctype html><title>Unavailable</title>"),
        );
        return;
      }
      // openPageInOwnContext: its pages, served only to a session, and the
      // sign-in page they send a request without one to, live in
      // fixture-app-contexts.mjs, so this file changes in this one place.
      if (url.pathname.startsWith("/own/") || url.pathname === "/sign-in") {
        import("./fixture-app-contexts.mjs").then(
          ({ serveOwnContextPage }) => serveOwnContextPage({ request, url, response }),
          () => html(500, "<!doctype html><title>Unavailable</title>"),
        );
        return;
      }
      html(404, "<!doctype html><title>Not found</title>");
    });
  };
  const server = createServer(handle);
  await new Promise((done) => server.listen(0, LOOPBACK, done));
  origin = `http://${LOOPBACK}:${server.address().port}`;
  let secureServer = null;
  let secureOrigin = null;
  const sessions = new Set();
  if (secure) {
    secureServer = createSecureServer(selfSignedCertificate(), handle);
    secureServer.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    await new Promise((done) => secureServer.listen(0, LOOPBACK, done));
    secureOrigin = `https://${LOOPBACK}:${secureServer.address().port}`;
  }
  return {
    origin,
    /** The same app over HTTP/2, when it was started with `secure`. */
    secureOrigin,
    requests,
    /** How many streams the app holds open now. */
    standingStreams: () => streams.size,
    /** Plain loads of a sign-in scenario page (no query string). */
    pageLoads: (name) => requests.filter((r) => r.method === "GET" && r.path === `/${name}/sign-in` && r.query.length === 0),
    /** Requests to the app's own sign-in routes. */
    signInRequests: () => requests.filter((r) => r.method === "POST" && (r.path === EMAIL_ROUTE || r.path === USERNAME_ROUTE)),
    /** Requests that carried a form field in a query string or a form body: native submissions. */
    carryingFields: () => requests.filter((r) => [...r.query, ...r.bodyFields].some((name) => FORM_FIELDS.includes(name))),
    stop: () =>
      Promise.all([
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
        secureServer &&
          new Promise((done) => {
            for (const session of sessions) session.destroy();
            secureServer.close(done);
          }),
      ]),
  };
}
