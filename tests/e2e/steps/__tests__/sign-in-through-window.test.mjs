// signInThroughWindow: the one sign-in through the window an embedded
// product's sign-in control opens.
//
// The defect these cases stand for: the assistant embedded in a site's page
// takes no cookie of the product; it signs a person in through a window of its
// own, which closes itself once it is done, and signInThroughPage loads a
// sign-in page and waits for the app shell. The step presses the frame's
// sign-in control, waits for the window, and reads which of two roads it
// takes: it returns by itself for a person with a live session (the run's
// once-only budget untouched), or it shows the product's sign-in form, which
// the step types into key by key, presses once and watches close itself (the
// budget spent once). No line carries the email or the password.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import {
  EMBED_NOTHING,
  EMBED_PAGE_PATH,
  EMBED_SIGN_IN,
  EMBED_STALLED_SIGN_IN,
  FRAME_SELECTOR,
  LAUNCHER_SELECTOR,
  SESSION_COOKIE,
  SITE_PAGE_PATH,
  STALLED_WINDOW_PATH,
  WINDOW_PAGE_PATH,
} from "./fixture-app-site.mjs";

afterAll(closeBrowser);

const FRAME_BOUNDS = Object.freeze({ frameMs: 5000, pollMs: 25 });
const BOUNDS = Object.freeze({ actionMs: 2000, openMs: 3000, returnMs: 4000, pollMs: 25, requestMs: 1500, answerMs: 3000 });
// Invented for the fixture and built from parts at run time; neither looks like anything real. They reach the window's fields and no line.
const EMAIL = ["fixture", "window", "person"].join("-");
const PASSWORD = ["fixture", "typed", "key", "by", "key"].join("-");
const CREDENTIALS = Object.freeze({ email: EMAIL, password: PASSWORD });

