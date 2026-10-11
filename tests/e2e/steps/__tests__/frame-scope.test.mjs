// frameOf: the one frame of a site's page, and the FRAME SCOPE the control
// steps take in place of a page.
//
// The defect these cases stand for: a run that had to drive an application
// embedded in another site's page (the assistant a site's widget mounts in a
// frame) could not do it with the maintained steps: they read the
// accessibility tree of the page they are handed and type through its
// keyboard. frameOf finds the frame by its element, through open shadow
// roots, and answers a scope in which nine steps read and act in the frame's
// document alone, with the site's page left as it was; every other step that
// needs a page refuses a scope before it does anything; a scope whose frame was
// replaced is refused as stale; and the frame's palette is read by readCount.
// The browser leg drives the frame on the same site as its page and on another
// site; a browser that runs every site in a process of its own, as Chrome does
// for a person, runs the frame of another site out of process, and the
// control reader then reads it through the frame's own session (Playwright's
// own launch keeps that frame in its page's process, so the leg drives both).
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, shutterDouble, theSteps } from "./backends.mjs";
import { STEP_MARK } from "./fixture-app.mjs";
import {
  EMBED_COMPOSER,
  EMBED_FIELD_LABEL,
  EMBED_ITEM_SELECTOR,
  EMBED_PAGE_PATH,
  EMBED_PALETTE_CLASS,
  EMBED_ROW_TEST_ID,
  EMBED_ROW_TEXT,
  EMBED_SAVE,
  EMBED_WINDOW,
  FRAME_SELECTOR,
  LAUNCHER_SELECTOR,
  SITE_PAGE_PATH,
} from "./fixture-app-site.mjs";

afterAll(closeBrowser);

// A browser that runs every site in a process of its own, launched beside the
// browser leg and on the same condition, so the frame of another site stands in
// a process of its own there.
let isolated = null;
let isolatedSkip = "set E2E_STEPS_UNIT_BROWSER=1 to drive a real browser as well";
if (process.env.E2E_STEPS_UNIT_BROWSER === "1") {
  try {
    const { chromium } = await import("@playwright/test");
    isolated = await chromium.launch({ args: ["--site-per-process"] });
    isolatedSkip = false;
  } catch (error) {
    isolatedSkip = `no browser could be launched here (${error?.name ?? "Error"})`;
  }
}
afterAll(async () => {
  if (isolated) await isolated.close();
});
const ISOLATED = {
  name: "browser, every site in a process of its own",
  skip: isolatedSkip,
  open: async () => (await isolated.newContext()).newPage(),
  close: (page) => page.context().close(),
};
/** The backends on which a frame of another site has a session of its own: the double, which keeps that rule, and the isolated browser. */
const OUT_OF_PROCESS = new Set(["page double", ISOLATED.name]);

// Short bounds, as each step's own test file shortens them.
const FRAME_BOUNDS = Object.freeze({ frameMs: 5000, pollMs: 25 });
const PRESS_BOUNDS = Object.freeze({ actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 });
const RUN_BOUNDS = Object.freeze({ actionMs: 2000, composerMs: 3000, runMs: 3000, pollMs: 25 });
const COMPOSER_BOUNDS = Object.freeze({ composerMs: 1500, actionMs: 2000, sentMs: 1500, cardMs: 3000, pollMs: 25 });
const TYPE_BOUNDS = Object.freeze({ fieldMs: 1500, actionMs: 2000, sentMs: 1500, pollMs: 25 });
const TURN_BOUNDS = Object.freeze({ turnMs: 3000, pollMs: 25 });
const FORM_BOUNDS = Object.freeze({ fieldsMs: 1500, actionMs: 2000, errorMs: 1000, pollMs: 25 });
const COUNT = Object.freeze({ settleMs: 200, pollMs: 25, bound: 3000 });

// Built from parts at run time: what is typed reaches the frame and no line.
const PROMPT = ["start", "the", "embedded", "run"].join(" ");
const TEXT = ["what", "does", "the", "brief", "need"].join(" ");
const TITLE = ["Embedded", "brief"].join(" ");

/** The two sites the frame is driven on: its page's own, and another, which a browser runs out of process. */
const SITES = Object.freeze([
  ["on the same site as its page", "siteOrigin"],
  ["on another site than its page", "crossSiteOrigin"],
]);

