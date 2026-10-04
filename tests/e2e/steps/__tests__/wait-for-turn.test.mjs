// waitForTurn: a turn of a run window's conversation waited for without a
// reload: a new entry of the assistant stands in the window, and its send
// control is idle again.
//
// The gap these cases stand for: after a message was sent in a run window or a
// review window, nothing waited for the answer; a run reloaded the page, which
// reads what the run stored and not the window a person watches, or it slept.
// The browser leg is what proves that the wait reads the page as it changes in
// place: one document, one load, from the send to the answer.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { RUN_WINDOW_NAME } from "./fixture-app-windows.mjs";

afterAll(closeBrowser);

const TYPE_BOUNDS = Object.freeze({ fieldMs: 1500, actionMs: 2000, sentMs: 1500, pollMs: 25 });
const BOUNDS = Object.freeze({ turnMs: 3000, pollMs: 25 });
const TEXT = ["what", "does", "the", "brief", "need"].join(" ");
const NAMED = `"${RUN_WINDOW_NAME}"`;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`waitForTurn [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("typeInWindow", "waitForTurn");
    };
    const loads = (app, path) => app.requests.filter((request) => request.method === "GET" && request.path === path);
    const timeOrigin = (page) => page.evaluate(() => performance.timeOrigin);

    it("waits, without a reload, until the assistant's entry stands and the send control is idle again", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const { typeInWindow, waitForTurn } = await open(page, app, "/window/turn");
        const origin = await timeOrigin(page);
        await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, send: true, record, bounds: TYPE_BOUNDS });
        const result = await waitForTurn(page, { record, bounds: BOUNDS });
        expect(result).toEqual({
          field: RUN_WINDOW_NAME,
          before: { person: 1, assistant: 1 },
          after: { person: 2, assistant: 2 },
          since: "send",
          elapsedMs: expect.any(Number),
          path: "/window/turn",
        });
        // The window answers 300 ms after the send, and the wait began after it.
        expect(result.elapsedMs).toBeLessThan(3000);
        expect(lines[1]).toBe(
          `waitForTurn: a new entry of the assistant stands in the window ${NAMED} on /window/turn after ${result.elapsedMs} ms, and its send control is idle; ` +
            "the person's entries went from 1 to 2 and the assistant's went from 1 to 2, counted from the send",
        );
        expect(await page.evaluate(() => document.querySelector('[data-fixture-window-send="turn"]').getAttribute("aria-label"))).toBe(RUN_WINDOW_NAME);
        expect(loads(app, "/window/turn"), "the page was loaded again").toHaveLength(1);
        expect(await timeOrigin(page), "the page is another document").toBe(origin);
      });
    });

    it("counts from the send: an answer that stood before the wait began is the new turn", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const { typeInWindow, waitForTurn } = await open(page, app, "/window/at-once");
        await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, send: true, record, bounds: TYPE_BOUNDS });
        // The window answered at once, before the wait's first reading.
        const result = await waitForTurn(page, { record, bounds: BOUNDS });
        expect(result).toMatchObject({ before: { person: 0, assistant: 0 }, after: { person: 1, assistant: 1 }, since: "send", path: "/window/at-once" });
        expect(lines).toHaveLength(2);
        // The note of the send served its wait: a second wait counts from its own first reading.
        const again = await refusal(waitForTurn(page, { record, bounds: { turnMs: 300, pollMs: 25 } }));
        expect(again.kind).toBe("no-turn");
        expect(again.message).toBe(
          `waitForTurn refused (no-turn): within 300 ms no new entry of the assistant stood in the window ${NAMED} on /window/at-once; ` +
            "the person's entries stayed at 1 and the assistant's stayed at 1 — nothing was reloaded",
        );
      });
    });

    it("counts from its own first reading when the message was sent by another step", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const { typeInWindow, waitForTurn, press } = await open(page, app, "/window/slow");
        await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, record, bounds: TYPE_BOUNDS });
        // The send control pressed by its name: the window answers a second later.
        await press(page, { name: RUN_WINDOW_NAME, record, bounds: { actionMs: 2000, startMs: 50, settleMs: 2000, pollMs: 25 } });
        const result = await waitForTurn(page, { record, bounds: BOUNDS });
        expect(result).toMatchObject({ before: { person: 2, assistant: 1 }, after: { person: 2, assistant: 2 }, since: "wait", path: "/window/slow" });
        expect(lines[2]).toBe(
          `waitForTurn: a new entry of the assistant stands in the window ${NAMED} on /window/slow after ${result.elapsedMs} ms, and its send control is idle; ` +
            "the person's entries stayed at 2 and the assistant's went from 1 to 2",
        );
      });
    });

    it("ends a turn that never comes at its bound, and names what was missing", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const { typeInWindow, waitForTurn } = await open(page, app, "/window/never");
        await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, send: true, record, bounds: TYPE_BOUNDS });
        const before = performance.now();
        const never = await refusal(waitForTurn(page, { record, bounds: { turnMs: 800, pollMs: 25 } }));
        const tookMs = performance.now() - before;
        expect(never.name).toBe("StepRefusal");
        expect(never.step).toBe("waitForTurn");
        expect(never.kind).toBe("no-turn");
        expect(never.message).toBe(
          `waitForTurn refused (no-turn): within 800 ms no new entry of the assistant stood in the window ${NAMED} on /window/never, ` +
            'and its send control was not idle (the text box is locked, and the buttons nearest to it read "Stop"); ' +
            "the person's entries went from 1 to 2 and the assistant's stayed at 1, counted from the send — nothing was reloaded",
        );
        expect(tookMs).toBeGreaterThanOrEqual(800);
        expect(lines.at(-1)).toBe(never.message);
        expect(loads(app, "/window/never"), "the page was loaded again").toHaveLength(1);

        // The answer comes, and the window never stops waiting: only the idle send control is missing.
        await page.goto(`${app.origin}/window/stuck`);
        await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, send: true, record, bounds: TYPE_BOUNDS });
        const stuck = await refusal(waitForTurn(page, { record, bounds: { turnMs: 800, pollMs: 25 } }));
        expect(stuck.message).toBe(
          `waitForTurn refused (no-turn): within 800 ms the send control of the window ${NAMED} on /window/stuck was not idle ` +
            '(the text box is locked, and the buttons nearest to it read "Stop"); ' +
            "the person's entries went from 1 to 2 and the assistant's went from 1 to 2, counted from the send — nothing was reloaded",
        );
      });
    });

    it("waits in the window of the part named within, and refuses a window it cannot tell apart or does not find", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const { typeInWindow, waitForTurn } = await open(page, app, "/window/two");
        const twins = await refusal(waitForTurn(page, { record, bounds: BOUNDS }));
        expect(twins.kind).toBe("ambiguous");
        expect(twins.message).toBe(
          `waitForTurn refused (ambiguous): 2 shown text boxes on /window/two are named ${NAMED}: 1 in the region "Step", 2 in the region "Review" — nothing was waited for, since a wait never guesses`,
        );
        await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, within: "Review", send: true, record, bounds: TYPE_BOUNDS });
        const result = await waitForTurn(page, { within: "Review", record, bounds: BOUNDS });
        expect(result).toMatchObject({ before: { person: 0, assistant: 0 }, after: { person: 1, assistant: 1 }, since: "send", path: "/window/two" });
        expect(lines.at(-1)).toBe(
          `waitForTurn: a new entry of the assistant stands in the window ${NAMED} in the region "Review" on /window/two after ${result.elapsedMs} ms, and its send control is idle; ` +
            "the person's entries went from 0 to 1 and the assistant's went from 0 to 1, counted from the send",
        );
        await page.goto(`${app.origin}/window/fields`);
        const none = await refusal(waitForTurn(page, { record, bounds: BOUNDS }));
        expect(none.kind).toBe("no-window");
        expect(none.message).toBe(
          `waitForTurn refused (no-window): no shown text box on /window/fields is named ${NAMED} — the text boxes it shows: "Notes", "Budget", "Feedback"; nothing was waited for`,
        );
        // A window of another name, named by its box.
        const other = await refusal(waitForTurn(page, { field: "Budget", record, bounds: { turnMs: 300, pollMs: 25 } }));
        expect(other.kind).toBe("no-turn");
      });
    });

    it("takes its bound up to its ceiling, and waits for nothing when it refuses its arguments", async () => {
      await scene(backend, { secrets: [TEXT] }, async ({ app, page, record, lines }) => {
        const { typeInWindow, waitForTurn, TURN_CEILING_MS } = await open(page, app, "/window/at-once");
        const nothing = "nothing was waited for";
        const cases = [
          [{ record, field: " " }, `name the window by the accessible name of its text box, such as ${RUN_WINDOW_NAME} — ${nothing}`],
          [{ record, within: 7 }, `name the part of the page by the name of a landmark, a heading or a labelled section, such as Review — ${nothing}`],
          [{ record, bounds: { turnMs: TURN_CEILING_MS + 1 } }, `turnMs may be raised up to ${TURN_CEILING_MS} ms and no further — ${nothing}`],
          [{ record, bounds: { turnMs: 0 } }, `turnMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, bounds: { settleMs: 5 } }, `there is no bound named settleMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(waitForTurn(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`waitForTurn refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(waitForTurn(page, {}));
        expect(unrecorded.message).toBe("waitForTurn refused (input): hand the step a record callback — nothing was done");
        // The ceiling itself is a bound it takes.
        await typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, send: true, record, bounds: TYPE_BOUNDS });
        const result = await waitForTurn(page, { record, bounds: { turnMs: TURN_CEILING_MS } });
        expect(result.since).toBe("send");
      });
    });
  });
}

describe("waitForTurn, its bounds", () => {
  it("names its bound, the ceiling a caller may raise it to, and the product's marker of a window's entries", () => {
    const steps = theSteps("waitForTurn");
    expect(steps.TURN_BOUND_MS).toBe(120_000);
    expect(steps.TURN_CEILING_MS).toBe(600_000);
    expect(steps.TURN_POLL_MS).toBe(250);
    expect(steps.WAIT_FOR_TURN_BOUNDS).toEqual({ turnMs: steps.TURN_BOUND_MS, pollMs: steps.TURN_POLL_MS });
    expect(steps.RUN_WINDOW_ENTRY_ATTRIBUTE).toBe("data-run-window-entry");
  });
});
