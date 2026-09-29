// More pages of the fixture app, for uploadFile, fillForm, switchTheme and
// decideGate: a library list with its Upload control, a form, a page with the
// theme control and a review island, and gates a run stops at. fixture-app.mjs
// hands every request under /upload/, /form/, /theme/ and /gate/ to
// `serveControlPage`.
//
// Each page declares what its own handlers do as JSON (`fixture-behaviour`,
// beside the `fixture-timeline` any fixture page may carry). In a browser the
// page's inline script plays it; the page double (page-double.mjs) reads the
// same JSON and plays it on its own document. One declaration feeds both:
//   - `{ press, choose }`: pressing `press` presses the hidden file input
//     `choose`, which opens the file chooser;
//   - `{ chosen, upload, rows, refused, delayMs }`: each file chosen on `chosen`
//     is posted to `upload`; once the app has answered and `delayMs` has passed,
//     a row naming it joins the list `rows`, or, when the app refused it,
//     `refused` shows the refusal;
//   - `{ submit, sends, done }`: sending the form `submit` marks each empty
//     `data-fixture-required` field invalid and shows its error text (in the
//     element `data-fixture-error-in` names, or in a destructive line after the
//     field); a form without one is posted to `sends`, and `done` is shown;
//   - `{ press, theme }`: pressing `press` toggles the root's class between
//     `theme.light` and `theme.dark`, and after `theme.delayMs` points each
//     frame `theme.islands` selects at the new scheme;
//   - `{ press, decide }`: pressing `press` settles the gate `decide.gate` (its
//     state becomes `decide.state` and its controls go) after `decide.delayMs`,
//     and, with `decide.status`, the run's status pill `decide.pill` reads it.
//
// Nothing here is a credential of anything, and no page carries an address.

/** The routes the upload page posts to: the app files the upload, or refuses it. */
export const UPLOAD_ACCEPT_ROUTE = "/upload/accept";
export const UPLOAD_REFUSE_ROUTE = "/upload/refuse";
/** The route the form posts to. */
export const FORM_SAVE_ROUTE = "/form/save";
/** The document the theme page frames as its review island. */
export const THEME_ISLAND_PATH = "/theme/island";

const LIBRARY_LIST = '[data-conformance-id="artifacts-library-list"]';
const RUN_PILL = '[data-conformance-id="run-surface"] [data-slot="status-pill"][data-glyph="dot"]';

