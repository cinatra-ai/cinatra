// pressKey: one key of a closed list pressed on the control that has the
// focus, the focused control read before and after, and the page's next
// settled state.
//
// The defect these cases stand for: a picture round had to prove that the
// arrow keys move between blog ideas (cinatra#3773), and no maintained step
// pressed a key on a control; a round may press no key of its own. The step
// presses only a key of its list, only where a shown control has the focus, and
// says where the focus was before and after.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

// Short bounds, so a key that settles in place costs half a second, not two.
const BOUNDS = Object.freeze({ actionMs: 2000, startMs: 500, settleMs: 5000, pollMs: 25 });
const START = "/press-key/start";
const STAYED = `no navigation started within 500 ms, and the page stayed on ${START}`;
const IDEA = (name) => ({ name, role: "radio" });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`pressKey [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}${START}`);
      return theSteps("pressKey").pressKey;
    };
    const chosen = (page) => page.evaluate(() => Array.from(document.querySelectorAll("[role='radio']")).map((radio) => radio.getAttribute("aria-checked")));
    const focused = (page) => page.evaluate(() => (document.activeElement && document.activeElement !== document.body ? document.activeElement.textContent : null));
    const keysHeard = (page) => page.evaluate(() => document.body.getAttribute("data-fixture-keys"));
    const marks = (page) => page.evaluate(() => document.querySelectorAll("[data-step-control]").length);

    it("presses ArrowDown on the radio it focuses by its name: the next radio takes the focus and the choice", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        const result = await pressKey(page, { key: "ArrowDown", focus: IDEA("Idea one"), record, bounds: BOUNDS });
        expect(result).toMatchObject({
          key: "ArrowDown",
          from: START,
          path: START,
          navigated: false,
          moved: true,
          before: { on: "control", role: "radio", name: "Idea one", state: "checked" },
          after: { on: "control", role: "radio", name: "Idea two", state: "checked" },
        });
        expect(await chosen(page)).toEqual(["false", "true", "false"]);
        expect(await focused(page)).toBe("Idea two");
        expect(await marks(page)).toBe(0);
        expect(lines).toEqual([
          `pressKey: pressed ArrowDown on the radio "Idea one" (checked) on ${START}, focused by its name first — the focus moved to the radio "Idea two" (checked); ${STAYED}`,
        ]);
      });
    });

    it("presses ArrowDown again on the control that has the focus, with no focus named", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        await pressKey(page, { key: "ArrowDown", focus: IDEA("Idea one"), record, bounds: BOUNDS });
        const result = await pressKey(page, { key: "ArrowDown", record, bounds: BOUNDS });
        expect(result).toMatchObject({ before: { name: "Idea two", state: "checked" }, after: { name: "Idea three", state: "checked" }, moved: true });
        expect(await chosen(page)).toEqual(["false", "false", "true"]);
        expect(await focused(page)).toBe("Idea three");
        expect(lines[1]).toBe(`pressKey: pressed ArrowDown on the radio "Idea two" (checked) on ${START} — the focus moved to the radio "Idea three" (checked); ${STAYED}`);
      });
    });

    it("wraps ArrowUp from the first radio to the last", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        const result = await pressKey(page, { key: "ArrowUp", focus: IDEA("Idea one"), record, bounds: BOUNDS });
        expect(result.after).toEqual({ on: "control", role: "radio", name: "Idea three", state: "checked" });
        expect(await chosen(page)).toEqual(["false", "false", "true"]);
        expect(await focused(page)).toBe("Idea three");
        expect(lines).toEqual([
          `pressKey: pressed ArrowUp on the radio "Idea one" (checked) on ${START}, focused by its name first — the focus moved to the radio "Idea three" (checked); ${STAYED}`,
        ]);
      });
    });

    it("moves ArrowRight to the next and ArrowLeft to the previous radio", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const pressKey = await start(page, app);
        const right = await pressKey(page, { key: "ArrowRight", focus: IDEA("Idea one"), record, bounds: BOUNDS });
        expect(right.after.name).toBe("Idea two");
        expect(await chosen(page)).toEqual(["false", "true", "false"]);
        const left = await pressKey(page, { key: "ArrowLeft", record, bounds: BOUNDS });
        expect(left.after).toEqual({ on: "control", role: "radio", name: "Idea one", state: "checked" });
        expect(await chosen(page)).toEqual(["true", "false", "false"]);
        expect(await focused(page)).toBe("Idea one");
      });
    });

    it("moves Home to the first and End to the last radio", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const pressKey = await start(page, app);
        await pressKey(page, { key: "ArrowDown", focus: IDEA("Idea one"), record, bounds: BOUNDS });
        const end = await pressKey(page, { key: "End", record, bounds: BOUNDS });
        expect(end.after.name).toBe("Idea three");
        expect(await chosen(page)).toEqual(["false", "false", "true"]);
        const home = await pressKey(page, { key: "Home", record, bounds: BOUNDS });
        expect(home.after).toEqual({ on: "control", role: "radio", name: "Idea one", state: "checked" });
        expect(await chosen(page)).toEqual(["true", "false", "false"]);
        expect(await focused(page)).toBe("Idea one");
      });
    });

    it("moves Tab from the group to the next control in the page's order", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        const result = await pressKey(page, { key: "Tab", focus: IDEA("Idea one"), record, bounds: BOUNDS });
        expect(result).toMatchObject({ moved: true, after: { on: "control", role: "button", name: "Show summary", state: null } });
        expect(await chosen(page), "Tab changed the choice").toEqual(["true", "false", "false"]);
        expect(await focused(page)).toBe("Show summary");
        expect(lines).toEqual([
          `pressKey: pressed Tab on the radio "Idea one" (checked) on ${START}, focused by its name first — the focus moved to the button "Show summary"; ${STAYED}`,
        ]);
      });
    });

    for (const key of ["Enter", "Space"]) {
      it(`activates a focused checkbox with ${key}: it goes from unchecked to checked and keeps the focus`, async () => {
        await scene(backend, {}, async ({ app, page, record, lines }) => {
          const pressKey = await start(page, app);
          const result = await pressKey(page, { key, focus: { name: "Keep drafts", role: "checkbox" }, record, bounds: BOUNDS });
          expect(result).toMatchObject({
            moved: false,
            navigated: false,
            before: { role: "checkbox", name: "Keep drafts", state: "unchecked" },
            after: { role: "checkbox", name: "Keep drafts", state: "checked" },
          });
          expect(await page.evaluate(() => document.querySelector("[data-fixture-toggles]").getAttribute("aria-checked"))).toBe("true");
          expect(await focused(page)).toBe("Keep drafts");
          expect(lines).toEqual([
            `pressKey: pressed ${key} on the checkbox "Keep drafts" (unchecked) on ${START}, focused by its name first — the focus stayed on the checkbox "Keep drafts" (checked); ${STAYED}`,
          ]);
        });
      });
    }

    it("presses Enter on a focused link and waits for the landing", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        const result = await pressKey(page, { key: "Enter", focus: { name: "Target", role: "link" }, record, bounds: BOUNDS });
        expect(result).toMatchObject({ from: START, path: "/nav/target", navigated: true, moved: true, before: { role: "link", name: "Target", state: null } });
        expect(new URL(page.url()).pathname).toBe("/nav/target");
        expect(lines).toEqual([
          `pressKey: pressed Enter on the link "Target" on ${START}, focused by its name first — the focus is now on nothing; landed on /nav/target after ${result.elapsedMs} ms`,
        ]);
      });
    });

    it("refuses a key outside the closed list before anything is pressed", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        const refused = "pressKey refused (input): key must be ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, Tab, Enter or Space — nothing was pressed";
        for (const key of ["Escape", "a", "Shift+Tab", ""]) {
          const error = await refusal(pressKey(page, { key, focus: IDEA("Idea one"), record, bounds: BOUNDS }));
          expect(error.kind, JSON.stringify(key)).toBe("input");
          expect(error.message).toBe(refused);
        }
        expect(lines).toEqual([refused, refused, refused, refused]);
        expect(await keysHeard(page), "a refused key reached the page").toBe(null);
        expect(await chosen(page)).toEqual(["true", "false", "false"]);
        expect(await focused(page), "a refused key moved the focus").toBe(null);
        expect(await marks(page)).toBe(0);
      });
    });

    it("refuses a page where nothing has the focus", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        const error = await refusal(pressKey(page, { key: "ArrowDown", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-focus");
        expect(error.message).toBe(`pressKey refused (no-focus): nothing on ${START} has the focus — nothing was pressed`);
        expect(lines).toEqual([error.message]);
        expect(await keysHeard(page), "a key reached the page").toBe(null);
        expect(await chosen(page)).toEqual(["true", "false", "false"]);
      });
    });

    it("refuses a focus name no shown control carries, pressing nothing", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const pressKey = await start(page, app);
        const error = await refusal(pressKey(page, { key: "ArrowDown", focus: IDEA("Idea four"), record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-control");
        expect(error.message).toBe(
          `pressKey refused (no-control): no shown radio on ${START} is named "Idea four" — the radios it shows: "Idea one", "Idea two", "Idea three"; nothing was pressed`,
        );
        expect(lines).toEqual([error.message]);
        expect(await keysHeard(page), "a key reached the page").toBe(null);
        expect(await focused(page)).toBe(null);
        expect(await marks(page)).toBe(0);
      });
    });
  });
}
