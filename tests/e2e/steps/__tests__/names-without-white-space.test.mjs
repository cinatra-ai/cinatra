// press, selectFrom and the within scope: a wanted name names a control when
// both read the same once all white space is removed.
//
// The defect these cases stand for: a step rail's tab draws a number and a
// label as two parts with no white space between them, so its accessible name
// reads "3Select blog idea", and press refused the name a person reads, "3
// Select blog idea". fillForm matched a label without its white space already;
// press, selectFrom and the within scope compared the name as written. A name
// that reads the same exactly still wins, and several controls that match only
// without their white space are refused, each named as the page reads it.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

// Short bounds, so a press that settles in place costs a third of a second.
const BOUNDS = Object.freeze({ actionMs: 2000, startMs: 300, settleMs: 5000, pollMs: 25 });
const SELECT_BOUNDS = Object.freeze({ actionMs: 2000, reflectMs: 2000, pollMs: 25 });
/** The line of a press that started no navigation on the page. */
const stayed = (what) => `press: pressed ${what} on /joined/start — no navigation started within 300 ms, and the page stayed on /joined/start`;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`names without their white space [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}/joined/start`);
      return theSteps("press", "selectFrom", "readControlNames");
    };
    const isShown = (page, selector) => page.evaluate((one) => !document.querySelector(one).hasAttribute("hidden"), selector);
    const hideAgain = (page, selector) => page.evaluate((one) => document.querySelector(one).setAttribute("hidden", ""), selector);
    const marks = (page) => page.evaluate(() => document.querySelectorAll("[data-step-control]").length);

    it("presses a tab whose name joins a number and a label, by the name a person reads and by the name as the page reads it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { press } = await start(page, app);
        const spaced = await press(page, { name: "3 Select blog idea", role: "tab", record, bounds: BOUNDS });
        expect(spaced).toMatchObject({ name: "3 Select blog idea", role: "tab", from: "/joined/start", navigated: false });
        expect(await isShown(page, "#joined-step-3"), "the tab was not pressed").toBe(true);
        await hideAgain(page, "#joined-step-3");
        await press(page, { name: "3Select blog idea", role: "tab", record, bounds: BOUNDS });
        expect(await isShown(page, "#joined-step-3"), "the tab was not pressed by the name as the page reads it").toBe(true);
        expect(await isShown(page, "#joined-step-1"), "another tab was pressed").toBe(false);
        expect(lines).toEqual([stayed('the tab "3 Select blog idea"'), stayed('the tab "3Select blog idea"')]);
      });
    });

    it("refuses as ambiguous a name that several tabs read only without white space, naming each as the page reads it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { press } = await start(page, app);
        const error = await refusal(press(page, { name: "4 Review draft", role: "tab", record, bounds: BOUNDS }));
        expect(error.kind).toBe("ambiguous");
        expect(error.message).toBe(
          'press refused (ambiguous): 2 shown tabs on /joined/start are named "4 Review draft" once white space is removed (the page reads "4Review draft", ' +
            '"4 Reviewdraft"): 1 in the group "Steps", 2 in the group "Steps" — nothing was pressed, since a press never guesses',
        );
        expect(lines).toEqual([error.message]);
        expect(await marks(page), "a control kept the step's mark").toBe(0);
      });
    });

    it("takes the control whose name reads the same exactly over one whose name reads the same only without white space", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { press } = await start(page, app);
        await press(page, { name: "Save draft", record, bounds: BOUNDS });
        expect(await isShown(page, "#joined-saved"), "the control named exactly was not pressed").toBe(true);
        expect(await isShown(page, "#joined-saved-joined"), "the control named only without white space was pressed").toBe(false);
        expect(lines).toEqual([stayed('the button "Save draft"')]);
      });
    });

    it("finds the part of the page named by a heading whose parts join, by both spellings, for press and for readControlNames", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { press, readControlNames } = await start(page, app);
        await press(page, { name: "Add", within: "2 Draft", record, bounds: BOUNDS });
        expect(await isShown(page, "#joined-added"), "the part's control was not pressed").toBe(true);
        await hideAgain(page, "#joined-added");
        await press(page, { name: "Add", within: "2Draft", record, bounds: BOUNDS });
        expect(await isShown(page, "#joined-added"), "the part's control was not pressed by the name as the page reads it").toBe(true);
        const read = await readControlNames(page, { record, within: "2 Draft" });
        expect(read).toEqual({ controls: [{ role: "button", name: "Add", from: "text", description: "" }], more: 0 });
        expect(lines).toEqual([
          stayed('the button "Add" in the region "2 Draft"'),
          stayed('the button "Add" in the region "2Draft"'),
          'readControlNames: {"role":"button","name":"Add","from":"text"}',
        ]);
      });
    });

    it("chooses a picker's entry whose name joins parts, by both spellings, in a picker whose name joins parts", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { selectFrom } = await start(page, app);
        for (const entry of ["3 Select blog idea", "3Select blog idea"]) {
          await page.goto(`${app.origin}/joined/start`);
          const result = await selectFrom(page, { picker: "Blog ideas", entry, record, bounds: SELECT_BOUNDS });
          expect(result).toMatchObject({ picker: "Blog ideas", entry, kind: "listbox", via: "confirmation", path: "/joined/start" });
          expect(lines.at(-1)).toBe(
            `selectFrom: selected "${entry}" in the picker "Blog ideas" on /joined/start — the page confirms it after ${result.elapsedMs} ms: "Idea: 3 Select blog idea"`,
          );
        }
        expect(lines).toHaveLength(2);
      });
    });
  });
}
