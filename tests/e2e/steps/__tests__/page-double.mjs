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
//   - a press on a link the page's own handler takes over plays that handler: it
//     cancels the press, or opens a dialog or a panel in place, or requests the
//     page from the app and, once the app has answered, moves the address
//     without a new document, as a client-side router does;
//   - a list drawn as the shared select draws it hides everything outside it
//     from assistive technology while it is open, as the select's library does,
//     and a press on one of its entries takes the entry, closes the list and
//     shows the page again (see hideOthers);
//   - a press on a checkbox, a radio or a switch the page draws itself plays the
//     page's handler for it, which flips its checked state;
//   - text filled into a search field, and a press on an entry of its list, run
//     the page's own handlers for them: the same two functions the page's inline
//     script runs in a browser (see typeInSearchField in fixture-app.mjs);
//   - a page has one frame, its main frame, and every request is made in it;
//   - an in-page function is rebuilt from its SOURCE inside the document's own
//     realm, as a browser receives it, so nothing of the step's module reaches it,
//     and its argument and its answer cross as JSON;
//   - a reading taken while a navigation is in flight throws, as a destroyed
//     execution context does in a browser;
//   - a submit event runs the app's handler on the form first and the window's
//     listeners after it, and, when nobody cancelled it, the form submits
//     natively: its fields leave in a query string or a form body;
//   - a failed fill repeats the value it was given to fill in its message, as
//     Playwright's own call log does, so a step that forwards that message fails
//     these cases.
// The page's declared behaviour (the JSON each fixture page carries) is played on
// its document with timers, as the page's inline script does in a browser: a
// stream it opens stays open, and while its main thread is declared busy, a
// reading waits. Inline scripts never run here.
import { connect, constants } from "node:http2";

import { JSDOM } from "jsdom";

