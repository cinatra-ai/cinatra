// selectFrom: an entry selected by its visible text in a picker found by its
// accessible name, waited for until the page reflects it.
//
// The defect these cases stand for: a selection typed by hand clicked an option
// by a selector and read the page at once, so a picker that opens its list first,
// or a page that takes a moment to take the choice, left the run on the old
// value. The step returns only once the entry reads as selected, or the page
// confirms it.
//
// One more came from a step-driven run on the skill match tab: the skill select
// is a combobox with no accessible name, which the step could not find. Such a
// combobox is found by the text a person reads for it, and never by a guess.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ actionMs: 2000, reflectMs: 800, pollMs: 25 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`selectFrom [${labelOf(backend)}]`, () => {
    const start = async (page, app, path = "/pick/start") => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("selectFrom").selectFrom;
    };

    it("selects an option of a select by its text, and reads its selected state", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app);
        const result = await selectFrom(page, { picker: "Size", entry: "Medium", record, bounds: BOUNDS });
        expect(result).toMatchObject({ picker: "Size", entry: "Medium", kind: "select", via: "state", path: "/pick/start" });
        const chosen = await page.evaluate(() => document.getElementById("pick-size").selectedOptions[0].text);
        expect(chosen).toBe("Medium");
        expect(lines).toEqual([`selectFrom: selected "Medium" in the picker "Size" on /pick/start — its selected state shows it after ${result.elapsedMs} ms`]);
      });
    });

    it("checks a radio of a group by its label, and reads it checked", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const selectFrom = await start(page, app);
        const result = await selectFrom(page, { picker: "Colour", entry: "Green", record, bounds: BOUNDS });
        expect(result).toMatchObject({ kind: "radiogroup", via: "state" });
        const checked = await page.evaluate(() => Array.from(document.querySelectorAll('input[name="colour"]')).map((radio) => radio.checked));
        expect(checked).toEqual([false, true]);
      });
    });

    it("presses an option of a listbox, and reads the page's confirmation", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app);
        const result = await selectFrom(page, { picker: "Fruit", entry: "Apple", record, bounds: BOUNDS });
        expect(result).toMatchObject({ kind: "listbox", via: "confirmation" });
        expect(lines).toEqual([
          `selectFrom: selected "Apple" in the picker "Fruit" on /pick/start — the page confirms it after ${result.elapsedMs} ms: "Fruit: Apple"`,
        ]);
      });
    });

    it("opens a combobox first, then selects from the list it controls", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const selectFrom = await start(page, app);
        const result = await selectFrom(page, { picker: "Vegetable", entry: "Leek", record, bounds: BOUNDS });
        expect(result).toMatchObject({ kind: "combobox", via: "confirmation" });
        const expanded = await page.evaluate(() => document.querySelector('[aria-label="Vegetable"]').getAttribute("aria-expanded"));
        expect(expanded).toBe("true");
      });
    });

    it("refuses by name a selection the page does not reflect within the bound", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app);
        const error = await refusal(selectFrom(page, { picker: "Fruit", entry: "Plum", record, bounds: BOUNDS }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("selectFrom");
        expect(error.kind).toBe("not-reflected");
        expect(error.message).toBe(
          'selectFrom refused (not-reflected): the selection of "Plum" in the picker "Fruit" on /pick/start was not reflected within 800 ms: ' +
            "the entry does not read as selected, and the page shows no confirmation that names it",
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses by name a picker the page does not show, naming the pickers it shows", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const selectFrom = await start(page, app);
        const error = await refusal(selectFrom(page, { picker: "Shape", entry: "Round", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-picker");
        expect(error.message).toBe(
          'selectFrom refused (no-picker): no shown picker, radio group or listbox on /pick/start is named "Shape" — ' +
            'the pickers it shows: "Size", "Colour", "Fruit", "Vegetable", "Twin", "Shut"; nothing was selected',
        );
      });
    });

    it("refuses by name an entry the picker does not have, naming its entries", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const selectFrom = await start(page, app);
        const error = await refusal(selectFrom(page, { picker: "Size", entry: "Tiny", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-entry");
        expect(error.message).toBe(
          'selectFrom refused (no-entry): the picker "Size" on /pick/start has no entry "Tiny" — its entries: "Small", "Medium", "Large", "Huge"; nothing was selected',
        );
        const shut = await refusal(selectFrom(page, { picker: "Shut", entry: "Never", record, bounds: BOUNDS }));
        expect(shut.kind).toBe("no-entry");
        expect(shut.message).toBe('selectFrom refused (no-entry): the picker "Shut" on /pick/start showed no list of entries within 800 ms of being opened — nothing was selected');
      });
    });

    it("never guesses between two pickers of one name, and refuses a disabled entry", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const selectFrom = await start(page, app);
        const twin = await refusal(selectFrom(page, { picker: "Twin", entry: "One", record, bounds: BOUNDS }));
        expect(twin.kind).toBe("ambiguous");
        expect(twin.message).toBe('selectFrom refused (ambiguous): 2 shown pickers on /pick/start are named "Twin" — nothing was selected, since a selection never guesses');
        const huge = await refusal(selectFrom(page, { picker: "Size", entry: "Huge", record, bounds: BOUNDS }));
        expect(huge.kind).toBe("disabled");
        expect(huge.message).toBe('selectFrom refused (disabled): the entry "Huge" of the picker "Size" on /pick/start is disabled — nothing was selected');
        const chosen = await page.evaluate(() => document.getElementById("pick-size").selectedOptions[0].text);
        expect(chosen, "a refused selection changed the picker").toBe("Small");
        const marked = await page.evaluate(() => document.querySelectorAll("[data-step-control]").length);
        expect(marked, "a control kept the step's mark").toBe(0);
      });
    });

    it("finds a combobox with no accessible name by the placeholder it shows, and selects from the list it opens", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/unnamed");
        const result = await selectFrom(page, { picker: "Pick a vegetable", entry: "Leek", record, bounds: BOUNDS });
        expect(result).toMatchObject({ picker: "Pick a vegetable", entry: "Leek", kind: "combobox", via: "confirmation", path: "/pick/unnamed" });
        expect(lines).toEqual([
          'selectFrom: selected "Leek" in the picker "Pick a vegetable" (a combobox with no accessible name, found by its placeholder) on /pick/unnamed — ' +
            `the page confirms it after ${result.elapsedMs} ms: "Vegetable: Leek"`,
        ]);
      });
    });

    it("finds a combobox with no accessible name by the value it shows", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/unnamed");
        const result = await selectFrom(page, { picker: "Weekly", entry: "Monthly", record, bounds: BOUNDS });
        expect(result).toMatchObject({ picker: "Weekly", entry: "Monthly", kind: "combobox", via: "confirmation" });
        expect(lines).toEqual([
          'selectFrom: selected "Monthly" in the picker "Weekly" (a combobox with no accessible name, found by its value) on /pick/unnamed — ' +
            `the page confirms it after ${result.elapsedMs} ms: "Frequency: Monthly"`,
        ]);
      });
    });

    it("finds a combobox with no accessible name by the label element before it in its form group", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/unnamed");
        const result = await selectFrom(page, { picker: "Repository", entry: "Main site", record, bounds: BOUNDS });
        expect(result).toMatchObject({ picker: "Repository", entry: "Main site", kind: "combobox", via: "confirmation" });
        expect(lines).toEqual([
          'selectFrom: selected "Main site" in the picker "Repository" (a combobox with no accessible name, found by the label before it) on /pick/unnamed — ' +
            `the page confirms it after ${result.elapsedMs} ms: "Repository: Main site"`,
        ]);
      });
    });

    it("never guesses between two comboboxes with no accessible name that show one text, and looks for the accessible name first", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/unnamed");
        const twin = await refusal(selectFrom(page, { picker: "Add a skill", entry: "Web search", record, bounds: BOUNDS }));
        expect(twin.kind).toBe("ambiguous");
        expect(twin.message).toBe(
          'selectFrom refused (ambiguous): 2 shown comboboxes on /pick/unnamed have no accessible name and are found by their placeholder: "Add a skill" — ' +
            "nothing was selected, since a selection never guesses",
        );
        // The select named Kind by its label, not the combobox that shows Kind as its placeholder.
        const named = await selectFrom(page, { picker: "Kind", entry: "Rich", record, bounds: BOUNDS });
        expect(named).toMatchObject({ picker: "Kind", entry: "Rich", kind: "select", via: "state" });
        expect(lines).toEqual([twin.message, `selectFrom: selected "Rich" in the picker "Kind" on /pick/unnamed — its selected state shows it after ${named.elapsedMs} ms`]);
        const marked = await page.evaluate(() => document.querySelectorAll("[data-step-control]").length);
        expect(marked, "a control kept the step's mark").toBe(0);
      });
    });

    it("selects nothing when it refuses its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app);
        const nothing = "nothing was selected";
        const cases = [
          [{ record, entry: "Medium" }, `name the picker by its accessible name, such as Size — ${nothing}`],
          [{ record, picker: "Size" }, `name the entry by its visible text, such as Medium — ${nothing}`],
          [{ record, picker: "Size", entry: "Medium", bounds: { reflectMs: -1 } }, `reflectMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, picker: "Size", entry: "Medium", bounds: { openMs: 5 } }, `there is no bound named openMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(selectFrom(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`selectFrom refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(selectFrom(page, { picker: "Size", entry: "Medium" }));
        expect(unrecorded.message).toBe("selectFrom refused (input): hand the step a record callback — nothing was done");
      });
    });
  });
}

describe("selectFrom, its bounds", () => {
  it("names its bounds", () => {
    const steps = theSteps("selectFrom");
    expect(steps.SELECT_REFLECT_BOUND_MS).toBe(5_000);
    expect(steps.SELECT_BOUNDS).toEqual({ actionMs: steps.CONTROL_ACTION_BOUND_MS, reflectMs: steps.SELECT_REFLECT_BOUND_MS, pollMs: steps.CONTROL_POLL_MS });
  });
});
