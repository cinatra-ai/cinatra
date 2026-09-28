// watchRun: a run's watch, driven against fixture run pages that settle, keep
// moving, draw no status, or reload in the middle of the watch.
//
// The defect these cases stand for: a run watch ended early, before its bound
// and before the run had settled, so the frame showed a moment nobody chose.
// The step keeps the watch to its bound, treats a reading it could not take as a
// reading and not as an end, and takes the frame at the bound when the run never
// settled.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, shutterDouble, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const POLL = 50;
const SHORT = 700;
const LONG = 5000;

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`watchRun [${labelOf(backend)}]`, () => {
    const watch = async (page, app, path, options) => {
      const { watchRun } = theSteps("watchRun");
      await page.goto(`${app.origin}${path}`);
      return watchRun(page, { pollMs: POLL, ...options });
    };

    it("takes the frame when the run settles on a person's turn, and writes one line", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await watch(page, app, "/run/settles", { bound: LONG, record, shutter });
        expect(result).toMatchObject({ state: "status:needs-review", settled: true, path: "frames/watchRun-1.png" });
        expect(shots).toHaveLength(1);
        expect(shots[0]).toMatchObject({ step: "watchRun", state: "status:needs-review", settled: true });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^watchRun: settled after \d+ ms \(state status:needs-review\); frame frames\/watchRun-1\.png$/);
      });
    });

    it("waits past a completed run whose output is still loading", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await watch(page, app, "/run/completes", { bound: LONG, record, shutter });
        expect(result).toMatchObject({ state: "completion:outputs", settled: true });
        expect(shots).toHaveLength(1);
        expect(lines[0]).toMatch(/^watchRun: settled after \d+ ms \(state completion:outputs\); frame /);
      });
    });

    it("keeps the watch to its bound and takes the frame there when the run keeps moving", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await watch(page, app, "/run/moving", { bound: SHORT, record, shutter });
        // The page also draws a pill that reads "approved" for something else; it is never the run's status.
        expect(result).toMatchObject({ state: "status:running", settled: false });
        expect(result.elapsedMs, "the watch ended before its bound").toBeGreaterThanOrEqual(SHORT);
        expect(shots, "no frame was taken at the bound").toHaveLength(1);
        expect(shots[0]).toMatchObject({ state: "status:running", settled: false });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^watchRun: ran out after \d+ ms \(state status:running\); frame frames\/watchRun-1\.png$/);
      });
    });

    it("runs to the bound on a page without a run and says so", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shutter } = shutterDouble();
        const result = await watch(page, app, "/run/absent", { bound: SHORT, record, shutter });
        expect(result).toMatchObject({ state: "absent", settled: false });
        expect(lines[0]).toMatch(/^watchRun: ran out after \d+ ms \(state absent\); frame /);
      });
    });

    it("runs to the bound on a run surface that draws no status", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { shutter } = shutterDouble();
        const result = await watch(page, app, "/run/unmarked", { bound: SHORT, record, shutter });
        expect(result).toMatchObject({ state: "unmarked", settled: false });
      });
    });

    it("does not end the watch when the page reloads in the middle of it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { shots, shutter } = shutterDouble();
        const result = await watch(page, app, "/run/reloads", { bound: LONG, record, shutter });
        expect(result).toMatchObject({ state: "status:failed", settled: true });
        expect(app.requests.filter((r) => r.path === "/run/reloads"), "the page did not reload during the watch").toHaveLength(2);
        expect(shots).toHaveLength(1);
        expect(lines).toHaveLength(1);
      });
    });

    it("reads nothing when it refuses its arguments", async () => {
      const { watchRun } = theSteps("watchRun");
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/run/settles`);
        const { shutter } = shutterDouble();
        const cases = [
          [{ record }, "hand the step a shutter that takes the frame — nothing was read"],
          [{ record, shutter, bound: Number.NaN }, "bound must be a positive number of milliseconds — nothing was read"],
          [{ record, shutter, pollMs: 0 }, "pollMs must be a positive number of milliseconds — nothing was read"],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(watchRun(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`watchRun refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(watchRun(page, { shutter }));
        expect(unrecorded.message).toBe("watchRun refused (input): hand the step a record callback — nothing was done");
      });
    });
  });
}
