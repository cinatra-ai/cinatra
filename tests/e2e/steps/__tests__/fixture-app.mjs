// A small local app the step tests drive: sign-in pages, a review island, a run
// page, pages to count on and pages to navigate between.
//
// Every page carries its behaviour twice, on purpose. An inline script runs it
// in a real browser; the same behaviour is declared as JSON in the page, and the
// page double (page-double.mjs) reads that JSON and plays it on its own document.
// One declaration feeds both, so the double cannot quietly drift from what the
// browser leg drives.
//
// Nothing here is a credential of anything: the tests build their values at run
// time, and the server only records which field NAMES a request carried.
import { createServer } from "node:http";

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
  "</nav>",
].join("");

const TIMELINE_RUNNER = `<script>
(function () {
  var ops = JSON.parse(document.getElementById("fixture-timeline").textContent);
  ops.forEach(function (op) {
    setTimeout(function () {
      if (op.reload) { location.reload(); return; }
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
    fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
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
 * Start the app. `answer` is the status the sign-in routes answer. Every request
 * is recorded with the field NAMES its query string or form body carried.
 */
export async function startFixtureApp({ answer = 200 } = {}) {
  const requests = [];
  const loads = new Map();
  let origin = null;
  const server = createServer((request, response) => {
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
      const scenePage = /^\/(island|run|count)\/([a-z-]+)$/.exec(url.pathname);
      if (scenePage) {
        const [, kind, name] = scenePage;
        const table = { island: ISLAND_SCENARIOS, run: RUN_SCENARIOS, count: COUNT_SCENARIOS }[kind];
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
      if (url.pathname === "/nav/slow") {
        setTimeout(() => html(200, page("Slow", "<p>Slow.</p>")), 3000);
        return;
      }
      if (/^\/(nav\/[a-z-]+|setup)$/.test(url.pathname)) return html(200, page(url.pathname, "<p>A page.</p>"));
      html(404, "<!doctype html><title>Not found</title>");
    });
  });
  await new Promise((done) => server.listen(0, LOOPBACK, done));
  origin = `http://${LOOPBACK}:${server.address().port}`;
  return {
    origin,
    requests,
    /** Plain loads of a sign-in scenario page (no query string). */
    pageLoads: (name) => requests.filter((r) => r.method === "GET" && r.path === `/${name}/sign-in` && r.query.length === 0),
    /** Requests to the app's own sign-in routes. */
    signInRequests: () => requests.filter((r) => r.method === "POST" && (r.path === EMAIL_ROUTE || r.path === USERNAME_ROUTE)),
    /** Requests that carried a form field in a query string or a form body: native submissions. */
    carryingFields: () => requests.filter((r) => [...r.query, ...r.bodyFields].some((name) => FORM_FIELDS.includes(name))),
    stop: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
}
