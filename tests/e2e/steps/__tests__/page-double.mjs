// A page double for the step tests: the parts of Playwright's `Page` the steps
// use, speaking real HTTP to the fixture app, with each document built by jsdom.
//
// It keeps a browser's rules for exactly what the steps do with a page:
//   - a navigation is a real request to the fixture app; every request is
//     announced to the page's request listeners before it is routed, and routes
//     run last-registered first and may abort a request before it leaves;
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
// its document with timers, as the page's inline script does in a browser.
// Inline scripts never run here.
import { JSDOM } from "jsdom";

import { EMAIL_ROUTE, USERNAME_ROUTE } from "./fixture-app.mjs";

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

/** Visible, as far as a document without layout can tell: attached, and no `hidden` or inline `display: none` on the way up. */
function isVisible(element) {
  if (!element.isConnected) return false;
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    if (/display\s*:\s*none/i.test(node.getAttribute("style") ?? "")) return false;
  }
  return true;
}

export class PageDouble {
  #origin;
  #href = "about:blank";
  #dom;
  #navigating = 0;
  #routes = [];
  #requestListeners = [];
  #timers = new Set();
  #closed = false;

  constructor(origin) {
    this.#origin = origin;
    this.#dom = this.#build("about:blank", "<!doctype html><html><body></body></html>");
  }

  url() {
    return this.#href;
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
        press: (element) => this.#press(element),
      },
      selector,
      {},
    );
  }

  async close() {
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
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

  /** A document for `html`, with the behaviour the page declares scheduled on it. */
  #build(href, html) {
    const dom = new JSDOM(html, { url: /^https?:/.test(href) ? href : "about:blank", runScripts: "outside-only" });
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

  #commit(href, html) {
    const previous = this.#dom;
    this.#href = href;
    this.#dom = this.#build(href, html);
    previous.window.close();
  }

  #play(dom, op) {
    if (this.#dom !== dom) return;
    if (op.reload) {
      this.#navigate("GET", this.#href, null).catch(() => {});
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
        this.#send("POST", new URL(route, this.#origin).href, JSON.stringify(payload), false).catch(() => {});
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

  #press(element) {
    if (element.localName === "a" && element.hasAttribute("href")) {
      // A link that opens another tab leaves this page where it is.
      if (element.getAttribute("target") === "_blank") return;
      this.#navigate("GET", new URL(element.getAttribute("href"), this.#href).href, null).catch(() => {});
      return;
    }
    const form = element.form;
    if (element.localName === "button" && (element.getAttribute("type") ?? "submit") === "submit" && form) {
      const window = element.ownerDocument.defaultView;
      const event = new window.Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      if (!event.defaultPrevented) this.#nativeSubmit(form);
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
      this.#commit(sent.url, sent.text);
      return { status: () => sent.status, url: () => sent.url };
    } finally {
      this.#navigating -= 1;
    }
  }

  async #send(method, href, body, navigation) {
    let answered;
    const answer = new Promise((done) => {
      answered = done;
    });
    const request = {
      url: () => href,
      method: () => method,
      isNavigationRequest: () => navigation,
      response: () => answer,
    };
    for (const listener of [...this.#requestListeners]) listener(request);
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
        return { aborted: true };
      }
      if (verdict === "continue") break;
    }
    const headers = body === null ? {} : { "content-type": navigation ? "application/x-www-form-urlencoded" : "application/json" };
    let response;
    try {
      response = await fetch(href, { method, body: body ?? undefined, headers, redirect: navigation ? "follow" : "manual" });
    } catch (error) {
      answered(null);
      throw error;
    }
    const text = await response.text();
    answered({ status: () => response.status });
    return { aborted: false, status: response.status, url: response.url, text };
  }
}

/** The locator calls the steps make: count, the visible filter, first, fill and click. */
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
  }

  async click({ timeout = 30_000 } = {}) {
    const element = await this.#one(timeout, `locator.click: Timeout ${timeout}ms exceeded.`);
    this.#page.press(element);
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
}