/** The site's page as it stands: its document and its widget's shadow root, the frame's own document aside. */
const siteReading = (page) =>
  page.evaluate(() => {
    const host = document.getElementById("cw-host");
    return `${document.documentElement.outerHTML}\n${host && host.shadowRoot ? host.shadowRoot.innerHTML : ""}`;
  });
/** How many elements of the frame's document carry the steps' mark. */
const marksIn = (scope) => scope.evaluate((mark) => document.querySelectorAll(`[${mark}]`).length, STEP_MARK);

/** The site's page, opened on `origin`, and its widget's frame mounted by a press on its launcher. */
async function openWidget(app, page, origin) {
  await page.goto(`${app[origin]}${SITE_PAGE_PATH}`);
  await page.locator(LAUNCHER_SELECTOR).click();
}

/** The line frameOf writes for the widget's frame. */
const FRAME_LINE = `frameOf: on ${SITE_PAGE_PATH}, the frame of the selector "${FRAME_SELECTOR}" stands on ${EMBED_PAGE_PATH}; the steps given its scope read and act in that frame's document alone`;

/**
 * THE NINE STEPS THAT TAKE A SCOPE: each row is the call the step's own test
 * file makes on a page, made on the frame's scope, and what it reads in the
 * frame's document after it.
 */
const SCOPED = [
  {
    step: "readCount",
    act: (steps, scope, record) => steps.readCount(scope, { selector: EMBED_ITEM_SELECTOR, record, ...COUNT }),
    landed: async (result) => expect(result).toEqual({ selector: EMBED_ITEM_SELECTOR, count: 3, path: EMBED_PAGE_PATH }),
  },
  {
    step: "press",
    act: (steps, scope, record) => steps.press(scope, { name: EMBED_SAVE, record, bounds: PRESS_BOUNDS }),
    landed: async (result, scope) => {
      expect(result).toMatchObject({ name: EMBED_SAVE, role: "button", from: EMBED_PAGE_PATH, path: EMBED_PAGE_PATH, navigated: false });
      expect(await scope.evaluate(() => !document.getElementById("embed-saved").hasAttribute("hidden")), "the press did not land in the frame").toBe(true);
    },
  },
  {
    step: "pressByTestId",
    act: (steps, scope, record) => steps.pressByTestId(scope, { testId: EMBED_ROW_TEST_ID, text: EMBED_ROW_TEXT, record, bounds: PRESS_BOUNDS }),
    landed: async (result, scope) => {
      expect(result).toMatchObject({ name: EMBED_ROW_TEXT, testId: EMBED_ROW_TEST_ID, from: EMBED_PAGE_PATH, navigated: false });
      expect(await scope.evaluate((id) => document.querySelector(`[data-testid="${id}"]`).getAttribute("data-fixture-clicks"), EMBED_ROW_TEST_ID)).toBe("1");
    },
  },
  {
    step: "dispatchRun",
    act: (steps, scope, record) => steps.dispatchRun(scope, { prompt: PROMPT, record, bounds: RUN_BOUNDS }),
    landed: async (result, scope) => {
      expect(result).toMatchObject({ card: null, via: "run", state: "status:queued", path: EMBED_PAGE_PATH });
      expect(await scope.evaluate(() => document.querySelectorAll("#embed-thread [data-run-progress-panel]").length)).toBe(1);
    },
  },
  {
    step: "sendInComposer",
    // The embed's composer starts a run with every message: a send there is dispatchRun's act, refused by name.
    act: async (steps, scope, record) => refusal(steps.sendInComposer(scope, { prompt: PROMPT, composer: EMBED_COMPOSER, record, bounds: COMPOSER_BOUNDS })),
    landed: async (error, scope) => {
      expect(error.kind).toBe("starts-run");
      expect(error.message).toBe(
        `sendInComposer refused (starts-run): the message sent through the composer "${EMBED_COMPOSER}" on ${EMBED_PAGE_PATH} started a run: it shows on ${EMBED_PAGE_PATH} (status:queued) — starting a run is dispatchRun's act`,
      );
      expect(await scope.evaluate(() => document.querySelectorAll("#embed-thread [data-run-progress-panel]").length)).toBe(1);
    },
  },
  {
    step: "typeInWindow",
    act: (steps, scope, record) => steps.typeInWindow(scope, { field: EMBED_WINDOW, text: TEXT, record, bounds: TYPE_BOUNDS }),
    landed: async (result, scope) => {
      expect(result).toEqual({ field: EMBED_WINDOW, text: TEXT, sent: false, path: EMBED_PAGE_PATH });
      expect(await scope.evaluate(() => document.querySelector('[data-fixture-window-box="turn"]').textContent)).toBe(TEXT);
    },
  },
  {
    step: "waitForTurn",
    act: async (steps, scope, record) => {
      await steps.typeInWindow(scope, { field: EMBED_WINDOW, text: TEXT, send: true, record, bounds: TYPE_BOUNDS });
      return steps.waitForTurn(scope, { record, bounds: TURN_BOUNDS });
    },
    landed: async (result) => {
      expect(result).toMatchObject({ field: EMBED_WINDOW, before: { person: 1, assistant: 1 }, after: { person: 2, assistant: 2 }, path: EMBED_PAGE_PATH });
    },
  },
  {
    step: "fillForm",
    act: (steps, scope, record) => steps.fillForm(scope, { fields: { [EMBED_FIELD_LABEL]: TITLE }, record, bounds: FORM_BOUNDS }),
    landed: async (result, scope) => {
      expect(result).toEqual({ filled: [EMBED_FIELD_LABEL], submitted: false, path: EMBED_PAGE_PATH });
      expect(await scope.evaluate(() => document.querySelector('input[name="title"]').value)).toBe(TITLE);
    },
  },
  {
    step: "readControlNames",
    act: (steps, scope, record) => steps.readControlNames(scope, { record, within: "Notes" }),
    landed: async (result) => {
      expect(result).toEqual({ controls: [{ role: "button", name: EMBED_SAVE, from: "text", description: "" }], more: 0 });
    },
  },
];

