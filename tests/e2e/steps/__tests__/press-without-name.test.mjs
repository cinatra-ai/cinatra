// pressWithoutName: the one control without an accessible name pressed by its
// selector, through an open shadow root, with the fault said.
//
// The defect these cases stand for: a site's widget draws its launcher as a
// button that holds an icon alone, inside the widget's own shadow root. It has
// no accessible name, so `press` has nothing to name there, and a run pressed
// whatever its own selector found first. The step presses only the one shown
// element of the selector, and only when the accessibility tree reads no name
// for it; a named twin is press's and is refused; the record says that the
// control has no name.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { FRAME_SELECTOR, LAUNCHER_SELECTOR, NAMED_LAUNCHER_NAME, NAMED_LAUNCHER_SELECTOR, PAIR_SELECTOR, SITE_PAGE_PATH } from "./fixture-app-site.mjs";

afterAll(closeBrowser);

// Short bounds, as press's own test file shortens them.
const BOUNDS = Object.freeze({ actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`pressWithoutName [${labelOf(backend)}]`, () => {
    /** How many frames the widget mounted, and how many elements of the page, its shadow roots too, carry the steps' mark. */
    const frames = (page) => page.locator(FRAME_SELECTOR).count();
    const marks = (page) =>
      page.evaluate(() => {
        const host = document.getElementById("cw-host");
        return document.querySelectorAll("[data-step-control]").length + (host && host.shadowRoot ? host.shadowRoot.querySelectorAll("[data-step-control]").length : 0);
      });

    it("presses the launcher without a name inside the widget's shadow root, says the fault first, and returns once the page has settled", async () => {
      const { pressWithoutName } = theSteps("pressWithoutName");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await page.goto(`${app.siteOrigin}${SITE_PAGE_PATH}`);
        expect(await frames(page)).toBe(0);
        const result = await pressWithoutName(page, { selector: LAUNCHER_SELECTOR, record, bounds: BOUNDS });
        expect(result).toMatchObject({ name: "", role: "button", selector: LAUNCHER_SELECTOR, from: SITE_PAGE_PATH, path: SITE_PAGE_PATH, navigated: false });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(BOUNDS.startMs);
        expect(await frames(page), "the press did not mount the widget's frame").toBe(1);
        expect(await marks(page), "the launcher kept the step's mark").toBe(0);
        expect(lines).toEqual([
          `pressWithoutName: on ${SITE_PAGE_PATH}, the button of the selector "${LAUNCHER_SELECTOR}" has no accessible name; it was found by its selector`,
          `pressWithoutName: pressed the button of the selector "${LAUNCHER_SELECTOR}" on ${SITE_PAGE_PATH} — no navigation started within 500 ms, and the page stayed on ${SITE_PAGE_PATH}`,
        ]);
      });
    });

    it("refuses a control of the selector that has a name, which is press's, and presses nothing", async () => {
      const { pressWithoutName } = theSteps("pressWithoutName");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await page.goto(`${app.siteOrigin}${SITE_PAGE_PATH}`);
        const error = await refusal(pressWithoutName(page, { selector: NAMED_LAUNCHER_SELECTOR, record, bounds: BOUNDS }));
        expect(error.kind).toBe("has-name");
        expect(error.message).toBe(
          `pressWithoutName refused (has-name): the button of the selector "${NAMED_LAUNCHER_SELECTOR}" on ${SITE_PAGE_PATH} is named "${NAMED_LAUNCHER_NAME}" — press is the step for it, by its role and its name; nothing was pressed`,
        );
        expect(lines).toEqual([error.message]);
        expect(await frames(page)).toBe(0);
        expect(await marks(page)).toBe(0);
      });
    });

    it("refuses a selector no shown element matches, naming how many match", async () => {
      const { pressWithoutName } = theSteps("pressWithoutName");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await page.goto(`${app.siteOrigin}${SITE_PAGE_PATH}`);
        const error = await refusal(pressWithoutName(page, { selector: "button.cw-none", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-control");
        expect(error.message).toBe(
          `pressWithoutName refused (no-control): no shown element on ${SITE_PAGE_PATH} matches the selector "button.cw-none" — no attached element matches it; nothing was pressed`,
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses a selector several shown elements match, naming where each sits, and never guesses", async () => {
      const { pressWithoutName } = theSteps("pressWithoutName");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await page.goto(`${app.siteOrigin}${SITE_PAGE_PATH}`);
        const error = await refusal(pressWithoutName(page, { selector: PAIR_SELECTOR, record, bounds: BOUNDS }));
        expect(error.kind).toBe("ambiguous");
        expect(error.message).toBe(
          `pressWithoutName refused (ambiguous): 2 shown elements on ${SITE_PAGE_PATH} match the selector "${PAIR_SELECTOR}": 1 in the group "Pair", 2 in the group "Pair" — nothing was pressed, since a press never guesses`,
        );
        expect(lines).toEqual([error.message]);
        expect(await marks(page)).toBe(0);
      });
    });
  });
}
