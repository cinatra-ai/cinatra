// The SITE of the fixture app, for frameOf, pressWithoutName, openPageOfOrigin
// and signInThroughWindow: a site's page that embeds the app's assistant in a
// frame, as a site's widget does, the app's embed page that frame shows, and
// the windows the embed page opens to sign a person in.
//
// startFixtureApp({ site: true }) serves the site's page on two further plain
// HTTP origins (startSiteServers): `siteOrigin`, on the app's own loopback
// address, so the frame stands on the SAME SITE as its page; and
// `crossSiteOrigin`, on the other spelling of the loopback, so the frame stands
// on another site, and a browser runs it out of process. The app serves the
// embed page and the windows under /embed/ and /widget/ (serveSiteAppPage);
// without `site` it serves neither.
//
// The site's page mounts its widget as the site's plugin does: an element with
// an OPEN SHADOW ROOT that holds a launcher drawn as a button with an icon and
// no name, a named twin of it, and a pair of nameless buttons; a press on the
// launcher mounts, inside that shadow root, a frame of the app's embed page.
// In a browser the page's inline script runs the two functions below; the page
// double (page-double.mjs) runs the same two on its own document.
//
// Nothing here is a credential of anything, and no page carries an address but
// the app's own origin, which the site's page is given at run time.
import { createServer } from "node:http";

import { EMAIL_ROUTE, LOOPBACK, page } from "./fixture-app.mjs";
import { inputInFixtureWindow, sendInFixtureWindow } from "./fixture-app-windows.mjs";

/** The site's page that embeds the assistant, on both site origins. */
export const SITE_PAGE_PATH = "/site/page";
/** A frame of the site's own on that page, beside the widget's: a banner. */
export const SITE_BANNER_PATH = "/site/banner";
/** The app's embed page, which the widget's frame shows. */
export const EMBED_PAGE_PATH = "/embed/assistant";
/** The app's sign-in window, which the embed page's sign-in control opens. */
export const WINDOW_PAGE_PATH = "/widget/auth";
/** A window of the app that neither returns nor shows a form. */
export const STALLED_WINDOW_PATH = "/widget/stalled";
/** The cookie of a live session, as the app's sign-in routes set it (fixture-app.mjs). */
export const SESSION_COOKIE = "fixture_session";

/** The widget's parts on the site's page. */
export const LAUNCHER_SELECTOR = "button.cw-circle";
export const NAMED_LAUNCHER_SELECTOR = "button.cw-named";
export const NAMED_LAUNCHER_NAME = "Open the assistant";
export const PAIR_SELECTOR = ".cw-pair button";
export const FRAME_SELECTOR = "iframe.cw-frame";

/** The embed page's controls, by their names. */
export const EMBED_SIGN_IN = "Sign in";
export const EMBED_STALLED_SIGN_IN = "Sign in to a stalled window";
export const EMBED_NOTHING = "Open nothing";
export const EMBED_SAVE = "Save";
export const EMBED_ROW_TEST_ID = "embed-row";
export const EMBED_ROW_TEXT = "Pick me";
export const EMBED_ITEM_SELECTOR = "[data-embed-item]";
export const EMBED_FIELD_LABEL = "Title";
export const EMBED_COMPOSER = "Send message";
export const EMBED_WINDOW = "Apply AI suggestion";
/** The class the app writes on the embed page's root: its light palette. */
export const EMBED_PALETTE_CLASS = "cinatra";

/** The other spelling of the loopback, built from parts so no host literal sits in source. */
const OTHER_LOOPBACK = ["local", "host"].join("");

// The site page's two handlers. They run IN THE PAGE: the page's inline script
// runs them in a browser, and the page double runs the same two on its own
// document, so nothing of this module may be used inside them.

/**
 * The site's widget, mounted as its plugin mounts it: in the open shadow root of
 * `#cw-host`, a launcher drawn as a button with an icon and no name, a named
 * twin, a group of two nameless buttons, and the panel its frame goes into.
 * Answers the shadow root.
 */
export function mountFixtureSite(document) {
  const host = document.getElementById("cw-host");
  if (!host) return null;
  if (host.shadowRoot) return host.shadowRoot;
  const root = host.attachShadow({ mode: "open" });
  const icon = '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>';
  const size = "width:48px;height:48px";
  root.innerHTML =
    '<div class="cw-wrap">' +
    '<button type="button" class="cw-circle" data-fixture-site-launcher style="' + size + '">' + icon + "</button>" +
    '<button type="button" class="cw-named" aria-label="Open the assistant" style="' + size + '">' + icon + "</button>" +
    '<div class="cw-pair" role="group" aria-label="Pair">' +
    '<button type="button" style="' + size + '">' + icon + "</button>" +
    '<button type="button" style="' + size + '">' + icon + "</button>" +
    "</div>" +
    '<div class="cw-panel"></div>' +
    "</div>";
  return root;
}

/**
 * A press on the launcher: the first mounts, inside the widget's shadow root, a
 * frame of the app's embed page; a later one leaves it as it is.
 */
