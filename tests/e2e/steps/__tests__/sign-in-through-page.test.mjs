// signInThroughPage: the one sign-in press, through the product's own sign-in
// page, driven against the fixture sign-in pages.
//
// The defect these cases stand for: a press made before the form had hydrated
// submitted it natively, no sign-in request reached the app, the fields left the
// page in a request of their own, and the run's one sign-in was spent on
// nothing. Every value below is built at run time; each case checks that no
// value and no address reaches a line the step wrote.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";
import { EMAIL_ROUTE, FORM_FIELDS, USERNAME_ROUTE } from "./fixture-app.mjs";

afterAll(closeBrowser);

// Built from parts at run time; neither looks like anything real.
const ONE = ["fixture", "reader", "one"].join("-");
const TWO = ["fixture", "opaque", "two"].join("-");
const CREDENTIALS = Object.freeze({ email: ONE, password: TWO });
const SECRETS = [ONE, TWO];

// Short bounds, so a stall or a missing request costs a second, not minutes.
const BOUNDS = Object.freeze({ navigationMs: 5000, hydrationMs: 3000, pollMs: 25, actionMs: 2000, requestMs: 700, answerMs: 3000 });

// The form's parts as the product renders them, spelled here on purpose.
const EMAIL = 'form:has(input[type="password"]) input[name="email"]';
const PASSWORD = 'input[type="password"]';
const SUBMIT = 'form:has(input[type="password"]) button[type="submit"]';

