// navigateTo: reaching a page through the product's own navigation, never by
// typing its address, and recording where the press landed.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ actionMs: 2000, landingMs: 3000 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`navigateTo [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}/nav/start`);
      return theSteps("navigateTo").navigateTo;
    };
    const visits = (app, path) => app.requests.filter((r) => r.path === path);

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
  });
}
