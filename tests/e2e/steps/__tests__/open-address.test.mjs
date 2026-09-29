// openAddress: an address of the page's own origin loaded, once, where no
// visible link leads, and the status the response gave.
//
// The gap these cases stand for: navigateTo presses a link and never types an
// address, so a page that exists only for a wrong address, such as the
// not-found page, could not be reached by the maintained steps at all: no link
// leads to it. The step refuses every path a press could reach instead.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { NOT_FOUND_HEADING } from "./fixture-app-windows.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ loadMs: 3000 });
/** An address of another origin, built from parts so no address literal sits in source. */
const ELSEWHERE = ["https:", "", ["elsewhere", "example"].join("."), "address", "missing"].join("/");

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`openAddress [${labelOf(backend)}]`, () => {
    const open = async (page, app) => {
      await page.goto(`${app.origin}/address/start`);
      return theSteps("openAddress").openAddress;
    };
    const visits = (app, path) => app.requests.filter((request) => request.path === path);
    const heading = (page) => page.evaluate(() => document.querySelector("h1")?.textContent ?? "");

    it("lands on the not-found page by its address, and answers the response's status", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const openAddress = await open(page, app);
        const result = await openAddress(page, { path: "/address/missing", record, bounds: BOUNDS });
        expect(result).toEqual({ path: "/address/missing", status: 404, from: "/address/start", elapsedMs: expect.any(Number) });
        expect(await heading(page)).toBe(NOT_FOUND_HEADING);
        expect(visits(app, "/address/missing"), "the address was loaded more than once").toHaveLength(1);
        expect(lines).toEqual([
          `openAddress: typed the address of /address/missing into the page on /address/start, where no visible link leads to it; it landed on /address/missing with status 404 after ${result.elapsedMs} ms`,
        ]);
      });
    });

    it("loads a path that only a link that is not shown leads to", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const openAddress = await open(page, app);
        const result = await openAddress(page, { path: "/address/hidden-only", record, bounds: BOUNDS });
        expect(result).toMatchObject({ path: "/address/hidden-only", status: 200, from: "/address/start" });
      });
    });

    it("refuses a path a visible link on the page leads to, since pressing it is navigateTo's act", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const openAddress = await open(page, app);
        const error = await refusal(openAddress(page, { path: "/address/linked", record, bounds: BOUNDS }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("openAddress");
        expect(error.kind).toBe("has-link");
        expect(error.message).toBe(
          "openAddress refused (has-link): a visible link on /address/start leads to /address/linked, and pressing it is navigateTo's act — no address was typed",
        );
        expect(lines).toEqual([error.message]);
        expect(visits(app, "/address/linked"), "the step reached the page after all").toEqual([]);
        expect(new URL(page.url()).pathname).toBe("/address/start");
      });
    });

    it("refuses by name a load that does not end within the bound", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const openAddress = await open(page, app);
        const error = await refusal(openAddress(page, { path: "/address/slow", record, bounds: { loadMs: 800 } }));
        expect(error.kind).toBe("no-load");
        expect(error.message).toBe(
          "openAddress refused (no-load): the address of /address/slow was typed, and its load did not end within 800 ms (TimeoutError; the page is on /address/start)",
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses another origin, and anything that is no page path, and types no address", async () => {
      await scene(backend, { secrets: [ELSEWHERE, ELSEWHERE.replace("https:", "")] }, async ({ app, page, record, lines }) => {
        const openAddress = await open(page, app);
        const before = app.requests.length;
        for (const path of [ELSEWHERE, ELSEWHERE.replace("https:", "")]) {
          const error = await refusal(openAddress(page, { path, record, bounds: BOUNDS }));
          expect(error.kind).toBe("other-origin");
          expect(error.message).toBe("openAddress refused (other-origin): the address names another origin than the page's on /address/start — no address was typed");
          expect(lines.at(-1)).toBe(error.message);
        }
        const nothing = "no address was typed";
        const PATH_ONLY = `name the page by its path alone, such as /chat — ${nothing}`;
        const cases = [
          [{ record }, PATH_ONLY],
          [{ record, path: "address/missing" }, PATH_ONLY],
          [{ record, path: "/address/missing?x=1" }, PATH_ONLY],
          [{ record, path: `${app.origin}/address/missing` }, PATH_ONLY],
          [{ record, path: "/address/missing", bounds: { loadMs: 0 } }, `loadMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, path: "/address/missing", bounds: { landingMs: 5 } }, `there is no bound named landingMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(openAddress(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`openAddress refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(openAddress(page, { path: "/address/missing" }));
        expect(unrecorded.message).toBe("openAddress refused (input): hand the step a record callback — nothing was done");
        expect(app.requests.length, "a refused call loaded something").toBe(before);
        expect(new URL(page.url()).pathname).toBe("/address/start");
      });
    });
  });
}

describe("openAddress, its bounds", () => {
  it("names its bound, and the reading of the page's links", () => {
    const steps = theSteps("openAddress");
    expect(steps.OPEN_ADDRESS_BOUND_MS).toBe(120_000);
    expect(steps.OPEN_ADDRESS_BOUNDS).toEqual({ loadMs: steps.OPEN_ADDRESS_BOUND_MS, readingMs: steps.READING_BOUND_MS });
  });
});
