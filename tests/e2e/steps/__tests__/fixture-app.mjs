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

const TIMELINE_RUNNER = `<script>
(function () {
  var ops = JSON.parse(document.getElementById("fixture-timeline").textContent);
  document.querySelectorAll("[data-fixture-inert]").forEach(function (link) {
    link.addEventListener("click", function (event) { event.preventDefault(); });
  });
  document.querySelectorAll("[data-fixture-opens]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      var opened = document.getElementById(link.getAttribute("data-fixture-opens"));
      if (opened) opened.removeAttribute("hidden");
      if (link.hasAttribute("aria-expanded")) link.setAttribute("aria-expanded", "true");
    });
  });
  document.querySelectorAll("[data-fixture-in-place]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      var href = link.getAttribute("href");
      fetch(href).then(function () { history.pushState(null, "", href); });
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

function page(title, body, timeline = []) {
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
        "/pick/start": PICK_PAGE,
        "/conversation/empty": CONVERSATION_PAGES.empty,
        "/conversation/thread": CONVERSATION_PAGES.thread,
        "/conversation/boxes": CONVERSATION_PAGES.boxes,
      };
      if (Object.hasOwn(pages, url.pathname)) return html(200, page(url.pathname, pages[url.pathname]));
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
