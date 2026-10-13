// holdResponse and releaseResponse: the requests of a page that a pattern
// matches, held unsent from the arming until they are released, so the
// short-lived state their answers would end stays on the page.
//
// The gap these cases stand for: a picture round had to photograph a state that
// lasts less than a wait and a shutter (the run page's loading moment right
// after a decision, ended by the page's refresh), and could only race it; the
// frame came after the refresh and showed the next state. The fixture page
// (fixture-app-hold.mjs) draws such a state: a press on Continue shows the
// step's loading state, and the app's answer, 100 ms after the request reaches
// it, takes its place. The first case shows the race the step removes; the
// others hold it. The browser leg is what proves that a held request is not
// sent: the app records no request for it until the release.
import { readFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";
import { HOLD_ANSWER_PATH, HOLD_ANSWER_QUERY, HOLD_LOADING, HOLD_PAGE_PATH, HOLD_QUESTION, holdAnswer } from "./fixture-app-hold.mjs";

afterAll(closeBrowser);

const README = new URL("../README.md", import.meta.url);

/** The pattern the cases hold the page's refresh with: its address and the start of its query. */
const PATTERN = /\/hold\/answer\?part=/;

/** How long a case lets the page go on before it reads it: ten times the app's answer time. */
const LONG_ENOUGH_MS = 1_000;

/** How far short of its delay a Node timer can end, read on performance.now(). */
const TIMER_CLOCK_SLACK_MS = 2;

/** The step's detail, as the page holds it now. */
const detailOf = (page) => page.evaluate(() => document.getElementById("hold-detail").innerHTML);

/** Read the detail until it is `want`, for at most `ms`; the last reading. */
async function detailBecomes(page, want, ms = 5_000) {
  const until = performance.now() + ms;
  let detail = await detailOf(page);
  while (detail !== want && performance.now() < until) {
    await pause(50);
    detail = await detailOf(page);
  }
  return detail;
}

/** The requests for the next state that reached the app. */
const answersAt = (app) => app.requests.filter((request) => request.path === HOLD_ANSWER_PATH);

/** The page's Continue, pressed as a person presses it. */
const pressContinue = (page) => page.locator("button[data-fixture-refreshes]").click();

const armedLine = (what, matchMs = 30_000, holdMs = 120_000) =>
  `holdResponse: armed on ${HOLD_PAGE_PATH}: every ${what} whose address the pattern matches is held unsent until the release (match bound ${matchMs} ms, hold bound ${holdMs} ms)`;
const caughtLine = (afterMs, n = 1) =>
  `holdResponse: holding GET ${HOLD_ANSWER_PATH} (held request ${n}), caught ${afterMs} ms after the arming; it is not sent until the release`;
const releasedLine = (held, heldMs) =>
  `releaseResponse: released ${held} held request${held === 1 ? "" : "s"} after ${heldMs} ms held, the first GET ${HOLD_ANSWER_PATH}; each went on unchanged`;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`holdResponse and releaseResponse [${labelOf(backend)}]`, () => {
    // The page, and then the two steps: the first case needs no step, and so reads the same before and after they exist.
    const open = async (page, app) => {
      await page.goto(`${app.origin}${HOLD_PAGE_PATH}`);
      expect(await detailOf(page)).toBe(HOLD_QUESTION);
    };
    const openHeld = async (page, app) => {
      await open(page, app);
      return theSteps("holdResponse", "releaseResponse");
    };

    it("without a hold, the page's loading state is gone long before a reading a second later: the race the step removes", async () => {
      await scene(backend, {}, async ({ app, page }) => {
        await open(page, app);
        await pressContinue(page);
        await pause(LONG_ENOUGH_MS);
        expect(await detailOf(page), "the loading state outlived the app's answer").toBe(holdAnswer(1));
        expect(answersAt(app)).toHaveLength(1);
      });
    });

    it("holds the matching request unsent: the loading state stands until the release, then the app's own answer lands", async () => {
      await scene(backend, { secrets: ["detail-of-the-step", PATTERN.source] }, async ({ app, page, record, lines }) => {
        const { holdResponse, releaseResponse } = await openHeld(page, app);
        const armed = await holdResponse(page, { urlPattern: PATTERN, method: "GET", record });
        expect(armed).toEqual({ path: HOLD_PAGE_PATH, method: "GET", matchMs: 30_000, holdMs: 120_000 });
        await pressContinue(page);
        await pause(LONG_ENOUGH_MS);
        expect(await detailOf(page), "the held state did not stand").toBe(HOLD_LOADING);
        expect(answersAt(app), "the held request reached the app before its release").toHaveLength(0);
        const released = await releaseResponse(page, { record });
        expect(released).toEqual({ method: "GET", path: HOLD_ANSWER_PATH, caughtAfterMs: expect.any(Number), heldMs: expect.any(Number), held: 1, released: "call" });
        // Held from its catching, a moment after the press, to the release: most of the second the case waited.
        expect(released.heldMs, "the request was held for less than half the case's wait").toBeGreaterThanOrEqual(LONG_ENOUGH_MS / 2);
        // The app's answer, as it sent it: the request went on unchanged, and nothing changed its answer.
        expect(await detailBecomes(page, holdAnswer(1))).toBe(holdAnswer(1));
        expect(answersAt(app).map(({ method, query }) => ({ method, query }))).toEqual([{ method: "GET", query: HOLD_ANSWER_QUERY.split("&").map((pair) => pair.split("=")[0]) }]);
        expect(lines).toEqual([armedLine("GET request"), caughtLine(released.caughtAfterMs), releasedLine(1, released.heldMs)]);
      });
    });

    it("holds every matching request until the release, a second one too, and lets a request after the release go on unheld", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { holdResponse, releaseResponse } = await openHeld(page, app);
        await holdResponse(page, { urlPattern: PATTERN, record });
        await pressContinue(page);
        await pause(300);
        // The page asks again, as a watcher's refresh does: the second request waits as well.
        await pressContinue(page);
        await pause(LONG_ENOUGH_MS);
        expect(await detailOf(page), "the second request ended the held state").toBe(HOLD_LOADING);
        expect(answersAt(app), "a held request reached the app before the release").toHaveLength(0);
        const released = await releaseResponse(page, { record });
        expect(released).toEqual({ method: "GET", path: HOLD_ANSWER_PATH, caughtAfterMs: expect.any(Number), heldMs: expect.any(Number), held: 2, released: "call" });
        // Both went on: the app answers each, and the page shows an answer of the app's.
        const until = performance.now() + 5_000;
        while (answersAt(app).length < 2 && performance.now() < until) await pause(50);
        expect(answersAt(app)).toHaveLength(2);
        // Once released, the route is gone: the next request goes on at once, and its answer lands.
        await pause(300);
        await pressContinue(page);
        expect(await detailBecomes(page, holdAnswer(3)), "a request after the release was held").toBe(holdAnswer(3));
        expect(lines).toHaveLength(4);
        expect(lines[0]).toBe(armedLine("request of any method"));
        expect(lines[1]).toBe(caughtLine(released.caughtAfterMs));
        expect(lines[2]).toMatch(/^holdResponse: holding GET \/hold\/answer \(held request 2\), caught [0-9]+ ms after the arming; it is not sent until the release$/);
        expect(lines[3]).toBe(releasedLine(2, released.heldMs));
      });
    });

    it("lets the held request go on by itself when the hold bound runs out, and says so", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { holdResponse, releaseResponse } = await openHeld(page, app);
        await holdResponse(page, { urlPattern: PATTERN, method: "GET", record, bounds: { holdMs: 400 } });
        await pressContinue(page);
        expect(await detailBecomes(page, holdAnswer(1)), "the hold bound did not let the request go").toBe(holdAnswer(1));
        const released = await releaseResponse(page, { record });
        expect(released).toEqual({ method: "GET", path: HOLD_ANSWER_PATH, caughtAfterMs: expect.any(Number), heldMs: expect.any(Number), held: 1, released: "bound" });
        expect(released.heldMs).toBeGreaterThanOrEqual(400 - TIMER_CLOCK_SLACK_MS);
        expect(answersAt(app)).toHaveLength(1);
        expect(lines).toEqual([
          armedLine("GET request", 30_000, 400),
          caughtLine(released.caughtAfterMs),
          `holdResponse: the hold bound of 400 ms ran out, so 1 held request went on unchanged after ${released.heldMs} ms held, the first GET ${HOLD_ANSWER_PATH}`,
          `releaseResponse: 1 held request had gone on already, by the hold bound, after ${released.heldMs} ms held, the first GET ${HOLD_ANSWER_PATH}`,
        ]);
      });
    });

    it("refuses a pattern that matches no request within its match bound, and holds nothing", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { holdResponse, releaseResponse } = await openHeld(page, app);
        await holdResponse(page, { urlPattern: /\/hold\/elsewhere/, method: "GET", record, bounds: { matchMs: 300 } });
        await pressContinue(page);
        expect(await detailBecomes(page, holdAnswer(1)), "a request the pattern does not match was held").toBe(holdAnswer(1));
        await pause(LONG_ENOUGH_MS);
        const noMatch = `holdResponse refused (no-match): no GET request whose address the pattern matches was made within 300 ms of the arming on ${HOLD_PAGE_PATH} — nothing was held`;
        expect(lines).toEqual([armedLine("GET request", 300), noMatch]);
        const error = await refusal(releaseResponse(page, { record }));
        expect(error.name).toBe("StepRefusal");
        expect(error.kind).toBe("no-match");
        expect(error.message).toBe(
          `releaseResponse refused (no-match): the hold armed on ${HOLD_PAGE_PATH} caught no GET request within its match bound of 300 ms — nothing was held, and the page went on unheld`,
        );
        expect(lines).toEqual([armedLine("GET request", 300), noMatch, error.message]);
        expect(answersAt(app)).toHaveLength(1);
      });
    });

    it("holds only the method it names: a GET request to a POST hold's address goes on at once", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { holdResponse, releaseResponse } = await openHeld(page, app);
        await holdResponse(page, { urlPattern: PATTERN, method: "POST", record, bounds: { matchMs: 300 } });
        await pressContinue(page);
        expect(await detailBecomes(page, holdAnswer(1)), "a GET request was held by a POST hold").toBe(holdAnswer(1));
        await pause(LONG_ENOUGH_MS);
        expect(lines[1]).toBe(
          `holdResponse refused (no-match): no POST request whose address the pattern matches was made within 300 ms of the arming on ${HOLD_PAGE_PATH} — nothing was held`,
        );
        expect((await refusal(releaseResponse(page, { record }))).kind).toBe("no-match");
        expect(answersAt(app)).toHaveLength(1);
      });
    });

    it("refuses a release with nothing caught yet, removes the hold, and lets the page go on unheld", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { holdResponse, releaseResponse } = await openHeld(page, app);
        await holdResponse(page, { urlPattern: PATTERN, method: "GET", record });
        const error = await refusal(releaseResponse(page, { record }));
        expect(error.kind).toBe("no-match");
        expect(error.message).toMatch(
          /^releaseResponse refused \(no-match\): the hold armed on \/hold\/start had caught no GET request [0-9]+ ms after the arming — nothing was held, and the hold is removed$/,
        );
        await pressContinue(page);
        expect(await detailBecomes(page, holdAnswer(1)), "a removed hold still held the request").toBe(holdAnswer(1));
        // The page holds no hold now, so a new one may be armed.
        expect(await holdResponse(page, { urlPattern: PATTERN, record })).toEqual({ path: HOLD_PAGE_PATH, method: null, matchMs: 30_000, holdMs: 120_000 });
        expect((await refusal(releaseResponse(page, { record }))).kind).toBe("no-match");
        expect(lines).toHaveLength(4);
        expect(answersAt(app)).toHaveLength(1);
      });
    });

    it("refuses by name, before it arms anything, what it cannot use", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { holdResponse, releaseResponse } = await openHeld(page, app);
        const nothing = "nothing was held";
        const cases = [
          [{ urlPattern: PATTERN }, "input", "hand the step a record callback — nothing was done"],
          [{ urlPattern: "/hold/answer", record }, "input", `urlPattern must be a regular expression that a request's address is tested with — ${nothing}`],
          [{ urlPattern: /\/hold\/answer/g, record }, "input", `urlPattern carries the g or the y flag, which makes each test depend on the one before — ${nothing}`],
          [{ urlPattern: /\/hold\/answer/y, record }, "input", `urlPattern carries the g or the y flag, which makes each test depend on the one before — ${nothing}`],
          [{ urlPattern: PATTERN, method: "get", record }, "input", `method must be one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS — ${nothing}`],
          [{ urlPattern: PATTERN, record, bounds: { waitMs: 100 } }, "input", `there is no bound named waitMs — ${nothing}`],
          [{ urlPattern: PATTERN, record, bounds: { holdMs: 0 } }, "input", `holdMs must be a positive number of milliseconds — ${nothing}`],
        ];
        for (const [options, kind, reason] of cases) {
          const error = await refusal(holdResponse(page, options));
          expect(error.name).toBe("StepRefusal");
          expect({ step: error.step, kind: error.kind, reason: error.reason }).toEqual({ step: "holdResponse", kind, reason });
        }
        expect((await refusal(releaseResponse(page, { record }))).message).toBe(
          `releaseResponse refused (no-hold): no hold is armed on the page on ${HOLD_PAGE_PATH} — arm one with holdResponse first; nothing was released`,
        );
        expect((await refusal(releaseResponse(page, {}))).message).toBe("releaseResponse refused (input): hand the step a record callback — nothing was done");
        // One hold at a time: a second arming before the release is refused, and the first still holds.
        await holdResponse(page, { urlPattern: PATTERN, record });
        expect((await refusal(holdResponse(page, { urlPattern: PATTERN, record }))).message).toBe(
          `holdResponse refused (held): a hold is armed on the page on ${HOLD_PAGE_PATH} already — release it with releaseResponse first; ${nothing}`,
        );
        await pressContinue(page);
        await pause(300);
        expect(await detailOf(page)).toBe(HOLD_LOADING);
        expect((await releaseResponse(page, { record })).released).toBe("call");
        expect(await detailBecomes(page, holdAnswer(1))).toBe(holdAnswer(1));
        // The refusals of the record-less calls wrote nothing: there was no record to write through.
        expect(lines.filter((line) => line.includes("refused"))).toHaveLength(cases.length - 1 + 2);
        expect(answersAt(app)).toHaveLength(1);
      });
    });

    it("names its bounds, and is listed in the README's table of steps, with a section that names its refusals", () => {
      const steps = theSteps("holdResponse", "releaseResponse");
      expect(steps.HOLD_MATCH_BOUND_MS).toBe(30_000);
      expect(steps.HOLD_BOUND_MS).toBe(120_000);
      expect(steps.HOLD_BOUNDS).toEqual({ matchMs: steps.HOLD_MATCH_BOUND_MS, holdMs: steps.HOLD_BOUND_MS });
      expect(steps.HOLD_METHODS).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
      const readme = readFileSync(README, "utf8");
      expect(readme).toMatch(/^\| `holdResponse` \| .+ \|$/m);
      expect(readme).toMatch(/^\| `releaseResponse` \| .+ \|$/m);
      const section = readme.split("\n## ").find((part) => part.startsWith("`holdResponse("));
      expect(section, "the README has no section for holdResponse").toBeDefined();
      for (const kind of ["input", "closed", "held", "driver-failure", "no-match", "no-hold"]) expect(section).toContain(`\`${kind}\``);
    });
  });
}
