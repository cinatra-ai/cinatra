// A page double for the step tests: the parts of Playwright's `Page` and
// `BrowserContext` the steps use, speaking real HTTP to the fixture app, with
// each document built by jsdom.
//
// It keeps a browser's rules for exactly what the steps do with a page:
//   - a navigation is a real request to the fixture app; every request is
//     announced to the page's request listeners before it is routed, and routes
//     run last-registered first and may abort a request before it leaves;
//   - the context announces every request of its pages, and its end: finished,
//     or failed (aborted, or cancelled because its document was left); a page
//     that closes takes its requests with it and reports nothing;
//   - plain HTTP goes over HTTP/1.1 and an https origin over HTTP/2, one
//     session per origin; each document's resource timing lists its own
//     navigation and every request it sent once that request's response has
//     ended, with the protocol it went over;
//   - a page whose first part declares that its response streams on is shown
//     from that part, and its own request stays open with it, without a
//     response end in its timing;
//   - a press that holds the new-tab modifier opens the link in a further page;
//   - a browser opens contexts, and each context keeps its own cookies, its own
//     storage and its own connections: at most six to one origin over plain
//     HTTP, and a request beyond them waits until one of them ends. A new
//     context starts from a storage state handed to it as an object (a path to a
//     file is refused). A document's storage is kept for its origin when the
//     document is left and when the context's storage state is read, and a new
//     document of that origin starts from it. A response's cookies are not
//     taken: a test adds the cookies a context starts with;
//   - a press on a link the page's own handler takes over plays that handler: it
//     cancels the press, or opens a dialog or a panel in place, or requests the
//     page from the app and, once the app has answered, moves the address
//     without a new document, as a client-side router does;
//   - a list drawn as the shared select draws it hides everything outside it
//     from assistive technology while it is open, as the select's library does,
//     and a press on one of its entries takes the entry, closes the list and
//     shows the page again (see hideOthers); the list may close after a delay
//     the page names, or never; the Escape key closes it too, taking no entry,
//     unless the page has it ignore the key (see pressEscape);
//   - a press on a checkbox, a radio or a switch the page draws itself plays the
//     page's handler for it, which flips its checked state;
//   - a press on a row drawn without a role plays the page's handlers for it: it
//     counts the press, selects the row, or leaves the page;
//   - text filled into a search field, and a press on an entry of its list, run
//     the page's own handlers for them: the same two functions the page's inline
//     script runs in a browser (see typeInSearchField in fixture-app.mjs);
//   - a page has one frame, its main frame, and every request is made in it;
//     the page announces each navigation of that frame (`framenavigated`): a new
//     document once it has committed, and a change of the address in place, a
//     state pushed or replaced in the document's history (at the same address
//     too) or a new fragment; it announces a failed request (`requestfailed`)
//     as the context does, and its own `close`;
//   - every document has its own time origin (`performance.timeOrigin`), as
//     every jsdom window has one, and a change of the address in place keeps it;
//   - an in-page function is rebuilt from its SOURCE inside the document's own
//     realm, as a browser receives it, so nothing of the step's module reaches it,
//     and its argument and its answer cross as JSON;
//   - a reading sent while a navigation is in flight is held until the
//     navigation has committed, and then throws, as a browser holds it and then
//     reports its execution context destroyed;
//   - a submit event runs the app's handler on the form first and the window's
//     listeners after it, and, when nobody cancelled it, the form submits
//     natively: its fields leave in a query string or a form body;
//   - a failed fill repeats the value it was given to fill in its message, as
//     Playwright's own call log does, so a step that forwards that message fails
//     these cases;
//   - a press moves the focus, and the keyboard types into the element that has
//     it (see the keyboard, further down);
//   - a page that declares a late hydration (`fixture-hydration`, see
//     withHydration in fixture-app.mjs) carries the App Router's flight data
//     from the start and hydrates once: at its time, or at the first press,
//     fill, typed key or focus played on it, whichever comes first; it reports
//     that moment to the app as its script does in a browser.
// The page's declared behaviour (the JSON each fixture page carries) is played on
// its document with timers, as the page's inline script does in a browser: a
// stream it opens stays open, and while its main thread is declared busy, a
// reading waits. Inline scripts never run here.
//
// frameOf, pressWithoutName, openPageOfOrigin and signInThroughWindow: what
// these steps, and the control steps given a frame scope, do with a page, with
// a browser's rules:
//   - a document's open shadow roots: a locator looks through them as
//     Playwright's CSS does (a selector matched inside every root), and the
//     accessibility tree holds their elements, as a browser's does; an in-page
//     reading sees them only where it walks into them itself; the site's page
//     mounts its widget into one, as its inline script does (see
//     fixture-app-site.mjs);
//   - a frame element's frame (`elementHandle().contentFrame()`) is a document
//     of its own, loaded from its element's address the first time it is
//     looked for, with its own focus and its own declared behaviour: its
//     readings, its locators and its waits are its own; its requests and its
//     navigations are announced on its page, each naming that frame; a press in
//     it moves the focus into it, and the page's keyboard types into the frame
//     that has the focus; it is detached once its element leaves the page's
//     document (a reload, or the element removed), and a frame of another site
//     than its page's has a CDP session of its own, as Chromium runs it out of
//     process when it runs every site in a process of its own (the browser leg
//     drives such a browser beside Playwright's own launch), while a frame of
//     the same site is read through its page's session, by the frame's id and
//     its document node (`DOM.describeNode`);
//   - `window.open` from a press (`data-fixture-window-opens`) opens a further
//     page in the same context and announces it on the page (`popup`), and a
//     page so opened that closes itself (`window.close`, declared by
//     `fixture-window-closes` or by its sign-in form once the app has answered
//     200) closes and announces `close`; a page waits for either event
//     (`waitForEvent`);
//   - a fill of an element whose content is editable sets its text, as
//     Playwright's fill does;
//   - contexts keep their cookies apart: a new context starts with none, and a
//     request carries only the cookies of its own host.
import { hydrateFixtureUpload } from "./fixture-app-controls.mjs";
import { connect, constants } from "node:http2";

import { JSDOM } from "jsdom";

import {
  EMAIL_ROUTE,
  HYDRATION_KEY,
  HYDRATION_REPORT_PATH,
  STEP_MARK,
  USERNAME_ROUTE,
  pressSearchEntry,
  typeInSearchField,
} from "./fixture-app.mjs";
import { inputInFixtureWindow, sendInFixtureWindow } from "./fixture-app-windows.mjs";
import { mountFixtureSite, pressFixtureLauncher } from "./fixture-app-site.mjs";

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const viaJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const DESTROYED = "Execution context was destroyed, most likely because of a navigation";
const ERROR_PAGE = "chrome-error://chromewebdata/";
/** The modifiers a press holds to open a link in a further page. */
const NEW_TAB_MODIFIERS = ["ControlOrMeta", "Control", "Meta"];
/** How a page double reaches its context: the context's own side, which Playwright's has not. */
const INNER = Symbol("context double");
/** A page's first part that says the rest of its response is still to come. */
const STREAMING_MARK = /<meta name="fixture-streaming"/;
/** How many connections a context opens to one origin over plain HTTP, as a browser does. */
const ORIGIN_CONNECTIONS = 6;
/** The viewport a context gives its pages unless it was made with another. */
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
/** How a context asks a page to keep its document's storage. */
const KEEP_STORAGE = Symbol("keep the storage");
const ACCESSIBILITY_SESSION = Symbol("fixture accessibility session");
/** How a frame of the double reaches the document that stands in it. */
const FRAME_PAGE = Symbol("frame document");
/** The ids frames are given, as a browser gives each frame one. */
let frameCount = 0;