// The page's own handlers, as a browser runs them: they play the page's
// declared behaviour, and its declared timeline.
const CONTROL_RUNNER = `<script>
(function () {
  function declared(id) {
    var node = document.getElementById(id);
    return node ? JSON.parse(node.textContent) : [];
  }
  var behaviour = declared("fixture-behaviour");
  declared("fixture-timeline").forEach(function (op) {
    setTimeout(function () {
      var el = document.querySelector(op.target);
      if (!el) return;
      if (op.attr) el.setAttribute(op.attr, op.value); else el.innerHTML = op.html;
    }, op.at);
  });
  function after(ms, run) { setTimeout(run, ms || 0); }
  function choose(op) {
    var input = document.querySelector(op.choose);
    if (input) input.click();
  }
  function theme(op) {
    var root = document.documentElement;
    var next = root.classList.contains(op.theme.dark) ? "light" : "dark";
    root.classList.remove(op.theme.dark, op.theme.light);
    root.classList.add(op.theme[next]);
    if (!op.theme.islands) return;
    after(op.theme.delayMs, function () {
      document.querySelectorAll(op.theme.islands).forEach(function (frame) {
        var src = new URL(frame.getAttribute("src"), location.href);
        src.searchParams.set("scheme", next);
        frame.setAttribute("src", src.pathname + src.search);
      });
    });
  }
  function decide(op) {
    after(op.decide.delayMs, function () {
      var gate = document.querySelector(op.decide.gate);
      if (gate) {
        gate.setAttribute("data-lifecycle-card-state", op.decide.state);
        gate.querySelectorAll("button").forEach(function (control) { control.remove(); });
      }
      if (!op.decide.status) return;
      document.querySelectorAll(op.decide.pill).forEach(function (pill) {
        pill.setAttribute("data-status", op.decide.status);
        pill.textContent = op.decide.status;
      });
    });
  }
  function upload(op, input) {
    Array.prototype.forEach.call(input.files, function (file) {
      fetch(op.upload, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }).then(function (answer) {
        after(op.delayMs, function () {
          if (answer.ok) {
            var list = document.querySelector(op.rows);
            if (!list) return;
            var row = document.createElement("li");
            row.setAttribute("data-field", "name=identity.displayName");
            var title = document.createElement("span");
            title.textContent = file.name;
            row.appendChild(title);
            list.appendChild(row);
            return;
          }
          var panel = document.querySelector(op.refused);
          if (!panel) return;
          panel.textContent = "Can't type " + file.name;
          panel.removeAttribute("hidden");
        });
      });
    });
  }
  function send(op, form) {
    form.querySelectorAll("[data-fixture-shown-error]").forEach(function (node) { node.remove(); });
    var required = Array.prototype.slice.call(form.querySelectorAll("[data-fixture-required]"));
    required.forEach(function (control) {
      control.removeAttribute("aria-invalid");
      var message = document.getElementById(control.getAttribute("data-fixture-error-in") || "");
      if (message) { message.textContent = ""; message.setAttribute("hidden", ""); }
    });
    var missing = required.filter(function (control) { return control.value.trim() === ""; });
    missing.forEach(function (control) {
      var said = control.getAttribute("data-fixture-required");
      control.setAttribute("aria-invalid", "true");
      var message = document.getElementById(control.getAttribute("data-fixture-error-in") || "");
      if (message) { message.textContent = said; message.removeAttribute("hidden"); return; }
      var line = document.createElement("p");
      line.className = "text-xs text-destructive";
      line.setAttribute("data-fixture-shown-error", "");
      line.textContent = said;
      control.insertAdjacentElement("afterend", line);
    });
    if (missing.length > 0) return;
    var values = {};
    Array.prototype.forEach.call(form.elements, function (control) { if (control.name) values[control.name] = control.value; });
    fetch(op.sends, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }).then(function () {
      var done = document.querySelector(op.done);
      if (done) done.removeAttribute("hidden");
    });
  }
  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    behaviour.forEach(function (op) {
      if (!op.press || !target.closest(op.press)) return;
      if (op.choose) choose(op);
      if (op.theme) theme(op);
      if (op.decide) decide(op);
    });
  });
  document.addEventListener("change", function (event) {
    behaviour.forEach(function (op) {
      if (op.chosen && event.target instanceof Element && event.target.matches(op.chosen)) upload(op, event.target);
    });
  });
  document.addEventListener("submit", function (event) {
    behaviour.forEach(function (op) {
      if (!op.submit || !event.target.matches(op.submit)) return;
      event.preventDefault();
      send(op, event.target);
    });
  });
})();
</script>`;

function controlPage(title, body, { behaviour = [], timeline = [], rootClass = "" } = {}) {
  return `<!doctype html>
<html${rootClass ? ` class="${rootClass}"` : ""}><head><meta charset="utf-8"><title>${title}</title></head>
<body>
${body}
<script type="application/json" id="fixture-behaviour">${JSON.stringify(behaviour)}</script>
<script type="application/json" id="fixture-timeline">${JSON.stringify(timeline)}</script>
${CONTROL_RUNNER}
</body></html>`;
}

// ---------------------------------------------------------------------------
// The library: its list of filed items, and its Upload control.
// ---------------------------------------------------------------------------

const libraryRow = (name) =>
  `<li data-field="name=identity.displayName"><span>${name}</span> <span>Default artifact</span></li>`;

