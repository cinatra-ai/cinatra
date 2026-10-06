// openPageInOwnContext: a further page opened in a browser context of its own,
// signed in by the session the first page carries. The context has its own
// connections, so a first page whose streams take every connection of the
// origin does not starve it; the step opens only what a visible link of the
// current page leads to, refuses a landing on the sign-in page, and its line
// names paths only, never a cookie, a storage value or an address.
import { readFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";
import { OWN_SESSION, OWN_STORAGE, OWN_STREAMS } from "./fixture-app-contexts.mjs";
import { LOOPBACK } from "./fixture-app.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ landingMs: 3000 });
const README = new URL("../README.md", import.meta.url);

/** Wait until the fixture app holds `count` streams, and a moment more for the context's own events. */
async function untilStreams(app, count) {
  for (let i = 0; i < 150 && app.standingStreams() !== count; i += 1) await pause(20);
  expect(app.standingStreams(), "the fixture app does not hold the streams the page opened").toBe(count);
  await pause(50);
}

/** `target`, as a page whose every property read is noted in `touched`. */
function watched(target, touched) {
  return new Proxy(target, {
    get(object, name) {
      touched.push(String(name));
      const value = Reflect.get(object, name);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/** `page`, as a page whose context has no browser, as a persistent context has none. */
function withoutBrowser(page) {
  const bound = (object, name) => {
    const value = Reflect.get(object, name);
    return typeof value === "function" ? value.bind(object) : value;
  };
  return new Proxy(page, {
    get(object, name) {
      if (name !== "context") return bound(object, name);
      return () => new Proxy(object.context(), { get: (context, key) => (key === "browser" ? () => null : bound(context, key)) });
    },
  });
}

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`openPageInOwnContext [${labelOf(backend)}]`, () => {
    /** The first page, signed in by the fixture's session cookie, on `path`. */
    const signedIn = async (page, app, path = "/own/start") => {
      await page.context().addCookies([{ name: OWN_SESSION.name, value: OWN_SESSION.value, url: app.origin }]);
      await page.goto(`${app.origin}${path}`);
      expect(new URL(page.url()).pathname, "the first page is not signed in").toBe(path);
      return theSteps("openPageInOwnContext").openPageInOwnContext;
    };
    const contextsOf = (page) => page.context().browser().contexts().length;
    const visits = (app, path) => app.requests.filter((r) => r.path === path);
    const LINE = /^openPageInOwnContext: landed on \/own\/target from \/own\/start after \d+ ms in a page that stands in a browser context of its own \(0 standing requests on its origin there\)$/;

    it("lands signed in by the session the first page carries, sends no sign-in, and loads the address the link leads to", async () => {
      await scene(backend, { secrets: [OWN_SESSION.value] }, async ({ app, page, record, lines }) => {
        await page.setViewportSize({ width: 900, height: 640 });
        const openPageInOwnContext = await signedIn(page, app);
        const before = contextsOf(page);
        const result = await openPageInOwnContext(page, { path: "/own/target", record, bounds: BOUNDS });
        try {
          expect(Object.keys(result)).toEqual(["path", "from", "elapsedMs", "furtherPage", "standing"]);
          expect(result).toMatchObject({ path: "/own/target", from: "/own/start" });
          expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
          const further = result.furtherPage;
          expect(new URL(further.url()).pathname).toBe("/own/target");
          expect(await further.evaluate(() => document.querySelector("h1").textContent)).toBe("Signed in");
          expect(further.context(), "the further page stands in the first page's context").not.toBe(page.context());
          expect(further.context().browser()).toBe(page.context().browser());
          expect(contextsOf(page)).toBe(before + 1);
          // The session went with the new context: nothing signed in, and the sign-in page was never loaded.
          expect(app.signInRequests()).toEqual([]);
          expect(visits(app, "/sign-in")).toEqual([]);
          // The address the link leads to, its query string included, and nothing typed in its place.
          expect(visits(app, "/own/target").map((r) => r.query)).toEqual([["from"]]);
          expect(further.viewportSize(), "the new context was made with another viewport").toEqual({ width: 900, height: 640 });
          expect(new URL(page.url()).pathname, "the first page moved").toBe("/own/start");
          expect(page.context().pages()).toEqual([page]);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(LINE);
        } finally {
          await result.furtherPage.context().close();
        }
      });
    });

    it("holds connections of its own: with every connection of the first context taken by streams, the further page still loads", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await readStandingRequests(page.context(), { record: () => {} });
        const openPageInOwnContext = await signedIn(page, app, "/own/streams");
        await untilStreams(app, OWN_STREAMS);
        // The first context's connections to the origin are all taken: a page of its own waits for one and never loads.
        const probe = await page.context().newPage();
        const waited = await refusal(probe.goto(`${app.origin}/own/target`, { timeout: 800 }));
        expect(waited.name, "a page of the first context loaded beside its streams").toBe("TimeoutError");
        await probe.close();
        const first = await readStandingRequests(page.context(), { record: () => {} });
        expect(first.origins.find((origin) => origin.origin === app.origin).standing).toBeGreaterThanOrEqual(OWN_STREAMS);

        const result = await openPageInOwnContext(page, { path: "/own/target", record, bounds: BOUNDS });
        try {
          expect(new URL(result.furtherPage.url()).pathname).toBe("/own/target");
          // The answer's reading is the new context's own: its page is known from its first request, and nothing stands there.
          expect(result.standing.unknown).toEqual([]);
          expect(result.standing.origins.find((origin) => origin.origin === app.origin)).toMatchObject({ standing: 0, holders: [] });
          const again = await readStandingRequests(result.furtherPage.context(), { record: () => {} });
          expect(again.unknown, "the new page was open before the new context's first reading").toEqual([]);
          expect(app.standingStreams(), "the first page's streams were ended").toBe(OWN_STREAMS);
        } finally {
          await result.furtherPage.context().close();
        }
      });
    });

    it("refuses a landing on the sign-in page, and closes the context it opened", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { openPageInOwnContext } = theSteps("openPageInOwnContext");
        await page.goto(`${app.origin}/own/public`);
        const before = contextsOf(page);
        const error = await refusal(openPageInOwnContext(page, { path: "/own/target", record, bounds: BOUNDS }));
        expect(error.name).toBe("StepRefusal");
        expect(error.kind).toBe("session-lost");
        expect(error.message).toBe(
          "openPageInOwnContext refused (session-lost): the page in a browser context of its own landed on the sign-in page /sign-in, " +
            "not on /own/target: the session of the page on /own/public did not sign it in, and its context was closed",
        );
        expect(lines).toEqual([error.message]);
        expect(contextsOf(page), "the context the step opened was left open").toBe(before);
        expect(visits(app, "/sign-in")).toHaveLength(1);
        expect(app.signInRequests()).toEqual([]);
        expect(new URL(page.url()).pathname).toBe("/own/public");
      });
    });

    it("refuses a landing on another path within the bound, and closes the context it opened", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const openPageInOwnContext = await signedIn(page, app);
        const before = contextsOf(page);
        const error = await refusal(openPageInOwnContext(page, { path: "/own/moves", record, bounds: { landingMs: 800 } }));
        expect(error.kind).toBe("landed-elsewhere");
        expect(error.message).toBe(
          "openPageInOwnContext refused (landed-elsewhere): the page in a browser context of its own did not land on /own/moves within 800 ms " +
            "(it was on /own/elsewhere), and its context was closed",
        );
        expect(lines).toEqual([error.message]);
        expect(contextsOf(page)).toBe(before);
      });
    });

    for (const [path, what] of [
      ["/own/nowhere", "no link at all"],
      ["/own/hidden", "a link that is not visible"],
    ]) {
      it(`refuses by name when the only road is ${what}, and opens no context`, async () => {
        await scene(backend, {}, async ({ app, page, record, lines }) => {
          const openPageInOwnContext = await signedIn(page, app);
          const before = contextsOf(page);
          const error = await refusal(openPageInOwnContext(page, { path, record, bounds: BOUNDS }));
          expect(error.kind).toBe("no-link");
          expect(error.message).toBe(
            `openPageInOwnContext refused (no-link): no visible link on /own/start leads to ${path} (0 of the 2 visible links on the page) — no context was opened`,
          );
          expect(lines).toEqual([error.message]);
          expect(contextsOf(page)).toBe(before);
          expect(visits(app, path), "the step reached the page some other way").toEqual([]);
        });
      });
    }

    it("refuses its arguments before the page is touched", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const openPageInOwnContext = await signedIn(page, app);
        const before = app.requests.length;
        const contexts = contextsOf(page);
        const PATH_ONLY = "name the page by its path alone, such as /chat — nothing was opened";
        const cases = [
          [{ record }, PATH_ONLY],
          [{ record, path: 42 }, PATH_ONLY],
          [{ record, path: "own/target" }, PATH_ONLY],
          [{ record, path: "//elsewhere/own/target" }, PATH_ONLY],
          [{ record, path: "/own/target?from=start" }, PATH_ONLY],
          [{ record, path: "/own/target#top" }, PATH_ONLY],
          [{ record, path: "/own target" }, PATH_ONLY],
          [{ record, path: "/sign-in" }, "the sign-in page is signInThroughPage's, and this step carries a session — nothing was opened"],
          [{ record, path: "/own/target", bounds: { landingMs: 0 } }, "landingMs must be a positive number of milliseconds — nothing was opened"],
          [{ record, path: "/own/target", bounds: { readingMs: -1 } }, "readingMs must be a positive number of milliseconds — nothing was opened"],
          [{ record, path: "/own/target", bounds: { actionMs: 5 } }, "there is no bound named actionMs — nothing was opened"],
        ];
        for (const [options, reason] of cases) {
          const touched = [];
          const error = await refusal(openPageInOwnContext(watched(page, touched), options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`openPageInOwnContext refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
          expect(touched, "the step touched the page before it refused its arguments").toEqual([]);
        }
        const unrecorded = await refusal(openPageInOwnContext(page, { path: "/own/target" }));
        expect(unrecorded.message).toBe("openPageInOwnContext refused (input): hand the step a record callback — nothing was done");
        expect(app.requests.length, "a refused call loaded something").toBe(before);
        expect(contextsOf(page), "a refused call opened a context").toBe(contexts);
      });
    });

    it("refuses a page whose context has no browser to open a context of its own from", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const openPageInOwnContext = await signedIn(page, app);
        const before = contextsOf(page);
        const error = await refusal(openPageInOwnContext(withoutBrowser(page), { path: "/own/target", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-browser");
        expect(error.message).toBe(
          "openPageInOwnContext refused (no-browser): the context of the page on /own/start has no browser to open a context of its own from — no context was opened",
        );
        expect(lines).toEqual([error.message]);
        expect(contextsOf(page)).toBe(before);
        expect(visits(app, "/own/target")).toEqual([]);
      });
    });

    it("carries the storage too, and its line names paths only: no cookie, no storage value, no address and no query string", async () => {
      await scene(backend, { secrets: [OWN_SESSION.value, OWN_STORAGE.value] }, async ({ app, page, record, lines }) => {
        const openPageInOwnContext = await signedIn(page, app);
        await page.evaluate(([key, value]) => localStorage.setItem(key, value), [OWN_STORAGE.name, OWN_STORAGE.value]);
        const result = await openPageInOwnContext(page, { path: "/own/target", record, bounds: BOUNDS });
        try {
          expect(await result.furtherPage.evaluate((key) => localStorage.getItem(key), OWN_STORAGE.name), "the storage stayed behind").toBe(OWN_STORAGE.value);
          const cookies = await result.furtherPage.context().cookies();
          expect(cookies.map((cookie) => cookie.name)).toContain(OWN_SESSION.name);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(LINE);
          const written = lines.join("\n");
          for (const kept of [OWN_SESSION.value, OWN_SESSION.name, OWN_STORAGE.value, LOOPBACK, "from=start", "?", "http"]) {
            expect(written.includes(kept), `the line carries ${kept.slice(0, 12)}`).toBe(false);
          }
        } finally {
          await result.furtherPage.context().close();
        }
      });
    });
  });
}

describe("openPageInOwnContext on the steps' surface", () => {
  it("offers the step and its named bounds", () => {
    const steps = theSteps("openPageInOwnContext");
    expect(steps.OWN_CONTEXT_LANDING_BOUND_MS).toBe(120_000);
    expect(steps.OWN_CONTEXT_BOUNDS).toEqual({ landingMs: steps.OWN_CONTEXT_LANDING_BOUND_MS, readingMs: steps.READING_BOUND_MS });
  });

  it("is listed in the README's table of steps, with a section that names its refusals", () => {
    const readme = readFileSync(README, "utf8");
    expect(readme).toMatch(/^\| `openPageInOwnContext` \| .+ \|$/m);
    const section = readme.split("\n## ").find((part) => part.startsWith("`openPageInOwnContext("));
    expect(section, "the README has no section for openPageInOwnContext").toBeDefined();
    for (const kind of ["input", "no-link", "unreadable", "no-browser", "driver-failure", "session-lost", "landed-elsewhere"]) {
      expect(section).toContain(`\`${kind}\``);
    }
  });
});
