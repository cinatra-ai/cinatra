// navigateTo: reaching a page through the product's own navigation, never by
// typing its address, and recording where the press landed. With `furtherPage`
// it opens the page in a further page, once it has read that the requests
// standing open on the origin leave a connection for a load and one for a press.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ actionMs: 2000, landingMs: 3000 });
const UNSEEN = "open before the first reading, so its earlier requests were not seen";

/** Wait until the fixture app holds `count` streams, and a moment more for the context's own events. */
async function untilStreams(app, count) {
  for (let i = 0; i < 150 && app.standingStreams() !== count; i += 1) await pause(20);
  expect(app.standingStreams(), "the fixture app does not hold the streams the pages opened").toBe(count);
  await pause(50);
}

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`navigateTo [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}/nav/start`);
      return theSteps("navigateTo").navigateTo;
    };
    const visits = (app, path) => app.requests.filter((r) => r.path === path);
    // The first reading on the context: from here on, every request of its pages is seen.
    const firstReading = (page) => theSteps("readStandingRequests").readStandingRequests(page.context(), { record: () => {} });

    it("reaches the page through its own link and records the landing by path", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const navigateTo = await start(page, app);
        const result = await navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS });
        expect(result).toMatchObject({ path: "/nav/target", from: "/nav/start", pressed: true });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(new URL(page.url()).pathname).toBe("/nav/target");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^navigateTo: landed on \/nav\/target from \/nav\/start after \d+ ms$/);
        // The link carries a query string; a line carries the path alone.
        expect(lines[0]).not.toContain("from=start");
      });
    });

    it("presses nothing when the page is already the one named", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { navigateTo } = theSteps("navigateTo");
        await page.goto(`${app.origin}/nav/target?from=elsewhere`);
        const before = app.requests.length;
        const result = await navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS });
        expect(result).toEqual({ path: "/nav/target", from: "/nav/target", pressed: false, elapsedMs: 0 });
        expect(lines).toEqual(["navigateTo: already on /nav/target — nothing pressed"]);
        expect(app.requests.length).toBe(before);
      });
    });

    for (const [path, what] of [
      ["/nav/hidden-only", "a link that is not visible"],
      ["/nav/new-tab", "a link that opens another tab"],
      ["/nav/nowhere", "no link at all"],
    ]) {
      it(`refuses by name when the only road is ${what}, and never types the address`, async () => {
        await scene(backend, {}, async ({ app, page, record, lines }) => {
          const navigateTo = await start(page, app);
          const error = await refusal(navigateTo(page, { path, record, bounds: BOUNDS }));
          expect(error.name).toBe("StepRefusal");
          expect(error.step).toBe("navigateTo");
          expect(error.kind).toBe("no-link");
          expect(error.message).toBe(`navigateTo refused (no-link): no visible link on /nav/start leads to ${path} — no address was typed`);
          expect(lines).toEqual([error.message]);
          expect(new URL(page.url()).pathname).toBe("/nav/start");
          expect(visits(app, path), "the step reached the page some other way").toEqual([]);
        });
      });
    }

    it("refuses by name a press that lands on another page", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const navigateTo = await start(page, app);
        const error = await refusal(navigateTo(page, { path: "/nav/redirect", record, bounds: { ...BOUNDS, landingMs: 800 } }));
        expect(error.kind).toBe("landed-elsewhere");
        expect(error.message).toBe(
          "navigateTo refused (landed-elsewhere): the press did not land on /nav/redirect within 800 ms (the page is on /nav/elsewhere)",
        );
      });
    });

    it("refuses by name a press whose page never arrives within the bound", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const navigateTo = await start(page, app);
        const error = await refusal(navigateTo(page, { path: "/nav/slow", record, bounds: { ...BOUNDS, landingMs: 800 } }));
        expect(error.kind).toBe("landed-elsewhere");
        expect(error.message).toBe(
          "navigateTo refused (landed-elsewhere): the press did not land on /nav/slow within 800 ms (the page is on /nav/start)",
        );
      });
    });

    it("presses nothing when it refuses its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const navigateTo = await start(page, app);
        const before = app.requests.length;
        const PATH_ONLY = "name the page by its path alone, such as /chat — nothing was pressed";
        const cases = [
          [{ record }, PATH_ONLY],
          [{ record, path: "nav/target" }, PATH_ONLY],
          [{ record, path: "//elsewhere/nav/target" }, PATH_ONLY],
          [{ record, path: "/nav/target?x=1" }, PATH_ONLY],
          [{ record, path: "/nav/target", bounds: { landingMs: 0 } }, "landingMs must be a positive number of milliseconds — nothing was pressed"],
          [{ record, path: "/nav/target", bounds: { clickMs: 5 } }, "there is no bound named clickMs — nothing was pressed"],
          [{ record, path: "/nav/target", furtherPage: "yes" }, "furtherPage must be true or false — nothing was pressed"],
          [
            { record, path: "/nav/target", furtherPage: true, standingBound: 0 },
            "standingBound must be a whole number of requests, at least 1 — nothing was pressed",
          ],
          [
            { record, path: "/nav/target", furtherPage: true, standingBound: 2.5 },
            "standingBound must be a whole number of requests, at least 1 — nothing was pressed",
          ],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(navigateTo(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`navigateTo refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(navigateTo(page, { path: "/nav/target" }));
        expect(unrecorded.message).toBe("navigateTo refused (input): hand the step a record callback — nothing was done");
        expect(app.requests.length, "a refused call pressed or loaded something").toBe(before);
        expect(new URL(page.url()).pathname).toBe("/nav/start");
      });
    });

    it("without furtherPage, on the same page, behaves as it did: the same press, result and line, and no reading", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { navigateTo, readStandingRequests } = theSteps("navigateTo", "readStandingRequests");
        await page.goto(`${app.origin}/stream/three`);
        const second = await page.context().newPage();
        await second.goto(`${app.origin}/stream/one`);
        await untilStreams(app, 4);
        const pressed = await navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS });
        expect(Object.keys(pressed)).toEqual(["path", "from", "pressed", "elapsedMs"]);
        expect(pressed).toMatchObject({ path: "/nav/target", from: "/stream/three", pressed: true });
        const unchanged = await navigateTo(second, { path: "/nav/target", record, bounds: BOUNDS, furtherPage: false });
        expect(Object.keys(unchanged)).toEqual(["path", "from", "pressed", "elapsedMs"]);
        expect(unchanged).toMatchObject({ path: "/nav/target", from: "/stream/one", pressed: true });
        const already = await navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS, standingBound: 1 });
        expect(already).toEqual({ path: "/nav/target", from: "/nav/target", pressed: false, elapsedMs: 0 });
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(/^navigateTo: landed on \/nav\/target from \/stream\/three after \d+ ms$/);
        expect(lines[1]).toMatch(/^navigateTo: landed on \/nav\/target from \/stream\/one after \d+ ms$/);
        expect(lines[2]).toBe("navigateTo: already on /nav/target — nothing pressed");
        expect(page.context().pages(), "a further page was opened").toHaveLength(2);
        // Nothing was read on the context yet: this first reading names both pages as open before it.
        const reading = await readStandingRequests(page.context(), { record: () => {} });
        expect(reading.unknown.map((unknown) => unknown.place)).toEqual([1, 2]);
      });
    });

    it("refuses a further page while four requests stand open on its origin, and opens it once a page is closed", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { navigateTo } = theSteps("navigateTo", "readStandingRequests");
        await firstReading(page);
        await page.goto(`${app.origin}/stream/one`);
        const second = await page.context().newPage();
        await second.goto(`${app.origin}/stream/three`);
        await untilStreams(app, 4);
        const error = await refusal(navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS, furtherPage: true }));
        expect(error.name).toBe("StepRefusal");
        expect(error.kind).toBe("standing-requests");
        expect(error.message).toBe(
          "navigateTo refused (standing-requests): 4 standing requests on the origin of /stream/one are at or above the bound of 4, " +
            "held by page 1 on /stream/one (1), page 2 on /stream/three (3) — close a page that is no longer needed; no further page was opened",
        );
        expect(lines).toEqual([error.message]);
        expect(page.context().pages(), "a further page was opened").toHaveLength(2);
        expect(visits(app, "/nav/target"), "the step reached the page some other way").toEqual([]);

        await second.close();
        const result = await navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS, furtherPage: true });
        expect(result).toMatchObject({ path: "/nav/target", from: "/stream/one", pressed: true, standing: { count: 1, bound: 4, counted: true } });
        expect(new URL(result.furtherPage.url()).pathname).toBe("/nav/target");
        expect(new URL(page.url()).pathname, "the current page moved").toBe("/stream/one");
        const pages = page.context().pages();
        expect(pages).toHaveLength(2);
        expect(pages[1]).toBe(result.furtherPage);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatch(
          /^navigateTo: landed on \/nav\/target in a further page from \/stream\/one after \d+ ms \(1 standing request on its origin, below the bound of 4\)$/,
        );
      });
    });

    it("does not count an origin served over HTTP/2: the further page opens beside four standing requests", async () => {
      await scene(backend, { secure: true }, async ({ app, page, record, lines }) => {
        const { navigateTo } = theSteps("navigateTo", "readStandingRequests");
        await firstReading(page);
        await page.goto(`${app.secureOrigin}/stream/one`);
        const second = await page.context().newPage();
        await second.goto(`${app.secureOrigin}/stream/three`);
        await untilStreams(app, 4);
        const result = await navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS, furtherPage: true });
        expect(result).toMatchObject({ path: "/nav/target", from: "/stream/one", pressed: true, standing: { count: 4, bound: 4, counted: false } });
        expect(result.furtherPage.url()).toBe(`${app.secureOrigin}/nav/target`);
        expect(page.context().pages()).toHaveLength(3);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          /^navigateTo: landed on \/nav\/target in a further page from \/stream\/one after \d+ ms \(4 standing requests on its origin, served over h2 and not counted\)$/,
        );
      });
    });

    it("refuses a further page while the standing requests of a page are unknown", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { navigateTo } = theSteps("navigateTo", "readStandingRequests");
        // The page loads before anything was read on the context, so what it sent was never seen.
        await page.goto(`${app.origin}/stream/one`);
        await untilStreams(app, 1);
        const error = await refusal(navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS, furtherPage: true }));
        expect(error.kind).toBe("standing-unknown");
        expect(error.message).toBe(
          "navigateTo refused (standing-unknown): 0 standing requests on the origin of /stream/one are below the bound of 4, " +
            `but the count is unknown: page 1 on /stream/one (${UNSEEN}) — no further page was opened`,
        );
        expect(lines).toEqual([error.message]);
        expect(page.context().pages()).toHaveLength(1);
        expect(visits(app, "/nav/target")).toEqual([]);
      });
    });

    it("takes the bound as an option", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { navigateTo } = theSteps("navigateTo", "readStandingRequests");
        await firstReading(page);
        await page.goto(`${app.origin}/stream/one`);
        await untilStreams(app, 1);
        const error = await refusal(navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS, furtherPage: true, standingBound: 1 }));
        expect(error.message).toBe(
          "navigateTo refused (standing-requests): 1 standing request on the origin of /stream/one is at or above the bound of 1, " +
            "held by page 1 on /stream/one (1) — close a page that is no longer needed; no further page was opened",
        );
        const result = await navigateTo(page, { path: "/nav/target", record, bounds: BOUNDS, furtherPage: true, standingBound: 2 });
        expect(result.standing).toEqual({ count: 1, bound: 2, counted: true });
      });
    });

    it("closes a further page that lands elsewhere, and refuses by name a press that opens none", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { navigateTo } = theSteps("navigateTo", "readStandingRequests");
        await firstReading(page);
        await page.goto(`${app.origin}/nav/start`);
        const elsewhere = await refusal(
          navigateTo(page, { path: "/nav/redirect", record, bounds: { ...BOUNDS, landingMs: 1500 }, furtherPage: true }),
        );
        expect(elsewhere.kind).toBe("landed-elsewhere");
        expect(elsewhere.message).toBe(
          "navigateTo refused (landed-elsewhere): the further page did not land on /nav/redirect within 1500 ms (it was on /nav/elsewhere, and it was closed)",
        );
        expect(page.context().pages(), "the further page was left open").toHaveLength(1);
        // The link's own handler cancels the press: no further page opens.
        const inert = await refusal(navigateTo(page, { path: "/nav/inert", record, bounds: { ...BOUNDS, landingMs: 800 }, furtherPage: true }));
        expect(inert.kind).toBe("no-further-page");
        expect(inert.message).toBe("navigateTo refused (no-further-page): the press opened no further page within 800 ms (this page is on /nav/start)");
        const none = await refusal(navigateTo(page, { path: "/nav/nowhere", record, bounds: BOUNDS, furtherPage: true }));
        expect(none.message).toBe("navigateTo refused (no-link): no visible link on /nav/start leads to /nav/nowhere — no address was typed");
        expect(page.context().pages()).toHaveLength(1);
        expect(new URL(page.url()).pathname).toBe("/nav/start");
        expect(visits(app, "/nav/inert")).toEqual([]);
      });
    });
  });
}