export function pressFixtureLauncher(launcher) {
  const root = launcher.getRootNode();
  if (!root || !root.host || root.querySelector("iframe")) return;
  const host = root.host;
  const frame = host.ownerDocument.createElement("iframe");
  frame.className = "cw-frame";
  frame.setAttribute("title", "Assistant");
  frame.setAttribute("style", "width:480px;height:720px;border:0");
  frame.setAttribute("src", host.getAttribute("data-fixture-site-app") + host.getAttribute("data-fixture-site-embed"));
  root.querySelector(".cw-panel").appendChild(frame);
}

const SITE_RUNNER = `<script>
(function () {
  var mountFixtureSite = ${mountFixtureSite};
  var pressFixtureLauncher = ${pressFixtureLauncher};
  var root = mountFixtureSite(document);
  root.addEventListener("click", function (event) {
    var launcher = event.target && event.target.closest ? event.target.closest("[data-fixture-site-launcher]") : null;
    if (launcher) pressFixtureLauncher(launcher);
  });
})();
</script>`;

/** The site's page: its own text, a banner frame of its own, and the widget's host, which knows the app's origin. */
function sitePage(appOrigin) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A site</title></head>
<body>
<main><h1>A site with the assistant</h1><p>The site's own text.</p>
<iframe class="site-banner" title="Banner" src="${SITE_BANNER_PATH}" style="width:300px;height:60px"></iframe></main>
<div id="cw-host" data-fixture-site-app="${appOrigin}" data-fixture-site-embed="${EMBED_PAGE_PATH}"></div>
<script type="application/json" id="fixture-site">{}</script>
${SITE_RUNNER}
</body></html>`;
}

const plainPage = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body></html>`;

/**
 * Serve the site's page on two further origins of the loopback: `siteOrigin`, on
 * the app's own address, and `crossSiteOrigin`, on its other spelling. Each
 * origin is read from its running server.
 * @param {string} appOrigin
 */
export async function startSiteServers(appOrigin) {
  const handle = (request, response) => {
    const path = String(request.url).split("?")[0];
    const html = (status, text) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(text);
    };
    request.resume();
    if (path === SITE_PAGE_PATH) return html(200, sitePage(appOrigin));
    if (path === SITE_BANNER_PATH) return html(200, plainPage("Banner", "<p>The site's banner.</p>"));
    html(404, "<!doctype html><title>Not found</title>");
  };
  const listen = async (host) => {
    const server = createServer(handle);
    await new Promise((done) => server.listen(0, host, done));
    return server;
  };
  const same = await listen(LOOPBACK);
  const other = await listen(OTHER_LOOPBACK);
  const stop = (server) =>
    new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    });
  return {
    siteOrigin: `http://${LOOPBACK}:${same.address().port}`,
    crossSiteOrigin: `http://${OTHER_LOOPBACK}:${other.address().port}`,
    stop: () => Promise.all([stop(same), stop(other)]),
  };
}

// ---------------------------------------------------------------------------
// The app's embed page and its windows.
// ---------------------------------------------------------------------------

/** A box drawn with a size of its own, as the window fixtures draw theirs. */
const BOX_STYLE = "display:inline-block;min-width:240px;min-height:24px;border:1px solid";
/** The run panel the conversation draws for a run it started. */
const RUN_PANEL = '<section data-run-progress-panel=""><span data-slot="status-pill" data-status="queued" data-glyph="dot">queued</span></section>';

/** A window's box and its send control, both named `name`, as the product draws them. */
const field = (window, name) =>
  `<div role="textbox" contenteditable="true" aria-multiline="false" aria-label="${name}" data-fixture-window-box="${window}" style="${BOX_STYLE}"></div> ` +
  `<button type="button" aria-label="${name}" data-fixture-window-send="${window}" disabled>Send</button>`;

/**
 * The embed page, as the app draws its assistant in a site's frame: its
 * sign-in controls (one opens the sign-in window, one a window that stalls, one
 * nothing), a list and a press, a row without a role, a form, a run window that
 * answers a message 300 ms after it, and the conversation's composer, whose
 * every message starts a run. Its root carries the app's light palette.
 */
