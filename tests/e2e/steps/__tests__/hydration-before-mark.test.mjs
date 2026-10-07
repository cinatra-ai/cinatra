// A step marks a control only once the page has hydrated.
//
// The defect these cases stand for: a press that came right after a navigation
// wrote the step's mark (`data-step-control`) on its control before React had
// hydrated the page. React then compared that element with the markup the
// server sent, found the mark on the client only and reported a hydration
// mismatch, and the development badge stood in every later frame of the run.
// Every step that writes the mark now waits, before its first reading, until
// the page has hydrated, as the sign-in step waits for its form's mark.
//
// The pages here hydrate late (`hydrate` in fixture-app.mjs): each hydrates at
// its own time, or at once on the first press, fill, typed key or focus on it,
// and reports the moment with the marks it carried then. A step called right
// after the navigation leaves every report on time, with no mark, and from a
// moment before its act.
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";
import { HYDRATION_REPORT_PATH } from "./fixture-app.mjs";
import { COMPOSER_NAME, RUN_WINDOW_NAME } from "./fixture-app-windows.mjs";

afterAll(closeBrowser);

/** A page that hydrates 800 ms after it was built, unless a press, a fill, a key or a focus comes first. */
const LATE = Object.freeze({ afterMs: 800 });
// Built from parts at run time: what is typed reaches the page and no line.
const PROMPT = ["start", "the", "fixture", "run", "now"].join(" ");
const TEXT = ["fill", "the", "title", "from", "the", "brief"].join(" ");
const TITLE = ["fixture", "title", "one"].join("-");
const SECRETS = [PROMPT, TEXT, TITLE];

// Each step of the steps that write the mark, on the page its own test file
// drives it on, with the call that file makes and the same short bounds:
// `documents` are the pages it acts on, each of which reports its hydration;
// `act` is the request its act sends, when it sends one.
const ROWS = [
  {
    step: "press",
    path: "/press/start",
    call: ({ press }, page, record) => press(page, { name: "Target", role: "link", record, bounds: { actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 } }),
    reads: (result) => expect(result).toMatchObject({ name: "Target", role: "link", from: "/press/start", path: "/nav/target", navigated: true }),
    documents: ["/press/start"],
    act: "/nav/target",
  },
  {
    step: "pressByTestId",
    path: "/press/rows",
    call: ({ pressByTestId }, page, record) =>
      pressByTestId(page, { testId: "artifacts-picker-type", text: "Note pack:note Pack", record, bounds: { actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 } }),
    reads: (result) => expect(result).toMatchObject({ name: "Note pack:note Pack", from: "/press/rows", path: "/press/rows", navigated: false }),
    documents: ["/press/rows"],
    act: null,
  },
  {
    step: "dispatchRun",
    path: "/cards/start",
    call: ({ dispatchRun }, page, record) =>
      dispatchRun(page, { card: "Chat agent", prompt: PROMPT, record, bounds: { actionMs: 2000, composerMs: 3000, runMs: 3000, pollMs: 25 } }),
    reads: (result) => expect(result).toMatchObject({ card: "Chat agent", via: "run", state: "status:queued", path: "/conversation/empty" }),
    // The press lands on a second document, which hydrates anew before its composer is read.
    documents: ["/cards/start", "/conversation/empty"],
    act: "/conversation/empty",
  },
  {
    step: "selectFrom",
    path: "/pick/start",
    call: ({ selectFrom }, page, record) => selectFrom(page, { picker: "Size", entry: "Medium", record, bounds: { actionMs: 2000, reflectMs: 800, pollMs: 25 } }),
    reads: (result) => expect(result).toMatchObject({ picker: "Size", entry: "Medium", kind: "select", via: "state", path: "/pick/start" }),
    documents: ["/pick/start"],
    act: null,
  },
  {
    step: "typeInWindow",
    path: "/window/turn",
    call: ({ typeInWindow }, page, record) =>
      typeInWindow(page, { field: RUN_WINDOW_NAME, text: TEXT, record, bounds: { fieldMs: 1500, actionMs: 2000, sentMs: 1500, pollMs: 25 } }),
    reads: (result) => expect(result).toEqual({ field: RUN_WINDOW_NAME, text: TEXT, sent: false, path: "/window/turn" }),
    documents: ["/window/turn"],
    act: null,
  },
  {
    step: "sendInComposer",
    path: "/composer/card",
    call: ({ sendInComposer }, page, record) =>
      sendInComposer(page, { prompt: PROMPT, composer: COMPOSER_NAME, record, bounds: { composerMs: 1500, actionMs: 2000, sentMs: 1500, cardMs: 3000, pollMs: 25 } }),
    reads: (result) => expect(result).toEqual({ composer: COMPOSER_NAME, kind: "trigger_schedule_proposal", path: "/composer/card", elapsedMs: expect.any(Number) }),
    documents: ["/composer/card"],
    act: null,
  },
  {
    step: "waitForTurn",
    path: "/window/at-once",
    // No message was sent: the wait counts from its own first reading, and no turn comes within its bound.
    call: ({ waitForTurn }, page, record) => refusal(waitForTurn(page, { record, bounds: { turnMs: 300, pollMs: 25 } })),
    reads: (error) => expect({ step: error.step, kind: error.kind }).toEqual({ step: "waitForTurn", kind: "no-turn" }),
    documents: ["/window/at-once"],
    act: null,
  },
  {
    step: "fillForm",
    path: "/form/profile",
    call: ({ fillForm }, page, record) => fillForm(page, { fields: { Title: TITLE }, record, bounds: { fieldsMs: 1500, actionMs: 2000, errorMs: 1000, pollMs: 25 } }),
    reads: (result) => expect(result).toEqual({ filled: ["Title"], submitted: false, path: "/form/profile" }),
    documents: ["/form/profile"],
    act: null,
  },
];

