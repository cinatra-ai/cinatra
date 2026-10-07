// readControlNames: every shown control of a page, read by its role and its
// accessible name with the reader the control steps use.
//
// The gap these cases stand for: the steps read a page's controls by role and
// name only inside press, selectFrom and dispatchRun, and no step answered that
// reading, so a check that a screen's controls carry accessible names (a
// section named by its heading, a picker and a button named for the row they
// belong to) had no step to stand on. A control without a name is listed with
// an empty name: a reading that left it out could not show that its name is
// missing.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";
import { NAMES_FULL_NAME, NAMES_LONG_NAME } from "./fixture-app.mjs";

afterAll(closeBrowser);

const control = (role, name, from, description = "") => ({ role, name, from, description });
/** The line the step writes for a control, as the specification spells it. */
const lineOf = ({ role, name, from }) => `readControlNames: ${JSON.stringify({ role, name, from })}`;

// Every shown control of /names/start, in the page's order, each with the source of its name.
const START = [
  control("navigation", "Main", "aria-label"),
  control("link", "Target", "text"),
  control("link", "", ""),
  control("region", "Plans", "aria-labelledby"),
  control("button", "Save plan", "text"),
  control("button", "Delete plan", "aria-label"),
  control("button", "", ""),
  control("button", "Refresh", "title"),
  control("textbox", "Title", "label", "Shown on the card."),
  control("textbox", "Owner", "aria-labelledby"),
  control("textbox", "Search plans", "placeholder"),
  control("combobox", "Size", "aria-label"),
  control("option", "Small", "text"),
  control("option", "Large", "text"),
  control("button", "Open draft", "text"),
  control("button", "First twin", "text"),
  control("button", "Second twin", "text"),
  control("region", "Notes", "aria-label"),
  control("form", "Filters", "aria-label"),
  control("group", "Colour", "label"),
  control("radio", "Red", "label"),
  control("button", "Send", "text"),
  control("dialog", "Confirm", "aria-labelledby"),
  control("button", "Close", "text"),
  control("alertdialog", "Discard the draft?", "aria-label"),
  control("button", "Discard", "text"),
  control("search", "Site", "aria-label"),
  control("searchbox", "Search the site", "aria-label"),
];
// The controls of the section "Plans", which its heading names.
const PLANS = START.slice(4, 14);

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`readControlNames [${labelOf(backend)}]`, () => {
    const start = async (page, app, path = "/names/start") => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("readControlNames").readControlNames;
    };

    it("lists every shown control, named or not, in the page's order, each with the source of its name", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app);
        const before = app.requests.length;
        const result = await readControlNames(page, { record });
        expect(result).toEqual({ controls: START, more: 0 });
        expect(app.requests.length, "the reading reached the app").toBe(before);
        expect(new URL(page.url()).pathname).toBe("/names/start");
        // One line per control, as the specification spells it.
        expect(lines).toEqual(START.map(lineOf));
        expect(lines[0]).toBe('readControlNames: {"role":"navigation","name":"Main","from":"aria-label"}');
        expect(lines[6]).toBe('readControlNames: {"role":"button","name":"","from":""}');
        expect(lines[8]).toBe('readControlNames: {"role":"textbox","name":"Title","from":"label"}');
      });
    });

    it("reads a section its heading names as a region with the heading's text, and a section a heading alone names for no one as no region", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const readControlNames = await start(page, app);
        const { controls } = await readControlNames(page, { record });
        expect(controls).toContainEqual(control("region", "Plans", "aria-labelledby"));
        expect(controls.filter((one) => one.role === "region").map((one) => one.name)).toEqual(["Plans", "Notes"]);
        // The section "Drafts" is no region, and its button is listed all the same.
        expect(controls).toContainEqual(control("button", "Open draft", "text"));
        // A form with no name is no form either.
        expect(controls.filter((one) => one.role === "form").map((one) => one.name)).toEqual(["Filters"]);
      });
    });

    it("leaves out a control hidden from assistive technology, one that is hidden, and one inside what is not drawn", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app);
        const { controls } = await readControlNames(page, { record });
        const names = controls.map((one) => one.name);
        for (const unseen of ["Hidden twin", "Not drawn", "Not displayed"]) {
          expect(names, `the reading lists ${unseen}`).not.toContain(unseen);
          expect(lines.some((line) => line.includes(unseen)), `a line names ${unseen}`).toBe(false);
        }
      });
    });

    it("reads only within the one part of the page named by within, and refuses a part that is absent or not unique", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app);
        const plans = await readControlNames(page, { record, within: "Plans" });
        expect(plans).toEqual({ controls: PLANS, more: 0 });
        expect(lines).toEqual(PLANS.map(lineOf));
        const none = await refusal(readControlNames(page, { record, within: "Nowhere" }));
        expect(none.name).toBe("StepRefusal");
        expect(none.step).toBe("readControlNames");
        expect(none.kind).toBe("no-scope");
        expect(none.message).toBe(
          'readControlNames refused (no-scope): no shown part of the page on /names/start is named "Nowhere" — the named parts it shows: "Main", "Plans and drafts", ' +
            '"Plans", "Drafts", "Twin", "Notes", "Filters", "Colour", "Confirm", "Discard the draft?"; nothing was listed',
        );
        const twin = await refusal(readControlNames(page, { record, within: "Twin" }));
        expect(twin.kind).toBe("ambiguous");
        expect(twin.message).toBe(
          'readControlNames refused (ambiguous): 2 shown parts of the page on /names/start are named "Twin": 1 a region in the region "Plans and drafts", ' +
            '2 a region in the region "Plans and drafts" — nothing was listed, since a reading never guesses',
        );
        expect(lines).toEqual([...PLANS.map(lineOf), none.message, twin.message]);
      });
    });

    it("refuses by name a page, or a part of it, that shows no control", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app, "/names/empty");
        const empty = await refusal(readControlNames(page, { record }));
        expect(empty.kind).toBe("no-control");
        expect(empty.message).toBe("readControlNames refused (no-control): no control is shown on /names/empty — nothing was listed");
        await page.goto(`${app.origin}/names/start`);
        const notes = await refusal(readControlNames(page, { record, within: "Notes" }));
        expect(notes.kind).toBe("no-control");
        expect(notes.message).toBe('readControlNames refused (no-control): no control is shown in the region "Notes" on /names/start — nothing was listed');
        expect(lines).toEqual([empty.message, notes.message]);
      });
    });

    it("writes a name whole up to its bound, cuts a longer one there with an ellipsis, and writes an address as one; the answer keeps each name whole", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app, "/names/long");
        const result = await readControlNames(page, { record });
        expect(NAMES_LONG_NAME).toHaveLength(400);
        expect(NAMES_FULL_NAME).toHaveLength(300);
        expect(result.controls.map((one) => one.name)).toEqual([NAMES_LONG_NAME, NAMES_FULL_NAME, expect.stringMatching(/^Read https:\/\/\S+ first$/)]);
        const cut = `${NAMES_LONG_NAME.slice(0, 299)}…`;
        expect(cut).toHaveLength(300);
        expect(lines).toEqual([
          `readControlNames: {"role":"button","name":"${cut}","from":"aria-label"}`,
          `readControlNames: {"role":"button","name":"${NAMES_FULL_NAME}","from":"aria-label"}`,
          'readControlNames: {"role":"link","name":"Read an address first","from":"text"}',
        ]);
      });
    });

    it("lists at most its bound of controls and counts the rest, on a line of their own", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app, "/names/many");
        const result = await readControlNames(page, { record });
        expect(result.more).toBe(5);
        expect(result.controls).toHaveLength(400);
        expect(result.controls[0]).toEqual(control("button", "Item 1", "text"));
        expect(result.controls[399]).toEqual(control("button", "Item 400", "text"));
        expect(lines).toHaveLength(401);
        expect(lines[399]).toBe('readControlNames: {"role":"button","name":"Item 400","from":"text"}');
        expect(lines[400]).toBe('readControlNames: {"more":5}');
      });
    });

    it("refuses by name a reading the driver could not take within its bound", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app, "/stream/frozen");
        // Its main thread is busy from 100 ms after its load, for two and a half seconds.
        await pause(250);
        const error = await refusal(readControlNames(page, { record, bounds: { readingMs: 300 } }));
        expect(error.kind).toBe("driver-failure");
        expect(error.message).toBe("readControlNames refused (driver-failure): the controls on /stream/frozen could not be read within 300 ms");
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses by name a reading of a closed page, and keeps only the error's class", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app);
        await page.close();
        const error = await refusal(readControlNames(page, { record }));
        expect(error.kind).toBe("driver-failure");
        expect(error.message).toBe("readControlNames refused (driver-failure): the controls on /names/start could not be read (Error)");
        expect(lines).toEqual([error.message]);
      });
    });

    it("reads nothing when it refuses its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const readControlNames = await start(page, app);
        const nothing = "nothing was read";
        const part = `name the part of the page by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`;
        const cases = [
          [{ record, within: "  " }, part],
          [{ record, within: 5 }, part],
          [{ record, bounds: { readingMs: 0 } }, `readingMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, bounds: { waitMs: 5 } }, `there is no bound named waitMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(readControlNames(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`readControlNames refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        expect(lines).toHaveLength(cases.length);
        const unrecorded = await refusal(readControlNames(page, {}));
        expect(unrecorded.message).toBe("readControlNames refused (input): hand the step a record callback — nothing was done");
      });
    });
  });
}

describe("readControlNames, its bounds", () => {
  it("names its bounds: the controls one reading lists, the characters of a name one line carries, and the one reading of the page", () => {
    const steps = theSteps("readControlNames");
    expect(steps.READ_CONTROL_NAMES_LIMIT).toBe(400);
    expect(steps.READ_CONTROL_NAME_LENGTH).toBe(300);
    expect(steps.READ_CONTROL_NAMES_BOUNDS).toEqual({ readingMs: steps.READING_BOUND_MS });
  });
});
