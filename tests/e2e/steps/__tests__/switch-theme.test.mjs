// switchTheme: the theme switched through the app's own control, and read back
// from the page and from the review island, driven against pages whose island
// follows the switch, lags it, or never follows.
//
// The defect these cases stand for: a picture taken right after the theme
// switch showed the island still in the old palette, because the island
// repaints only once the card has pointed it at the new palette and it has
// loaded again.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { THEME_ISLAND_PATH } from "./fixture-app-controls.mjs";

afterAll(closeBrowser);

// Short bounds, so a refusal costs a second, not minutes. The fixture's island
// is served on a path of its own.
const OPTIONS = Object.freeze({ frameSrcPath: THEME_ISLAND_PATH, bounds: { controlMs: 1500, actionMs: 2000, appliedMs: 800, pollMs: 25 } });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`switchTheme [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("switchTheme").switchTheme;
    };
    const rootClass = (page) => page.evaluate(() => document.documentElement.className);

    it("presses the app's theme control and waits for the island to report the theme", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const switchTheme = await open(page, app, "/theme/follows");
        const result = await switchTheme(page, { to: "dark", record, ...OPTIONS });
        expect(result).toMatchObject({ to: "dark", pressed: true, islands: 1 });
        // The card points its island at the new palette 150 ms after the press: the step waited for it.
        expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
        expect(await rootClass(page)).toBe("dark");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^switchTheme: pressed "Toggle theme" on \/theme\/follows; the page and its island report dark after \d+ ms$/);

        const back = await switchTheme(page, { to: "light", record, ...OPTIONS });
        expect(back).toMatchObject({ to: "light", pressed: true, islands: 1 });
        expect(await rootClass(page)).toBe("cinatra");
      });
    });

    it("presses nothing when the page and its island show the theme already", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const switchTheme = await open(page, app, "/theme/dark");
        const result = await switchTheme(page, { to: "dark", record, ...OPTIONS });
        expect(result).toMatchObject({ to: "dark", pressed: false, islands: 1 });
        expect(lines).toEqual(["switchTheme: the page on /theme/dark shows dark already — nothing pressed; its island reports dark"]);
        expect(await rootClass(page)).toBe("dark");
      });
    });

    it("waits for the control, which the app names only once it has mounted it", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const switchTheme = await open(page, app, "/theme/unmounted");
        const result = await switchTheme(page, { to: "dark", record, ...OPTIONS });
        expect(result).toMatchObject({ to: "dark", pressed: true, islands: 1 });
      });
    });

    it("refuses by name an island that never reports the theme, with what it reported last", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const switchTheme = await open(page, app, "/theme/stuck");
        const error = await refusal(switchTheme(page, { to: "dark", record, ...OPTIONS }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("switchTheme");
        expect(error.kind).toBe("island-unreported");
        expect(error.message).toBe(
          'switchTheme refused (island-unreported): the press on "Toggle theme" switched the page on /theme/stuck to dark, ' +
            "but its island reported light last, not dark, within 800 ms",
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses by name a press that does not switch the page", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const switchTheme = await open(page, app, "/theme/inert");
        const error = await refusal(switchTheme(page, { to: "dark", record, ...OPTIONS }));
        expect(error.kind).toBe("not-applied");
        expect(error.message).toBe(
          'switchTheme refused (not-applied): the press on "Toggle theme" did not switch the page on /theme/inert to dark within 800 ms (it shows light)',
        );
      });
    });

    it("refuses a page that frames no island, unless the caller says there is none to read", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const switchTheme = await open(page, app, "/theme/bare");
        const error = await refusal(switchTheme(page, { to: "dark", record, ...OPTIONS }));
        expect(error.kind).toBe("island-unreported");
        expect(error.message).toBe(
          'switchTheme refused (island-unreported): the press on "Toggle theme" switched the page on /theme/bare to dark, ' +
            "but no island reported dark within 800 ms (the page frames none: absent)",
        );
        const result = await switchTheme(page, { to: "light", island: false, record, ...OPTIONS });
        expect(result).toMatchObject({ to: "light", pressed: true, islands: 0 });
        expect(lines[1]).toMatch(/^switchTheme: pressed "Toggle theme" on \/theme\/bare; the page reports light after \d+ ms; no island was read$/);
      });
    });

    it("refuses by name a control that is not shown with its name within the bound", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const switchTheme = await open(page, app, "/theme/unmounted");
        const error = await refusal(switchTheme(page, { to: "dark", record, ...OPTIONS, bounds: { ...OPTIONS.bounds, controlMs: 100 } }));
        expect(error.kind).toBe("no-control");
        expect(error.message).toBe(
          'switchTheme refused (no-control): no shown control named "Toggle theme" on /theme/unmounted within 100 ms (the page shows light) — nothing was pressed',
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("presses nothing when it refuses its arguments", async () => {
      const { switchTheme } = theSteps("switchTheme");
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/theme/follows`);
        const cases = [
          [{ record }, "name the theme to switch to: light or dark — nothing was pressed"],
          [{ record, to: "blue" }, "name the theme to switch to: light or dark — nothing was pressed"],
          [{ record, to: "dark", island: "yes" }, "island must be true or false — nothing was pressed"],
          [{ record, to: "dark", frameSrcPath: "island" }, "name the island's frame by its path, such as /lifecycle/review-island — nothing was pressed"],
          [{ record, to: "dark", bounds: { appliedMs: 0 } }, "appliedMs must be a positive number of milliseconds — nothing was pressed"],
          [{ record, to: "dark", bounds: { waitMs: 5 } }, "there is no bound named waitMs — nothing was pressed"],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(switchTheme(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`switchTheme refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(switchTheme(page, { to: "dark" }));
        expect(unrecorded.message).toBe("switchTheme refused (input): hand the step a record callback — nothing was done");
        expect(await page.evaluate(() => document.documentElement.className), "a refused call switched the theme").toBe("cinatra");
      });
    });
  });
}
