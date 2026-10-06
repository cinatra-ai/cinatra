// readCount: a reading with a value, for a state whose precondition is absent on
// the boot. The count is recorded on one line, and only once it has held still,
// so a list that mounts a moment after the page loads is never read as empty.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const QUICK = Object.freeze({ settleMs: 200, pollMs: 25, bound: 3000 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`readCount [${labelOf(backend)}]`, () => {
    const count = async (page, app, path, options) => {
      const { readCount } = theSteps("readCount");
      await page.goto(`${app.origin}${path}`);
      return readCount(page, { ...QUICK, ...options });
    };

    it("records what is attached, hidden rows included, on one line", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const result = await count(page, app, "/count/steady", { selector: ".row", record });
        expect(result).toEqual({ selector: ".row", count: 3, path: "/count/steady" });
        expect(lines).toEqual(["readCount: 3 elements match .row on /count/steady"]);
      });
    });

    it("records a zero as a reading with a value", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const none = await count(page, app, "/count/none", { selector: ".row", record });
        expect(none.count).toBe(0);
        const list = await count(page, app, "/count/none", { selector: "#rows", record });
        expect(list.count).toBe(1);
        expect(lines).toEqual([
          "readCount: 0 elements match .row on /count/none",
          "readCount: 1 element matches #rows on /count/none",
        ]);
      });
    });

    it("waits for the count to hold still, so a list that mounts late is not read as empty", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const result = await count(page, app, "/count/late", { selector: ".row", record, settleMs: 400 });
        expect(result.count).toBe(2);
        expect(lines).toEqual(["readCount: 2 elements match .row on /count/late"]);
      });
    });

    it("refuses by name a count that never holds still", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const error = await refusal(
          count(page, app, "/count/growing", { selector: ".row", record, settleMs: 150, pollMs: 20, bound: 1000 }),
        );
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("readCount");
        expect(error.kind).toBe("unsteady");
        expect(error.message).toMatch(
          /^readCount refused \(unsteady\): the count of \.row did not hold still for 150 ms within 1000 ms \(last reading \d+\)$/,
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("refuses by name a selector it cannot count, keeping only the error class", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const error = await refusal(count(page, app, "/count/steady", { selector: "li[", record }));
        expect(error.kind).toBe("unreadable");
        expect(error.message).toMatch(/^readCount refused \(unreadable\): li\[ could not be counted \((SyntaxError|Error)\)$/);
      });
    });

    it("reads nothing when it refuses its arguments", async () => {
      const { readCount } = theSteps("readCount");
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/count/steady`);
        const cases = [
          [{ record }, "name the selector to count — nothing was read"],
          [{ record, selector: "  " }, "name the selector to count — nothing was read"],
          [{ record, selector: ".row", settleMs: 0 }, "settleMs must be a positive number of milliseconds — nothing was read"],
          [{ record, selector: ".row", bound: -5 }, "bound must be a positive number of milliseconds — nothing was read"],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(readCount(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`readCount refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(readCount(page, { selector: ".row" }));
        expect(unrecorded.message).toBe("readCount refused (input): hand the step a record callback — nothing was done");
      });
    });
  });
}