/**
 * THE STEPS THAT REFUSE A SCOPE: every other step that takes a page, each with
 * the call made on a scope and the words the step says of what it did not do.
 */
const REFUSING = [
  ["reloadPage", (s, scope, record) => s.reloadPage(scope, { record }), "nothing was reloaded"],
  ["openAddress", (s, scope, record) => s.openAddress(scope, { path: "/nav/target", record }), "no address was typed"],
  ["readAddress", (s, scope, record) => s.readAddress(scope, { params: ["tab"], record }), "nothing was read"],
  ["navigateTo", (s, scope, record) => s.navigateTo(scope, { path: "/nav/target", record }), "nothing was pressed"],
  ["openPageInOwnContext", (s, scope, record) => s.openPageInOwnContext(scope, { path: "/nav/target", record }), "nothing was opened"],
  [
    "signInThroughPage",
    (s, scope, record) => s.signInThroughPage(scope, { credentials: { email: "a", password: "b" }, budget: s.createSignInBudget(), record }),
    "nothing was sent",
  ],
  ["armPageTape", (s, scope, record) => s.armPageTape(scope, { record }), "no tape was armed"],
  ["readPageTape", (s, scope, record) => s.readPageTape(scope, { record }), "nothing was read"],
  ["selectFrom", (s, scope, record) => s.selectFrom(scope, { picker: "Blog ideas", entry: "One", record }), "nothing was selected"],
  ["readOptions", (s, scope, record) => s.readOptions(scope, { picker: "Blog ideas", record }), "nothing was read"],
  ["uploadFile", (s, scope, record) => s.uploadFile(scope, { control: "Upload", path: "brief.md", record }), "nothing was pressed"],
  ["switchTheme", (s, scope, record) => s.switchTheme(scope, { to: "dark", record }), "nothing was pressed"],
  ["decideGate", (s, scope, record) => s.decideGate(scope, { gate: "Review requested", decision: "Approve", record }), "nothing was pressed"],
  ["watchRun", (s, scope, record) => s.watchRun(scope, { record, shutter: shutterDouble().shutter }), "nothing was read"],
  ["readStandingRequests", (s, scope, record) => s.readStandingRequests(scope, { record }), "nothing was read"],
  ["readTitle", (s, scope, record) => s.readTitle(scope, { record }), "nothing was read"],
  ["waitForIsland", (s, scope, record) => s.waitForIsland(scope, { record, shutter: shutterDouble().shutter }), "nothing was read"],
];