/** Every element under `root`, and under every open shadow root inside it, in the order a browser's tree lists them. */
function deepElements(root) {
  const found = [];
  const walk = (node) => {
    for (const element of node.querySelectorAll("*")) {
      found.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(root);
  return found;
}

/** The elements `selector` matches under `root`, looking through open shadow roots as Playwright's CSS does. */
function deepQueryAll(root, selector) {
  return deepElements(root).filter((element) => element.matches(selector));
}

// A fixture-only name/source double for the existing branch tests. It is NOT
// the platform algorithm: browser-control-names.test.mjs exercises the cases
// (including SVG descendants and HTML label ARIA) that only Chromium can prove.
function fixtureName(element) {
  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const content = (node, skip) => {
    if (node === skip) return "";
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1 || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return "";
    if (["script", "style", "template"].includes(node.localName)) return "";
    if (node.localName === "img") return ` ${node.getAttribute("alt") || ""} `;
    if (node.localName === "select") return ` ${Array.from(node.selectedOptions || [], (option) => option.text).join(" ")} `;
    if (node.localName === "textarea") return ` ${node.value} `;
    if (node.localName === "input") return ["radio", "checkbox", "hidden", "file"].includes(node.type) ? "" : ` ${node.value || ""} `;
    return Array.from(node.childNodes, (child) => content(child, skip)).join("");
  };
  const named = (name, from) => ({ name, from: name ? from : "" });
  const labelled = text(text(element.getAttribute("aria-labelledby")).split(" ").map((id) => element.ownerDocument.getElementById(id)).filter(Boolean).map((node) => content(node, element)).join(" "));
  if (labelled) return named(labelled, "aria-labelledby");
  const aria = text(element.getAttribute("aria-label"));
  if (aria) return named(aria, "aria-label");
  const label = text(Array.from(element.labels || [], (node) => content(node, element)).join(" "));
  if (label) return named(label, "label");
  if (element.localName === "fieldset") return named(text(content(element.querySelector("legend"), null)), "label");
  if (element.localName === "input" && ["button", "submit", "reset", "image"].includes(element.type)) {
    const name = text(element.type === "image" ? element.getAttribute("alt") : element.value);
    if (name) return named(name, "text");
  }
  const role = element.getAttribute("role") || ({ a: "link" }[element.localName] ?? element.localName);
  if (["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "radio", "checkbox", "switch", "treeitem"].includes(role)) {
    const name = text(content(element, null));
    if (name) return named(name, "text");
  }
  const title = text(element.getAttribute("title"));
  if (title) return named(title, "title");
  return named(text(element.getAttribute("placeholder")), "placeholder");
}

/**
 * A response body as it arrives: `head` resolves with what has come once its
 * first part is there (or it ended), `whole` with all of it once it has ended,
 * and rejects when it was cancelled or failed. `subscribe` feeds it:
 * (onPart, onEnd, onFail).
 */
function collect(subscribe) {
  let text = "";
  let firstPart;
  const head = new Promise((done) => {
    firstPart = done;
  });
  const whole = new Promise((done, fail) => {
    subscribe(
      (part) => {
        text += part;
        firstPart(text);
      },
      () => {
        firstPart(text);
        done(text);
      },
      (error) => {
        firstPart(text);
        fail(error);
      },
    );
  });
  whole.catch(() => {});
  return { head, whole };
}

/**
 * One request over the wire, answered once the response's head has arrived:
 * its status, its final address, the protocol it went over, its body as it
 * arrives (`head` and `whole`, see collect) and `cancel`. Plain HTTP goes over
 * HTTP/1.1; an https origin over HTTP/2.
 */
async function transfer(inner, href, { method, body, headers, follow }) {
  headers = { ...headers, ...inner.cookiesFor(href) };
  if (new URL(href).protocol === "http:") {
    // One of the context's connections to the origin, held until the body has ended.
    const release = await inner.connection(new URL(href).origin);
    const controller = new AbortController();
    let response;
    try {
      response = await fetch(href, {
        method,
        body: body ?? undefined,
        headers,
        redirect: follow ? "follow" : "manual",
        signal: controller.signal,
      });
    } catch (error) {
      release();
      throw error;
    }
    const { head, whole } = collect((onPart, onEnd, onFail) => {
      if (!response.body) return onEnd();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const pump = () =>
        reader.read().then(({ done, value }) => {
          if (done) {
            const rest = decoder.decode();
            if (rest) onPart(rest);
            return onEnd();
          }
          onPart(decoder.decode(value, { stream: true }));
          return pump();
        }, onFail);
      pump();
    });
    whole.then(release, release);
    return { status: response.status, url: response.url, protocol: "http/1.1", head, whole, cancel: () => controller.abort() };
  }
  const session = await inner.session(new URL(href).origin);
  for (let hops = 0; ; hops += 1) {
    const url = new URL(href);
    const stream = session.request({ ":method": method, ":path": `${url.pathname}${url.search}`, ...headers });
    stream.on("error", () => {});
    stream.end(body ?? undefined);
    const answer = await new Promise((done, fail) => {
      stream.once("response", done);
      stream.once("close", () => fail(new Error("the stream closed before its response")));
    });
    const status = Number(answer[":status"]);
    if (follow && status >= 300 && status < 400 && answer.location && hops < 20) {
      stream.close(constants.NGHTTP2_CANCEL);
      href = new URL(answer.location, href).href;
      method = "GET";
      body = null;
      continue;
    }
    const { head, whole } = collect((onPart, onEnd, onFail) => {
      stream.setEncoding("utf8");
      stream.on("data", onPart);
      stream.once("end", onEnd);
      stream.once("close", () => onFail(new Error("the stream was cancelled")));
    });
    return { status, url: href, protocol: session.alpnProtocol, head, whole, cancel: () => stream.close(constants.NGHTTP2_CANCEL) };
  }
}

/** Whether a cookie of `domain` goes to `host`: the host itself, or a host under a domain written with a leading dot. */
const domainMatches = (host, domain) => host === domain || (domain.startsWith(".") && (host === domain.slice(1) || host.endsWith(domain)));

/** A browser: the contexts it has open. */
export class BrowserDouble {
  #origin;
  #contexts = [];

  constructor(origin) {
    this.#origin = origin;
    this[INNER] = {
      forget: (context) => {
        this.#contexts = this.#contexts.filter((open) => open !== context);
      },
    };
  }

  contexts() {
    return [...this.#contexts];
  }

  /** A context of its own: `storageState` (an object), `viewport`. */
  async newContext(options = {}) {
    const context = new ContextDouble(this.#origin, { ...options, browser: this });
    this.#contexts.push(context);
    return context;
  }

  async close() {
    for (const context of this.contexts()) await context.close();
  }
}

/** A browser context: its open pages, the request events of all of them, and its own cookies, storage and connections. */
export class ContextDouble {
  async newCDPSession(page) {
    // A frame has a session of its own only when it runs out of process: when it stands on another site than its page.
    if (page[FRAME_PAGE]) return page[FRAME_PAGE][ACCESSIBILITY_SESSION](true);
    return page[ACCESSIBILITY_SESSION]();
  }
  #origin;
  #browser;
  #viewport;
  #pages = [];
  #listeners = new Map();
  #sessions = new Map();
  #cookies = [];
  /** The storage of each origin: a map of names to values. */
  #storage = new Map();
  /** The connections to each origin over plain HTTP: how many are taken, and the requests that wait for one. */
  #pools = new Map();
  #closed = false;

  /** Made by a browser (BrowserDouble.newContext), or alone, as a context no browser opened. */
  constructor(origin, { browser = null, storageState, viewport } = {}) {
    this.#origin = origin;
    this.#browser = browser;
    this.#viewport = viewport === undefined ? { ...DEFAULT_VIEWPORT } : viewport;
    if (storageState !== undefined) {
      if (!storageState || typeof storageState !== "object") throw new Error("the page double takes a storage state as an object, never a file");
      this.#addCookies(storageState.cookies ?? []);
      for (const { origin: of, localStorage } of storageState.origins ?? []) {
        this.#storage.set(of, new Map(localStorage.map(({ name, value }) => [name, value])));
      }
    }
    this[INNER] = {
      emit: (event, value) => {
        for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(value);
      },
      open: () => {
        const page = new PageDouble(this.#origin, this);
        this.#pages.push(page);
        this[INNER].emit("page", page);
        return page;
      },
      forget: (page) => {
        this.#pages = this.#pages.filter((open) => open !== page);
      },
      // One HTTP/2 session per origin, as a browser keeps one connection. The
      // origin's certificate is made at run time, so it is not verified.
      session: (origin) => {
        let session = this.#sessions.get(origin);
        if (!session) {
          session = new Promise((done, fail) => {
            const opened = connect(origin, { rejectUnauthorized: false });
            opened.on("error", fail);
            opened.once("connect", () => done(opened));
          });
          session.catch(() => {});
          this.#sessions.set(origin, session);
        }
        return session;
      },
      transfer: (href, options) => transfer(this[INNER], href, options),
      /** The cookie header a request to `href` carries. */
      cookiesFor: (href) => {
        const url = new URL(href);
        const sent = this.#cookies.filter((cookie) => domainMatches(url.hostname, cookie.domain) && url.pathname.startsWith(cookie.path));
        return sent.length > 0 ? { cookie: sent.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } : {};
      },
      /** One connection to `origin`, once one is free: answers its release. */
      connection: (origin) => {
        let pool = this.#pools.get(origin);
        if (!pool) this.#pools.set(origin, (pool = { taken: 0, waiting: [] }));
        return new Promise((done, fail) => {
          if (this.#closed) return fail(new Error("the context was closed"));
          const take = () => {
            pool.taken += 1;
            let released = false;
            done(() => {
              if (released) return;
              released = true;
              pool.taken -= 1;
              pool.waiting.shift()?.take();
            });
          };
          if (pool.taken < ORIGIN_CONNECTIONS) take();
          else pool.waiting.push({ take, fail });
        });
      },
      /** The storage of `origin`, which a new document of that origin starts from. */
      storage: (origin) => {
        let kept = this.#storage.get(origin);
        if (!kept) this.#storage.set(origin, (kept = new Map()));
        return kept;
      },
      viewport: () => this.#viewport,
    };
  }

  /** The browser that opened the context, or null when none did. */
  browser() {
    return this.#browser;
  }

  pages() {
    return [...this.#pages];
  }

  #addCookies(cookies) {
    for (const given of cookies) {
      const domain = given.domain ?? new URL(given.url).hostname;
      const path = given.path ?? "/";
      this.#cookies = this.#cookies.filter((cookie) => !(cookie.name === given.name && cookie.domain === domain && cookie.path === path));
      this.#cookies.push({
        name: given.name,
        value: given.value,
        domain,
        path,
        expires: given.expires ?? -1,
        httpOnly: given.httpOnly ?? false,
        secure: given.secure ?? false,
        sameSite: given.sameSite ?? "Lax",
      });
    }
  }

  async addCookies(cookies) {
    this.#addCookies(cookies);
  }

  async cookies() {
    return this.#cookies.map((cookie) => ({ ...cookie }));
  }

  /** The cookies and the storage of each origin, as Playwright answers them. */
  async storageState() {
    for (const page of this.#pages) page[KEEP_STORAGE]();
    const origins = [...this.#storage]
      .filter(([, kept]) => kept.size > 0)
      .map(([origin, kept]) => ({ origin, localStorage: [...kept].map(([name, value]) => ({ name, value })) }));
    return { cookies: await this.cookies(), origins };
  }

  async newPage() {
    return this[INNER].open();
  }

  on(event, listener) {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  off(event, listener) {
    this.#listeners.set(
      event,
      (this.#listeners.get(event) ?? []).filter((l) => l !== listener),
    );
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    // A request that waits for a connection goes nowhere once its context is gone.
    for (const pool of this.#pools.values()) for (const waiting of pool.waiting.splice(0)) waiting.fail(new Error("the context was closed"));
    for (const page of this.pages()) await page.close();
    for (const session of this.#sessions.values()) (await session.catch(() => null))?.destroy();
    this.#sessions.clear();
    this.#browser?.[INNER].forget(this);
  }
}

/** Visible, as far as a document without layout can tell: attached, and no `hidden` or inline `display: none` on the way up. */
function isVisible(element) {
  if (!element.isConnected) return false;
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    if (/display\s*:\s*none/i.test(node.getAttribute("style") ?? "")) return false;
  }
  return true;
}

/** The marker the shared select's library puts on each element it hides. */
const HIDDEN_MARKER = "data-aria-hidden";

/**
 * What the shared select's library does once its list is open: every element
 * outside the list is hidden from assistive technology, the combobox that opened
 * it included. It walks down from the body along the elements that hold the
 * list, a live region or a script, and gives every other element it meets there
 * `aria-hidden="true"` and its marker; an element hidden already keeps its own
 * value. The inline script of fixture-app.mjs does the same in a browser.
 */
function hideOthers(list) {
  const document = list.ownerDocument;
  const kept = [list, ...document.querySelectorAll("[aria-live], script")];
  const walk = (parent) => {
    for (const child of Array.from(parent.children)) {
      if (kept.includes(child)) continue;
      if (kept.some((node) => child.contains(node))) {
        walk(child);
        continue;
      }
      const own = child.getAttribute("aria-hidden");
      if (own !== null && own !== "false") continue;
      child.setAttribute("aria-hidden", "true");
      child.setAttribute(HIDDEN_MARKER, "true");
    }
  };
  walk(document.body);
}

/** Such a list closes: it is hidden, and every element it hid is shown again. */
function closeList(list) {
  list.setAttribute("hidden", "");
  for (const node of list.ownerDocument.querySelectorAll(`[${HIDDEN_MARKER}]`)) {
    node.removeAttribute("aria-hidden");
    node.removeAttribute(HIDDEN_MARKER);
  }
}

/**
 * The Escape key closes every shown list a combobox opened, as the select's
 * library does, and takes no entry: the combobox reads collapsed again. A list
 * that carries `data-fixture-escape="ignored"` stays open. The inline script of
 * fixture-app.mjs does the same in a browser.
 */
function pressEscape(document) {
  for (const list of Array.from(document.querySelectorAll("[role='listbox']"))) {
    if (!list.id || list.hasAttribute("hidden") || list.getAttribute("data-fixture-escape") === "ignored") continue;
    const picker = document.querySelector(`[data-fixture-opens="${list.id}"][aria-controls="${list.id}"]`);
    if (!picker) continue;
    closeList(list);
    picker.setAttribute("aria-expanded", "false");
  }
}

/**
 * An entry pressed in such a list is taken: the combobox that controls it shows
 * the entry, and the list closes and every element it hid is shown again, at
 * once or, when the list carries `data-fixture-closes-after`, after that many
 * milliseconds (`later` is the page's timer road) or never.
 */
function chooseEntry(entry, later) {
  const document = entry.ownerDocument;
  const list = entry.closest("[role='listbox']");
  if (!list) return;
  const close = () => closeList(list);
  const picker = document.querySelector(`[aria-controls="${list.id}"]`);
  if (picker) {
    picker.textContent = entry.textContent;
    picker.removeAttribute("data-placeholder");
    picker.setAttribute("aria-expanded", "false");
  }
  // A list that carries `data-fixture-closes-after` closes that many milliseconds later, or never.
  const closesAfter = list.getAttribute("data-fixture-closes-after");
  if (closesAfter === null) close();
  else {
    entry.setAttribute("aria-selected", "true");
    if (closesAfter !== "never") later(close, Number(closesAfter));
  }
}

export class PageDouble {
  #origin;
  #context;
  #frame = { page: () => this, url: () => this.#href };
  #href = "about:blank";
  #dom;
  #navigating = 0;
  #routes = [];
  #requestListeners = [];
  /** The page's other listeners, by event: `framenavigated`, `requestfailed` and `close`. */
  #listeners = new Map();
  #timers = new Set();
  #closed = false;
  #streams = new Set();
  #entries = new WeakMap();
  #busyUntil = new WeakMap();
  /** The documents that declare a late hydration and have not hydrated yet. */
  #unhydrated = new WeakSet();
  #viewport;
  /** The page a frame's document stands in (the page itself for a page), and the frame element it stands for (null for a page). */
  #top = this;
  #owner = null;
  /** A page's frames, by their elements, and all of them, so they close with it. */
  #innerFrames = new WeakMap();
  #children = new Set();
  /** The frame that has the focus, when a press moved it into one. */
  #inFrame = null;
  #frameId = "";
  /** Whether a press opened this page (`window.open`): such a page may close itself. */
  #opened = false;

  /**
   * Opened by its context: `context.newPage()`. With `owner`, the document of a
   * frame instead: `{ top, element }`, the page the frame stands in and its
   * element (see the frames of a page, further down).
   */
  constructor(origin, context, owner = null) {
    this.#origin = origin;
    this.#context = context;
    this.#viewport = context[INNER].viewport();
    if (owner) {
      this.#top = owner.top;
      this.#owner = owner.element;
      this.#frameId = `frame-${(frameCount += 1)}`;
      this.#frame = this.#frameApi();
    }
    this.#dom = this.#build("about:blank", "<!doctype html><html><body></body></html>", null, 0);
  }

  viewportSize() {
    return this.#viewport ? { ...this.#viewport } : null;
  }

  async setViewportSize(size) {
    this.#viewport = { width: size.width, height: size.height };
  }

  /** Keep the storage of `dom` for its origin, in the context. */
  #keepStorage(dom) {
    if (!/^https?:/.test(dom.window.location.href)) return;
    const kept = this.#context[INNER].storage(dom.window.location.origin);
    const storage = dom.window.localStorage;
    kept.clear();
    for (let i = 0; i < storage.length; i += 1) kept.set(storage.key(i), storage.getItem(storage.key(i)));
  }

  [KEEP_STORAGE]() {
    if (!this.#closed) this.#keepStorage(this.#dom);
  }

  url() {
    return this.#href;
  }

  /** The frame every request of this page is made in: the page has no other. */
  mainFrame() {
    return this.#frame;
  }

  context() {
    return this.#context;
  }

  isClosed() {
    return this.#closed;
  }

  async goto(url, { timeout } = {}) {
    return this.#bounded(this.#navigate("GET", new URL(url, this.#origin).href, null), timeout, "page.goto");
  }

  async reload({ timeout } = {}) {
    return this.#bounded(this.#navigate("GET", this.#href, null), timeout, "page.reload");
  }

  async route(matcher, handler) {
    if (typeof matcher !== "function") throw new Error("the page double routes by predicate only");
    this.#routes.push({ matcher, handler });
  }

  async unroute(matcher, handler) {
    this.#routes = this.#routes.filter((r) => r.matcher !== matcher || r.handler !== handler);
  }

  on(event, listener) {
    if (event === "request") this.#requestListeners.push(listener);
    else this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  off(event, listener) {
    this.#requestListeners = this.#requestListeners.filter((l) => l !== listener);
    for (const [name, listeners] of this.#listeners) this.#listeners.set(name, listeners.filter((l) => l !== listener));
  }

  /** Tells the page's listeners of `event`. A frame's document tells its page's, its own `close` aside. */
  #emit(event, value) {
    const target = event === "close" ? this : this.#top;
    for (const listener of [...(target.#listeners.get(event) ?? [])]) listener(value);
  }

  /** Announces `request` to the page's request listeners: a frame's requests are its page's. */
  #announce(request) {
    for (const listener of [...this.#top.#requestListeners]) listener(request);
  }

  async evaluate(fn, arg) {
    // A page whose main thread is busy answers once it is free again.
    const busy = (this.#busyUntil.get(this.#dom) ?? 0) - Date.now();
    if (busy > 0) await pause(busy);
    // A reading sent while a navigation is in flight is held until the new document has committed, and the document it was sent to is gone then.
    if (this.#navigating > 0) {
      while (this.#navigating > 0 && !this.#closed) await pause(10);
      throw new Error(DESTROYED);
    }
    if (this.#closed) throw new Error(DESTROYED);
    const inPage = this.#dom.window.eval(`(${fn.toString()})`);
    return viaJson(await inPage(viaJson(arg)));
  }

  /**
   * The CDP session of this page's target: its document is the root, every
   * element (inside open shadow roots too) a node of its accessibility tree.
   * A frame of the same site is read through it, by the frame's id and its
   * document node; a frame's own session (`ownTarget`) exists only for a frame
   * of another site, which a browser runs out of process.
   */
  [ACCESSIBILITY_SESSION](ownTarget = false) {
    if (ownTarget && !this.#outOfProcess()) throw new Error("This frame does not have a separate CDP session, it is a part of the parent frame's session");
    if (this.#closed) throw new Error(DESTROYED);
    const document = this.#dom.window.document;
    // Backend ids: the document is 1, and each node after it in the order the session meets it.
    const ids = new Map();
    const objects = [];
    const idOf = (node) => {
      if (!ids.has(node)) {
        objects.push(node);
        ids.set(node, objects.length);
      }
      return ids.get(node);
    };
    for (const node of [document, ...deepElements(document)]) idOf(node);
    /** The documents of this page's frames of the same site, by the frame's id, once a frame element was described. */
    const frameDocuments = new Map();
    const nodeOf = (id) => {
      const node = objects[Number(id) - 1];
      if (!node) throw new Error("Could not find node with given id");
      return node;
    };
    let detached = false;
    return {
      send: async (command, args = {}) => {
        await this.evaluate(() => true); // Preserve busy, closed and navigating failures.
        if (detached || document !== this.#dom.window.document) throw new Error(DESTROYED);
        if (command === "DOM.getDocument") return { root: { backendNodeId: 1 } };
        if (command === "DOM.resolveNode") return { object: { objectId: String(args.backendNodeId) } };
        if (command === "Accessibility.getFullAXTree") {
          const of = args.frameId === undefined ? document : frameDocuments.get(args.frameId);
          if (!of) throw new Error("Frame with the given frameId is not found.");
          return {
            nodes: deepElements(of).map((element) => {
              const { name, from } = fixtureName(element);
              const source = { value: { value: name } };
              if (from === "label") source.nativeSource = "label";
              else if (from === "text") source.type = "contents";
              else if (from === "placeholder") source.type = "placeholder";
              else source.attribute = from;
              return { backendDOMNodeId: idOf(element), name: { value: name, sources: [source] } };
            }),
          };
        }
        if (command === "Runtime.evaluate") {
          const value = this.#dom.window.eval(args.expression);
          return value && typeof value === "object" && value.nodeType ? { result: { objectId: String(idOf(value)) } } : { result: { value: viaJson(value) } };
        }
        if (command === "DOM.describeNode") {
          const node = nodeOf(args.objectId);
          const described = { backendNodeId: idOf(node), nodeName: node.nodeName };
          const inner = node.localName === "iframe" ? this.#innerFrames.get(node) : undefined;
          if (inner && !inner.#detached()) {
            described.frameId = inner.#frameId;
            // A frame of the same site is part of this target: its document is this session's to read.
            if (!inner.#outOfProcess()) {
              const frameDocument = inner.#dom.window.document;
              frameDocuments.set(inner.#frameId, frameDocument);
              described.contentDocument = { backendNodeId: idOf(frameDocument), nodeName: "#document" };
            }
          }
          return { node: described };
        }
        if (command === "Runtime.callFunctionOn") {
          const self = nodeOf(args.objectId);
          const realm = (self.ownerDocument ?? self).defaultView;
          if (!realm || (self !== document && self.ownerDocument !== document && ![...frameDocuments.values()].includes(self.ownerDocument ?? self))) throw new Error(DESTROYED);
          const fn = realm.eval(`(${args.functionDeclaration})`);
          const values = args.arguments.map((arg) => (arg.objectId ? nodeOf(arg.objectId) : viaJson(arg.value)));
          return { result: { value: viaJson(await fn.apply(self, values)) } };
        }
        if (command === "Runtime.releaseObjectGroup") return {};
        throw new Error(`The fixture has no CDP command ${command}`);
      },
      detach: async () => { detached = true; },
    };
  }

  async waitForFunction(fn, arg, { timeout = 30_000, polling = 100 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const value = await this.evaluate(fn, arg);
      if (value) return value;
      if (Date.now() >= until) throw new TimeoutError(`page.waitForFunction: Timeout ${timeout}ms exceeded.`);
      await pause(polling);
    }
  }

  async waitForURL(predicate, { timeout = 30_000 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      if (this.#navigating === 0 && predicate(new URL(this.#href))) return;
      if (Date.now() >= until) throw new TimeoutError(`page.waitForURL: Timeout ${timeout}ms exceeded.`);
      await pause(20);
    }
  }

  locator(selector) {
    return new LocatorDouble(
      {
        document: () => this.#dom.window.document,
        press: (element, modifiers) => this.#press(element, modifiers),
        typed: (element) => this.#typed(element),
        focus: (element) => this.#focus(element),
        acted: () => this.#acted(),
        handle: (element) => this.#handleOf(element),
        setInputFilesOn: (element, files) => this.setInputFilesOn(element, files),
      },
      selector,
      {},
    );
  }

  async close() {
    if (this.#closed) return;
    this.#keepStorage(this.#dom);
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#endStreams(null, "closed");
    this.#context[INNER].forget(this);
    // The frames of the page close with it.
    for (const child of this.#children) await child.close();
    this.#children.clear();
    this.#dom.window.close();
    this.#emit("close", this);
  }

  // ---------------------------------------------------------------------------
  // The frames of a page: a frame element's frame is a document of its own, the
  // document of a PageDouble made for that element (`owner`), which is no page
  // of its context. See the header for the rules kept.
  // ---------------------------------------------------------------------------

  /** A handle on `element`: its frame, when it is a frame element, and an evaluation on it. */
  #handleOf(element) {
    return {
      contentFrame: async () => this.#contentFrame(element),
      evaluate: async (fn, arg) => {
        if (this.#closed || !element.isConnected) throw new Error("Element is not attached to the DOM");
        const inPage = element.ownerDocument.defaultView.eval(`(${fn.toString()})`);
        return viaJson(await inPage(element, viaJson(arg)));
      },
      dispose: async () => {},
    };
  }

  /** The frame of a frame element of this page's document: made, and loaded from the element's address, the first time it is looked for. */
  #contentFrame(element) {
    if (element.localName !== "iframe" || !element.isConnected || element.ownerDocument !== this.#dom.window.document) return null;
    const held = this.#innerFrames.get(element);
    if (held && !held.#detached()) return held.#frame;
    const inner = new PageDouble(this.#origin, this.#context, { top: this.#top, element });
    this.#innerFrames.set(element, inner);
    this.#top.#children.add(inner);
    const href = new URL(element.getAttribute("src") || "about:blank", this.#href).href;
    if (/^https?:/.test(href)) inner.goto(href).catch(() => {});
    return inner.#frame;
  }

  /** Whether this frame's document no longer stands in its page: its element left the page's document, or the page closed. */
  #detached() {
    if (this.#owner === null) return this.#closed;
    const gone = this.#closed || this.#top.#closed || !this.#owner.isConnected || this.#owner.ownerDocument !== this.#top.#dom.window.document;
    if (gone && !this.#closed) this.close().catch(() => {});
    return gone;
  }

  /** Whether this frame stands on another site than its page (a browser then runs it out of process). */
  #outOfProcess() {
    if (this.#owner === null) return false;
    const site = (href) => (/^https?:/.test(href) ? `${new URL(href).protocol}//${new URL(href).hostname}` : null);
    const own = site(this.#href);
    return own !== null && own !== site(this.#top.#href);
  }

  /** What a frame answers of itself, as Playwright's Frame does, for the calls the steps make. */
  #frameApi() {
    const owner = this.#owner;
    return {
      [FRAME_PAGE]: this,
      page: () => this.#top,
      url: () => this.#href,
      name: () => owner.getAttribute("name") ?? "",
      parentFrame: () => this.#top.mainFrame(),
      childFrames: () => [],
      isDetached: () => this.#detached(),
      evaluate: (fn, arg) => this.evaluate(fn, arg),
      locator: (selector) => this.locator(selector),
      waitForFunction: (fn, arg, options) => this.waitForFunction(fn, arg, options),
      getByRole: (role, options) => this.getByRole(role, options),
      frameElement: async () => this.#top.#handleOf(owner),
    };
  }

  #later(fn, ms) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#closed) fn();
    }, ms);
    this.#timers.add(timer);
  }

  #bounded(promise, timeout, name) {
    promise.catch(() => {});
    if (!timeout) return promise;
    let timer;
    const expired = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new TimeoutError(`${name}: Timeout ${timeout}ms exceeded.`)), timeout);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  }

  /** A document for `html`, with its resource timing and the behaviour the page declares scheduled on it. */
  #build(href, html, protocol, responseEnd) {
    const dom = new JSDOM(html, { url: /^https?:/.test(href) ? href : "about:blank", runScripts: "outside-only" });
    // A new document starts from the storage its context keeps for its origin.
    if (/^https?:/.test(href)) {
      for (const [name, value] of this.#context[INNER].storage(new URL(href).origin)) dom.window.localStorage.setItem(name, value);
    }
    const entries = /^https?:/.test(href)
      ? [{ name: href, entryType: "navigation", nextHopProtocol: protocol ?? "", startTime: 0, responseEnd }]
      : [];
    this.#entries.set(dom, entries);
    Object.defineProperty(dom.window.performance, "getEntriesByType", {
      value: (type) => entries.filter((entry) => entry.entryType === type).map((entry) => ({ ...entry })),
    });
    // A change of the address in place: a state pushed or replaced in the
    // history (at the same address too), or a new fragment.
    const { history } = dom.window;
    for (const name of ["pushState", "replaceState"]) {
      const own = history[name].bind(history);
      Object.defineProperty(history, name, {
        configurable: true,
        value: (...args) => {
          own(...args);
          this.#movedInPlace(dom);
        },
      });
    }
    dom.window.addEventListener("hashchange", () => this.#movedInPlace(dom));
    const declared = (id) => {
      const node = dom.window.document.getElementById(id);
      return node ? JSON.parse(node.textContent) : null;
    };
    for (const op of declared("fixture-timeline") ?? []) this.#later(() => this.#play(dom, op), op.at);
    for (const op of declared("fixture-behaviour") ?? []) {
      if (op.direct && op.hydrateAfterMs !== null) this.#later(() => hydrateFixtureUpload(dom.window.document, op), op.hydrateAfterMs);
    }
    const scenario = declared("fixture-scenario");
    if (scenario && scenario.hydrateAfterMs !== null) {
      this.#later(() => this.#hydrate(dom, scenario), scenario.hydrateAfterMs);
    }
    // The site's page mounts its widget as its inline script does, and a window that closes itself does so once it has loaded.
    if (dom.window.document.getElementById("fixture-site")) mountFixtureSite(dom.window.document);
    if (dom.window.document.getElementById("fixture-window-closes")) {
      this.#later(() => {
        if (this.#dom === dom && this.#opened) this.close().catch(() => {});
      }, 0);
    }
    const hydration = declared("fixture-hydration");
    if (hydration) {
      dom.window.__next_f = [];
      this.#unhydrated.add(dom);
      if (hydration.afterMs !== null) this.#later(() => this.#hydrateLate(dom, "time"), hydration.afterMs);
    }
    return dom;
  }

  /**
   * A page that declares a late hydration hydrates once, `by` its time or by an
   * event: every element of its body carries the key React sets on an element
   * it has hydrated, and the page reports the moment, with the marks it carried.
   */
  #hydrateLate(dom, by) {
    if (this.#closed || this.#dom !== dom || !this.#unhydrated.has(dom)) return;
    this.#unhydrated.delete(dom);
    const { document, location } = dom.window;
    const marked = document.querySelectorAll(`[${STEP_MARK}]`).length;
    for (const element of document.body?.querySelectorAll("*") ?? []) element[HYDRATION_KEY] = true;
    const report = new URL(HYDRATION_REPORT_PATH, location.href);
    report.search = new URLSearchParams({ by, marked: String(marked), path: location.pathname, at: String(Date.now()) }).toString();
    this.#send("GET", report.href, null, false).catch(() => {});
  }

  /** A press, a fill, a typed key or a focus is played on the page: a page that has not hydrated yet hydrates at once. */
  #acted() {
    this.#hydrateLate(this.#dom, "event");
  }

  #commit(href, html, protocol = null, elapsedMs = 0, streaming = null) {
    const previous = this.#dom;
    this.#keepStorage(previous);
    this.#href = href;
    this.#dom = this.#build(href, html, protocol, streaming ? 0 : Math.max(1, elapsedMs));
    // A new document has the focus on nothing of its own yet.
    this.#focused = null;
    // The document left behind cancels its requests, and the context hears of each.
    this.#endStreams(previous, "failed");
    if (streaming) {
      // Its own request stays open with it; its response end is written once the rest has come.
      const dom = this.#dom;
      const held = this.#hold(dom, streaming.request, () => {
        this.#entries.get(dom)[0].responseEnd = dom.window.performance.now();
      });
      held.stop = streaming.reply.cancel;
      streaming.reply.whole.then(
        () => held.settle("finished"),
        () => held.settle("failed"),
      );
    }
    previous.window.close();
    // The frames of the document left behind are detached, and close.
    for (const child of [...this.#children]) {
      if (child.#detached()) this.#children.delete(child);
    }
    this.#emit("framenavigated", this.#frame);
  }

  /** The address of `dom` changed in place: the page follows it, and announces the navigation of its main frame. */
  #movedInPlace(dom) {
    if (this.#closed || this.#dom !== dom) return;
    this.#href = dom.window.location.href;
    this.#emit("framenavigated", this.#frame);
  }

  #play(dom, op) {
    if (this.#dom !== dom) return;
    if (op.reload) {
      this.#navigate("GET", this.#href, null).catch(() => {});
      return;
    }
    if (op.stream) {
      this.#openStream(dom, op.stream);
      return;
    }
    if (op.freeze) {
      this.#busyUntil.set(dom, Date.now() + op.freeze);
      return;
    }
    const element = dom.window.document.querySelector(op.target);
    if (!element) return;
    if (op.attr) element.setAttribute(op.attr, op.value);
    else element.innerHTML = op.html;
  }

  /** What the sign-in page's script does once the app takes the form over. */
  #hydrate(dom, scenario) {
    if (this.#dom !== dom) return;
    const form = dom.window.document.getElementById("sign-in");
    const field = (name) => form.elements.namedItem(name);
    if (scenario.handler === "posts" || scenario.handler === "posts-username") {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const id = field("email") ? field("email").value : "";
        const secret = field("password").value;
        const [route, payload] =
          scenario.handler === "posts"
            ? [EMAIL_ROUTE, { email: id, password: secret }]
            : [USERNAME_ROUTE, { username: id, password: secret }];
        this.#send("POST", new URL(route, this.#origin).href, JSON.stringify(payload), false)
          .then((sent) => {
            // The landing of signInThroughPage: once the app has answered 200, the
            // page goes where its scenario says, as the product's form does.
            if (sent.status === 200 && typeof scenario.landing === "string" && this.#dom === dom) {
              this.#navigate("GET", new URL(scenario.landing, this.#origin).href, null).catch(() => {});
            }
          })
          .catch(() => {});
      });
    } else if (scenario.handler === "posts-closes") {
      // A window's form: the app's own sign-in request, and the window closes itself once the app has answered 200.
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const payload = { email: field("email").value, password: field("password").value };
        this.#send("POST", new URL(EMAIL_ROUTE, this.#href).href, JSON.stringify(payload), false)
          .then((sent) => {
            if (sent.status === 200 && this.#dom === dom && this.#opened) this.close().catch(() => {});
          })
          .catch(() => {});
      });
    } else if (scenario.handler === "silent") {
      form.addEventListener("submit", (event) => event.preventDefault());
    } else if (scenario.handler === "scripted") {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        // `form.submit()` fires no submit event: straight to the native submission.
        this.#later(() => {
          if (this.#dom === dom) this.#nativeSubmit(form);
        }, 0);
      });
    }
    form.setAttribute("novalidate", "");
  }

  /**
   * Text filled or typed into a field: the page's handler for a window's box
   * keeps its send control in step with it, and the page's handler for a search
   * field opens its list and answers the search.
   */
  #typed(element) {
    if (element.hasAttribute("data-fixture-window-box")) inputInFixtureWindow(element);
    if (!element.hasAttribute("data-fixture-searches")) return;
    const document = element.ownerDocument;
    typeInSearchField(element, (run, ms) =>
      this.#later(() => {
        if (this.#dom.window.document === document) run();
      }, ms),
    );
  }

  #press(element, modifiers) {
    // The site's own handler of its widget's launcher (see fixture-app-site.mjs).
    if (element.hasAttribute("data-fixture-site-launcher")) {
      pressFixtureLauncher(element);
      return;
    }
    // The page's handler of a control that opens a window: a further page in the same context, announced as a popup.
    const opener = element.closest("[data-fixture-window-opens]");
    if (opener) {
      const popup = this.#context[INNER].open();
      popup.#opened = true;
      this.#emit("popup", popup);
      popup.goto(new URL(opener.getAttribute("data-fixture-window-opens"), this.#href).href).catch(() => {});
      return;
    }
    // The page's handlers of a row drawn without a role (see PRESS_ROWS_PAGE in
    // fixture-app.mjs): it counts its presses, selects itself, or leaves the page.
    if (element.hasAttribute("data-fixture-counts")) {
      element.setAttribute("data-fixture-clicks", String(Number(element.getAttribute("data-fixture-clicks") ?? 0) + 1));
    }
    if (element.hasAttribute("data-fixture-selects")) {
      for (const row of element.ownerDocument.querySelectorAll("[data-fixture-selects]")) row.setAttribute("data-selected", String(row === element));
    }
    if (element.hasAttribute("data-fixture-goes")) {
      this.#navigate("GET", new URL(element.getAttribute("data-fixture-goes"), this.#href).href, null).catch(() => {});
      return;
    }
    // The page's handler takes a press on a window's send control.
    const send = element.closest("[data-fixture-window-send]");
    if (send) {
      const document = send.ownerDocument;
      sendInFixtureWindow(send, (run, ms) =>
        this.#later(() => {
          if (this.#dom.window.document === document) run();
        }, ms),
      );
      return;
    }
    // The page's handler takes an entry of a search field's list.
    const entry = element.closest("[data-fixture-picks]");
    if (entry) {
      pressSearchEntry(entry);
      return;
    }
    // The page's handler flips the checked state of a control it draws itself.
    if (element.hasAttribute("data-fixture-toggles")) {
      const on = element.getAttribute("aria-checked") !== "true";
      element.setAttribute("aria-checked", String(on));
      element.setAttribute("data-state", on ? "checked" : "unchecked");
      return;
    }
    if (element.localName === "a" && element.hasAttribute("href")) {
      // The page's handler cancels every press of this link.
      if (element.hasAttribute("data-fixture-inert")) return;
      // The page's handler takes an entry of a list drawn as the shared select draws it.
      if (element.hasAttribute("data-fixture-chooses")) {
        const document = element.ownerDocument;
        chooseEntry(element, (run, ms) =>
          this.#later(() => {
            if (this.#dom.window.document === document) run();
          }, ms),
        );
        return;
      }
      // The page's handler cancels the press and opens the dialog or the panel it names, in place.
      const opens = element.getAttribute("data-fixture-opens");
      if (opens !== null) {
        const opened = element.ownerDocument.getElementById(opens);
        opened?.removeAttribute("hidden");
        if (opened?.hasAttribute("data-fixture-hides-others")) hideOthers(opened);
        if (element.hasAttribute("aria-expanded")) element.setAttribute("aria-expanded", "true");
        return;
      }
      // A link that opens another tab leaves this page where it is.
      if (element.getAttribute("target") === "_blank") return;
      const href = new URL(element.getAttribute("href"), this.#href).href;
      if (element.hasAttribute("data-fixture-in-place")) {
        // The page's handler cancels the press, requests the page from the app,
        // and pushes the address once the app has answered: the document stays.
        const dom = this.#dom;
        this.#send("GET", href, null, false).then(
          () => {
            if (this.#closed || this.#dom !== dom) return;
            dom.window.history.pushState(null, "", href);
          },
          () => {},
        );
        return;
      }
      if (modifiers.some((modifier) => NEW_TAB_MODIFIERS.includes(modifier))) {
        // The new-tab modifier: the link opens in a further page, and this one stays.
        this.#context[INNER].open().goto(href).catch(() => {});
        return;
      }
      this.#navigate("GET", href, null).catch(() => {});
      return;
    }
    const form = element.form;
    if (element.localName === "button" && (element.getAttribute("type") ?? "submit") === "submit" && form) {
      const window = element.ownerDocument.defaultView;
      const event = new window.Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      // A form the page declares a handler for is taken by that handler, as the page's script takes it in a browser.
      const handlers = this.#declared(element.ownerDocument).filter((op) => op.submit && form.matches(op.submit));
      for (const op of handlers) this.#playSubmit(form, op);
      if (handlers.length === 0 && !event.defaultPrevented) this.#nativeSubmit(form);
    }
  }

  #nativeSubmit(form) {
    const window = form.ownerDocument.defaultView;
    const fields = new window.URLSearchParams(new window.FormData(form)).toString();
    const target = new URL(form.getAttribute("action") || this.#href, this.#href);
    if ((form.getAttribute("method") || "get").toLowerCase() === "post") {
      this.#navigate("POST", target.href, fields).catch(() => {});
    } else {
      target.search = fields;
      this.#navigate("GET", target.href, null).catch(() => {});
    }
  }

  async #navigate(method, href, body) {
    this.#navigating += 1;
    try {
      const sent = await this.#send(method, href, body, true);
      if (this.#closed) return null;
      if (sent.aborted) {
        // The browser shows its own error page in place of a navigation that never left it.
        this.#commit(ERROR_PAGE, "<!doctype html><title>Blocked</title>");
        return null;
      }
      this.#commit(sent.url, sent.text, sent.protocol, sent.elapsedMs, sent.streaming);
      return { status: () => sent.status, url: () => sent.url };
    } finally {
      this.#navigating -= 1;
    }
  }

  #request(method, href, navigation, answer) {
    return {
      url: () => href,
      method: () => method,
      isNavigationRequest: () => navigation,
      response: () => answer,
      frame: () => this.#frame,
    };
  }

  /** The request's entry in the resource timing of the document that sent it, once its response has ended. */
  #timed(dom, href, protocol, startedAt) {
    const entries = this.#entries.get(dom);
    if (!entries || this.#dom !== dom) return;
    const now = dom.window.performance.now();
    entries.push({
      name: href,
      entryType: "resource",
      nextHopProtocol: protocol,
      startTime: Math.max(0, now - (performance.now() - startedAt)),
      responseEnd: now,
    });
  }

  /**
   * Keep `request` open with `dom`. It settles once: finished (its body ended),
   * failed (`dom` was left), and the context hears of both; or closed with its
   * page, and the context hears nothing, as in a browser.
   */
  #hold(dom, request, onFinished) {
    const inner = this.#context[INNER];
    const held = { dom, settled: false, stop: () => {} };
    held.settle = (how) => {
      if (held.settled) return;
      held.settled = true;
      this.#streams.delete(held);
      if (how === "finished") {
        inner.emit("requestfinished", request);
        onFinished();
      } else if (how === "failed") {
        inner.emit("requestfailed", request);
        this.#emit("requestfailed", request);
      }
    };
    this.#streams.add(held);
    return held;
  }

  /** A request the document holds open, as an event stream is: it ends only when the server ends it or the page leaves it. */
  #openStream(dom, path) {
    if (this.#dom !== dom || this.#closed) return;
    const href = new URL(path, this.#href).href;
    const inner = this.#context[INNER];
    let answered;
    const request = this.#request(
      "GET",
      href,
      false,
      new Promise((done) => {
        answered = done;
      }),
    );
    const startedAt = performance.now();
    let protocol = "";
    const held = this.#hold(dom, request, () => this.#timed(dom, href, protocol, startedAt));
    this.#announce(request);
    inner.emit("request", request);
    inner.transfer(href, { method: "GET", body: null, headers: { accept: "text/event-stream" }, follow: false }).then(
      (reply) => {
        answered({ status: () => reply.status });
        protocol = reply.protocol;
        if (held.settled) {
          reply.cancel();
          return;
        }
        held.stop = reply.cancel;
        reply.whole.then(
          () => held.settle("finished"),
          () => held.settle("failed"),
        );
      },
      () => {
        answered(null);
        held.settle("failed");
      },
    );
  }

  /** End the streams of `dom` (of every document when null): `failed` when the document is left, `closed` with the page. */
  #endStreams(dom, how) {
    for (const stream of [...this.#streams]) {
      if (dom !== null && stream.dom !== dom) continue;
      stream.settle(how);
      stream.stop();
    }
  }

  async #send(method, href, body, navigation) {
    const from = this.#dom;
    const inner = this.#context[INNER];
    let answered;
    const answer = new Promise((done) => {
      answered = done;
    });
    const request = this.#request(method, href, navigation, answer);
    this.#announce(request);
    inner.emit("request", request);
    for (const { matcher, handler } of [...this.#routes].reverse()) {
      if (!matcher(new URL(href))) continue;
      let verdict = "fallback";
      await handler(
        {
          abort: async () => {
            verdict = "abort";
          },
          fallback: async () => {},
          continue: async () => {
            verdict = "continue";
          },
        },
        request,
      );
      if (verdict === "abort") {
        answered(null);
        inner.emit("requestfailed", request);
        this.#emit("requestfailed", request);
        return { aborted: true };
      }
      if (verdict === "continue") break;
    }
    const headers = body === null ? {} : { "content-type": navigation ? "application/x-www-form-urlencoded" : "application/json" };
    const startedAt = performance.now();
    let reply;
    let text;
    try {
      reply = await inner.transfer(href, { method, body, headers, follow: navigation });
      // A page whose first part says its response streams on is shown from that part; its request stays open.
      const first = navigation ? await reply.head : "";
      if (STREAMING_MARK.test(first)) {
        answered({ status: () => reply.status });
        const elapsedMs = performance.now() - startedAt;
        return { aborted: false, status: reply.status, url: reply.url, text: first, protocol: reply.protocol, elapsedMs, streaming: { reply, request } };
      }
      text = await reply.whole;
    } catch (error) {
      answered(null);
      inner.emit("requestfailed", request);
      this.#emit("requestfailed", request);
      throw error;
    }
    answered({ status: () => reply.status });
    inner.emit("requestfinished", request);
    if (!navigation) this.#timed(from, href, reply.protocol, startedAt);
    const elapsedMs = performance.now() - startedAt;
    return { aborted: false, status: reply.status, url: reply.url, text, protocol: reply.protocol, elapsedMs };
  }

  // ---------------------------------------------------------------------------
  // uploadFile, fillForm, switchTheme and decideGate: what these four steps do
  // with a page, in this one place. They name controls as a person reads them
  // (`getByRole`), answer a file chooser
  // (`waitForEvent("filechooser")`) and read the documents of the page's frames
  // (`frames()`). The browser's rules kept for them:
  //   - a named locator matches what the accessibility tree shows: nothing
  //     `hidden`, under an inline `display: none` or under `aria-hidden="true"`,
  //     named by `aria-labelledby`, then `aria-label`, then its labels, its value
  //     or its text;
  //   - a press dispatches a click, then the page's own handler for it runs (its
  //     declared `press` behaviour), then the browser's default: a file input
  //     opens a file chooser, a submit button sends its form (to the form's
  //     declared `submit` behaviour, or natively by the rules above), and a
  //     link follows the rules above; a submit button pressed by a selector
  //     (`locator`) sends its form the same way;
  //   - a file chooser reaches every `waitForEvent("filechooser")` pending when
  //     it opens, and one nobody waits for is dropped, as a headless browser
  //     drops it; the files handed to it land on its input, which reports
  //     `input` and `change` only when they differ from the files it holds
  //     already (a browser compares them by their source, so the same file
  //     handed over twice reports nothing the second time);
  //   - a fill sets the value and reports `input` and `change`;
  //   - a frame's document is loaded from the app the first time it is read and
  //     again once its address has changed, and that load is not announced: no
  //     step listens for a frame's requests.
  // A page's declared behaviour (`fixture-behaviour`, see fixture-app-controls.mjs)
  // is played here on its document, as its inline script plays it in a browser.
  // ---------------------------------------------------------------------------

  #chooserWaiters = [];
  #frameDocuments = new WeakMap();
  /** What each file input holds: the source of each of its files. */
  #heldFiles = new WeakMap();

  getByRole(role, { name, exact = false } = {}) {
    return this.#named(`getByRole('${role}')`, (document) =>
      Array.from(document.querySelectorAll("*")).filter(
        (element) =>
          PageDouble.#hasRole(element, role) &&
          PageDouble.#exposed(element) &&
          PageDouble.#matches([PageDouble.#accessibleName(element)], name, exact),
      ),
    );
  }

  waitForEvent(event, { timeout = 30_000 } = {}) {
    if (event === "popup" || event === "close") {
      return new Promise((done, fail) => {
        const listener = (value) => {
          clearTimeout(timer);
          this.off(event, listener);
          done(value);
        };
        const timer = setTimeout(() => {
          this.off(event, listener);
          fail(new TimeoutError(`page.waitForEvent: Timeout ${timeout}ms exceeded while waiting for event "${event}"`));
        }, timeout);
        this.on(event, listener);
      });
    }
    if (event !== "filechooser") return Promise.reject(new Error(`the page double waits for a file chooser only, not for ${event}`));
    return new Promise((done, fail) => {
      const waiter = { done };
      waiter.timer = setTimeout(() => {
        this.#chooserWaiters = this.#chooserWaiters.filter((pending) => pending !== waiter);
        fail(new TimeoutError(`page.waitForEvent: Timeout ${timeout}ms exceeded while waiting for event "filechooser"`));
      }, timeout);
      this.#chooserWaiters.push(waiter);
    });
  }

  /** The main frame first, then a frame for every iframe of the document. */
  frames() {
    const main = Object.assign(this.#frame, { url: () => this.#href, evaluate: (fn, arg) => this.evaluate(fn, arg) });
    return [main, ...Array.from(this.#dom.window.document.querySelectorAll("iframe"), (frame) => this.#childFrame(frame))];
  }

  static #normal(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  /** The text a person reads in `node`: its text, without what is hidden from assistive technology. */
  static #textOf(node) {
    let found = "";
    const walker = node.ownerDocument.createTreeWalker(node, 4 /* text nodes */);
    for (let at = walker.nextNode(); at; at = walker.nextNode()) {
      if (at.parentElement?.closest('[aria-hidden="true"]')) continue;
      found += ` ${at.nodeValue}`;
    }
    return PageDouble.#normal(found);
  }

  static #byIds(element, attribute) {
    const ids = PageDouble.#normal(element.getAttribute(attribute)).split(" ").filter(Boolean);
    return ids.map((id) => element.ownerDocument.getElementById(id)).filter(Boolean);
  }

  static #accessibleName(element) {
    const labelledBy = PageDouble.#byIds(element, "aria-labelledby");
    if (labelledBy.length > 0) return PageDouble.#normal(labelledBy.map((node) => PageDouble.#textOf(node)).join(" "));
    const label = PageDouble.#normal(element.getAttribute("aria-label"));
    if (label) return label;
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (element.localName === "input" && ["submit", "reset", "button"].includes(type)) {
      return PageDouble.#normal(element.value) || { submit: "Submit", reset: "Reset" }[type] || "";
    }
    if (["input", "textarea", "select"].includes(element.localName)) {
      const labels = PageDouble.#normal(Array.from(element.labels ?? [], (node) => PageDouble.#textOf(node)).join(" "));
      if (labels) return labels;
      return type === "file" ? "Choose File" : PageDouble.#normal(element.getAttribute("title"));
    }
    return PageDouble.#textOf(element) || PageDouble.#normal(element.getAttribute("title"));
  }

  static #hasRole(element, role) {
    const own = element.getAttribute("role");
    if (own) return own === role;
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    return role === "button" && (element.localName === "button" || (element.localName === "input" && ["button", "submit", "reset", "image", "file"].includes(type)));
  }

  static #exposed(element) {
    return isVisible(element) && !element.closest('[aria-hidden="true"]');
  }

  static #matches(names, wanted, exact) {
    if (wanted === undefined) return true;
    const want = PageDouble.#normal(wanted);
    return names.some((name) => (exact ? PageDouble.#normal(name) === want : PageDouble.#normal(name).toLowerCase().includes(want.toLowerCase())));
  }

  /** A locator over what `resolve` finds in the current document: count, nth, first, evaluate, click and fill. */
  #named(description, resolve) {
    const found = () => resolve(this.#dom.window.document);
    const one = async (timeout, timeoutMessage, actionable) => {
      const until = Date.now() + timeout;
      for (;;) {
        const all = found();
        if (all.length > 1) throw new Error(`strict mode violation: ${description} resolved to ${all.length} elements`);
        if (all.length === 1 && (!actionable || (isVisible(all[0]) && !all[0].disabled))) return all[0];
        if (Date.now() >= until) throw new TimeoutError(timeoutMessage);
        await pause(20);
      }
    };
    const locator = {
      count: async () => found().length,
      nth: (index) => this.#named(`${description} >> nth=${index}`, (document) => resolve(document).slice(index, index + 1)),
      first: () => locator.nth(0),
      evaluate: async (fn, arg, { timeout = 30_000 } = {}) => {
        const element = await one(timeout, `locator.evaluate: Timeout ${timeout}ms exceeded.`, false);
        if (this.#navigating > 0 || this.#closed) throw new Error(DESTROYED);
        const inPage = element.ownerDocument.defaultView.eval(`(${fn.toString()})`);
        return viaJson(await inPage(element, viaJson(arg)));
      },
      click: async ({ timeout = 30_000 } = {}) => {
        const element = await one(timeout, `locator.click: Timeout ${timeout}ms exceeded.`, true);
        if (element.hasAttribute("data-fixture-pointer-intercepted")) throw new TimeoutError("locator.click: another element intercepts pointer events");
        this.#acted();
        this.#pressControl(element);
      },
      fill: async (value, { timeout = 30_000 } = {}) => {
        const element = await one(timeout, `locator.fill: Timeout ${timeout}ms exceeded.\nCall log:\n  - fill("${value}")`, true);
        this.#acted();
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (element.localName === "select" || !["input", "textarea"].includes(element.localName)) {
          throw new Error("Error: Element is not an <input>, <textarea> or [contenteditable] element");
        }
        if (element.localName === "input" && ["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color"].includes(type)) {
          throw new Error(`Error: Input of type "${type}" cannot be filled`);
        }
        element.value = value;
        const window = element.ownerDocument.defaultView;
        element.dispatchEvent(new window.Event("input", { bubbles: true }));
        element.dispatchEvent(new window.Event("change", { bubbles: true }));
      },
    };
    return locator;
  }

  /** Playwright's direct file-input hand-over, without a pointer action. */
  async setInputFilesOn(element, files) {
    this.#acted();
    if (element.localName !== "input" || element.type !== "file") throw new Error("Element is not an input[type=file]");
    return this.#setFiles(element, files);
  }

  /** What the page declares its own handlers do. */
  #declared(document) {
    const node = document.getElementById("fixture-behaviour");
    return node ? JSON.parse(node.textContent) : [];
  }

  /** A press of a named control: the click, the page's own handler, then the browser's default. */
  #pressControl(element) {
    const document = element.ownerDocument;
    const window = document.defaultView;
    const click = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(click);
    if (click.defaultPrevented || this.#dom.window.document !== document) return;
    const declared = this.#declared(document);
    for (const op of declared) {
      if (op.press && element.closest(op.press)) this.#playPress(document, op);
    }
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (element.localName === "input" && type === "file") {
      this.#openChooser(element);
      return;
    }
    const form = element.form;
    if (form && element.localName === "button" && (type || "submit") === "submit") {
      this.#press(element, []);
      return;
    }
    const link = element.closest("a[href]");
    if (link) this.#press(link, []);
  }

  #playPress(document, op) {
    const dom = this.#dom;
    if (op.choose) {
      // The page's handler presses its hidden file input, which opens the chooser.
      const input = document.querySelector(op.choose);
      if (input) {
        input.dispatchEvent(new document.defaultView.MouseEvent("click", { bubbles: true, cancelable: true }));
        this.#openChooser(input);
      }
    }
    if (op.theme) {
      const root = document.documentElement;
      const next = root.classList.contains(op.theme.dark) ? "light" : "dark";
      root.classList.remove(op.theme.dark, op.theme.light);
      root.classList.add(op.theme[next]);
      if (op.theme.islands) {
        this.#later(() => {
          if (this.#dom !== dom) return;
          for (const frame of document.querySelectorAll(op.theme.islands)) {
            const src = new URL(frame.getAttribute("src") ?? "", this.#href);
            src.searchParams.set("scheme", next);
            frame.setAttribute("src", `${src.pathname}${src.search}`);
          }
        }, op.theme.delayMs ?? 0);
      }
    }
    if (op.decide) {
      this.#later(() => {
        if (this.#dom !== dom) return;
        const gate = document.querySelector(op.decide.gate);
        if (gate) {
          gate.setAttribute("data-lifecycle-card-state", op.decide.state);
          for (const control of gate.querySelectorAll("button")) control.remove();
        }
        if (!op.decide.status) return;
        for (const pill of document.querySelectorAll(op.decide.pill)) {
          pill.setAttribute("data-status", op.decide.status);
          pill.textContent = op.decide.status;
        }
      }, op.decide.delayMs ?? 0);
    }
  }

  #openChooser(input) {
    const waiters = this.#chooserWaiters;
    this.#chooserWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.done({ page: () => this, isMultiple: () => input.multiple === true, setFiles: (files) => this.#setFiles(input, files) });
    }
  }

  /**
   * Files handed to a chooser: read, set on its input, and, when they differ from
   * the files the input held, reported and handed to the page's handler. A file
   * read from a path has that path as its source; one handed over as a payload
   * has a source of its own.
   */
  async #setFiles(input, files) {
    const [{ readFile }, { basename, resolve }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const chosen = await Promise.all(
      (Array.isArray(files) ? files : [files]).map(async (file) =>
        typeof file === "string"
          ? { name: basename(file), mimeType: "application/octet-stream", buffer: await readFile(file), source: resolve(file) }
          : { ...file, source: Symbol("payload") },
      ),
    );
    if (!input.isConnected || this.#closed) throw new Error("Element is not attached to the DOM");
    const document = input.ownerDocument;
    const window = document.defaultView;
    const list = chosen.map((file) => new window.File([file.buffer], file.name, { type: file.mimeType }));
    const fileList = Object.assign(Object.fromEntries(list.map((file, at) => [at, file])), { length: list.length, item: (at) => list[at] ?? null });
    Object.defineProperty(input, "files", { configurable: true, get: () => fileList });
    const held = this.#heldFiles.get(input) ?? [];
    this.#heldFiles.set(input, chosen.map((file) => file.source));
    if (held.length === chosen.length && chosen.every((file, at) => file.source === held[at])) return;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    for (const op of this.#declared(document)) {
      if (op.chosen && input.matches(op.chosen) && (!op.direct || typeof input.__reactProps$fixture?.onChange === "function")) this.#playChosen(document, op, chosen, input);
    }
  }

  #playChosen(document, op, chosen, input) {
    const dom = this.#dom;
    // The page's handler takes the files and empties its input at once, as the library's own handler does.
    const none = { length: 0, item: () => null };
    Object.defineProperty(input, "files", { configurable: true, get: () => none });
    this.#heldFiles.delete(input);
    for (const file of chosen) {
      this.#send("POST", new URL(op.upload, this.#href).href, file.buffer, false).then(
        (sent) =>
          this.#later(() => {
            if (this.#dom !== dom) return;
            if (sent.status >= 200 && sent.status < 300) {
              if (op.completion) {
                const signal = document.querySelector(op.completion);
                if (signal && !op.completionNever) { signal.textContent = op.wrongResult ? "@acme/different-skill" : "@acme/fixture-skill"; signal.removeAttribute("hidden"); }
                return;
              }
              const list = document.querySelector(op.rows);
              if (!list) return;
              const row = document.createElement("li");
              row.setAttribute("data-field", "name=identity.displayName");
              const title = document.createElement("span");
              title.textContent = file.name;
              row.append(title);
              list.append(row);
              return;
            }
            const panel = document.querySelector(op.refused);
            if (!panel) return;
            panel.textContent = `Can't type ${file.name}`;
            panel.removeAttribute("hidden");
          }, op.delayMs ?? 0),
        () => {},
      );
    }
  }

  #playSubmit(form, op) {
    const document = form.ownerDocument;
    const dom = this.#dom;
    for (const line of form.querySelectorAll("[data-fixture-shown-error]")) line.remove();
    const required = Array.from(form.querySelectorAll("[data-fixture-required]"));
    const messageOf = (control) => document.getElementById(control.getAttribute("data-fixture-error-in") ?? "");
    for (const control of required) {
      control.removeAttribute("aria-invalid");
      const message = messageOf(control);
      if (message) {
        message.textContent = "";
        message.setAttribute("hidden", "");
      }
    }
    const missing = required.filter((control) => control.value.trim() === "");
    for (const control of missing) {
      const said = control.getAttribute("data-fixture-required");
      control.setAttribute("aria-invalid", "true");
      const message = messageOf(control);
      if (message) {
        message.textContent = said;
        message.removeAttribute("hidden");
        continue;
      }
      const line = document.createElement("p");
      line.className = "text-xs text-destructive";
      line.setAttribute("data-fixture-shown-error", "");
      line.textContent = said;
      control.after(line);
    }
    if (missing.length > 0) return;
    const values = Object.fromEntries(Array.from(form.elements, (control) => [control.name, control.value]).filter(([name]) => name));
    this.#send("POST", new URL(op.sends, this.#href).href, JSON.stringify(values), false).then(
      () => {
        if (this.#dom === dom) document.querySelector(op.done)?.removeAttribute("hidden");
      },
      () => {},
    );
  }

  #childFrame(frame) {
    const href = () => new URL(frame.getAttribute("src") || "about:blank", this.#href).href;
    return {
      url: () => href(),
      parentFrame: () => this.#frame,
      evaluate: async (fn, arg) => {
        const dom = await this.#frameDocument(frame, href());
        const inFrame = dom.window.eval(`(${fn.toString()})`);
        return viaJson(await inFrame(viaJson(arg)));
      },
    };
  }

  /** The frame's document at `href`: loaded once per address it is pointed at. */
  #frameDocument(frame, href) {
    const held = this.#frameDocuments.get(frame);
    if (held?.href === href) return held.dom;
    const dom = /^https?:/.test(href)
      ? this.#context[INNER].transfer(href, { method: "GET", body: null, headers: {}, follow: true }).then(
          async (reply) => new JSDOM(await reply.whole, { url: href, runScripts: "outside-only" }),
        )
      : Promise.reject(new Error("the page double loads a frame over HTTP only"));
    dom.catch(() => {});
    this.#frameDocuments.set(frame, { href, dom });
    return dom;
  }

  // ---------------------------------------------------------------------------
  // typeInWindow, waitForTurn and sendInComposer: the focus and the keyboard.
  // The browser's rules kept for them:
  //   - a press moves the focus to the pressed element when it takes the focus
  //     (a field, a control, a link, or an element whose content is editable),
  //     and away from any other otherwise; a new document has it on nothing;
  //   - the keyboard types into the element that has the focus when it takes
  //     text: a text field that is neither disabled nor read-only, or an element
  //     whose content is editable (`contenteditable` other than "false"). The
  //     text goes in at the selection, in place of what the selection holds, or
  //     at the end of the element's text when the selection is elsewhere, and
  //     the element reports `input`. A browser types key by key and reports each
  //     key; the double types the whole text at once and reports it once;
  //   - Backspace deletes what the selection holds, or the last character of
  //     the text when the caret is at its end; Escape closes the open lists of
  //     the shared select (see pressEscape); no other key is pressed here;
  //   - text typed into a window's box, and a press on a window's send control,
  //     run the page's own handlers for them: the same two functions the page's
  //     inline script runs in a browser (see fixture-app-windows.mjs).
  // ---------------------------------------------------------------------------

  #focused = null;

  /** The keyboard: text typed, and Backspace pressed, into the element that has the focus; Escape pressed on the page. */
  keyboard = {
    type: async (text) => {
      // The page's keyboard types into the frame that has the focus.
      const inner = this.#focusedFrame();
      if (inner) return inner.keyboard.type(text);
      this.#acted();
      this.#typeText(String(text));
    },
    press: async (key) => {
      const inner = this.#focusedFrame();
      if (inner) return inner.keyboard.press(key);
      this.#acted();
      this.#pressKey(String(key));
    },
  };

  /** The frame the focus stands in, while it stands in its page. */
  #focusedFrame() {
    const inner = this.#inFrame;
    return inner && !inner.#detached() ? inner : null;
  }

  #focus(element) {
    const focusable = element.matches("a[href], button, input, select, textarea, [tabindex]") || PageDouble.#takesText(element);
    this.#focused = focusable ? element : null;
    // A press in a frame moves the page's focus into that frame; a press in the page itself out of any.
    this.#top.#inFrame = this.#owner === null ? null : this;
  }

  /** Whether `element` takes text typed into it. */
  static #takesText(element) {
    if (!element || !element.isConnected) return false;
    if (element.localName === "input" || element.localName === "textarea") return !element.disabled && !element.readOnly;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const editable = node.getAttribute("contenteditable");
      if (editable !== null) return editable.toLowerCase() !== "false";
    }
    return false;
  }

  /** The element the keyboard types into: the one that has the focus, in the current document, when it takes text. */
  #typingTarget() {
    const element = this.#focused;
    return element && element.ownerDocument === this.#dom.window.document && PageDouble.#takesText(element) ? element : null;
  }

  /** The selection's range when it lies inside `element`, else a caret at the end of its text. */
  static #rangeIn(element) {
    const document = element.ownerDocument;
    const selection = document.defaultView.getSelection();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (range && element.contains(range.startContainer) && element.contains(range.endContainer)) return range;
    const end = document.createRange();
    end.selectNodeContents(element);
    end.collapse(false);
    return end;
  }

  #typeText(text) {
    const element = this.#typingTarget();
    if (!element || text === "") return;
    const window = element.ownerDocument.defaultView;
    if (element.localName === "input" || element.localName === "textarea") {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      element.value = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`;
      element.setSelectionRange(start + text.length, start + text.length);
    } else {
      const range = PageDouble.#rangeIn(element);
      range.deleteContents();
      const node = element.ownerDocument.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    this.#typed(element);
  }

  #pressKey(key) {
    if (key === "Escape") {
      pressEscape(this.#dom.window.document);
      return;
    }
    if (key !== "Backspace") throw new Error(`the page double presses Backspace and Escape only, not ${key}`);
    const element = this.#typingTarget();
    if (!element) return;
    const window = element.ownerDocument.defaultView;
    if (element.localName === "input" || element.localName === "textarea") {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      const from = start === end ? Math.max(0, start - 1) : start;
      element.value = `${element.value.slice(0, from)}${element.value.slice(end)}`;
      element.setSelectionRange(from, from);
    } else {
      const range = PageDouble.#rangeIn(element);
      if (!range.collapsed) {
        range.deleteContents();
      } else {
        const walker = element.ownerDocument.createTreeWalker(element, 4 /* text nodes */);
        let last = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue !== "") last = node;
        if (last) last.deleteData(last.nodeValue.length - 1, 1);
      }
    }
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    this.#typed(element);
  }
}

/** The locator calls the steps make: count, the visible filter, first, an attribute, fill and click (with its modifiers). */
class LocatorDouble {
  #page;
  #selector;
  #options;

  constructor(page, selector, options) {
    this.#page = page;
    this.#selector = selector;
    this.#options = options;
  }

  filter({ visible } = {}) {
    return new LocatorDouble(this.#page, this.#selector, { ...this.#options, visible: visible === true });
  }

  first() {
    return new LocatorDouble(this.#page, this.#selector, { ...this.#options, first: true });
  }

  async count() {
    return this.#matches().length;
  }

  async getAttribute(name, { timeout = 30_000 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const found = this.#matches();
      if (found.length > 1) throw new Error(`strict mode violation: ${this.#selector} resolved to ${found.length} elements`);
      if (found.length === 1) return found[0].getAttribute(name);
      if (Date.now() >= until) throw new TimeoutError(`locator.getAttribute: Timeout ${timeout}ms exceeded.`);
      await pause(20);
    }
  }

  async setInputFiles(files, { timeout = 30_000 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const found = this.#matches();
      if (found.length > 1) throw new Error(`strict mode violation: ${this.#selector} resolved to ${found.length} elements`);
      if (found.length === 1) return this.#page.setInputFilesOn(found[0], files);
      if (Date.now() >= until) throw new TimeoutError("locator.setInputFiles: Timeout exceeded");
      await pause(20);
    }
  }

  async fill(value, { timeout = 30_000 } = {}) {
    const element = await this.#one(timeout, `locator.fill: Timeout ${timeout}ms exceeded.\nCall log:\n  - fill("${value}")`);
    this.#page.acted();
    const window = element.ownerDocument.defaultView;
    if (LocatorDouble.#editable(element)) {
      // An element whose content is editable takes the value as its text, as Playwright's fill sets it.
      element.textContent = value;
      element.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      this.#page.typed(element);
      return;
    }
    element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
    this.#page.typed(element);
  }

  /** Whether `element` is no field but an element whose content is editable. */
  static #editable(element) {
    if (["input", "textarea", "select"].includes(element.localName)) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const editable = node.getAttribute("contenteditable");
      if (editable !== null) return editable.toLowerCase() !== "false";
    }
    return false;
  }

  /** A handle on the one attached element: its frame, when it is a frame element. */
  async elementHandle({ timeout = 30_000 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const found = this.#matches();
      if (found.length > 1) throw new Error(`strict mode violation: ${this.#selector} resolved to ${found.length} elements`);
      if (found.length === 1) return this.#page.handle(found[0]);
      if (Date.now() >= until) throw new TimeoutError(`locator.elementHandle: Timeout ${timeout}ms exceeded.`);
      await pause(20);
    }
  }

  async click({ timeout = 30_000, modifiers = [] } = {}) {
    const element = await this.#one(timeout, `locator.click: Timeout ${timeout}ms exceeded.`);
    this.#page.acted();
    this.#page.focus(element);
    this.#page.press(element, modifiers);
  }

  #matches() {
    const all = deepQueryAll(this.#page.document(), this.#selector);
    const kept = this.#options.visible ? all.filter(isVisible) : all;
    return this.#options.first ? kept.slice(0, 1) : kept;
  }

  async #one(timeout, timeoutMessage) {
    const until = Date.now() + timeout;
    for (;;) {
      const found = this.#matches();
      if (found.length > 1) throw new Error(`strict mode violation: ${this.#selector} resolved to ${found.length} elements`);
      if (found.length === 1 && isVisible(found[0]) && !found[0].disabled) return found[0];
      if (Date.now() >= until) throw new TimeoutError(timeoutMessage);
      await pause(20);
    }
  }

  // readRows, the landing of signInThroughPage, dispatchRun, press and
  // selectFrom: the two calls selectFrom makes on the page's own controls, with a
  // browser's rules. A select takes an option by its place and announces the
  // change; a radio is checked by its own press, which unchecks the others of its
  // group and announces the change.
  async selectOption(value, { timeout = 30_000 } = {}) {
    const element = await this.#one(timeout, `locator.selectOption: Timeout ${timeout}ms exceeded.`);
    this.#page.acted();
    if (element.localName !== "select") throw new Error("locator.selectOption: Element is not a <select> element");
    const index = value && typeof value === "object" ? value.index : undefined;
    if (!Number.isInteger(index) || !element.options[index]) throw new Error("locator.selectOption: did not find some options");
    const window = element.ownerDocument.defaultView;
    element.selectedIndex = index;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
    return [element.options[index].value];
  }

  async check({ timeout = 30_000 } = {}) {
    const element = await this.#one(timeout, `locator.check: Timeout ${timeout}ms exceeded.`);
    this.#page.acted();
    if (element.localName !== "input" || !["radio", "checkbox"].includes(element.type)) throw new Error("locator.check: Not a checkbox or radio button");
    if (!element.checked) element.click();
    if (!element.checked) throw new Error("locator.check: Clicking the checkbox did not change its state");
  }
}