import { EMAIL_ROUTE, USERNAME_ROUTE, pressSearchEntry, typeInSearchField } from "./fixture-app.mjs";

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
async function transfer(sessionOf, href, { method, body, headers, follow }) {
  if (new URL(href).protocol === "http:") {
    const controller = new AbortController();
    const response = await fetch(href, {
      method,
      body: body ?? undefined,
      headers,
      redirect: follow ? "follow" : "manual",
      signal: controller.signal,
    });
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
    return { status: response.status, url: response.url, protocol: "http/1.1", head, whole, cancel: () => controller.abort() };
  }
  const session = await sessionOf(new URL(href).origin);
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

/** A browser context: its open pages, and the request events of all of them. */
export class ContextDouble {
  #origin;
  #pages = [];
  #listeners = new Map();
  #sessions = new Map();

  constructor(origin) {
    this.#origin = origin;
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
      transfer: (href, options) => transfer(this[INNER].session, href, options),
    };
  }

  pages() {
    return [...this.#pages];
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
    for (const page of this.pages()) await page.close();
    for (const session of this.#sessions.values()) (await session.catch(() => null))?.destroy();
    this.#sessions.clear();
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

/**
 * An entry pressed in such a list is taken: the list closes, the combobox that
 * controls it shows the entry, and every element the list hid is shown again.
 */
function chooseEntry(entry) {
  const document = entry.ownerDocument;
  const list = entry.closest("[role='listbox']");
  if (!list) return;
  list.setAttribute("hidden", "");
  for (const node of document.querySelectorAll(`[${HIDDEN_MARKER}]`)) {
    node.removeAttribute("aria-hidden");
    node.removeAttribute(HIDDEN_MARKER);
  }
  const picker = document.querySelector(`[aria-controls="${list.id}"]`);
  if (!picker) return;
  picker.textContent = entry.textContent;
  picker.removeAttribute("data-placeholder");
  picker.setAttribute("aria-expanded", "false");
}

export class PageDouble {
  #origin;
  #context;
  #frame = { page: () => this };
  #href = "about:blank";
  #dom;
  #navigating = 0;
  #routes = [];
  #requestListeners = [];
  #timers = new Set();
  #closed = false;
  #streams = new Set();
  #entries = new WeakMap();
  #busyUntil = new WeakMap();

  /** Opened by its context: `context.newPage()`. */
  constructor(origin, context) {
    this.#origin = origin;
    this.#context = context;
    this.#dom = this.#build("about:blank", "<!doctype html><html><body></body></html>", null, 0);
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
  }

  off(event, listener) {
    this.#requestListeners = this.#requestListeners.filter((l) => l !== listener);
  }

  async evaluate(fn, arg) {
    // A page whose main thread is busy answers once it is free again.
    const busy = (this.#busyUntil.get(this.#dom) ?? 0) - Date.now();
    if (busy > 0) await pause(busy);
    if (this.#navigating > 0 || this.#closed) throw new Error(DESTROYED);
    const inPage = this.#dom.window.eval(`(${fn.toString()})`);
    return viaJson(await inPage(viaJson(arg)));
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
      },
      selector,
      {},
    );
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#endStreams(null, "closed");
    this.#context[INNER].forget(this);
    this.#dom.window.close();
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
    const entries = /^https?:/.test(href)
      ? [{ name: href, entryType: "navigation", nextHopProtocol: protocol ?? "", startTime: 0, responseEnd }]
      : [];
    this.#entries.set(dom, entries);
    Object.defineProperty(dom.window.performance, "getEntriesByType", {
      value: (type) => entries.filter((entry) => entry.entryType === type).map((entry) => ({ ...entry })),
    });
    const declared = (id) => {
      const node = dom.window.document.getElementById(id);
      return node ? JSON.parse(node.textContent) : null;
    };
    for (const op of declared("fixture-timeline") ?? []) this.#later(() => this.#play(dom, op), op.at);
    const scenario = declared("fixture-scenario");
    if (scenario && scenario.hydrateAfterMs !== null) {
      this.#later(() => this.#hydrate(dom, scenario), scenario.hydrateAfterMs);
    }
    return dom;
  }

  #commit(href, html, protocol = null, elapsedMs = 0, streaming = null) {
    const previous = this.#dom;
    this.#href = href;
    this.#dom = this.#build(href, html, protocol, streaming ? 0 : Math.max(1, elapsedMs));
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

  /** Text filled into a field: the page's handler for a search field opens its list and answers the search. */
  #typed(element) {
    if (!element.hasAttribute("data-fixture-searches")) return;
    const document = element.ownerDocument;
    typeInSearchField(element, (run, ms) =>
      this.#later(() => {
        if (this.#dom.window.document === document) run();
      }, ms),
    );
  }

  #press(element, modifiers) {
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
        chooseEntry(element);
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
        // and moves the address once the app has answered: the document stays.
        const dom = this.#dom;
        this.#send("GET", href, null, false).then(
          () => {
            if (this.#closed || this.#dom !== dom) return;
            this.#href = href;
            dom.reconfigure({ url: href });
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
    for (const listener of [...this.#requestListeners]) listener(request);
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
    for (const listener of [...this.#requestListeners]) listener(request);
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
  //     `input` and `change`;
  //   - a fill sets the value and reports `input` and `change`;
  //   - a frame's document is loaded from the app the first time it is read and
  //     again once its address has changed, and that load is not announced: no
  //     step listens for a frame's requests.
  // A page's declared behaviour (`fixture-behaviour`, see fixture-app-controls.mjs)
  // is played here on its document, as its inline script plays it in a browser.
  // ---------------------------------------------------------------------------

  #chooserWaiters = [];
  #frameDocuments = new WeakMap();

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
        this.#pressControl(await one(timeout, `locator.click: Timeout ${timeout}ms exceeded.`, true));
      },
      fill: async (value, { timeout = 30_000 } = {}) => {
        const element = await one(timeout, `locator.fill: Timeout ${timeout}ms exceeded.\nCall log:\n  - fill("${value}")`, true);
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

  /** Files handed to a chooser: read, set on its input, reported, and handed to the page's handler. */
  async #setFiles(input, files) {
    const [{ readFile }, { basename }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const chosen = await Promise.all(
      (Array.isArray(files) ? files : [files]).map(async (file) =>
        typeof file === "string" ? { name: basename(file), mimeType: "application/octet-stream", buffer: await readFile(file) } : file,
      ),
    );
    if (!input.isConnected || this.#closed) throw new Error("Element is not attached to the DOM");
    const document = input.ownerDocument;
    const window = document.defaultView;
    const list = chosen.map((file) => new window.File([file.buffer], file.name, { type: file.mimeType }));
    const fileList = Object.assign(Object.fromEntries(list.map((file, at) => [at, file])), { length: list.length, item: (at) => list[at] ?? null });
    Object.defineProperty(input, "files", { configurable: true, get: () => fileList });
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    for (const op of this.#declared(document)) {
      if (op.chosen && input.matches(op.chosen)) this.#playChosen(document, op, chosen);
    }
  }

  #playChosen(document, op, chosen) {
    const dom = this.#dom;
    for (const file of chosen) {
      this.#send("POST", new URL(op.upload, this.#href).href, file.buffer, false).then(
        (sent) =>
          this.#later(() => {
            if (this.#dom !== dom) return;
            if (sent.status >= 200 && sent.status < 300) {
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
}

/** The locator calls the steps make: count, the visible filter, first, fill and click (with its modifiers). */
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

  async fill(value, { timeout = 30_000 } = {}) {
    const element = await this.#one(timeout, `locator.fill: Timeout ${timeout}ms exceeded.\nCall log:\n  - fill("${value}")`);
    element.value = value;
    const window = element.ownerDocument.defaultView;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
    this.#page.typed(element);
  }

  async click({ timeout = 30_000, modifiers = [] } = {}) {
    const element = await this.#one(timeout, `locator.click: Timeout ${timeout}ms exceeded.`);
    this.#page.press(element, modifiers);
  }

  #matches() {
    const all = Array.from(this.#page.document().querySelectorAll(this.#selector));
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
    if (element.localName !== "input" || !["radio", "checkbox"].includes(element.type)) throw new Error("locator.check: Not a checkbox or radio button");
    if (!element.checked) element.click();
    if (!element.checked) throw new Error("locator.check: Clicking the checkbox did not change its state");
  }
}