for (const backend of [...BACKENDS, ISOLATED]) {
  describe.skipIf(Boolean(backend.skip))(`frameOf and the frame scope [${labelOf(backend)}]`, () => {
    for (const [where, origin] of SITES) {
      it(`answers the scope of the widget's frame ${where}, found through the widget's shadow root, and the frame's path`, async () => {
        const { frameOf } = theSteps("frameOf");
        await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
          await openWidget(app, page, origin);
          const result = await frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
          expect(result.path).toBe(EMBED_PAGE_PATH);
          expect(new URL(result.scope.url()).pathname).toBe(EMBED_PAGE_PATH);
          expect(result.scope.mainFrame().url()).toBe(result.scope.url());
          expect(result.scope.isClosed()).toBe(false);
          // A scope is never reloaded, sent elsewhere, photographed or closed: the page is.
          for (const name of ["reload", "goto", "screenshot", "close"]) expect(result.scope[name], `a scope offers ${name}`).toBeUndefined();
          // The two roads of the control reader: a frame of another site runs out of process, with a session of its own; one of the same site has none.
          const own = await page
            .context()
            .newCDPSession(result.scope.mainFrame())
            .then(
              async (session) => {
                await session.detach();
                return true;
              },
              () => false,
            );
          if (OUT_OF_PROCESS.has(backend.name)) expect(own, "the frame's own session").toBe(origin === "crossSiteOrigin");
          else expect(own, "a frame of the same site has a session of its own").toBe(origin === "crossSiteOrigin" ? own : false);
          expect(lines).toEqual([FRAME_LINE]);
        });
      });

      for (const row of SCOPED) {
        it(`${row.step}, given the scope of a frame ${where}, reads and acts in the frame's document alone`, async () => {
          const steps = theSteps("frameOf", row.step);
          await scene(backend, { site: true, secrets: [PROMPT, TEXT, TITLE] }, async ({ app, page, record, lines }) => {
            await openWidget(app, page, origin);
            const { scope } = await steps.frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
            const site = await siteReading(page);
            const result = await row.act(steps, scope, record);
            await row.landed(result, scope);
            expect(await siteReading(page), "the site's page changed").toBe(site);
            expect(await marksIn(scope), "the frame kept a step's mark").toBe(0);
            expect(lines[0]).toBe(FRAME_LINE);
            for (const line of lines.slice(1)) expect(line.startsWith(`${row.step}: `) || line.startsWith("typeInWindow: ") || line.startsWith(`${row.step} refused`), line).toBe(true);
          });
        });
      }

      it(`sends a run through the composer of a frame ${where} (via run), and refuses sendInComposer's send that starts one on the same scope`, async () => {
        const steps = theSteps("frameOf", "dispatchRun", "sendInComposer");
        await scene(backend, { site: true, secrets: [PROMPT] }, async ({ app, page, record, lines }) => {
          await openWidget(app, page, origin);
          const { scope } = await steps.frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
          const run = await steps.dispatchRun(scope, { prompt: PROMPT, record, bounds: RUN_BOUNDS });
          expect(run).toMatchObject({ via: "run", state: "status:queued", path: EMBED_PAGE_PATH });
          const error = await refusal(steps.sendInComposer(scope, { prompt: PROMPT, composer: EMBED_COMPOSER, record, bounds: COMPOSER_BOUNDS }));
          expect(error.kind).toBe("starts-run");
          expect(await scope.evaluate(() => document.querySelectorAll("#embed-thread [data-run-progress-panel]").length)).toBe(2);
          expect(lines).toEqual([
            FRAME_LINE,
            `dispatchRun: the run sent through the composer "${EMBED_COMPOSER}" shows on ${EMBED_PAGE_PATH} after ${run.elapsedMs} ms (status:queued)`,
            error.message,
          ]);
        });
      });
    }

    it("refuses a frame no element of the selector stands for within the bound, naming how many matched", async () => {
      const { frameOf } = theSteps("frameOf");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await page.goto(`${app.siteOrigin}${SITE_PAGE_PATH}`);
        const error = await refusal(frameOf(page, { frame: FRAME_SELECTOR, record, bounds: { frameMs: 400, pollMs: 25 } }));
        expect(error.kind).toBe("no-frame");
        expect(error.message).toBe(
          `frameOf refused (no-frame): no frame of the selector "${FRAME_SELECTOR}" on ${SITE_PAGE_PATH} loaded within 400 ms: no attached element matched it — no frame was read`,
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses a selector several frame elements match, naming how many, and never guesses", async () => {
      const { frameOf } = theSteps("frameOf");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await openWidget(app, page, "siteOrigin");
        // The site's own banner frame, and the widget's frame inside its shadow root.
        const error = await refusal(frameOf(page, { frame: "iframe", record, bounds: FRAME_BOUNDS }));
        expect(error.kind).toBe("ambiguous");
        expect(error.message).toBe(`frameOf refused (ambiguous): 2 attached elements on ${SITE_PAGE_PATH} match the selector "iframe" — no frame was read, since a frame is never guessed`);
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses a frame scope in place of a page, as every step that needs a page does", async () => {
      const { frameOf } = theSteps("frameOf");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await openWidget(app, page, "siteOrigin");
        const { scope } = await frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
        const error = await refusal(frameOf(scope, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS }));
        expect(error.kind).toBe("input");
        expect(error.message).toBe("frameOf refused (input): a frame scope stands where a page is needed — no frame was read");
        expect(lines).toEqual([FRAME_LINE, error.message]);
      });
    });

    it("refuses, as unreadable, a stale scope whose frame was replaced, in each of the nine steps; frameOf answers the new frame", async () => {
      const steps = theSteps("frameOf", ...SCOPED.map((row) => row.step));
      await scene(backend, { site: true, secrets: [PROMPT, TEXT, TITLE] }, async ({ app, page, record, lines }) => {
        await openWidget(app, page, "siteOrigin");
        const { scope } = await steps.frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
        await page.reload();
        await page.locator(LAUNCHER_SELECTOR).click();
        expect(scope.isClosed(), "the scope of the replaced frame does not read as closed").toBe(true);
        const before = app.requests.length;
        for (const row of SCOPED) {
          const error = await refusal(row.act(steps, scope, record).then((value) => (value instanceof Error ? Promise.reject(value) : value)));
          expect(error.kind, row.step).toBe("unreadable");
          expect(error.message).toContain(`is detached: its page was reloaded or the frame was mounted anew, so call frameOf again`);
        }
        expect(app.requests.length, "a step given a stale scope reached the app").toBe(before);
        // frameOf answers the new frame, and its scope reads.
        const fresh = await steps.frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
        expect((await steps.readCount(fresh.scope, { selector: EMBED_ITEM_SELECTOR, record, ...COUNT })).count).toBe(3);
        expect(lines.filter((line) => line.startsWith("frameOf: "))).toEqual([FRAME_LINE, FRAME_LINE]);
      });
    });

    it("refuses a frame scope in every step that needs a page, before it loads, presses or marks anything", async () => {
      const steps = theSteps("frameOf", ...REFUSING.map(([step]) => step));
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await openWidget(app, page, "siteOrigin");
        const { scope } = await steps.frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
        const site = await siteReading(page);
        const requests = app.requests.length;
        const at = lines.length;
        for (const [step, call, nothing] of REFUSING) {
          const error = await refusal(Promise.resolve().then(() => call(steps, scope, record)));
          expect(error.name, step).toBe("StepRefusal");
          expect(error.message).toBe(`${step} refused (input): a frame scope stands where a page is needed — ${nothing}`);
        }
        expect(lines.slice(at)).toEqual(REFUSING.map(([step, , nothing]) => `${step} refused (input): a frame scope stands where a page is needed — ${nothing}`));
        expect(app.requests.length, "a refusing step reached the app").toBe(requests);
        expect(await siteReading(page), "a refusing step changed the site's page").toBe(site);
        expect(await marksIn(scope), "a refusing step marked the frame").toBe(0);
        expect(new URL(page.url()).pathname).toBe(SITE_PAGE_PATH);
      });
    });

    it("reads the frame's palette with readCount, on the class the app writes on the frame document's root", async () => {
      const steps = theSteps("frameOf", "readCount");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await openWidget(app, page, "siteOrigin");
        const { scope } = await steps.frameOf(page, { frame: FRAME_SELECTOR, record, bounds: FRAME_BOUNDS });
        const selector = `html.${EMBED_PALETTE_CLASS}`;
        expect(await steps.readCount(scope, { selector, record, ...COUNT })).toEqual({ selector, count: 1, path: EMBED_PAGE_PATH });
        expect(await steps.readCount(page, { selector, record, ...COUNT })).toEqual({ selector, count: 0, path: SITE_PAGE_PATH });
        expect(lines).toEqual([
          FRAME_LINE,
          `readCount: 1 element matches ${selector} on ${EMBED_PAGE_PATH}`,
          `readCount: 0 elements match ${selector} on ${SITE_PAGE_PATH}`,
        ]);
      });
    });
  });
}

