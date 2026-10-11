// pressByTestId: an element without a role pressed by its test id and its
// text, and the page's next settled state.
//
// The defect these cases stand for: a picture run could not choose a type in
// the upload dialog. The rows of its type picker are list items with a click
// handler and a test id, and no role, so `press` has nothing to name there. The
// step finds such a row by its test id and its whole text, presses it only when
// exactly one shown element matches, refuses an element that `press` can find
// by its role and its name, and says in the record that the row has no role.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

// Short bounds, so a press that settles in place costs half a second, not two.
const BOUNDS = Object.freeze({ actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 });
const TEST_ID = "artifacts-picker-type";
const ID = `the test id "${TEST_ID}"`;
/** The line the step writes before a press on a row of the dialog. */
const noRole = (text, where = "") =>
  `pressByTestId: on /press/rows, the element of ${ID} with the text "${text}"${where} carries no role; it was found by its test id`;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`pressByTestId [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}/press/rows`);
      return theSteps("pressByTestId").pressByTestId;
    };
    /** The presses each element of the test id has taken, and which rows read as selected, in the page's order. */
    const clicks = (page, testId = TEST_ID) =>
      page.evaluate(
        (id) => Array.from(document.querySelectorAll(`[data-testid="${id}"]`), (element) => Number(element.getAttribute("data-fixture-clicks") ?? 0)),
        testId,
      );
    const selected = (page) =>
      page.evaluate(() => Array.from(document.querySelectorAll("[data-fixture-selects]"), (row) => row.getAttribute("data-selected")));
    const marks = (page) => page.evaluate(() => document.querySelectorAll("[data-step-control]").length);

    it("presses the one row of the test id and the text, says that it has no role, and returns once the page has settled in place", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        const before = app.requests.length;
        const result = await pressByTestId(page, { testId: TEST_ID, text: "Note pack:note Pack", record, bounds: BOUNDS });
        expect(result).toMatchObject({ name: "Note pack:note Pack", role: "", testId: TEST_ID, from: "/press/rows", path: "/press/rows", navigated: false });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(BOUNDS.startMs);
        expect(result.elapsedMs, "the step waited for a landing that could not come").toBeLessThan(BOUNDS.settleMs);
        expect(await clicks(page), "the row was not pressed once, or another element was pressed").toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
        expect(await selected(page)).toEqual(["true", "false"]);
        expect(await marks(page), "the row kept the step's mark").toBe(0);
        expect(app.requests.length, "a press that stays reached the app").toBe(before);
        expect(lines).toEqual([
          noRole("Note pack:note Pack"),
          `pressByTestId: pressed the element of ${ID} with the text "Note pack:note Pack" on /press/rows — no navigation started within 500 ms, and the page stayed on /press/rows`,
        ]);
      });
    });

    it("presses a row whose handler leaves the page and waits for the landing, with the fields press answers", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        const result = await pressByTestId(page, { testId: TEST_ID, text: "Open the target", record, bounds: BOUNDS });
        expect(Object.keys(result).sort()).toEqual(["elapsedMs", "from", "name", "navigated", "path", "role", "testId"]);
        expect(result).toMatchObject({ name: "Open the target", role: "", from: "/press/rows", path: "/nav/target", navigated: true });
        expect(new URL(page.url()).pathname).toBe("/nav/target");
        expect(lines).toEqual([
          noRole("Open the target"),
          `pressByTestId: pressed the element of ${ID} with the text "Open the target" on /press/rows — landed on /nav/target after ${result.elapsedMs} ms`,
        ]);
      });
    });

    it("folds the white space of the text the row draws, and reads no hidden part of it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        await pressByTestId(page, { testId: TEST_ID, text: "Plain text core:text", record, bounds: BOUNDS });
        expect(await selected(page)).toEqual(["false", "true"]);
        // The wanted text is folded as well.
        await pressByTestId(page, { testId: TEST_ID, text: "  Half\n", record, bounds: BOUNDS });
        expect(await clicks(page)).toEqual([0, 1, 0, 1, 0, 0, 0, 0]);
        expect(lines.filter((line) => line.includes("carries no role"))).toEqual([noRole("Plain text core:text"), noRole("Half")]);
      });
    });

    it("refuses a text no shown element of the test id shows, naming how many carry the test id and their texts; a hidden row and a part of a text are no match", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        const before = app.requests.length;
        const listed = '7 shown elements carry it, with the texts "Note pack:note Pack", "Plain text core:text", "Half", "Open the target", "Save type", "Twin"';
        const hidden = await refusal(pressByTestId(page, { testId: TEST_ID, text: "Hidden pack:hidden", record, bounds: BOUNDS }));
        expect(hidden.name).toBe("StepRefusal");
        expect(hidden.step).toBe("pressByTestId");
        expect(hidden.kind).toBe("no-control");
        expect(hidden.message).toBe(
          `pressByTestId refused (no-control): no shown element on /press/rows carries ${ID} with the text "Hidden pack:hidden" — ${listed}; nothing was pressed`,
        );
        const part = await refusal(pressByTestId(page, { testId: TEST_ID, text: "Note", record, bounds: BOUNDS }));
        expect(part.kind).toBe("no-control");
        expect(part.message).toBe(`pressByTestId refused (no-control): no shown element on /press/rows carries ${ID} with the text "Note" — ${listed}; nothing was pressed`);
        // The text of a hidden part is no part of the row's text.
        const kept = await refusal(pressByTestId(page, { testId: TEST_ID, text: "Half kept apart", record, bounds: BOUNDS }));
        expect(kept.kind).toBe("no-control");
        const none = await refusal(pressByTestId(page, { testId: "no-such-id", text: "Note", record, bounds: BOUNDS }));
        expect(none.message).toBe(
          'pressByTestId refused (no-control): no shown element on /press/rows carries the test id "no-such-id" with the text "Note" — no shown element carries it; nothing was pressed',
        );
        expect(lines).toEqual([hidden.message, part.message, kept.message, none.message]);
        expect(await clicks(page), "a refused press reached an element").toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(app.requests.length, "a refused press reached the app").toBe(before);
        expect(await marks(page), "an element kept the step's mark").toBe(0);
      });
    });

    it("never guesses among several elements of the test id and the text: it presses nothing and names the part of the page each sits in", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        const error = await refusal(pressByTestId(page, { testId: TEST_ID, text: "Twin", record, bounds: BOUNDS }));
        expect(error.kind).toBe("ambiguous");
        expect(error.message).toBe(
          `pressByTestId refused (ambiguous): 2 shown elements on /press/rows carry ${ID} with the text "Twin": 1 in the region "First list", 2 in the region "Second list" — ` +
            "nothing was pressed, since a press never guesses",
        );
        expect(lines).toEqual([error.message]);
        expect(await clicks(page)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(await marks(page), "an element kept the step's mark").toBe(0);
      });
    });

    it("refuses an element with a role and an accessible name, since press is the step for it, and presses nothing", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        const error = await refusal(pressByTestId(page, { testId: TEST_ID, text: "Save type", record, bounds: BOUNDS }));
        expect(error.kind).toBe("has-role");
        expect(error.message).toBe(
          `pressByTestId refused (has-role): the element of ${ID} with the text "Save type" on /press/rows is a button named "Save type" — ` +
            "press is the step for it, by its role and its name; nothing was pressed",
        );
        expect(lines, "the step said the button has no role").toEqual([error.message]);
        expect(await clicks(page), "the button was pressed").toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(await marks(page), "the button kept the step's mark").toBe(0);
      });
    });

    it("looks only inside the one shown part of the page named within, and refuses a scope no part or several parts carry", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        const result = await pressByTestId(page, { testId: TEST_ID, text: "Twin", within: "Second list", record, bounds: BOUNDS });
        expect(result).toMatchObject({ name: "Twin", path: "/press/rows", navigated: false });
        expect(await clicks(page), "the row of the part named was not the one pressed").toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
        // A row that is on the page, but not within the part named.
        const elsewhere = await refusal(pressByTestId(page, { testId: TEST_ID, text: "Note pack:note Pack", within: "First list", record, bounds: BOUNDS }));
        expect(elsewhere.message).toBe(
          `pressByTestId refused (no-control): no shown element in the region "First list" on /press/rows carries ${ID} with the text "Note pack:note Pack" — ` +
            '1 shown element carries it, with the text "Twin"; nothing was pressed',
        );
        const none = await refusal(pressByTestId(page, { testId: TEST_ID, text: "Twin", within: "Nowhere", record, bounds: BOUNDS }));
        expect(none.kind).toBe("no-scope");
        expect(none.message).toBe(
          'pressByTestId refused (no-scope): no shown part of the page on /press/rows is named "Nowhere" — the named parts it shows: "Choose a type", "First list", ' +
            '"Second list", "Same list"; nothing was pressed',
        );
        const twin = await refusal(pressByTestId(page, { testId: "other-type", text: "Alone", within: "Same list", record, bounds: BOUNDS }));
        expect(twin.kind).toBe("ambiguous");
        expect(twin.message).toBe(
          'pressByTestId refused (ambiguous): 2 shown parts of the page on /press/rows are named "Same list": 1 a region in no named part of the page, ' +
            "2 a region in no named part of the page — nothing was pressed, since a press never guesses",
        );
        expect(lines).toEqual([
          noRole("Twin", ' in the region "Second list"'),
          `pressByTestId: pressed the element of ${ID} with the text "Twin" in the region "Second list" on /press/rows — no navigation started within 500 ms, and the page stayed on /press/rows`,
          elsewhere.message,
          none.message,
          twin.message,
        ]);
        expect(await clicks(page, "other-type"), "a refused scope reached an element").toEqual([0, 0]);
        expect(await marks(page), "an element kept the step's mark").toBe(0);
      });
    });

    it("presses nothing and touches no page when it refuses its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressByTestId = await start(page, app);
        const before = app.requests.length;
        // A page that refuses to be read: an argument refused before the page is touched never reads it.
        const touched = [];
        const watched = new Proxy(page, {
          get: (target, key) => {
            if (typeof key === "string" && ["evaluate", "locator", "url", "on"].includes(key)) touched.push(key);
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const nothing = "nothing was pressed";
        const noId = `name the element by its test id, such as artifacts-picker-type — ${nothing}`;
        const noText = `name the element by the text it shows, such as Note — ${nothing}`;
        const cases = [
          [{ record, text: "Note" }, noId],
          [{ record, testId: "  ", text: "Note" }, noId],
          [{ record, testId: 5, text: "Note" }, noId],
          [{ record, testId: TEST_ID }, noText],
          [{ record, testId: TEST_ID, text: " \n " }, noText],
          [{ record, testId: TEST_ID, text: ["Note"] }, noText],
          [{ record, testId: TEST_ID, text: "Note", within: "  " }, `name the scope by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`],
          [{ record, testId: TEST_ID, text: "Note", bounds: { startMs: 0 } }, `startMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, testId: TEST_ID, text: "Note", bounds: { waitMs: 5 } }, `there is no bound named waitMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(pressByTestId(watched, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`pressByTestId refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(pressByTestId(watched, { testId: TEST_ID, text: "Note" }));
        expect(unrecorded.message).toBe("pressByTestId refused (input): hand the step a record callback — nothing was done");
        expect(touched, "a refused call touched the page").toEqual([]);
        expect(app.requests.length, "a refused call pressed or loaded something").toBe(before);
      });
    });
  });
}

describe("pressByTestId, its bounds", () => {
  it("reads its test id from the attribute the product's tests use, and takes the bounds of press", () => {
    const steps = theSteps("pressByTestId", "press");
    expect(steps.TEST_ID_ATTRIBUTE).toBe("data-testid");
    expect(steps.PRESS_BY_TEST_ID_BOUNDS).toEqual(steps.PRESS_BOUNDS);
  });
});
