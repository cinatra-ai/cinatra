// reloadPage: the browser's own reload of the page, until the new document's
// content has loaded, and the new document's time origin.
//
// The gap these cases stand for: no step was the browser's own reload. A run
// reloaded by hand, or loaded the address again, which is another load and can
// land somewhere else without anyone reading that it did.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

/** How far short of its delay a Node timer can end, read on performance.now(): the event loop counts whole milliseconds and may read the coarse monotonic clock, one tick behind. */
const TIMER_CLOCK_SLACK_MS = 2;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`reloadPage [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("reloadPage", "armPageTape", "readPageTape");
    };
    const loads = (app, path) => app.requests.filter((request) => request.method === "GET" && request.path === path);

    it("reloads the page and answers the new document's time origin", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { reloadPage, armPageTape, readPageTape } = await open(page, app, "/reload/page");
        const armed = await armPageTape(page, { record: () => {} });
        const result = await reloadPage(page, { record });
        expect(result).toEqual({ path: "/reload/page", timeOrigin: expect.any(Number), elapsedMs: expect.any(Number) });
        expect(result.timeOrigin, "the reload kept the document's time origin").toBeGreaterThan(armed.timeOrigin);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(result.timeOrigin);
        // The tape counts one new document, and the app one more load of the page.
        expect(await readPageTape(page, { record: () => {} })).toMatchObject({ documents: 1, addressChanges: 0, sameDocument: false });
        expect(loads(app, "/reload/page")).toHaveLength(2);
        expect(lines).toEqual([`reloadPage: reloaded /reload/page after ${result.elapsedMs} ms; the new document's time origin is ${result.timeOrigin}`]);
      });
    });

    it("refuses by name a reload that lands on another path", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { reloadPage } = await open(page, app, "/reload/moves");
        const error = await refusal(reloadPage(page, { record }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("reloadPage");
        expect(error.kind).toBe("landed-elsewhere");
        expect(error.message).toBe("reloadPage refused (landed-elsewhere): the reload of /reload/moves landed on /reload/elsewhere");
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses by name a reload that does not end within its bound", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { reloadPage } = await open(page, app, "/reload/slow");
        const before = performance.now();
        const error = await refusal(reloadPage(page, { record, bounds: { reloadMs: 800 } }));
        const tookMs = performance.now() - before;
        expect(error.kind).toBe("no-load");
        expect(error.message).toBe("reloadPage refused (no-load): the reload of /reload/slow did not end within 800 ms (TimeoutError; the page is on /reload/slow)");
        expect(lines).toEqual([error.message]);
        expect(tookMs, "the step refused before its bound").toBeGreaterThanOrEqual(800 - TIMER_CLOCK_SLACK_MS);
        expect(tookMs, "the step waited past its bound").toBeLessThan(2900);
      });
    });

    it("reloads nothing when it refuses a closed page, or its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { reloadPage } = await open(page, app, "/reload/page");
        const nothing = "nothing was reloaded";
        const cases = [
          [{ record, bounds: { reloadMs: 0 } }, `reloadMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, bounds: { loadMs: 5 } }, `there is no bound named loadMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(reloadPage(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`reloadPage refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(reloadPage(page, {}));
        expect(unrecorded.message).toBe("reloadPage refused (input): hand the step a record callback — nothing was done");
        expect(loads(app, "/reload/page"), "a refused call reloaded the page").toHaveLength(1);
        await page.close();
        const closed = await refusal(reloadPage(page, { record }));
        expect(closed.kind).toBe("closed");
        expect(closed.message).toBe(`reloadPage refused (closed): the page on /reload/page is closed — ${nothing}`);
        expect(lines.at(-1)).toBe(closed.message);
      });
    });
  });
}

describe("reloadPage, its bounds", () => {
  it("names its bound, and the reading of the new document", () => {
    const steps = theSteps("reloadPage");
    expect(steps.RELOAD_BOUND_MS).toBe(120_000);
    expect(steps.RELOAD_PAGE_BOUNDS).toEqual({ reloadMs: steps.RELOAD_BOUND_MS, readingMs: steps.READING_BOUND_MS });
  });
});
