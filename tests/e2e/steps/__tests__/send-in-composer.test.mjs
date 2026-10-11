// sendInComposer: one message sent through the conversation's composer, and the
// card that answers it waited for.
//
// The gap these cases stand for: dispatchRun sends through the composer too, but
// it is the act of starting a run and refuses a message that starts none, so a
// chat message whose answer is a card and no run had no step. A message that
// starts a run is refused here in turn, since starting a run is dispatchRun's
// act. The prompt is built at run time; no line may carry it.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { COMPOSER_NAME, DRAFT } from "./fixture-app-windows.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ composerMs: 1500, actionMs: 2000, sentMs: 1500, cardMs: 3000, pollMs: 25 });
const SHORT = Object.freeze({ ...BOUNDS, cardMs: 700 });
const PROMPT = ["schedule", "the", "brief", "every", "monday"].join(" ");
const NAMED = `"${COMPOSER_NAME}"`;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`sendInComposer [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("sendInComposer").sendInComposer;
    };
    /** The messages the conversation shows, as a person reads them. */
    const thread = (page) => page.evaluate(() => Array.from(document.querySelectorAll("#composer-thread > li"), (item) => item.textContent));

    for (const [path, kind] of [
      ["/composer/card", "trigger_schedule_proposal"],
      ["/composer/view", "artifact_preview"],
    ]) {
      it(`sends one message through the composer and answers the kind of the card that answers it (${kind})`, async () => {
        await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
          const sendInComposer = await open(page, app, path);
          const result = await sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, record, bounds: BOUNDS });
          expect(result).toEqual({ composer: COMPOSER_NAME, kind, path, elapsedMs: expect.any(Number) });
          expect((await thread(page))[0]).toBe(PROMPT);
          expect(lines).toEqual([`sendInComposer: the message sent through the composer ${NAMED} on ${path} is answered with a card ${kind} on ${path} after ${result.elapsedMs} ms`]);
        });
      });
    }

    for (const path of ["/composer/inline-run", "/composer/inline-run-after-old", "/composer/inline-run-new-thread"]) {
      it(`returns the new run ID from a chat card without waiting for a run panel (${path})`, async () => {
        await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
          const sendInComposer = await open(page, app, path);
          const result = await sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, expect: "run", record, bounds: BOUNDS });
          const threadPath = path.endsWith("new-thread") ? "/chat/fixture-created-thread" : path;
          expect(result).toEqual({ composer: COMPOSER_NAME, runId: "fixture-run-new", threadPath, elapsedMs: expect.any(Number) });
          expect((await thread(page)).at(-2)).toBe(PROMPT);
          expect(lines).toEqual([`sendInComposer: the message sent through the composer ${NAMED} on ${path} started run "fixture-run-new" on ${threadPath} after ${result.elapsedMs} ms`]);
        });
      });
    }

    for (const path of ["/composer/card", "/composer/notify", "/composer/inline-old-only", "/composer/inline-hidden", "/composer/inline-unnamed", "/composer/error"]) {
      it(`refuses an expected run without a new visible concrete ID within the bound (${path})`, async () => {
        await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
          const sendInComposer = await open(page, app, path);
          const error = await refusal(sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, expect: "run", record, bounds: SHORT }));
          expect(error.kind).toBe("no-run");
          expect(error.message).toContain("no new run ID within 700 ms");
          if (path === "/composer/error") expect(error.message).toContain("The assistant could not answer.");
          expect(lines).toEqual([error.message]);
        });
      });
    }

    it("sends the prompt alone in place of a draft, and counts only a card the conversation did not show before", async () => {
      await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record }) => {
        const sendInComposer = await open(page, app, "/composer/thread");
        const result = await sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, record, bounds: BOUNDS });
        expect(result).toMatchObject({ kind: "citation_group", path: "/composer/thread" });
        const messages = await thread(page);
        expect(messages.at(-2), "the draft went with the message").toBe(PROMPT);
        expect(messages.join(" ")).not.toContain(DRAFT);
      });
    });

    for (const [path, how] of [
      ["/composer/run", "it shows on /composer/run (status:queued)"],
      ["/composer/notify", 'the page notifies of it: "Run started: Research assistant"'],
    ]) {
      it(`refuses a message that starts a run, since that is dispatchRun's act (${path})`, async () => {
        await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
          const sendInComposer = await open(page, app, path);
          const error = await refusal(sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, record, bounds: BOUNDS }));
          expect(error.name).toBe("StepRefusal");
          expect(error.step).toBe("sendInComposer");
          expect(error.kind).toBe("starts-run");
          expect(error.message).toBe(
            `sendInComposer refused (starts-run): the message sent through the composer ${NAMED} on ${path} started a run: ${how} — starting a run is dispatchRun's act`,
          );
          expect(lines).toEqual([error.message]);
        });
      });
    }

    for (const [path, shows] of [
      ["/composer/quiet", ""],
      ["/composer/error", '; it shows an error: "The assistant could not answer."'],
    ]) {
      it(`refuses by name an answer that brings no card within the bound (${path})`, async () => {
        await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
          const sendInComposer = await open(page, app, path);
          const error = await refusal(sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, record, bounds: SHORT }));
          expect(error.kind).toBe("no-card");
          expect(error.message).toBe(
            `sendInComposer refused (no-card): the message sent through the composer ${NAMED} on ${path} was answered with no card within 700 ms (the page is on ${path})${shows}`,
          );
          expect(lines).toEqual([error.message]);
        });
      });
    }

    it("refuses by name a page without the composer, naming its text boxes, and sends nothing", async () => {
      await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
        const sendInComposer = await open(page, app, "/conversation/boxes");
        const error = await refusal(sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, record, bounds: { ...BOUNDS, composerMs: 300 } }));
        expect(error.kind).toBe("no-composer");
        expect(error.message).toBe(
          `sendInComposer refused (no-composer): no shown text box on /conversation/boxes is named ${NAMED} within 300 ms — the text boxes it shows: "Notes", "Type a message..."; nothing was typed`,
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("sends nothing when it refuses its arguments", async () => {
      await scene(backend, { secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
        const sendInComposer = await open(page, app, "/composer/card");
        const nothing = "nothing was sent";
        const cases = [
          [{ record, composer: COMPOSER_NAME }, `hand the step a prompt with some text to send — ${nothing}`],
          [{ record, composer: COMPOSER_NAME, prompt: " " }, `hand the step a prompt with some text to send — ${nothing}`],
          [
            { record, composer: COMPOSER_NAME, prompt: `${PROMPT}\nmore` },
            `the prompt is typed key by key, so it may hold no line break or other control character: a line break would press Enter — ${nothing}`,
          ],
          [{ record, prompt: PROMPT }, `name the composer, such as ${COMPOSER_NAME} — ${nothing}`],
          [{ record, prompt: PROMPT, composer: "" }, `name the composer, such as ${COMPOSER_NAME} — ${nothing}`],
          [{ record, prompt: PROMPT, composer: COMPOSER_NAME, expect: "guess", bounds: SHORT }, `expect must be card or run — ${nothing}`],
          [{ record, prompt: PROMPT, composer: COMPOSER_NAME, bounds: { cardMs: -1 } }, `cardMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, prompt: PROMPT, composer: COMPOSER_NAME, bounds: { runMs: 5 } }, `there is no bound named runMs — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(sendInComposer(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`sendInComposer refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME }));
        expect(unrecorded.message).toBe("sendInComposer refused (input): hand the step a record callback — nothing was done");
        expect(await thread(page), "a refused call sent a message").toEqual([]);
      });
    });
  });
}

describe("sendInComposer, its bounds", () => {
  it("names its bounds, and the cards it reads an answer's kind from", () => {
    const steps = theSteps("sendInComposer");
    expect(steps.COMPOSER_CARD_BOUND_MS).toBe(120_000);
    expect(steps.SEND_IN_COMPOSER_BOUNDS).toEqual({
      composerMs: steps.DISPATCH_RUN_COMPOSER_BOUND_MS,
      actionMs: steps.CONTROL_ACTION_BOUND_MS,
      sentMs: steps.WINDOW_SENT_BOUND_MS,
      cardMs: steps.COMPOSER_CARD_BOUND_MS,
      pollMs: steps.CONTROL_POLL_MS,
    });
    expect(steps.COMPOSER_CARD_SELECTOR).toBe("[data-lifecycle-card], [data-view-type]");
    expect(steps.COMPOSER_CARD_KIND_ATTRIBUTES).toEqual(["data-lifecycle-card", "data-view-type"]);
    expect(steps.COMPOSER_ERROR_SELECTOR).toBe(`${steps.DISPATCH_RUN_ERROR_SELECTOR}, [data-chat-error-card]`);
  });
});