/** The reports of hydration the app has had, in the order they came, as press.test.mjs reads its visits. */
const reportsOf = (app) => app.requests.filter((request) => request.path === HYDRATION_REPORT_PATH);

/** The reports, once one has come from each of `documents` or a second and a half has passed. */
async function reportsFrom(app, documents) {
  for (let waited = 0; waited < 1500; waited += 25) {
    const from = new Set(reportsOf(app).map((request) => request.report.path));
    if (documents.every((path) => from.has(path))) break;
    await pause(25);
  }
  return reportsOf(app);
}

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`a step marks a control only once the page has hydrated [${labelOf(backend)}]`, () => {
    for (const row of ROWS) {
      it(`${row.step} acts on ${row.path}, called right after the navigation, only once the page has hydrated`, async () => {
        await scene(backend, { hydrate: LATE, secrets: SECRETS }, async ({ app, page, record }) => {
          const steps = theSteps(row.step);
          await page.goto(`${app.origin}${row.path}`);
          // At once: no wait between the navigation and the call.
          const result = await row.call(steps, page, record);
          const answeredAt = Date.now();
          // (1) The step did its act, as its own test file reads it on this page.
          row.reads(result);

          // (2) Every page it acted on hydrated on its own time, with no mark on any element.
          const reports = await reportsFrom(app, row.documents);
          const from = reports.map((request) => request.report.path);
          for (const path of row.documents) expect(from, `the page on ${path} did not report its hydration`).toContain(path);
          for (const { report } of reports) {
            expect(
              { by: report.by, marked: report.marked },
              `the page on ${report.path} hydrated with the mark on it, or because the step acted on it before it had hydrated`,
            ).toEqual({ by: "time", marked: 0 });
          }

          // (3) Each page hydrated before the step acted on it: before the request its act sent, and before the step
          // answered. The moment is the one the page reports: its request may reach the app after a later one.
          const hydratedAt = (path) => reports.find((request) => request.report.path === path).report.at;
          if (row.act) {
            const acted = app.requests.find((request) => request.path === row.act);
            expect(acted, `the act sent no request to ${row.act}`).toBeDefined();
            expect(hydratedAt(row.documents[0]), `the page on ${row.documents[0]} hydrated only after the step's act`).toBeLessThanOrEqual(acted.at);
          }
          for (const path of row.documents) {
            expect(hydratedAt(path), `the page on ${path} hydrated only after the step had answered`).toBeLessThanOrEqual(answeredAt);
          }
        });
      });
    }

    it("reads at once a page with nothing to hydrate", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { press } = theSteps("press");
        await page.goto(`${app.origin}/press/start`);
        const bounds = { actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 };
        const startedAt = performance.now();
        const result = await press(page, { name: "Target", role: "link", record, bounds });
        expect(result).toMatchObject({ from: "/press/start", path: "/nav/target", navigated: true });
        expect(performance.now() - startedAt, "the press waited past its own bounds").toBeLessThan(bounds.actionMs + bounds.settleMs);
        expect(reportsOf(app), "a page with nothing to hydrate reported a hydration").toEqual([]);
      });
    });

    it("answers false at its bound on a page that never hydrates, and writes nothing into it", async () => {
      await scene(backend, { hydrate: { afterMs: null } }, async ({ app, page }) => {
        await page.goto(`${app.origin}/press/start`);
        const controls = await import("../page-controls.mjs");
        expect(typeof controls.waitForPageHydration, "page-controls.mjs offers no waitForPageHydration").toBe("function");
        const startedAt = performance.now();
        const hydrated = await controls.waitForPageHydration(page, { hydrationMs: 300, pollMs: 25 });
        expect(hydrated, "a page that never hydrates read as hydrated").toBe(false);
        expect(performance.now() - startedAt, "the wait gave up before its bound").toBeGreaterThanOrEqual(300 - 25);
        const marked = await page.evaluate(() => document.querySelectorAll("[data-step-control]").length);
        expect(marked, "the wait wrote the mark into the page").toBe(0);
        expect(reportsOf(app), "the page hydrated, so the wait acted on it").toEqual([]);
      });
    });
  });
}

