// dispatchRun: a run started from its card, found by the card's name, and the
// run or its notification waited for.
//
// The defect these cases stand for: a run started from a card was re-typed in
// every run, a press on whatever a selector found first and a wait for whatever
// the run happened to draw. The step presses the one card's one run control and
// returns once the page shows the run or a notification of it.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ actionMs: 2000, composerMs: 3000, runMs: 3000, pollMs: 25 });
const SHORT = Object.freeze({ ...BOUNDS, runMs: 700 });
// Built from parts at run time: the prompt reaches the composer and no line.
const PROMPT = ["start", "the", "fixture", "run", "now"].join(" ");

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`dispatchRun [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}/cards/start`);
      return theSteps("dispatchRun").dispatchRun;
    };

    it("starts a run from the product's agent card and waits for the run page's surface", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const dispatchRun = await start(page, app);
        const result = await dispatchRun(page, { card: "Research assistant", record, bounds: BOUNDS });
        expect(result).toMatchObject({ card: "Research assistant", via: "run", path: "/run/settles" });
        expect(result.state).toMatch(/^status:(queued|running|needs-review)$/);
        expect(app.requests.filter((request) => request.path === "/cards/launch/run")).toHaveLength(1);
        expect(lines).toEqual([
          `dispatchRun: the run from the card "Research assistant" shows on /run/settles after ${result.elapsedMs} ms (${result.state})`,
        ]);
      });
    });

    it("waits for the notification of a run its card starts in place", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const dispatchRun = await start(page, app);
        const result = await dispatchRun(page, { card: "Blog writer", record, bounds: BOUNDS });
        expect(result).toMatchObject({ via: "notification", state: "Run started: Blog writer", path: "/cards/start" });
        expect(lines).toEqual([
          `dispatchRun: the page notifies of the run from the card "Blog writer" after ${result.elapsedMs} ms: "Run started: Blog writer"`,
        ]);
      });
    });

    for (const [card, instead, shows] of [
      ["Inert agent", "/cards/start", ""],
      ["Failing agent", "/cards/start", '; it shows an error: "Could not start the agent."'],
      ["Broken agent", "/cards/nothing", ""],
    ]) {
      it(`refuses by name a press that shows neither a run nor a notification (${card})`, async () => {
        await scene(backend, {}, async ({ app, page, record, lines }) => {
          const dispatchRun = await start(page, app);
          const error = await refusal(dispatchRun(page, { card, record, bounds: SHORT }));
          expect(error.name).toBe("StepRefusal");
          expect(error.step).toBe("dispatchRun");
          expect(error.kind).toBe("no-run");
          expect(error.message).toBe(
            `dispatchRun refused (no-run): the press on "Run" in the card "${card}" showed neither a run nor a notification within 700 ms (the page is on ${instead})${shows}`,
          );
          expect(lines).toEqual([error.message]);
        });
      });
    }

    it("refuses by name a card the page does not show, naming the cards it shows", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const dispatchRun = await start(page, app);
        const before = app.requests.length;
        const error = await refusal(dispatchRun(page, { card: "Research Assistant", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-card");
        expect(error.message).toBe(
          'dispatchRun refused (no-card): no shown card on /cards/start is named "Research Assistant" — the cards it shows: "Research assistant", ' +
            '"Blog writer", "Inert agent", "Failing agent", "Broken agent", "Draft agent", "Twin agent", "Double agent", "Locked agent", "Chat agent"; nothing was pressed',
        );
        expect(app.requests.length).toBe(before);
      });
    });

    it("never starts a run from a guess: two cards of one name, or two controls of one name", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const dispatchRun = await start(page, app);
        const before = app.requests.length;
        const twin = await refusal(dispatchRun(page, { card: "Twin agent", record, bounds: BOUNDS }));
        expect(twin.kind).toBe("ambiguous");
        expect(twin.message).toBe('dispatchRun refused (ambiguous): 2 shown cards on /cards/start are named "Twin agent" — nothing was pressed, since a run is never started from a guess');
        const double = await refusal(dispatchRun(page, { card: "Double agent", record, bounds: BOUNDS }));
        expect(double.kind).toBe("ambiguous");
        expect(double.message).toBe(
          'dispatchRun refused (ambiguous): the card "Double agent" on /cards/start has 2 shown controls named "Run", a link and a button — nothing was pressed, since a run is never started from a guess',
        );
        expect(app.requests.length, "a refused dispatch reached the app").toBe(before);
      });
    });

    it("refuses a card without its run control, naming the controls it has, and a disabled one", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const dispatchRun = await start(page, app);
        const draft = await refusal(dispatchRun(page, { card: "Draft agent", record, bounds: BOUNDS }));
        expect(draft.kind).toBe("no-control");
        expect(draft.message).toBe('dispatchRun refused (no-control): the card "Draft agent" on /cards/start has no shown button or link named "Run" — its controls: "Open"; nothing was pressed');
        const locked = await refusal(dispatchRun(page, { card: "Locked agent", record, bounds: BOUNDS }));
        expect(locked.kind).toBe("disabled");
        expect(locked.message).toBe('dispatchRun refused (disabled): the control "Run" of the card "Locked agent" on /cards/start is disabled — nothing was pressed');
        // Another control of the card, by its name.
        const settings = await refusal(dispatchRun(page, { card: "Research assistant", control: "Settings", record, bounds: SHORT }));
        expect(settings.kind).toBe("no-run");
        expect(new URL(page.url()).pathname).toBe("/nav/target");
      });
    });

    // The composer is found by its role and its name, never by its placeholder:
    // an empty conversation shows "Ask anything...", one with messages "Type a message...".
    for (const [path, which] of [
      ["/conversation/empty", "an empty conversation"],
      ["/conversation/thread", "a conversation with messages and an earlier run"],
    ]) {
      it(`sends the prompt through the composer of ${which}, and waits for the new run`, async () => {
        await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
          const { dispatchRun } = theSteps("dispatchRun");
          await page.goto(`${app.origin}${path}`);
          const result = await dispatchRun(page, { prompt: PROMPT, record, bounds: BOUNDS });
          expect(result).toMatchObject({ card: null, via: "run", state: "status:queued", path });
          expect(lines).toEqual([`dispatchRun: the run sent through the composer "Send message" shows on ${path} after ${result.elapsedMs} ms (status:queued)`]);
        });
      });
    }

    it("presses a card that opens a conversation, then sends the prompt through its composer", async () => {
      await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
        const dispatchRun = await start(page, app);
        const result = await dispatchRun(page, { card: "Chat agent", prompt: PROMPT, record, bounds: BOUNDS });
        expect(result).toMatchObject({ card: "Chat agent", via: "run", state: "status:queued", path: "/conversation/empty" });
        expect(lines).toEqual([
          `dispatchRun: the run from the card "Chat agent", sent through the composer "Send message" shows on /conversation/empty after ${result.elapsedMs} ms (status:queued)`,
        ]);
      });
    });

    it("refuses by name a page without the composer, naming its text boxes including platform placeholder names", async () => {
      await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
        const { dispatchRun } = theSteps("dispatchRun");
        await page.goto(`${app.origin}/conversation/boxes`);
        const error = await refusal(dispatchRun(page, { prompt: PROMPT, record, bounds: { ...BOUNDS, composerMs: 300 } }));
        expect(error.kind).toBe("no-composer");
        expect(error.message).toBe(
          'dispatchRun refused (no-composer): no shown text box on /conversation/boxes is named "Send message" within 300 ms — ' +
            'the text boxes it shows: "Search", "Notes", "Type a message..."; no prompt was sent',
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("presses nothing when it refuses its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const dispatchRun = await start(page, app);
        const before = app.requests.length;
        const nothing = "nothing was pressed";
        const cases = [
          [{ record }, `name the card to start the run from, or the prompt to send, or both — ${nothing}`],
          [{ record, card: " " }, `name the card by its accessible name, such as Research assistant — ${nothing}`],
          [{ record, prompt: "" }, `hand the step a prompt with some text to send — ${nothing}`],
          [{ record, prompt: PROMPT, composer: "" }, `name the composer, such as Send message — ${nothing}`],
          [{ record, card: "Blog writer", control: "" }, `name the card's run control, such as Run — ${nothing}`],
          [{ record, card: "Blog writer", bounds: { runMs: 0 } }, `runMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, card: "Blog writer", bounds: { rowMs: 5 } }, `there is no bound named rowMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(dispatchRun(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`dispatchRun refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(dispatchRun(page, { card: "Blog writer" }));
        expect(unrecorded.message).toBe("dispatchRun refused (input): hand the step a record callback — nothing was done");
        expect(app.requests.length, "a refused call pressed or loaded something").toBe(before);
      });
    });
  });
}

describe("dispatchRun, its bound", () => {
  it("names its bound, its control and what it waits for", () => {
    const steps = theSteps("dispatchRun");
    expect(steps.DISPATCH_RUN_BOUND_MS).toBe(120_000);
    expect(steps.DISPATCH_RUN_CONTROL).toBe("Run");
    expect(steps.DISPATCH_RUN_COMPOSER).toBe("Send message");
    expect(steps.DISPATCH_RUN_BOUNDS).toEqual({
      actionMs: steps.CONTROL_ACTION_BOUND_MS,
      composerMs: steps.DISPATCH_RUN_COMPOSER_BOUND_MS,
      runMs: steps.DISPATCH_RUN_BOUND_MS,
      pollMs: steps.CONTROL_POLL_MS,
    });
    expect(steps.DISPATCH_RUN_SELECTOR).toBe(`${steps.RUN_SURFACE_SELECTOR}, [data-run-progress-panel]`);
  });
});
