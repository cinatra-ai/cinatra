// press: a control pressed by its role and its accessible name, and the page's
// next settled state: no navigation started, or the navigation landed.
//
// The defects these cases stand for: a press by a hand-written selector pressed
// whatever it found first, and the run read the page before the press had taken
// it anywhere. The step presses only a control whose name exactly one shown
// control of the role carries, and returns once the page has settled.
//
// Two more came from a step-driven run on the agents pages: a skill's pill box
// is a checkbox, which the step would not press; and "Add skill" is one button
// per agent section, which the step refused as ambiguous although the section
// that holds it is not. A checkbox, a radio or a switch is pressed and must
// flip, and a name is looked for within one named part of the page when the
// call names one.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

// Short bounds, so a press that settles in place costs half a second, not two.
const BOUNDS = Object.freeze({ actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`press [${labelOf(backend)}]`, () => {
    const start = async (page, app, path = "/press/start") => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("press").press;
    };
    const isShown = (page, selector) => page.evaluate((one) => !document.querySelector(one).hasAttribute("hidden"), selector);
    const marks = (page) => page.evaluate(() => document.querySelectorAll("[data-step-control]").length);
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

    it("presses a checkbox the page draws itself and reads its checked state flip, and refuses one whose state did not change", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app, "/press/sections");
        const result = await press(page, { name: "Web search", role: "checkbox", record, bounds: BOUNDS });
        expect(result).toMatchObject({ name: "Web search", role: "checkbox", from: "/press/sections", path: "/press/sections", navigated: false });
        const box = await page.evaluate(() => {
          const pill = document.querySelector('[aria-labelledby="press-skill-web"]');
          return [pill.getAttribute("aria-checked"), pill.getAttribute("data-state")];
        });
        expect(box, "the pressed box did not flip").toEqual(["true", "checked"]);
        const pinned = await refusal(press(page, { name: "Pinned", role: "checkbox", record, bounds: BOUNDS }));
        expect(pinned.kind).toBe("unchanged");
        expect(pinned.message).toBe('press refused (unchanged): the checkbox "Pinned" on /press/sections still reads checked after the press — its checked state did not change');
        expect(await marks(page), "a control kept the step's mark").toBe(0);
        // A box whose press leaves the page cannot be read after it: no change was seen.
        const left = await refusal(press(page, { name: "Keep drafts", role: "checkbox", record, bounds: BOUNDS }));
        expect(left.kind).toBe("unchanged");
        expect(left.message).toBe(
          'press refused (unchanged): the checked state of the checkbox "Keep drafts" on /press/sections could not be read after the press, so no change of it was seen',
        );
        expect(lines).toEqual([
          'press: pressed the checkbox "Web search" on /press/sections — it went from unchecked to checked; no navigation started within 500 ms, and the page stayed on /press/sections',
          pinned.message,
          left.message,
        ]);
      });
    });

    it("never guesses among sections that each carry the name, and names each section as a scope names it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app, "/press/sections");
        const error = await refusal(press(page, { name: "Add skill", record, bounds: BOUNDS }));
        expect(error.kind).toBe("ambiguous");
        expect(error.message).toBe(
          'press refused (ambiguous): 4 shown buttons on /press/sections are named "Add skill": 1 in the region "Research assistant", 2 in the region "Blog writer", ' +
            '3 in the region "Twin agent", 4 in the region "Twin agent" — nothing was pressed, since a press never guesses',
        );
        // A scope that holds every one of them leaves the name as ambiguous as the page does.
        const wide = await refusal(press(page, { name: "Add skill", within: "Agents", record, bounds: BOUNDS }));
        expect(wide.kind).toBe("ambiguous");
        expect(wide.message).toBe(
          'press refused (ambiguous): 4 shown buttons in the region "Agents" on /press/sections are named "Add skill": 1 in the region "Research assistant", ' +
            '2 in the region "Blog writer", 3 in the region "Twin agent", 4 in the region "Twin agent" — nothing was pressed, since a press never guesses',
        );
        expect(lines).toEqual([error.message, wide.message]);
        expect(await isShown(page, "#press-added-research"), "a refused press reached a control").toBe(false);
        expect(await marks(page), "a control kept the step's mark").toBe(0);
      });
    });

    it("presses the one control of the name within the part of the page named by its heading or its label, and looks nowhere else", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app, "/press/sections");
        const result = await press(page, { name: "Add skill", within: "Research assistant", record, bounds: BOUNDS });
        expect(result).toMatchObject({ name: "Add skill", role: "button", from: "/press/sections", path: "/press/sections", navigated: false });
        expect(await isShown(page, "#press-added-research"), "the section's own control was not pressed").toBe(true);
        expect(await isShown(page, "#press-added-blog"), "another section's control was pressed").toBe(false);
        await press(page, { name: "Add skill", within: "Blog writer", record, bounds: BOUNDS });
        expect(await isShown(page, "#press-added-blog"), "the labelled section's control was not pressed").toBe(true);
        // "Pinned" is on the page, but not within the section named.
        const elsewhere = await refusal(press(page, { name: "Pinned", role: "checkbox", within: "Blog writer", record, bounds: BOUNDS }));
        expect(elsewhere.kind).toBe("no-control");
        expect(lines).toEqual([
          'press: pressed the button "Add skill" in the region "Research assistant" on /press/sections — no navigation started within 500 ms, and the page stayed on /press/sections',
          'press: pressed the button "Add skill" in the region "Blog writer" on /press/sections — no navigation started within 500 ms, and the page stayed on /press/sections',
          'press refused (no-control): no shown checkbox in the region "Blog writer" on /press/sections is named "Pinned" — the checkboxes it shows: none; nothing was pressed',
        ]);
      });
    });

    it("refuses a scope that several parts of the page carry, and a scope that none carries", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const press = await start(page, app, "/press/sections");
        const before = app.requests.length;
        const twin = await refusal(press(page, { name: "Add skill", within: "Twin agent", record, bounds: BOUNDS }));
        expect(twin.kind).toBe("ambiguous");
        expect(twin.message).toBe(
          'press refused (ambiguous): 2 shown parts of the page on /press/sections are named "Twin agent": 1 a region in the region "Agents", 2 a region in the region "Agents" — ' +
            "nothing was pressed, since a press never guesses",
        );
        const none = await refusal(press(page, { name: "Add skill", within: "Nowhere", record, bounds: BOUNDS }));
        expect(none.kind).toBe("no-scope");
        expect(none.message).toBe(
          'press refused (no-scope): no shown part of the page on /press/sections is named "Nowhere" — the named parts it shows: "Agents", "Research assistant", "Blog writer", "Twin agent"; nothing was pressed',
        );
        expect(lines).toEqual([twin.message, none.message]);
        expect(app.requests.length, "a refused press reached the app").toBe(before);
        expect(await marks(page), "a control kept the step's mark").toBe(0);
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
          [{ record, name: "Save", role: "slider" }, `role must be button, link, menuitem, tab, checkbox, radio or switch — ${nothing}`],
          [{ record, name: "Save", within: "  " }, `name the scope by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`],
          [{ record, name: "Save", within: 5 }, `name the scope by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`],
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
    expect(steps.PRESS_ROLES).toEqual(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch"]);
    expect(steps.PRESS_START_BOUND_MS).toBe(2_000);
    expect(steps.PRESS_BOUNDS).toEqual({
      actionMs: steps.CONTROL_ACTION_BOUND_MS,
      startMs: steps.PRESS_START_BOUND_MS,
      settleMs: steps.PRESS_SETTLE_BOUND_MS,
      pollMs: steps.CONTROL_POLL_MS,
    });
  });
});
