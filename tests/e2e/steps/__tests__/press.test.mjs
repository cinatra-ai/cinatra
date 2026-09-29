// press: a control pressed by its role and its accessible name, and the page's
// next settled state: no navigation started, or the navigation landed.
//
// The defects these cases stand for: a press by a hand-written selector pressed
// whatever it found first, and the run read the page before the press had taken
// it anywhere. The step presses only a control whose name exactly one shown
// control of the role carries, and returns once the page has settled.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

// Short bounds, so a press that settles in place costs half a second, not two.
const BOUNDS = Object.freeze({ actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`press [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}/press/start`);
      return theSteps("press").press;
    };
    const visits = (app, path) => app.requests.filter((request) => request.path === path);

    it("presses a link by its name and waits for the landing", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app);
        const result = await press(page, { name: "Target", role: "link", record, bounds: BOUNDS });
        expect(result).toMatchObject({ name: "Target", role: "link", from: "/press/start", path: "/nav/target", navigated: true });
        expect(new URL(page.url()).pathname).toBe("/nav/target");
        expect(lines).toEqual([`press: pressed the link "Target" on /press/start — landed on /nav/target after ${result.elapsedMs} ms`]);
      });
    });

    it("presses a form's button, a button by default, and waits for the page the form leads to", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app);
        const result = await press(page, { name: "Save", record, bounds: BOUNDS });
        expect(result).toMatchObject({ role: "button", path: "/press/saved", navigated: true });
        expect(visits(app, "/press/saved")).toHaveLength(1);
        expect(visits(app, "/press/saved")[0].query).toEqual(["note"]);
        expect(lines).toEqual([`press: pressed the button "Save" on /press/start — landed on /press/saved after ${result.elapsedMs} ms`]);
      });
    });

    it("returns once the start bound has passed when the press starts no navigation", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app);
        const before = app.requests.length;
        const result = await press(page, { name: "Stay", record, bounds: BOUNDS });
        expect(result).toMatchObject({ name: "Stay", from: "/press/start", path: "/press/start", navigated: false });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(BOUNDS.startMs);
        expect(result.elapsedMs, "the step waited for a landing that could not come").toBeLessThan(BOUNDS.settleMs);
        expect(app.requests.length).toBe(before);
        expect(lines).toEqual(['press: pressed the button "Stay" on /press/start — no navigation started within 500 ms, and the page stayed on /press/start']);
      });
    });

    for (const [role, name, shows, word] of [
      ["tab", "Second", "#press-second", "tab"],
      ["menuitem", "Archive", "#press-archived", "menu item"],
    ]) {
      it(`presses a ${word} whose handler shows its part in place, and settles there`, async () => {
        await scene(backend, {}, async ({ app, page, record, lines }) => {
          const press = await start(page, app);
          const result = await press(page, { name, role, record, bounds: BOUNDS });
          expect(result).toMatchObject({ role, path: "/press/start", navigated: false });
          const shown = await page.evaluate((selector) => !document.querySelector(selector).hasAttribute("hidden"), shows);
          expect(shown, `the ${word}'s part is not shown`).toBe(true);
          expect(lines).toEqual([`press: pressed the ${word} "${name}" on /press/start — no navigation started within 500 ms, and the page stayed on /press/start`]);
        });
      });
    }

    it("waits past the start bound for a navigation in place whose request is still out", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app);
        const result = await press(page, { name: "Slow in place", role: "link", record, bounds: BOUNDS });
        expect(result).toMatchObject({ path: "/nav/slow-in-place", navigated: true });
        expect(result.elapsedMs, "the page moved before the start bound ran out").toBeGreaterThan(BOUNDS.startMs);
        expect(lines).toEqual([`press: pressed the link "Slow in place" on /press/start — landed on /nav/slow-in-place after ${result.elapsedMs} ms`]);
      });
    });

    it("refuses by name a navigation that does not land within the settle bound", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app);
        const error = await refusal(press(page, { name: "Slow", role: "link", record, bounds: { ...BOUNDS, settleMs: 800 } }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("press");
        expect(error.kind).toBe("unsettled");
        expect(error.message).toBe(
          'press refused (unsettled): the press on the link "Slow" started a navigation from /press/start that did not land within 800 ms (the page is on /press/start)',
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("never guesses among several controls of one name: it presses nothing and names where each sits", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app);
        const before = app.requests.length;
        const error = await refusal(press(page, { name: "Delete", record, bounds: BOUNDS }));
        expect(error.kind).toBe("ambiguous");
        expect(error.message).toBe(
          'press refused (ambiguous): 2 shown buttons on /press/start are named "Delete": 1 in the list item "First row", 2 in the list item "Second row" — nothing was pressed, since a press never guesses',
        );
        expect(lines).toEqual([error.message]);
        expect(app.requests.length, "the refused press reached the app").toBe(before);
        expect(new URL(page.url()).pathname).toBe("/press/start");
        const marked = await page.evaluate(() => document.querySelectorAll("[data-step-control]").length);
        expect(marked, "a control kept the step's mark").toBe(0);
      });
    });

    it("refuses by name a control no shown control of the role carries, listing a bounded number of those it shows", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const press = await start(page, app);
        const error = await refusal(press(page, { name: "Publish", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-control");
        expect(error.message).toBe(
          'press refused (no-control): no shown button on /press/start is named "Publish" — the buttons it shows: "Save", "Stay", "Locked", "Delete", ' +
            '"Tool 1", "Tool 2", "Tool 3", "Tool 4", "Tool 5", "Tool 6" and 2 more; nothing was pressed',
        );
        // A link of that name is no button, and a hidden part's control is not shown.
        const link = await refusal(press(page, { name: "Target", record, bounds: BOUNDS }));
        expect(link.kind).toBe("no-control");
        const tab = await refusal(press(page, { name: "Archive", role: "tab", record, bounds: BOUNDS }));
        expect(tab.message).toBe('press refused (no-control): no shown tab on /press/start is named "Archive" — the tabs it shows: "Second"; nothing was pressed');
      });
    });

    it("refuses a disabled control before pressing it", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const press = await start(page, app);
        const error = await refusal(press(page, { name: "Locked", record, bounds: BOUNDS }));
        expect(error.kind).toBe("disabled");
        expect(error.message).toBe('press refused (disabled): the button "Locked" on /press/start is disabled — nothing was pressed');
      });
    });

    it("presses nothing when it refuses its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app);
        const before = app.requests.length;
        const nothing = "nothing was pressed";
        const cases = [
          [{ record }, `name the control by its accessible name, such as Save — ${nothing}`],
          [{ record, name: "  " }, `name the control by its accessible name, such as Save — ${nothing}`],
          [{ record, name: "Save", role: "checkbox" }, `role must be button, link, menuitem or tab — ${nothing}`],
          [{ record, name: "Save", bounds: { startMs: 0 } }, `startMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, name: "Save", bounds: { waitMs: 5 } }, `there is no bound named waitMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(press(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`press refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(press(page, { name: "Save" }));
        expect(unrecorded.message).toBe("press refused (input): hand the step a record callback — nothing was done");
        expect(app.requests.length, "a refused call pressed or loaded something").toBe(before);
      });
    });
  });
}

describe("press, its bounds", () => {
  it("names its roles and bounds: a short start bound beside the settle bound", () => {
    const steps = theSteps("press");
    expect(steps.PRESS_ROLES).toEqual(["button", "link", "menuitem", "tab"]);
    expect(steps.PRESS_START_BOUND_MS).toBe(2_000);
    expect(steps.PRESS_BOUNDS).toEqual({
      actionMs: steps.CONTROL_ACTION_BOUND_MS,
      startMs: steps.PRESS_START_BOUND_MS,
      settleMs: steps.PRESS_SETTLE_BOUND_MS,
      pollMs: steps.CONTROL_POLL_MS,
    });
  });
});