// The reading itself, on documents shaped as React leaves them. React keeps a
// complete Suspense boundary dehydrated after the shell, and a dialog adds its
// focus guards to the body outside React: neither may decide the reading.
describe("the reading of a page's hydration", () => {
  /** pageHydrated, run in a document whose body is `body` and whose React root has committed `dehydrated`, or carries no root (null). */
  const reading = async (body, { dehydrated = null, keyed = [] } = {}) => {
    const { pageHydrated } = await import("../page-controls.mjs");
    expect(typeof pageHydrated, "page-controls.mjs offers no pageHydrated").toBe("function");
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { runScripts: "outside-only" });
    const { window } = dom;
    window.__next_f = [];
    if (dehydrated !== null) {
      window.document["__reactContainer$fixture"] = { stateNode: { current: { memoizedState: { isDehydrated: dehydrated } } } };
    }
    for (const selector of keyed) for (const element of window.document.querySelectorAll(selector)) element["__reactFiber$fixture"] = {};
    return window.eval(`(${pageHydrated.toString()})()`);
  };
  const GUARD = '<span data-radix-focus-guard="" tabindex="0"></span>';

  it("reads a committed root as hydrated while a dialog's focus guards stand in the body", async () => {
    const page = `${GUARD}<main><button>Run</button></main><div role="dialog"><button>Close</button></div>${GUARD}`;
    expect(await reading(page, { dehydrated: false, keyed: ["main", "main *", "[role=dialog]", "[role=dialog] *"] })).toBe(true);
    expect(await reading(page, { dehydrated: true, keyed: ["main", "main *", "[role=dialog]", "[role=dialog] *"] })).toBe(false);
  });

  it("reads a page as not hydrated while a complete boundary is still dehydrated, though its shell is", async () => {
    const page = "<main><h1>Agents</h1><!--$--><section><a href=\"/agents/one/new\">Run</a></section><!--/$--></main>";
    expect(await reading(page, { dehydrated: false, keyed: ["main", "h1"] })).toBe(false);
    expect(await reading(page, { dehydrated: false, keyed: ["main", "h1", "section", "section a"] })).toBe(true);
    // Without a React root, the body's rendered children decide the shell; the boundary still counts.
    expect(await reading(page, { keyed: ["main", "h1"] })).toBe(false);
    expect(await reading(page, { keyed: ["main", "h1", "section", "section a"] })).toBe(true);
  });
});
