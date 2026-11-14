// More pages of the fixture app, for holdResponse and releaseResponse: a page
// with a short-lived state. fixture-app.mjs hands every request under /hold/ to
// `serveHoldPage`.
//
// The page draws a step and its Continue. A press on Continue shows the step's
// loading state at once, asks the app for the next state, and puts the app's
// answer in place of the loading state the moment the answer comes, as a
// client-side refresh replaces a placeholder with the server's new tree. The
// app answers HOLD_ANSWER_DELAY_MS after the request reaches it, so without a
// hold the loading state lasts about that long. Each answer carries its serial
// number among the app's answers, so a case can tell which request a state
// came from, and the page puts the answer's text into the step's detail as the
// app sent it, so a case can read that nothing changed it on the way.
//
// In a browser the page's inline script runs the two handlers below on the
// page's own events; the page double (page-double.mjs) runs the same two on its
// own document. One source feeds both.
//
// Nothing here is a credential of anything, and no page carries an address.

/** The page with the short-lived state, and the address its Continue asks for the next state. */
export const HOLD_PAGE_PATH = "/hold/start";
export const HOLD_ANSWER_PATH = "/hold/answer";

/** The query the page's Continue sends with its request: a value no line of a step may carry. */
export const HOLD_ANSWER_QUERY = "part=detail-of-the-step";

/** How long the app takes to answer, once the request has reached it. */
export const HOLD_ANSWER_DELAY_MS = 100;

/** The step's detail before the press, and while its next state loads. */
export const HOLD_QUESTION = '<p data-hold-state="question">Which skills should the run use?</p>';
export const HOLD_LOADING = '<p data-hold-state="loading">Loading the next step</p>';

/** The app's answer: the next state, with its serial number among the app's answers. */
export const holdAnswer = (serial) => `<p data-hold-state="answered" data-hold-serial="${serial}">The next step, answer ${serial}</p>`;

// The two handlers of the page. They run IN THE PAGE: the page's inline script
// runs them in a browser, and the page double runs the same two on its own
// document, so nothing of this module may be used inside them.

/** A press on the step's Continue: the step's detail shows its loading state at once. */
export function showFixtureLoading(control) {
  var detail = control.ownerDocument.getElementById(control.getAttribute("data-fixture-refreshes-into"));
  if (detail) detail.innerHTML = '<p data-hold-state="loading">Loading the next step</p>';
}

/** The app's answer has come: it takes the place of the loading state, as the app sent it. */
export function showFixtureAnswer(control, text) {
  var detail = control.ownerDocument.getElementById(control.getAttribute("data-fixture-refreshes-into"));
  if (detail) detail.innerHTML = text;
}

// The page's own handlers, as a browser runs them: a press on a control that
// refreshes shows the loading state, asks the app, and shows its answer.
const HOLD_RUNNER = `<script>
(function () {
  var showFixtureLoading = ${showFixtureLoading};
  var showFixtureAnswer = ${showFixtureAnswer};
  document.addEventListener("click", function (event) {
    var control = event.target && event.target.closest ? event.target.closest("[data-fixture-refreshes]") : null;
    if (!control) return;
    showFixtureLoading(control);
    fetch(control.getAttribute("data-fixture-refreshes"), { cache: "no-store" })
      .then(function (answer) { return answer.text(); })
      .then(function (text) { showFixtureAnswer(control, text); }, function () {});
  });
})();
</script>`;

const HOLD_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>A step with a short-lived state</title></head>
<body>
<main aria-label="Run">
<section id="hold-detail" aria-label="Step">${HOLD_QUESTION}</section>
<button type="button" data-fixture-refreshes="${HOLD_ANSWER_PATH}?${HOLD_ANSWER_QUERY}" data-fixture-refreshes-into="hold-detail">Continue</button>
</main>
${HOLD_RUNNER}
</body></html>`;

/**
 * Serve a page under /hold/: the page, or the app's answer HOLD_ANSWER_DELAY_MS
 * after the request has reached it, numbered by `requests`, the app's own
 * record of every request (this one included).
 */
export function serveHoldPage({ method, url, response, requests }) {
  const send = (status, type, text) => {
    response.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    response.end(text);
  };
  if (method === "GET" && url.pathname === HOLD_PAGE_PATH) return send(200, "text/html", HOLD_PAGE);
  if (url.pathname === HOLD_ANSWER_PATH) {
    const serial = requests.filter((request) => request.path === HOLD_ANSWER_PATH).length;
    setTimeout(() => send(200, "text/html", holdAnswer(serial)), HOLD_ANSWER_DELAY_MS);
    return;
  }
  send(404, "text/html", "<!doctype html><title>Not found</title>");
}