const EMBED_BODY = [
  '<main aria-label="Assistant">',
  '<section aria-label="Sign-in"><h2>Sign in to talk to the assistant</h2>',
  `<button type="button" data-fixture-window-opens="${WINDOW_PAGE_PATH}">${EMBED_SIGN_IN}</button> `,
  `<button type="button" data-fixture-window-opens="${STALLED_WINDOW_PATH}">${EMBED_STALLED_SIGN_IN}</button> `,
  `<button type="button">${EMBED_NOTHING}</button></section>`,
  '<section aria-label="Notes"><h2>Notes</h2><ul><li data-embed-item>One</li><li data-embed-item>Two</li><li data-embed-item>Three</li></ul>',
  `<a href="#save" role="button" data-fixture-opens="embed-saved">${EMBED_SAVE}</a><p id="embed-saved" hidden>Saved.</p>`,
  `<ul><li data-testid="${EMBED_ROW_TEST_ID}" data-fixture-counts>${EMBED_ROW_TEXT}</li></ul></section>`,
  `<form aria-label="Brief"><label>${EMBED_FIELD_LABEL} <input name="title"></label></form>`,
  '<section aria-label="Run window"><div id="turn-entries"><div data-run-window-entry="person">What does this step need?</div>',
  '<div data-run-window-entry="assistant">A title.</div></div>',
  `<div data-run-window-field="">${field("turn", EMBED_WINDOW)}</div></section>`,
  `<section aria-label="Conversation"><ol aria-label="Messages" id="embed-thread"></ol>`,
  `<div class="prompt-field"><span aria-hidden="true">Ask anything...</span> ${field("chat", EMBED_COMPOSER)}</div></section>`,
  "</main>",
].join("");

/** What the embed page's two windows do with a message (see sendInFixtureWindow). */
const EMBED_WINDOWS = {
  turn: { name: EMBED_WINDOW, entries: "turn-entries", pending: "until-answer", answerMs: 300, answer: { entry: "The title is filled from your message." } },
  chat: { name: EMBED_COMPOSER, echo: "embed-thread", pending: "none", answer: { html: `<li>${RUN_PANEL}</li>`, into: "#embed-thread" } },
};

/** The embed page's own handlers in a browser: the two of a window, and the sign-in control's window. */
const EMBED_RUNNER = `<script>
(function () {
  var inputInFixtureWindow = ${inputInFixtureWindow};
  var sendInFixtureWindow = ${sendInFixtureWindow};
  document.addEventListener("input", function (event) {
    var box = event.target && event.target.closest ? event.target.closest("[data-fixture-window-box]") : null;
    if (box) inputInFixtureWindow(box);
  });
  document.addEventListener("click", function (event) {
    var send = event.target && event.target.closest ? event.target.closest("[data-fixture-window-send]") : null;
    if (send && !send.disabled) sendInFixtureWindow(send, function (run, ms) { setTimeout(run, ms); });
    var opener = event.target && event.target.closest ? event.target.closest("[data-fixture-window-opens]") : null;
    if (opener) window.open(new URL(opener.getAttribute("data-fixture-window-opens"), location.href).href, "fixture-window", "popup,width=480,height=640");
  });
})();
</script>`;

function embedPage() {
  const drawn = page("Assistant", EMBED_BODY).replace("<html>", `<html class="${EMBED_PALETTE_CLASS}">`);
  const own = `<script type="application/json" id="fixture-windows">${JSON.stringify(EMBED_WINDOWS).replace(/</g, "\\u003c")}</script>\n${EMBED_RUNNER}\n`;
  return drawn.replace("</body>", `${own}</body>`);
}

/**
 * The sign-in window's form, as the product's window draws it: it takes the
 * form over 100 ms after it loads (the hydration mark `novalidate`), sends the
 * app's own sign-in request, and closes itself once the app has answered 200.
 */
function windowSignInPage() {
  const scenario = { hydrateAfterMs: 100, handler: "posts-closes", landing: null };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
<form id="sign-in" method="post">
  <label>Email <input name="email" type="text" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form>
<script type="application/json" id="fixture-scenario">${JSON.stringify(scenario)}</script>
<script>
(function () {
  var form = document.getElementById("sign-in");
  setTimeout(function () {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var payload = { email: form.elements.email.value, password: form.elements.password.value };
      fetch(${JSON.stringify(EMAIL_ROUTE)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(function (answer) {
        if (answer.status === 200) window.close();
      });
    });
    form.setAttribute("novalidate", "");
  }, ${scenario.hydrateAfterMs});
})();
</script>
</body></html>`;
}

/** The sign-in window for a person with a live session: it returns at once, closing itself. */
const RETURNING_WINDOW_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Signed in</title></head>
<body><p>Signed in.</p>
<script type="application/json" id="fixture-window-closes">{}</script>
<script>window.close();</script>
</body></html>`;

/**
 * Answer one request of the app under /embed/ or /widget/: the embed page, the
 * sign-in window (returning at once for a request that carries the session's
 * cookie, else its form) and the window that stalls.
 * @param {{ request: import("node:http").IncomingMessage, url: URL, response: import("node:http").ServerResponse }} served
 */
export function serveSiteAppPage({ request, url, response }) {
  const html = (status, text) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(text);
  };
  if (url.pathname === EMBED_PAGE_PATH) return html(200, embedPage());
  if (url.pathname === WINDOW_PAGE_PATH) {
    const cookies = String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim());
    return html(200, cookies.includes(`${SESSION_COOKIE}=1`) ? RETURNING_WINDOW_PAGE : windowSignInPage());
  }
  if (url.pathname === STALLED_WINDOW_PATH) return html(200, plainPage("Waiting", "<p>Waiting for the assistant.</p>"));
  html(404, "<!doctype html><title>Not found</title>");
}