// The answer is taken only once it still holds, and only within the bound. A
// driver whose readings are played in order stands for the moments between
// them: a second frame element mounted, or the frame detached, while the
// frame's document was being read; or a document that answers after the bound.
describe("frameOf, read again before it answers", () => {
  // An origin of no server, built from parts: the readings are played, never served.
  const PLAYED = ["http:", "", "played.test"].join("/");
  /** A page whose selector counts `counts` in turn (the last one after), and whose one frame answers `frame`. */
  function playedPage({ counts, frame }) {
    let reads = 0;
    const elements = {
      count: async () => counts[Math.min(reads++, counts.length - 1)],
      elementHandle: async () => ({ contentFrame: async () => frame, dispose: async () => {} }),
    };
    return { url: () => `${PLAYED}/post`, locator: () => elements, isClosed: () => false };
  }
  /** A frame on the embed's path whose document answers loaded after `ms`, and detaches once read when `detaches`. */
  function playedFrame({ ms = 0, detaches = false } = {}) {
    let detached = false;
    return {
      url: () => `${PLAYED}/embed/assistant`,
      isDetached: () => detached,
      evaluate: async () => {
        await new Promise((done) => setTimeout(done, ms));
        if (detaches) detached = true;
        return true;
      },
      childFrames: () => [],
    };
  }
  const collect = () => {
    const lines = [];
    return { lines, record: (line) => lines.push(line) };
  };

  it("refuses as ambiguous a second frame element mounted while the frame's document was read", async () => {
    const { frameOf } = theSteps("frameOf");
    const { lines, record } = collect();
    const page = playedPage({ counts: [1, 2], frame: playedFrame() });
    const error = await refusal(frameOf(page, { frame: "iframe", record, bounds: { frameMs: 400, pollMs: 10 } }));
    expect(error.kind).toBe("ambiguous");
    expect(error.message).toBe(`frameOf refused (ambiguous): 2 attached elements on /post match the selector "iframe" — no frame was read, since a frame is never guessed`);
    expect(lines).toEqual([error.message]);
  });

  it("answers no scope of a frame detached while its document was read", async () => {
    const { frameOf } = theSteps("frameOf");
    const { lines, record } = collect();
    const page = playedPage({ counts: [1], frame: playedFrame({ detaches: true }) });
    const error = await refusal(frameOf(page, { frame: "iframe", record, bounds: { frameMs: 150, pollMs: 10 } }));
    expect(error.kind).toBe("no-frame");
    expect(error.message).toBe(`frameOf refused (no-frame): no frame of the selector "iframe" on /post loaded within 150 ms: 1 attached element matched it, without a loaded frame — no frame was read`);
    expect(lines).toEqual([error.message]);
  });

  it("answers no frame whose document answered only after the bound ran out", async () => {
    const { frameOf } = theSteps("frameOf");
    const { lines, record } = collect();
    const page = playedPage({ counts: [1], frame: playedFrame({ ms: 200 }) });
    const started = performance.now();
    const error = await refusal(frameOf(page, { frame: "iframe", record, bounds: { frameMs: 30, pollMs: 10 } }));
    expect(error.kind).toBe("no-frame");
    expect(performance.now() - started, "frameOf waited for a reading past its bound").toBeLessThan(150);
    expect(lines).toEqual([error.message]);
  });
});