const NOT_SPENT = "the once-only sign-in is not spent";

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`signInThroughPage [${labelOf(backend)}]`, () => {
    const signIn = (page, app, path, overrides = {}) => {
      const { signInThroughPage } = theSteps("signInThroughPage");
      return signInThroughPage(page, {
        credentials: CREDENTIALS,
        url: `${app.origin}${path}`,
        bounds: BOUNDS,
        ...overrides,
      });
    };

    it("control: without the step, a press before hydration submits the form natively", async () => {
      await scene(backend, {}, async ({ app, page }) => {
        // The page that never hydrates, so the press is before hydration however slow the machine is.
        await page.goto(`${app.origin}/never/sign-in`);
        await page.locator(EMAIL).fill(ONE);
        await page.locator(PASSWORD).fill(TWO);
        await page.locator(SUBMIT).click();
        for (let i = 0; i < 40 && app.carryingFields().length === 0; i += 1) await pause(50);
        // The defect the step exists to prevent: the fields left the page in a
        // request of their own, and the app never heard its own sign-in request.
        expect(app.carryingFields(), "the fixture page no longer stands for the defect").toHaveLength(1);
        expect(app.carryingFields()[0].bodyFields).toEqual(FORM_FIELDS);
        expect(app.signInRequests()).toHaveLength(0);
      });
    });

    it("waits for a late handler, presses once and reads the app's own request", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const budget = createSignInBudget();
        const result = await signIn(page, app, "/late/sign-in", { budget, record });
        expect(result).toEqual({ status: 200, reloads: 0, spent: 1, landed: "/landing/app" });
        expect(budget.spent).toBe(1);
        const loads = app.pageLoads("late");
        const sent = app.signInRequests();
        expect(loads).toHaveLength(1);
        expect(sent, "the press sent the app's own sign-in request exactly once").toHaveLength(1);
        expect(JSON.parse(sent[0].body)).toEqual({ email: ONE, password: TWO });
        // Only the handler that attaches at 500 ms sends this request, so it cannot leave any earlier.
        expect(sent[0].at - loads[0].at).toBeGreaterThanOrEqual(500);
        expect(app.carryingFields(), "a request carried the form's fields natively").toEqual([]);
        expect(lines).toHaveLength(4);
        expect(lines.slice(0, 3)).toEqual([
          "signInThroughPage: the form carries its hydration mark on the first load",
          `signInThroughPage: the press sent the app's own sign-in request (${EMAIL_ROUTE}) — the once-only sign-in is spent`,
          "signInThroughPage: signed in — the app answered 200 to its own sign-in request",
        ]);
        expect(lines[3]).toMatch(/^signInThroughPage: landed on \/landing\/app after \d+ ms, and the page draws a\[href="\/chat"\]$/);
      });
    });

    it("reads the username road as the app's own sign-in request too", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const budget = createSignInBudget();
        const result = await signIn(page, app, "/username/sign-in", { budget, record });
        expect(result.status).toBe(200);
        expect(budget.spent).toBe(1);
        expect(app.signInRequests().map((r) => r.path)).toEqual([USERNAME_ROUTE]);
        expect(lines[1]).toContain(`(${USERNAME_ROUTE})`);
      });
    });

    it("reloads a page that never hydrates once, then refuses by name", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const budget = createSignInBudget();
        const error = await refusal(
          signIn(page, app, "/never/sign-in", { budget, record, bounds: { ...BOUNDS, hydrationMs: 400 } }),
        );
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("signInThroughPage");
        expect(error.kind).toBe("blocker");
        expect(error.message).toBe(
          "signInThroughPage refused (blocker): the sign-in page did not hydrate within 400 ms after its load, " +
            "nor after one full reload (reading: path /never/sign-in, document complete, form present, " +
            `hydration mark absent, button enabled) — ${NOT_SPENT}`,
        );
        expect(app.pageLoads("never"), "the page is loaded once and reloaded exactly once").toHaveLength(2);
        expect(app.signInRequests()).toHaveLength(0);
        expect(app.carryingFields()).toEqual([]);
        expect(budget.spent).toBe(0);
        expect(lines[0]).toMatch(/^signInThroughPage: no hydration mark within 400 ms \(reading: .*hydration mark absent.*\) — one full reload$/);
        expect(lines.at(-1), "the refusal is written through the record as well").toBe(error.message);
      });
    });

    it("never lets a native submission out: the page guard cancels one nobody owns", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const budget = createSignInBudget();
        const error = await refusal(signIn(page, app, "/unowned/sign-in", { budget, record }));
        expect(error.kind).toBe("driver-failure");
        expect(error.message).toBe(
          "signInThroughPage refused (driver-failure): the press sent no sign-in request within 700 ms " +
            `(native submissions cancelled: 1, form navigations aborted: 0) — ${NOT_SPENT}`,
        );
        await pause(200);
        expect(app.carryingFields(), "the fixture received the form's fields in a request").toEqual([]);
        expect(app.pageLoads("unowned")).toHaveLength(1);
        expect(budget.spent).toBe(0);
      });
    });

    for (const [scenario, how] of [
      ["scripted", "in a form body"],
      ["scripted-get", "in a query string"],
    ]) {
      it(`never lets a native submission out: the network guard aborts one made by script (${how})`, async () => {
        const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
        await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
          const budget = createSignInBudget();
          const error = await refusal(signIn(page, app, `/${scenario}/sign-in`, { budget, record }));
          expect(error.kind).toBe("driver-failure");
          expect(error.message).toMatch(
            /^signInThroughPage refused \(driver-failure\): the press sent no sign-in request within 700 ms \(native submissions cancelled: (0|unread), form navigations aborted: 1\) — the once-only sign-in is not spent$/,
          );
          await pause(200);
          expect(app.carryingFields(), "the fixture received the form's fields in a request").toEqual([]);
          expect(budget.spent).toBe(0);
        });
      });
    }

    it("counts a press that sends no request as a driver failure that never spends the budget", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const budget = createSignInBudget();
        const error = await refusal(signIn(page, app, "/silent/sign-in", { budget, record }));
        expect(error.kind).toBe("driver-failure");
        expect(error.message).toBe(
          "signInThroughPage refused (driver-failure): the press sent no sign-in request within 700 ms " +
            `(native submissions cancelled: 0, form navigations aborted: 0) — ${NOT_SPENT}`,
        );
        expect(budget.spent, "a driver failure spent the once-only sign-in").toBe(0);
        expect(app.signInRequests()).toHaveLength(0);
        // The same run may press again, and that press is the one that counts.
        const result = await signIn(page, app, "/ready/sign-in", { budget, record });
        expect(result.status).toBe(200);
        expect(budget.spent).toBe(1);
        expect(app.signInRequests()).toHaveLength(1);
      });
    });

    it("keeps only the error class of a fill that failed, never the value", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const budget = createSignInBudget();
        const error = await refusal(
          signIn(page, app, "/nofield/sign-in", { budget, record, bounds: { ...BOUNDS, actionMs: 500 } }),
        );
        expect(error.kind).toBe("driver-failure");
        expect(error.message).toBe(
          `signInThroughPage refused (driver-failure): the email field could not be filled (TimeoutError) — nothing was pressed; ${NOT_SPENT}`,
        );
        expect(error.message).not.toContain(ONE);
        expect(app.signInRequests()).toHaveLength(0);
        expect(budget.spent).toBe(0);
      });
    });

    it("spends the budget on the request that left the page, whatever the answer", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { answer: 401, secrets: SECRETS }, async ({ app, page, record }) => {
        const budget = createSignInBudget();
        const rejected = await refusal(signIn(page, app, "/ready/sign-in", { budget, record }));
        expect(rejected.kind).toBe("rejected");
        expect(rejected.message).toMatch(/^signInThroughPage refused \(rejected\): the app answered 401 .* — the once-only sign-in is spent$/);
        expect(budget.spent).toBe(1);
        const before = app.requests.length;
        const spent = await refusal(signIn(page, app, "/ready/sign-in", { budget, record }));
        expect(spent.kind).toBe("spent");
        expect(spent.message).toBe("signInThroughPage refused (spent): this run's one sign-in already reached the app — no second press");
        expect(app.requests.length, "a spent sign-in still loaded or sent something").toBe(before);
      });
    });

    it("refuses a sign-in page that answers with another page before anything is pressed", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const budget = createSignInBudget();
        const error = await refusal(signIn(page, app, "/redirects/sign-in", { budget, record }));
        expect(error.kind).toBe("blocker");
        expect(error.message).toBe(
          `signInThroughPage refused (blocker): the sign-in page answered with another page, /setup, and nothing was pressed — ${NOT_SPENT}`,
        );
        expect(app.signInRequests()).toHaveLength(0);
        expect(budget.spent).toBe(0);
      });
    });

    it("refuses a sign-in page that does not load within its bound", async () => {
      const { createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const budget = createSignInBudget();
        const error = await refusal(
          signIn(page, app, "/slow/sign-in", { budget, record, bounds: { ...BOUNDS, navigationMs: 500 } }),
        );
        expect(error.kind).toBe("blocker");
        expect(error.message).toBe(
          `signInThroughPage refused (blocker): the sign-in page did not load within 500 ms (TimeoutError) — ${NOT_SPENT}`,
        );
        expect(budget.spent).toBe(0);
      });
    });

    it("sends nothing when it refuses its arguments", async () => {
      const { signInThroughPage, createSignInBudget } = theSteps("signInThroughPage", "createSignInBudget");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const url = `${app.origin}/ready/sign-in`;
        const cases = [
          [{ credentials: CREDENTIALS, url, record }, "hand the step the run's once-only budget (createSignInBudget) — nothing was sent"],
          [{ budget: createSignInBudget(), url, record }, "hand the step credentials with a non-empty email and password — nothing was sent"],
          [
            { credentials: { email: ONE, password: "" }, budget: createSignInBudget(), url, record },
            "hand the step credentials with a non-empty email and password — nothing was sent",
          ],
          [
            { credentials: CREDENTIALS, budget: createSignInBudget(), url, record, bounds: { waitMs: 5 } },
            "there is no bound named waitMs — nothing was sent",
          ],
          [
            { credentials: CREDENTIALS, budget: createSignInBudget(), url, record, bounds: { requestMs: 0 } },
            "requestMs must be a positive number of milliseconds — nothing was sent",
          ],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(signInThroughPage(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`signInThroughPage refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(signInThroughPage(page, { credentials: CREDENTIALS, budget: createSignInBudget(), url }));
        expect(unrecorded.message).toBe("signInThroughPage refused (input): hand the step a record callback — nothing was done");
        expect(app.requests, "a refused call loaded or sent something").toEqual([]);
      });
    });
  });
}
