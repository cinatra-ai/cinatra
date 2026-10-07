// typeInWindow: text typed into a run window's text box through the keyboard,
// read back from the box, and sent through the window's own send control.
//
// The gap these cases stand for: a run window's text box is a box whose content
// is editable (role textbox), not an input, a textarea or a select, so fillForm
// finds no field in it, and a driver that used only the maintained steps could
// not type a message into a window. Every text below is built at run time, and
// each case checks that no text reaches a line the step wrote.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { DRAFT, RUN_WINDOW_NAME } from "./fixture-app-windows.mjs";

afterAll(closeBrowser);

// Short bounds, so a refusal costs a second, not minutes.
const BOUNDS = Object.freeze({ fieldMs: 1500, actionMs: 2000, sentMs: 1500, pollMs: 25 });
const TEXT = ["fill", "the", "title", "from", "the", "brief"].join(" ");
const DIGITS = ["abc", "123"].join("");
const NAMED = `"${RUN_WINDOW_NAME}"`;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`typeInWindow [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("typeInWindow").typeInWindow;
    };
    /** What a window's box holds, as a person reads it. */
    const boxText = (page, window) =>
      page.evaluate((name) => document.querySelector(`[data-fixture-window-box="${name}"]`).textContent.replace(/\u00a0/g, " "), window);
    /** How many entries of `who` the page shows. */
    const entries = (page, who) => page.evaluate((one) => document.querySelectorAll(`[data-run-window-entry="${one}"]`).length, who);

    it("types into the run window's text box, which is no form field, and reads the text back", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/turn");
        // fillForm fills inputs, textareas and selects: the window's box is none of them.
        const { fillForm } = theSteps("fillForm");
        const unfilled = await refusal(fillForm(page, { fields: { [RUN_WINDOW_NAME]: TEXT }, record: () => {}, bounds: { fieldsMs: 300, pollMs: 25 } }));
        expect(unfilled.kind).toBe("unknown-label");
        const result = await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, record, bounds: BOUNDS });
        expect(result).toEqual({ field: RUN_WINDOW_NAME, text: TEXT, sent: false, path: "/window/turn" });
        expect(await boxText(page, "turn")).toBe(TEXT);
        // The step's form has a text box of its own, "Title": it was not typed into.
        expect(await page.evaluate(() => document.querySelector('input[name="title"]').value)).toBe("");
        expect(await entries(page, "person"), "a message was sent").toBe(1);
        expect(lines).toEqual([`typeInWindow: typed into the text box ${NAMED} on /window/turn`]);
      });
    });

    it("types after the text the box holds, and with replace empties the box first", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/draft");
        const kept = await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, record, bounds: BOUNDS });
        expect(kept.text).toBe(`${DRAFT}${TEXT}`);
        expect(await boxText(page, "draft")).toBe(`${DRAFT}${TEXT}`);
        const replaced = await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, replace: true, record, bounds: BOUNDS });
        expect(replaced).toEqual({ field: RUN_WINDOW_NAME, text: TEXT, sent: false, path: "/window/draft" });
        expect(await boxText(page, "draft")).toBe(TEXT);
        expect(lines).toEqual([
          `typeInWindow: typed into the text box ${NAMED} on /window/draft`,
          `typeInWindow: replaced the text of the text box ${NAMED} on /window/draft`,
        ]);
      });
    });

    it("with send, presses the send control of the same window once the text is in, and the window takes the message", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/turn");
        // The window's send control is disabled while its box is empty, as the product's is.
        expect(await page.evaluate(() => document.querySelector('[data-fixture-window-send="turn"]').disabled)).toBe(true);
        const result = await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, send: true, record, bounds: BOUNDS });
        expect(result).toEqual({ field: RUN_WINDOW_NAME, text: TEXT, sent: true, path: "/window/turn" });
        expect(await boxText(page, "turn"), "the window did not take the message").toBe("");
        expect(await entries(page, "person")).toBe(2);
        expect(lines).toEqual([`typeInWindow: typed into the text box ${NAMED} on /window/turn, and pressed its send control: the window took the message`]);
      });
    });

    it("waits for a window the page mounts after it has loaded", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/late");
        const result = await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, record, bounds: BOUNDS });
        expect(result.text).toBe(TEXT);
        expect(lines).toEqual([`typeInWindow: typed into the text box ${NAMED} on /window/late`]);
      });
    });

    it("types into the window of the part named within, and never guesses between two windows of one name", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/two");
        const twins = await refusal(typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, record, bounds: BOUNDS }));
        expect(twins.name).toBe("StepRefusal");
        expect(twins.step).toBe("typeInWindow");
        expect(twins.kind).toBe("ambiguous");
        expect(twins.message).toBe(
          `typeInWindow refused (ambiguous): 2 shown text boxes on /window/two are named ${NAMED}: 1 in the region "Step", 2 in the region "Review" — nothing was typed, since typing never guesses`,
        );
        const result = await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, within: "Review", send: true, record, bounds: BOUNDS });
        expect(result).toEqual({ field: RUN_WINDOW_NAME, text: TEXT, sent: true, path: "/window/two" });
        expect(await page.evaluate(() => document.querySelectorAll('#review-entries [data-run-window-entry="person"]').length)).toBe(1);
        expect(await page.evaluate(() => document.querySelectorAll('#step-entries [data-run-window-entry="person"]').length)).toBe(0);
        const nowhere = await refusal(typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, within: "Summary", record, bounds: BOUNDS }));
        expect(nowhere.kind).toBe("no-scope");
        expect(nowhere.message).toBe(
          'typeInWindow refused (no-scope): no shown part of the page on /window/two is named "Summary" within 1500 ms — the named parts it shows: "Run", "Step", "Review"; nothing was typed',
        );
        expect(lines).toEqual([
          twins.message,
          `typeInWindow: typed into the text box ${NAMED} in the region "Review" on /window/two, and pressed its send control: the window took the message`,
          nowhere.message,
        ]);
      });
    });

    it("refuses by name a text box the page does not show, naming those it shows, and a locked one", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/turn");
        const missing = await refusal(typeInWindow(page, { field: "Ask Cinatra", text: TEXT, record, bounds: { ...BOUNDS, fieldMs: 300 } }));
        expect(missing.kind).toBe("no-field");
        expect(missing.message).toBe(
          `typeInWindow refused (no-field): no shown text box on /window/turn is named "Ask Cinatra" within 300 ms — the text boxes it shows: "Title", ${NAMED}; nothing was typed`,
        );
        await page.goto(`${app.origin}/window/locked`);
        const locked = await refusal(typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, record, bounds: BOUNDS }));
        expect(locked.kind).toBe("disabled");
        expect(locked.message).toBe(
          `typeInWindow refused (disabled): the text box ${NAMED} on /window/locked cannot be typed into: it is locked, as a window's box is while its answer is pending — nothing was typed`,
        );
        expect(await boxText(page, "locked")).toBe("");
        expect(lines).toEqual([missing.message, locked.message]);
      });
    });

    it("refuses by name a send with no send control, a box that does not read back what was typed, and a message the window does not take", async () => {
      await scene(backend, { secrets: [TEXT, DIGITS] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/fields");
        const unsent = await refusal(typeInWindow(page, { field: "Notes", text: TEXT, send: true, record, bounds: BOUNDS }));
        expect(unsent.kind).toBe("no-control");
        expect(unsent.message).toBe(
          'typeInWindow refused (no-control): the text box "Notes" on /window/fields has no shown send control beside it, a button named "Notes" — the buttons nearest to it: "Budget", "Feedback"; nothing was typed',
        );
        expect(await boxText(page, "notes"), "a refused send typed its text").toBe("");
        // The page keeps only the digits typed into this box.
        const altered = await refusal(typeInWindow(page, { field: "Budget", text: DIGITS, send: true, record, bounds: BOUNDS }));
        expect(altered.kind).toBe("not-typed");
        expect(altered.message).toBe('typeInWindow refused (not-typed): the text box "Budget" on /window/fields does not read back the text typed into it — nothing was sent');
        expect(await boxText(page, "budget"), "the box was sent after all").toBe("123");
        // The page takes no message sent from this box.
        const kept = await refusal(typeInWindow(page, { field: "Feedback", text: TEXT, send: true, record, bounds: { ...BOUNDS, sentMs: 400 } }));
        expect(kept.kind).toBe("not-sent");
        expect(kept.message).toBe(
          'typeInWindow refused (not-sent): the press on the send control of the text box "Feedback" on /window/fields did not send the message: the box still held it 400 ms after the press',
        );
        expect(lines).toEqual([unsent.message, altered.message, kept.message]);
      });
    });

    it("types nothing when it refuses its arguments", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const typeInWindow = await open(page, app, "/window/turn");
        const nothing = "nothing was typed";
        const field = RUN_WINDOW_NAME;
        const cases = [
          [{ record, text: TEXT }, `name the text box by its accessible name, such as ${RUN_WINDOW_NAME} — ${nothing}`],
          [{ record, field: " ", text: TEXT }, `name the text box by its accessible name, such as ${RUN_WINDOW_NAME} — ${nothing}`],
          [{ record, field }, `hand the step the text to type — ${nothing}`],
          [{ record, field, text: "" }, `hand the step the text to type — ${nothing}`],
          [{ record, field, text: `${TEXT}\nmore` }, `the text is typed key by key, so it may hold no line break or other control character: a line break would press Enter — ${nothing}`],
          [{ record, field, text: `${TEXT}\tmore` }, `the text is typed key by key, so it may hold no line break or other control character: a line break would press Enter — ${nothing}`],
          [{ record, field, text: TEXT, send: "yes" }, `send must be true or false — ${nothing}`],
          [{ record, field, text: TEXT, replace: 1 }, `replace must be true or false — ${nothing}`],
          [{ record, field, text: TEXT, within: " " }, `name the part of the page by the name of a landmark, a heading or a labelled section, such as Review — ${nothing}`],
          [{ record, field, text: TEXT, bounds: { sentMs: 0 } }, `sentMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, field, text: TEXT, bounds: { typeMs: 5 } }, `there is no bound named typeMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(typeInWindow(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`typeInWindow refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(typeInWindow(page, { field, text: TEXT }));
        expect(unrecorded.message).toBe("typeInWindow refused (input): hand the step a record callback — nothing was done");
        expect(await boxText(page, "turn"), "a refused call typed something").toBe("");
      });
    });
  });
}

describe("typeInWindow, its bounds", () => {
  it("names its bounds, and the run window's name its box and its send control carry", () => {
    const steps = theSteps("typeInWindow");
    expect(steps.RUN_WINDOW_FIELD).toBe(RUN_WINDOW_NAME);
    expect(steps.WINDOW_FIELD_BOUND_MS).toBe(30_000);
    expect(steps.WINDOW_SENT_BOUND_MS).toBe(5_000);
    expect(steps.TYPE_IN_WINDOW_BOUNDS).toEqual({
      fieldMs: steps.WINDOW_FIELD_BOUND_MS,
      actionMs: steps.CONTROL_ACTION_BOUND_MS,
      sentMs: steps.WINDOW_SENT_BOUND_MS,
      pollMs: steps.CONTROL_POLL_MS,
    });
  });
});
