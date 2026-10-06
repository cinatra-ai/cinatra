// readTitle: the page's title, through the browser's own reading of it, once it
// has held still.
//
// The defect these cases stand for: a picture run counted the head's title
// element with a selector and read 0, since the engine that reads text reads
// only what the page draws. The step reads `document.title`, returns it only
// once it has held still, and refuses a title that never does, as readCount
// refuses a count.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const QUICK = Object.freeze({ settleMs: 200, pollMs: 25, bound: 3000 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`readTitle [${labelOf(backend)}]`, () => {
    const title = async (page, app, path, options) => {
      const { readTitle } = theSteps("readTitle");
      await page.goto(`${app.origin}${path}`);
      return readTitle(page, { ...QUICK, ...options });
    };

    it("returns a title that holds still, and writes it on one line with the page's path", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const started = performance.now();
        const result = await title(page, app, "/title/steady", { record });
        expect(result).toEqual({ title: "Steady title", path: "/title/steady" });
        expect(performance.now() - started, "the title was returned before it had held still").toBeGreaterThanOrEqual(QUICK.settleMs);
        expect(lines).toEqual(['readTitle: the title of the page on /title/steady reads "Steady title"']);
      });
    });

    it("returns a title the page sets a moment after it loads only once the new title has held still", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const result = await title(page, app, "/title/late", { record, settleMs: 400 });
        expect(result).toEqual({ title: "Loaded title", path: "/title/late" });
        expect(lines).toEqual(['readTitle: the title of the page on /title/late reads "Loaded title"']);
      });
    });

    it("returns an empty title as the empty string, and says so", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const result = await title(page, app, "/title/empty", { record });
        expect(result).toEqual({ title: "", path: "/title/empty" });
        expect(lines).toEqual(["readTitle: the page on /title/empty has an empty title"]);
      });
    });

    it("refuses by name a title that never holds still, naming the last two titles it read", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const error = await refusal(title(page, app, "/title/restless", { record, settleMs: 150, pollMs: 20, bound: 1000 }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("readTitle");
        expect(error.kind).toBe("unsteady");
        expect(error.message).toMatch(
          /^readTitle refused \(unsteady\): the title of the page on \/title\/restless did not hold still for 150 ms within 1000 ms \(the last two titles it read: "Title (\d+)", then "Title (\d+)"\)$/,
        );
        const [, older, newer] = /"Title (\d+)", then "Title (\d+)"/.exec(error.message);
        expect(Number(newer), "the two titles named are not the last two it read").toBeGreaterThan(Number(older));
        expect(lines).toEqual([error.message]);
      });
    });

    it("reads nothing when it refuses its arguments", async () => {
      const { readTitle } = theSteps("readTitle");
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/title/steady`);
        const touched = [];
        const watched = new Proxy(page, {
          get: (target, key) => {
            if (typeof key === "string" && ["evaluate", "url", "title"].includes(key)) touched.push(key);
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const nothing = "nothing was read";
        const cases = [
          [{ record, settleMs: 0 }, `settleMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, pollMs: -1 }, `pollMs must be a positive number of milliseconds — ${nothing}`],
          [{ record, bound: -5 }, `bound must be a positive number of milliseconds — ${nothing}`],
          [{ record, bound: Number.POSITIVE_INFINITY }, `bound must be a positive number of milliseconds — ${nothing}`],
          [{ record, waitMs: 500 }, `there is no option named waitMs; the bounds are settleMs, pollMs and bound — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(readTitle(watched, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`readTitle refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(readTitle(watched, {}));
        expect(unrecorded.message).toBe("readTitle refused (input): hand the step a record callback — nothing was done");
        expect(touched, "a refused call read the page").toEqual([]);
      });
    });
  });
}

describe("readTitle, its bounds", () => {
  it("names its bounds as readCount names its own", () => {
    const steps = theSteps("readTitle", "readCount");
    expect(steps.TITLE_SETTLE_MS).toBe(steps.COUNT_SETTLE_MS);
    expect(steps.TITLE_POLL_MS).toBe(steps.COUNT_POLL_MS);
    expect(steps.TITLE_BOUND_MS).toBe(steps.COUNT_BOUND_MS);
  });
});
