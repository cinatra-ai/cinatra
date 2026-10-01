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
//
// And one more: while its list is open, the shared select hides everything
// outside the list from assistive technology, the combobox included. A step that
// looks for the combobox by its name again once it has opened it finds none,
// and refuses a selection a person makes; the step reads it again by its mark.
//
// And one more: a picker drawn as a text input with the role combobox (the
// entity search, on the agent's Skills tab among others: a person types, a list
// of matching entries opens, and one is pressed) was no picker for the step,
// which refused every page that assigns by search.
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

    it("reads a combobox it opened again by its mark while the list hides the rest of the page, and says what found it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/hiding");
        const plan = await selectFrom(page, { picker: "Plan", entry: "Team", record, bounds: BOUNDS });
        expect(plan).toMatchObject({ picker: "Plan", entry: "Team", kind: "combobox", via: "state", path: "/pick/hiding" });
        const skill = await selectFrom(page, { picker: "Pick a skill", entry: "Web search", record, bounds: BOUNDS });
        expect(skill).toMatchObject({ picker: "Pick a skill", entry: "Web search", kind: "combobox", via: "state", path: "/pick/hiding" });
        expect(lines).toEqual([
          `selectFrom: selected "Team" in the picker "Plan" on /pick/hiding — its selected state shows it after ${plan.elapsedMs} ms`,
          'selectFrom: selected "Web search" in the picker "Pick a skill" (a combobox with no accessible name, found by its placeholder) on /pick/hiding — ' +
            `its selected state shows it after ${skill.elapsedMs} ms`,
        ]);
        // Each list closed on the choice and showed the page again, and no control kept the step's mark.
        const after = await page.evaluate(() => ({
          shows: Array.from(document.querySelectorAll("[role='combobox']"), (picker) => picker.textContent),
          hidden: document.querySelectorAll("[aria-hidden]").length,
          marked: document.querySelectorAll("[data-step-control]").length,
        }));
        expect(after).toEqual({ shows: ["Team", "Web search"], hidden: 0, marked: 0 });
      });
    });

    it("waits for a list that closes after the choice, so a second pick on the same page finds its picker, and says how long the list took to close", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/closing");
        const hour = await selectFrom(page, { picker: "Hour", entry: "09", record, bounds: BOUNDS });
        const minute = await selectFrom(page, { picker: "Minute", entry: "30", record, bounds: BOUNDS });
        expect(hour).toMatchObject({ kind: "combobox", via: "state", path: "/pick/closing" });
        expect(minute).toMatchObject({ kind: "combobox", via: "state", path: "/pick/closing" });
        expect(lines).toHaveLength(2);
        const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const closed = [];
        for (const [index, [pickerName, entryName]] of [["Hour", "09"], ["Minute", "30"]].entries()) {
          const shape = new RegExp(
            `^${escape(`selectFrom: selected "${entryName}" in the picker "${pickerName}" on /pick/closing — its selected state shows it after `)}\\d+ ms${escape("; its list closed after ")}(\\d+) ms$`,
          );
          const found = shape.exec(lines[index]);
          expect(found, lines[index]).not.toBeNull();
          closed.push(Number(found[1]));
        }
        for (const ms of closed) expect(ms).toBeGreaterThan(0);
        const after = await page.evaluate(() => {
          const text = (name) => document.querySelector(`[role='combobox'][aria-label='${name}']`).textContent;
          return {
            hour: text("Hour"),
            minute: text("Minute"),
            hidden: document.querySelectorAll("[aria-hidden]").length,
            marked: document.querySelectorAll("[data-step-control]").length,
          };
        });
        expect(after).toEqual({ hour: "09", minute: "30", hidden: 0, marked: 0 });
      });
    });

    it("refuses by name a list that does not close within the bound, once the selection shows", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/closing");
        const before = performance.now();
        const error = await refusal(selectFrom(page, { picker: "Zone", entry: "UTC", record, bounds: BOUNDS }));
        const tookMs = performance.now() - before;
        expect(error.kind).toBe("not-closed");
        expect(error.message).toBe('selectFrom refused (not-closed): the list of the picker "Zone" on /pick/closing did not close within 800 ms of the selection of "UTC"');
        expect(lines).toEqual([error.message]);
        expect(tookMs).toBeGreaterThanOrEqual(800 - 2);
        expect(tookMs).toBeLessThan(2900);
        const zone = await page.evaluate(() => document.querySelector("[role='combobox'][aria-label='Zone']").textContent);
        expect(zone).toBe("UTC");
      });
    });

    it("refuses an entry the open list does not have, naming its entries, and leaves no mark", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/hiding");
        const error = await refusal(selectFrom(page, { picker: "Plan", entry: "Enterprise", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-entry");
        expect(error.message).toBe('selectFrom refused (no-entry): the picker "Plan" on /pick/hiding has no entry "Enterprise" — its entries: "Free", "Team"; nothing was selected');
        expect(lines).toEqual([error.message]);
        // The list is still open, so the combobox still carries aria-hidden; no control kept the step's mark.
        const after = await page.evaluate(() => ({
          hidden: document.querySelector("[aria-controls='hiding-plans']").getAttribute("aria-hidden"),
          marked: document.querySelectorAll("[data-step-control]").length,
        }));
        expect(after).toEqual({ hidden: "true", marked: 0 });
      });
    });

    it("types into a search field found by its accessible name, waits for its list, and presses the one entry of that name, not the row the list marks active", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/search");
        const result = await selectFrom(page, { picker: "Skills", entry: "Web search", record, bounds: BOUNDS });
        expect(result).toMatchObject({ picker: "Skills", entry: "Web search", kind: "search", via: "state", path: "/pick/search" });
        expect(lines).toEqual([`selectFrom: selected "Web search" in the picker "Skills" on /pick/search — the page draws it after ${result.elapsedMs} ms`]);
        // The row the page drew is the pressed entry's, not the first one's, and the field was emptied for the next search.
        const after = await page.evaluate(() => ({
          rows: Array.from(document.querySelectorAll("#search-skills-rows li"), (row) => row.firstElementChild.textContent),
          value: document.getElementById("search-skills").value,
          expanded: document.getElementById("search-skills").getAttribute("aria-expanded"),
          marked: document.querySelectorAll("[data-step-control]").length,
        }));
        expect(after).toEqual({ rows: ["Web search"], value: "", expanded: "false", marked: 0 });
      });
    });

    it("finds a search field with no accessible name by its placeholder, and again by its mark once the typed text has hidden the placeholder", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/search");
        const result = await selectFrom(page, { picker: "Search people…", entry: "Alan Turing", record, bounds: BOUNDS });
        expect(result).toMatchObject({ picker: "Search people…", entry: "Alan Turing", kind: "search", via: "state", path: "/pick/search" });
        expect(lines).toEqual([
          'selectFrom: selected "Alan Turing" in the picker "Search people…" (a combobox with no accessible name, found by its placeholder) on /pick/search — ' +
            `the page draws it after ${result.elapsedMs} ms`,
        ]);
        // The page drew a chip that names the entry in the field's place.
        const after = await page.evaluate(() => ({
          field: document.getElementById("search-people") !== null,
          chip: Array.from(document.querySelectorAll("[data-fixture-chip] > span"), (part) => part.textContent),
          marked: document.querySelectorAll("[data-step-control]").length,
        }));
        expect(after).toEqual({ field: false, chip: ["Alan Turing", "Research"], marked: 0 });
      });
    });

    it("finds a search field with no accessible name by the label before it, reads the entry back from the field, and then finds the field by that value", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/search");
        const first = await selectFrom(page, { picker: "Reviewer", entry: "Grace Hopper", record, bounds: BOUNDS });
        expect(first).toMatchObject({ picker: "Reviewer", entry: "Grace Hopper", kind: "search", via: "state" });
        const second = await selectFrom(page, { picker: "Grace Hopper", entry: "Grace Kelly", record, bounds: BOUNDS });
        expect(second).toMatchObject({ picker: "Grace Hopper", entry: "Grace Kelly", kind: "search", via: "state" });
        expect(lines).toEqual([
          'selectFrom: selected "Grace Hopper" in the picker "Reviewer" (a combobox with no accessible name, found by the label before it) on /pick/search — ' +
            `the field shows it after ${first.elapsedMs} ms`,
          'selectFrom: selected "Grace Kelly" in the picker "Grace Hopper" (a combobox with no accessible name, found by its value) on /pick/search — ' +
            `the field shows it after ${second.elapsedMs} ms`,
        ]);
        const after = await page.evaluate(() => ({
          value: document.getElementById("search-reviewers").value,
          marked: document.querySelectorAll("[data-step-control]").length,
        }));
        expect(after).toEqual({ value: "Grace Kelly", marked: 0 });
      });
    });

    it("never guesses between two entries of one name in a search field's list, and names the entries it showed when none has the name", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/search");
        const twin = await refusal(selectFrom(page, { picker: "Skills", entry: "Summary", record, bounds: BOUNDS }));
        expect(twin.kind).toBe("ambiguous");
        expect(twin.message).toBe('selectFrom refused (ambiguous): the picker "Skills" on /pick/search has 2 entries "Summary" — nothing was selected, since a selection never guesses');
        const none = await refusal(selectFrom(page, { picker: "Skills", entry: "Web", record, bounds: BOUNDS }));
        expect(none.kind).toBe("no-entry");
        expect(none.message).toBe(
          'selectFrom refused (no-entry): the list of the picker "Skills" on /pick/search showed no entry "Web" within 800 ms of typing it — ' +
            'the entries it showed: "Web search pro", "Web search", "Web scraper"; nothing was selected',
        );
        expect(lines).toEqual([twin.message, none.message]);
        const after = await page.evaluate(() => ({
          rows: document.querySelectorAll("#search-skills-rows li").length,
          marked: document.querySelectorAll("[data-step-control]").length,
        }));
        expect(after).toEqual({ rows: 0, marked: 0 });
      });
    });

    it("refuses a choice the page takes as another entry, whether the page draws it or the field shows it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/search");
        const drawn = await refusal(selectFrom(page, { picker: "Author", entry: "Dana", record, bounds: BOUNDS }));
        expect(drawn.kind).toBe("other-entry");
        expect(drawn.message).toBe('selectFrom refused (other-entry): the press on "Dana" in the list of the picker "Author" on /pick/search took another entry: the page draws "Dana Scully"');
        const shown = await refusal(selectFrom(page, { picker: "Assignee", entry: "Dana", record, bounds: BOUNDS }));
        expect(shown.kind).toBe("other-entry");
        expect(shown.message).toBe('selectFrom refused (other-entry): the press on "Dana" in the list of the picker "Assignee" on /pick/search took another entry: the field shows "Dana Scully"');
        expect(lines).toEqual([drawn.message, shown.message]);
        expect(await page.evaluate(() => document.querySelectorAll("[data-step-control]").length), "a control kept the step's mark").toBe(0);
      });
    });

    it("refuses a choice the page does not take, although the list marks the pressed row as its active one", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/search");
        const error = await refusal(selectFrom(page, { picker: "Editor", entry: "Eve", record, bounds: BOUNDS }));
        expect(error.kind).toBe("not-reflected");
        expect(error.message).toBe(
          'selectFrom refused (not-reflected): the selection of "Eve" in the picker "Editor" on /pick/search was not reflected within 800 ms: ' +
            "the field does not show it with its list closed, and no new text on the page names it",
        );
        expect(lines).toEqual([error.message]);
        // The pressed row reads aria-selected in the closed list: the list's active row, never a choice.
        const after = await page.evaluate(() => ({
          active: document.querySelector("#search-editor-list [role='option']").getAttribute("aria-selected"),
          marked: document.querySelectorAll("[data-step-control]").length,
        }));
        expect(after).toEqual({ active: "true", marked: 0 });
      });
    });

    it("refuses a search field whose list does not open once the entry is typed", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const selectFrom = await start(page, app, "/pick/search");
        const error = await refusal(selectFrom(page, { picker: "Viewer", entry: "Vic", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-entry");
        expect(error.message).toBe('selectFrom refused (no-entry): the picker "Viewer" on /pick/search showed no list of entries within 800 ms of typing "Vic" — nothing was selected');
        expect(lines).toEqual([error.message]);
        expect(await page.evaluate(() => document.querySelectorAll("[data-step-control]").length), "a control kept the step's mark").toBe(0);
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