/** The library pages, by the second segment of their path. */
export const UPLOAD_SCENARIOS = Object.freeze({
  // The Upload button opens the hidden file input, and the app files the upload.
  library: { route: UPLOAD_ACCEPT_ROUTE, opens: true },
  // The app refuses the upload: the page shows the refusal, and no row.
  refused: { route: UPLOAD_REFUSE_ROUTE, opens: true },
  // The button's handler is not there, as before the page has hydrated: a press opens nothing.
  inert: { route: UPLOAD_ACCEPT_ROUTE, opens: false },
  // A shown file input with a label of its own is the control itself.
  attach: { route: UPLOAD_ACCEPT_ROUTE, attach: true },
});

function uploadPage(scenario) {
  const control = scenario.attach
    ? '<label>Attach a file <input type="file" id="upload-input"></label>'
    : '<div data-conformance-id="artifacts-upload-affordance"><span>or drop a file</span> ' +
      '<button type="button" id="upload-button" data-testid="artifacts-upload-button"><svg aria-hidden="true"></svg>Upload</button></div>' +
      '<input type="file" id="upload-input" data-testid="artifacts-upload-input" hidden>';
  const body =
    `<main>${control}<div id="upload-refused" data-conformance-id="artifacts-upload-refused" hidden></div>` +
    `<ul data-conformance-id="artifacts-library-list">${libraryRow("Quarterly plan.md")}${libraryRow("Launch notes.txt")}</ul></main>`;
  const behaviour = [
    ...(scenario.opens ? [{ press: "#upload-button", choose: "#upload-input" }] : []),
    { chosen: "#upload-input", upload: scenario.route, rows: LIBRARY_LIST, refused: "#upload-refused", delayMs: 200 },
  ];
  return controlPage("Library", body, { behaviour });
}

// ---------------------------------------------------------------------------
// A form: three fields, two of them required, with the error each shows.
// ---------------------------------------------------------------------------

// "Title" declares itself required and names its message through
// aria-describedby, as the shared form message does; "Summary *" declares
// nothing and gets a destructive line after it, as the step forms draw one;
// "Notes (optional)" is labelled by a label around it; "Reference" is
// disabled, so no fill reaches it.
const PROFILE_FORM = [
  '<form id="profile-form" novalidate aria-label="Profile">',
  '<div class="field"><label for="title">Title</label>',
  '<input id="title" name="title" aria-required="true" aria-describedby="title-hint title-message" ',
  'data-fixture-required="Title is required." data-fixture-error-in="title-message">',
  '<p id="title-hint">Shown on the card.</p><p id="title-message" data-slot="form-message" hidden></p></div>',
  '<div class="field"><label for="summary">Summary *</label>',
  '<textarea id="summary" name="summary" data-fixture-required="Summary is required."></textarea></div>',
  '<div class="field"><label>Notes <span>(optional)</span> <input name="notes"></label></div>',
  '<div class="field"><label for="reference">Reference</label><input id="reference" name="reference" disabled></div>',
  '<button type="submit">Save</button>',
  '<p id="form-saved" role="status" hidden>Saved</p>',
  "</form>",
].join("");

// "Idea (optional)" is drawn as the product draws an optional field: the label's
// two inline parts meet with no white space between them, so its text reads
// "Idea(optional)" while the form reading names it "Idea (optional)".
const IDEA_FORM = [
  '<form id="idea-form" novalidate aria-label="Idea">',
  '<div class="field"><label for="idea">Idea<span class="ml-1">(optional)</span></label><textarea id="idea" name="idea"></textarea></div>',
  "</form>",
].join("");

// Two fields whose labels differ in white space only: "Brief (optional)" and "Brief(optional)".
const BRIEF_FORM = [
  '<form id="brief-form" novalidate aria-label="Brief">',
  '<div class="field"><label for="brief">Brief (optional)</label><textarea id="brief" name="brief"></textarea></div>',
  '<div class="field"><label for="brief-more">Brief(optional)</label><textarea id="brief-more" name="brief-more"></textarea></div>',
  "</form>",
].join("");

