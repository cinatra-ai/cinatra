// waitForIsland: the review island's wait, driven against fixture pages whose
// island reaches each of its load states.
//
// The defect these cases stand for: an island wait ran out after three minutes
// and no frame was taken at the bound, so the run kept no picture of what the
// island showed. The step takes the frame either way and writes one line either
// way.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, shutterDouble, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const POLL = 50;
const SHORT = 700;
const LONG = 5000;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`waitForIsland [${labelOf(backend)}]`, () => {
    const wait = async (page, app, path, options) => {
      const { waitForIsland } = theSteps("waitForIsland");
      await page.goto(`${app.origin}${path}`);
      return waitForIsland(page, { pollMs: POLL, ...options });
    };

    it("takes the frame when the island settles, and writes one line", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await wait(page, app, "/island/loads", { bound: LONG, record, shutter });
        expect(result).toMatchObject({ state: "loaded", settled: true, path: "frames/waitForIsland-1.png" });
        expect(result.elapsedMs).toBeLessThan(LONG);
        expect(shots).toHaveLength(1);
        expect(shots[0]).toMatchObject({ step: "waitForIsland", state: "loaded", settled: true });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^waitForIsland: settled after \d+ ms \(state loaded\); frame frames\/waitForIsland-1\.png$/);
      });
    });

    it("takes the frame at the bound when the island never settles", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await wait(page, app, "/island/stalls", { bound: SHORT, record, shutter });
        expect(result).toMatchObject({ state: "loading", settled: false });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(SHORT);
        expect(shots, "no frame was taken at the bound").toHaveLength(1);
        expect(shots[0]).toMatchObject({ state: "loading", settled: false });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^waitForIsland: ran out after \d+ ms \(state loading\); frame frames\/waitForIsland-1\.png$/);
      });
    });

    it("does not end the wait on the card's own timed-out reading", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await wait(page, app, "/island/times-out", { bound: SHORT, record, shutter });
        expect(result).toMatchObject({ state: "timed-out", settled: false });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(SHORT);
        expect(shots).toHaveLength(1);
        expect(lines[0]).toMatch(/^waitForIsland: ran out after \d+ ms \(state timed-out\); frame /);
      });
    });

    it("settles on a late load that heals the card after its own bound", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await wait(page, app, "/island/heals", { bound: LONG, record, shutter });
        expect(result).toMatchObject({ state: "loaded", settled: true });
        expect(shots).toHaveLength(1);
        expect(lines[0]).toMatch(/^waitForIsland: settled after \d+ ms \(state loaded\); frame /);
      });
    });

    it("runs to the bound on a page without the island and says so", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await wait(page, app, "/island/absent", { bound: SHORT, record, shutter });
        expect(result).toMatchObject({ state: "absent", settled: false });
        expect(shots).toHaveLength(1);
        expect(lines[0]).toMatch(/^waitForIsland: ran out after \d+ ms \(state absent\); frame /);
      });
    });

    it("does not take an island that frames another document for this one", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { shutter } = shutterDouble();
        const result = await wait(page, app, "/island/elsewhere", { bound: SHORT, record, shutter });
        expect(result).toMatchObject({ state: "absent", settled: false });
      });
    });

    it("refuses by name when the shutter fails, and keeps only the error class", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const shutter = async () => {
          throw new TypeError("could not write frames/unwritable.png");
        };
        const error = await refusal(wait(page, app, "/island/loads", { bound: LONG, record, shutter }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("waitForIsland");
        expect(error.kind).toBe("no-frame");
        expect(error.message).toBe("waitForIsland refused (no-frame): the shutter failed (TypeError) — no frame was taken");
        expect(lines).toEqual([error.message]);
      });
    });

    it("reads nothing when it refuses its arguments", async () => {
      const { waitForIsland } = theSteps("waitForIsland");
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/island/loads`);
        const { shutter } = shutterDouble();
        const cases = [
          [{ record }, "hand the step a shutter that takes the frame — nothing was read"],
          [{ record, shutter, bound: 0 }, "bound must be a positive number of milliseconds — nothing was read"],
          [{ record, shutter, pollMs: -1 }, "pollMs must be a positive number of milliseconds — nothing was read"],
          [
            { record, shutter, frameSrcPath: "review-island" },
            "name the island's frame by its path, such as /lifecycle/review-island — nothing was read",
          ],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(waitForIsland(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`waitForIsland refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(waitForIsland(page, { shutter }));
        expect(unrecorded.message).toBe("waitForIsland refused (input): hand the step a record callback — nothing was done");
      });
    });
  });
}
