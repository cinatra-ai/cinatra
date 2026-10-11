// More pages of the fixture app, for openPageInOwnContext: pages served only to
// a session, the sign-in page they send a person without one to, and a page
// whose streams take every connection a browser context opens to the origin.
// fixture-app.mjs hands every request under /own/, and the request for the
// sign-in page, to `serveOwnContextPage`.
//
// The session is a cookie the test adds to the first page's context. Its value
// and the storage value below are no credential of anything: the tests search
// every line a step wrote for them.
import { STREAM_ROUTE, page } from "./fixture-app.mjs";

/** The cookie a page under /own/ is served to. */
export const OWN_SESSION = Object.freeze({ name: "fixture_own_session", value: "own-session-5f1c93e7" });
/** A value the first page keeps in its origin's storage. */
export const OWN_STORAGE = Object.freeze({ name: "fixture-own-note", value: "own-storage-8a2d40b6" });
/** How many streams the streams page holds open: every connection a browser opens to one origin over plain HTTP. */
export const OWN_STREAMS = 6;
/** The product's sign-in page, where a page without the session is sent. */
export const OWN_SIGN_IN_PATH = "/sign-in";

/** The links of the first pages: the target (by an address with a query string), a page that moves on, and a link that is not shown. */
const OWN_LINKS = '<nav aria-label="Main"><a href="/own/target?from=start">Target</a> <a href="/own/moves">Moves</a> <a href="/own/hidden" hidden>Hidden</a></nav>';

/**
 * The pages under /own/, by the second segment of their path: whether each is
 * served only to the session, and what it draws. `streams` holds OWN_STREAMS
 * streams open, as a run page holds its own.
 */
const OWN_PAGES = Object.freeze({
  public: { session: false, body: OWN_LINKS, timeline: [] },
  start: { session: true, body: OWN_LINKS, timeline: [] },
  streams: { session: true, body: OWN_LINKS, timeline: Array.from({ length: OWN_STREAMS }, () => ({ at: 0, stream: STREAM_ROUTE })) },
  target: { session: true, body: "<main><h1>Signed in</h1><p>The target.</p></main>", timeline: [] },
  elsewhere: { session: true, body: "<p>Another page.</p>", timeline: [] },
  hidden: { session: true, body: "<p>A page only a link that is not shown leads to.</p>", timeline: [] },
});

/** Whether the request carries the session cookie. */
function hasSession(request) {
  const cookies = String(request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim());
  return cookies.includes(`${OWN_SESSION.name}=${OWN_SESSION.value}`);
}

/**
 * Answer one request under /own/, or for the sign-in page. A page served only
 * to the session sends a request without it to the sign-in page, with the path
 * it came for in the query string; `/own/moves` sends a request with it on to
 * `/own/elsewhere`.
 * @param {{ request: import("node:http").IncomingMessage, url: URL, response: import("node:http").ServerResponse }} request
 */
export function serveOwnContextPage({ request, url, response }) {
  const html = (status, text) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(text);
  };
  const redirect = (location) => {
    response.writeHead(302, { location });
    response.end();
  };
  if (url.pathname === OWN_SIGN_IN_PATH) return html(200, page("Sign in", "<main><h1>Sign in</h1></main>"));
  const [, name] = /^\/own\/([a-z-]+)$/.exec(url.pathname) ?? [];
  const known = name === "moves" || (name !== undefined && Object.hasOwn(OWN_PAGES, name));
  if (!known) return html(404, "<!doctype html><title>Not found</title>");
  if ((name === "moves" || OWN_PAGES[name].session) && !hasSession(request)) {
    return redirect(`${OWN_SIGN_IN_PATH}?next=${encodeURIComponent(url.pathname)}`);
  }
  if (name === "moves") return redirect("/own/elsewhere");
  const { body, timeline } = OWN_PAGES[name];
  return html(200, page(url.pathname, body, timeline));
}
