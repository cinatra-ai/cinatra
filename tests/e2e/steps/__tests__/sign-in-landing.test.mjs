// signInThroughPage, its landing: the step returns only once the page has left
// the sign-in page and the page it landed on draws its ready signal.
//
// The defect these cases stand for: a navigation was started on the sign-in page
// before the sign-in had landed. Every value below is built at run time; each
// case checks that no value and no address reaches a line the step wrote.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { EMAIL_ROUTE } from "./fixture-app.mjs";

afterAll(closeBrowser);

// Built from parts at run time; neither looks like anything real.
const ONE = ["fixture", "lander", "one"].join("-");
const TWO = ["fixture", "opaque", "two"].join("-");
const CREDENTIALS = Object.freeze({ email: ONE, password: TWO });
const SECRETS = [ONE, TWO];

const BOUNDS = Object.freeze({ navigationMs: 5000, hydrationMs: 3000, pollMs: 25, actionMs: 2000, requestMs: 700, answerMs: 3000, landingMs: 4000 });
const SPENT = "the once-only sign-in is spent";
const READY = 'a[href="/chat"], nav or [data-slot="sidebar"]';

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`signInThroughPage, its landing [${labelOf(backend)}]`, () => {
    const signIn = (page, app, path, overrides = {}) => {
      const { signInThroughPage, createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      return signInThroughPage(page, { credentials: CREDENTIALS, budget: createSignInBudget(), url: `${app.origin}${path}`, bounds: BOUNDS, ...overrides });
    };

    it("returns once the landed page draws its ready signal, and not before", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const result = await signIn(page, app, "/lands-late/sign-in", { record });
        expect(result).toEqual({ status: 200, reloads: 0, spent: 1, landed: "/landing/late" });
        expect(new URL(page.url()).pathname).toBe("/landing/late");
        const drawn = await page.evaluate(() => Boolean(document.querySelector('a[href="/chat"]')));
        expect(drawn, "the step returned before the landed page drew its ready signal").toBe(true);
        expect(lines).toHaveLength(4);
        const landed = /^signInThroughPage: landed on \/landing\/late after (\d+) ms, and the page draws a\[href="\/chat"\]$/.exec(lines[3]);
        expect(landed, lines[3]).not.toBeNull();
        // The landed page draws its shell 600 ms after it loads; a browser's page may
        // hear the answer a moment before the step does, hence the margin.
        expect(Number(landed[1])).toBeGreaterThanOrEqual(500);
      });
    });

    it("pins that a navigateTo right after it never runs on the sign-in page", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const { navigateTo } = theSteps("navigateTo");
        // Where the page is when the app answers: the landing is still to come, so
        // a step taken at the answer would run on the sign-in page.
        let atAnswer = null;
        page.on("request", (request) => {
          if (new URL(request.url()).pathname !== EMAIL_ROUTE) return;
          Promise.resolve(request.response()).then(() => {
            atAnswer = new URL(page.url()).pathname;
          });
        });
        const signedIn = await signIn(page, app, "/lands-slow/sign-in", { record });
        expect(atAnswer, "the page had landed by the answer, so this case proves nothing").toBe("/lands-slow/sign-in");
        expect(signedIn.landed).toBe("/landing/slow");
        const moved = await navigateTo(page, { path: "/nav/target", record, bounds: { actionMs: 2000, landingMs: 3000 } });
        expect(moved).toMatchObject({ path: "/nav/target", from: "/landing/slow", pressed: true });
        expect(lines.at(-1)).toBe(`navigateTo: landed on /nav/target from /landing/slow after ${moved.elapsedMs} ms`);
        expect(lines.filter((line) => line.includes("sign-in") && line.startsWith("navigateTo")), "a navigation ran on the sign-in page").toEqual([]);
      });
    });

    it("refuses by name a sign-in whose page never leaves the sign-in page", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const { signInThroughPage, createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
        const budget = createSignInBudget();
        const error = await refusal(
          signInThroughPage(page, { credentials: CREDENTIALS, budget, url: `${app.origin}/stays/sign-in`, record, bounds: { ...BOUNDS, landingMs: 500 } }),
        );
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("signInThroughPage");
        expect(error.kind).toBe("no-landing");
        expect(error.message).toBe(`signInThroughPage refused (no-landing): the page did not leave the sign-in page within 500 ms (it is on /stays/sign-in) — ${SPENT}`);
        expect(lines.at(-1)).toBe(error.message);
        expect(budget.spent, "the request left the page: the once-only sign-in is spent").toBe(1);
        expect(app.signInRequests()).toHaveLength(1);
      });
    });

    it("refuses by name a landed page that never draws its ready signal", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const error = await refusal(signIn(page, app, "/lands-bare/sign-in", { record, bounds: { ...BOUNDS, landingMs: 800 } }));
        expect(error.kind).toBe("no-landing");
        expect(error.message).toBe(
          `signInThroughPage refused (no-landing): the page left the sign-in page for /landing/bare, but drew no ready signal (${READY}) within 800 ms — ${SPENT}`,
        );
      });
    });

    it("takes the landed page's ready signal as an option", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const result = await signIn(page, app, "/lands-bare/sign-in", { record, ready: ["main", "p"] });
        expect(result.landed).toBe("/landing/bare");
        expect(lines.at(-1)).toMatch(/^signInThroughPage: landed on \/landing\/bare after \d+ ms, and the page draws p$/);
      });
    });

    it("sends nothing when the ready signal is not one or more selectors", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const reason = "name the landed page's ready signal as one or more selectors — nothing was sent";
        for (const ready of [[], [""], "nav", [3]]) {
          const error = await refusal(signIn(page, app, "/ready/sign-in", { record, ready }));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`signInThroughPage refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const zero = await refusal(signIn(page, app, "/ready/sign-in", { record, bounds: { ...BOUNDS, landingMs: 0 } }));
        expect(zero.message).toBe("signInThroughPage refused (input): landingMs must be a positive number of milliseconds — nothing was sent");
        expect(app.requests, "a refused call loaded or sent something").toEqual([]);
      });
    });
  });
}

describe("signInThroughPage, its landing bound", () => {
  it("names the landing bound and the ready signal", () => {
    const steps = theSteps("signInThroughPage");
    expect(steps.SIGN_IN_LANDING_BOUND_MS).toBe(120_000);
    expect(steps.SIGN_IN_BOUNDS.landingMs).toBe(steps.SIGN_IN_LANDING_BOUND_MS);
    expect(steps.SIGN_IN_READY_SELECTORS).toEqual(['a[href="/chat"]', "nav", '[data-slot="sidebar"]']);
  });
});