/** The form pages, by the second segment of their path. */
export const FORM_SCENARIOS = Object.freeze({
  profile: { body: PROFILE_FORM, timeline: [] },
  // The app draws the form a moment after the page.
  late: { body: '<div id="form-slot"></div>', timeline: [{ at: 300, target: "#form-slot", html: PROFILE_FORM }] },
  idea: { body: IDEA_FORM, timeline: [] },
  brief: { body: BRIEF_FORM, timeline: [] },
});

function formPage(scenario) {
  const behaviour = [{ submit: "#profile-form", sends: FORM_SAVE_ROUTE, done: "#form-saved" }];
  return controlPage("Profile", scenario.body, { behaviour, timeline: scenario.timeline });
}

// ---------------------------------------------------------------------------
// The theme control, and a review island that reports the theme it applied.
// ---------------------------------------------------------------------------

const THEME_TOGGLE =
  '<button type="button" id="theme-toggle"><svg aria-hidden="true"></svg><svg aria-hidden="true"></svg><span class="sr-only">Toggle theme</span></button>';
const themeIsland = (scheme) =>
  '<div data-conformance-id="review-target-island" data-island-load-state="loaded">' +
  `<iframe src="${THEME_ISLAND_PATH}?scheme=${scheme}" title="Review target" data-fixture-island></iframe></div>`;

/** The theme pages, by the second segment of their path. */
export const THEME_SCENARIOS = Object.freeze({
  // The toggle switches the page, and the card points its island at the new scheme.
  follows: { root: "light", toggle: true, island: "light", follows: true },
  // The toggle switches the page, and the island is never pointed at the new scheme.
  stuck: { root: "light", toggle: true, island: "light", follows: false },
  // The toggle's handler is not there: a press switches nothing.
  inert: { root: "light", toggle: false, island: "light" },
  // The control has no name until the app has mounted it.
  unmounted: { root: "light", toggle: true, island: "light", follows: true, mountAfterMs: 300 },
  // A page that frames no island.
  bare: { root: "light", toggle: true, island: null },
  // A page, and its island, already dark.
  dark: { root: "dark", toggle: true, island: "dark", follows: true },
});

function themePage(scenario) {
  const header = scenario.mountAfterMs
    ? '<header id="theme-header"><button type="button" id="theme-toggle" disabled></button></header>'
    : `<header id="theme-header">${THEME_TOGGLE}</header>`;
  const body = header + (scenario.island ? themeIsland(scenario.island) : "<p>No review card on this page.</p>");
  const islands = scenario.follows ? "iframe[data-fixture-island]" : null;
  const behaviour = scenario.toggle ? [{ press: "#theme-toggle", theme: { light: "cinatra", dark: "dark", islands, delayMs: 150 } }] : [];
  const timeline = scenario.mountAfterMs ? [{ at: scenario.mountAfterMs, target: "#theme-header", html: THEME_TOGGLE }] : [];
  return controlPage("Theme", body, { behaviour, timeline, rootClass: scenario.root === "dark" ? "dark" : "cinatra" });
}

/** The island's document: its wrapper reports the scheme it was pointed at, or none. */
function islandDocument(scheme) {
  const applied = scheme === "light" || scheme === "dark" ? ` data-island-color-scheme="${scheme}"` : "";
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Island</title></head><body>' +
    `<div data-conformance-id="review-target-island-body"${applied}>The work.</div></body></html>`
  );
}

// ---------------------------------------------------------------------------
// Gates a run stops at, on a run page and in a conversation.
// ---------------------------------------------------------------------------

const runSurface = (status) =>
  '<div data-conformance-id="run-surface"><aside data-run-step-rail=""></aside>' +
  `<span data-slot="status-pill" data-status="${status}" data-glyph="dot">${status}</span></div>`;
// A gate named by its heading, drawn before the other, with an Approve of its own.
const BUDGET_GATE =
  '<div data-lifecycle-card="artifact_review_gate" data-lifecycle-card-state="pending" id="gate-budget">' +
  '<h3>Budget review</h3><div data-conformance-id="review-decision-bar">' +
  '<button type="button">Reject</button><button type="button" id="budget-approve">Approve</button></div></div>';