/** The line frameOf writes for the widget's frame. */
const FRAME_LINE = `frameOf: on ${SITE_PAGE_PATH}, the frame of the selector "${FRAME_SELECTOR}" stands on ${EMBED_PAGE_PATH}; the steps given its scope read and act in that frame's document alone`;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`signInThroughWindow [${labelOf(backend)}]`, () => {
    /** The site's page, its widget's frame mounted by a press on its launcher, and the frame's scope. */
    const openFrame = async (steps, app, page, record) => {
      await page.goto(`${app.siteOrigin}${SITE_PAGE_PATH}`);
      await page.locator(LAUNCHER_SELECTOR).click();
      return (await steps.frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS })).scope;
    };
    const windowLoads = (app, path) => app.requests.filter((request) => request.method === "GET" && request.path === path);

    it("answers the window that returns by itself for a person with a live session, and leaves the budget untouched", async () => {
      const steps = theSteps("frameOf", "signInThroughWindow", "createSignInBudget");
      await scene(backend, { site: true, secrets: [EMAIL, PASSWORD] }, async ({ app, page, record, lines }) => {
        await page.context().addCookies([{ name: SESSION_COOKIE, value: "1", url: app.origin }]);
        const scope = await openFrame(steps, app, page, record);
        const budget = steps.createSignInBudget();
        const result = await steps.signInThroughWindow(scope, { name: EMBED_SIGN_IN, credentials: CREDENTIALS, budget, record, bounds: BOUNDS });
        expect(result).toMatchObject({ window: "returned", spent: false, path: EMBED_PAGE_PATH });
        expect(budget.spent).toBe(0);
        expect(windowLoads(app, WINDOW_PAGE_PATH)).toHaveLength(1);
        expect(app.signInRequests()).toHaveLength(0);
        expect(lines).toEqual([
          FRAME_LINE,
          `signInThroughWindow: the window the button "${EMBED_SIGN_IN}" on ${EMBED_PAGE_PATH} opened returned by itself after ${result.elapsedMs} ms — a session of this browser context signed it in; the once-only sign-in is not spent`,
        ]);
      });
    });

    it("types the email and the password key by key into the window's form, presses once, spends the budget once and waits for the window to close", async () => {
      const steps = theSteps("frameOf", "signInThroughWindow", "createSignInBudget");
      await scene(backend, { site: true, secrets: [EMAIL, PASSWORD] }, async ({ app, page, record, lines }) => {
        const scope = await openFrame(steps, app, page, record);
        const budget = steps.createSignInBudget();
        const result = await steps.signInThroughWindow(scope, { name: EMBED_SIGN_IN, credentials: CREDENTIALS, budget, record, bounds: BOUNDS });
        expect(result).toMatchObject({ window: "signed-in", spent: true, path: EMBED_PAGE_PATH, windowPath: WINDOW_PAGE_PATH });
        expect(budget.spent).toBe(1);
        const sent = app.signInRequests();
        expect(sent).toHaveLength(1);
        // What the window's own handler sent: the values typed into its two fields, and no native submission.
        expect(JSON.parse(sent[0].body)).toEqual({ email: EMAIL, password: PASSWORD });
        expect(app.carryingFields()).toHaveLength(0);
        expect(lines).toEqual([
          FRAME_LINE,
          `signInThroughWindow: the window the button "${EMBED_SIGN_IN}" on ${EMBED_PAGE_PATH} opened shows the product's sign-in form on ${WINDOW_PAGE_PATH}, and it carries its hydration mark`,
          `signInThroughWindow: typed the email and the password key by key into the window on ${WINDOW_PAGE_PATH}; the email reads back as typed, and the password reads back at its length`,
          "signInThroughWindow: the press sent the app's own sign-in request (/api/auth/sign-in/email) — the once-only sign-in is spent",
          "signInThroughWindow: signed in — the app answered 200 to its own sign-in request",
          `signInThroughWindow: the window closed itself after the app's answer; the run is signed in, ${result.elapsedMs} ms after the press`,
        ]);
      });
    });

    it("refuses a spent budget before anything is pressed", async () => {
      const steps = theSteps("frameOf", "signInThroughWindow");
      await scene(backend, { site: true, secrets: [EMAIL, PASSWORD] }, async ({ app, page, record, lines }) => {
        const scope = await openFrame(steps, app, page, record);
        const error = await refusal(steps.signInThroughWindow(scope, { name: EMBED_SIGN_IN, credentials: CREDENTIALS, budget: { spent: 1 }, record, bounds: BOUNDS }));
        expect(error.kind).toBe("spent");
        expect(error.message).toBe("signInThroughWindow refused (spent): this run's one sign-in already reached the app — no second press");
        expect(windowLoads(app, WINDOW_PAGE_PATH), "a window opened").toHaveLength(0);
        expect(lines).toEqual([FRAME_LINE, error.message]);
      });
    });

    it("refuses a press that opens no window within the bound, with the budget untouched", async () => {
      const steps = theSteps("frameOf", "signInThroughWindow", "createSignInBudget");
      await scene(backend, { site: true, secrets: [EMAIL, PASSWORD] }, async ({ app, page, record, lines }) => {
        const scope = await openFrame(steps, app, page, record);
        const budget = steps.createSignInBudget();
        const error = await refusal(steps.signInThroughWindow(scope, { name: EMBED_NOTHING, credentials: CREDENTIALS, budget, record, bounds: { ...BOUNDS, openMs: 500 } }));
        expect(error.kind).toBe("no-window");
        expect(error.message).toBe(
          `signInThroughWindow refused (no-window): the press on the button "${EMBED_NOTHING}" on ${EMBED_PAGE_PATH} opened no window within 500 ms — the once-only sign-in is not spent`,
        );
        expect(budget.spent).toBe(0);
        expect(lines).toEqual([FRAME_LINE, error.message]);
      });
    });

    it("refuses a window that neither returns nor shows the sign-in form within the bound, naming its path", async () => {
      const steps = theSteps("frameOf", "signInThroughWindow", "createSignInBudget");
      await scene(backend, { site: true, secrets: [EMAIL, PASSWORD] }, async ({ app, page, record, lines }) => {
        const scope = await openFrame(steps, app, page, record);
        const budget = steps.createSignInBudget();
        const error = await refusal(
          steps.signInThroughWindow(scope, { name: EMBED_STALLED_SIGN_IN, credentials: CREDENTIALS, budget, record, bounds: { ...BOUNDS, returnMs: 800 } }),
        );
        expect(error.kind).toBe("not-returned");
        expect(error.message).toBe(
          `signInThroughWindow refused (not-returned): the window the button "${EMBED_STALLED_SIGN_IN}" on ${EMBED_PAGE_PATH} opened on ${STALLED_WINDOW_PATH} neither returned by itself nor showed the product's sign-in form within 800 ms — the once-only sign-in is not spent`,
        );
        expect(budget.spent).toBe(0);
        expect(app.signInRequests()).toHaveLength(0);
        expect(lines).toEqual([FRAME_LINE, error.message]);
      });
    });
  });
}