// The review gate as the product draws it: no name of its own, it opens with its title.
const REVIEW_GATE =
  '<div data-lifecycle-card="artifact_review_gate" data-lifecycle-card-state="pending" data-conformance-id="review-gate-card" id="gate-review">' +
  '<div><span><svg aria-hidden="true"></svg></span><span>Review requested</span><span>Awaiting your decision</span></div>' +
  '<div data-conformance-id="review-decision-bar"><button type="button">Comment</button>' +
  '<button type="button" id="review-reject">Reject</button><button type="button" id="review-approve"><svg aria-hidden="true"></svg>Approve</button></div></div>';

/** The gate pages, by the second segment of their path. `decides` is [press, gate, status]. */
export const GATE_SCENARIOS = Object.freeze({
  // A run page with two gates; the budget review's Approve comes first on the page.
  run: {
    status: "needs-review",
    gates: BUDGET_GATE + REVIEW_GATE,
    decides: [
      ["#review-approve", "#gate-review", "running"],
      ["#budget-approve", "#gate-budget", "approved"],
    ],
  },
  // A conversation: no run status, so the gate itself tells.
  thread: { status: null, gates: REVIEW_GATE, decides: [["#review-approve", "#gate-review", null]] },
  // The decision goes nowhere: the run stays at the gate.
  stuck: { status: "needs-review", gates: REVIEW_GATE, decides: [] },
  // The app draws the gate a moment after the page.
  late: { status: "needs-review", gates: "", later: REVIEW_GATE, decides: [["#review-approve", "#gate-review", "running"]] },
});

function gatePage(scenario) {
  const body = `${scenario.status ? runSurface(scenario.status) : ""}<div id="gates">${scenario.gates}</div>`;
  const behaviour = scenario.decides.map(([press, gate, status]) => ({
    press,
    decide: { gate, state: "settled", status, pill: RUN_PILL, delayMs: 300 },
  }));
  const timeline = scenario.later ? [{ at: 300, target: "#gates", html: scenario.later }] : [];
  return controlPage("Run", body, { behaviour, timeline });
}

const PAGES = Object.freeze({
  upload: [UPLOAD_SCENARIOS, uploadPage],
  form: [FORM_SCENARIOS, formPage],
  theme: [THEME_SCENARIOS, themePage],
  gate: [GATE_SCENARIOS, gatePage],
});

/**
 * Answer one request under /upload/, /form/, /theme/ or /gate/: a page, the
 * island's document, or one of the routes the pages post to.
 * @param {{ method: string, url: URL, response: import("node:http").ServerResponse }} request
 */
export function serveControlPage({ method, url, response }) {
  const send = (status, type, text) => {
    response.writeHead(status, { "content-type": type });
    response.end(text);
  };
  const html = (status, text) => send(status, "text/html; charset=utf-8", text);
  if (method === "POST" && url.pathname === UPLOAD_ACCEPT_ROUTE) return send(201, "application/json", '{"ok":true}');
  if (method === "POST" && url.pathname === UPLOAD_REFUSE_ROUTE) {
    return send(415, "application/json", '{"ok":false,"error":"No installed base type accepts this file."}');
  }
  if (method === "POST" && url.pathname === FORM_SAVE_ROUTE) return send(200, "application/json", '{"ok":true}');
  if (url.pathname === THEME_ISLAND_PATH) return html(200, islandDocument(url.searchParams.get("scheme")));
  const [, kind, name] = /^\/([a-z]+)\/([a-z-]+)$/.exec(url.pathname) ?? [];
  const [scenarios, build] = (kind && Object.hasOwn(PAGES, kind) && PAGES[kind]) || [];
  if (!scenarios || !Object.hasOwn(scenarios, name)) return html(404, "<!doctype html><title>Not found</title>");
  return html(200, build(scenarios[name]));
}
