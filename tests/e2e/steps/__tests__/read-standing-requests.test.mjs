// readStandingRequests: the requests that stand open on each origin, read from
// the browser context's own request events and from each page's resource
// timing, with the pages that hold them.
//
// The defect these cases stand for: five pages of one session held six streams
// on one origin over plain HTTP, every connection the browser opens to that
// origin was taken, and the next press waited in the browser and never reached
// the server. The step counts those streams before a further page is opened.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

const UNSEEN = "open before the first reading, so its earlier requests were not seen";

/** Wait until the fixture app holds `count` streams, and a moment more for the context's own events. */
async function untilStreams(app, count) {
  for (let i = 0; i < 150 && app.standingStreams() !== count; i += 1) await pause(20);
  expect(app.standingStreams(), "the fixture app does not hold the streams the pages opened").toBe(count);
  await pause(50);
}

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`readStandingRequests [${labelOf(backend)}]`, () => {
    const firstReading = (page) => theSteps("readStandingRequests").readStandingRequests(page.context(), { record: () => {} });

    it("counts each origin's standing streams from the request events and names the pages that hold them", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await firstReading(page);
        await page.goto(`${app.origin}/stream/one`);
        const second = await page.context().newPage();
        await second.goto(`${app.origin}/stream/three`);
        await untilStreams(app, 4);
        const reading = await readStandingRequests(page.context(), { record });
        expect(reading).toEqual({
          origins: [
            {
              origin: app.origin,
              protocols: ["http/1.1"],
              counted: true,
              standing: 4,
              events: 4,
              timing: 0,
              holders: [
                { place: 1, path: "/stream/one", standing: 1, events: 1, timing: 0 },
                { place: 2, path: "/stream/three", standing: 3, events: 3, timing: 0 },
              ],
            },
          ],
          unknown: [],
        });
        expect(lines).toEqual([
          "readStandingRequests: 4 standing requests on origin 1 (http/1.1, counted; events 4, timing 0), held by page 1 on /stream/one (1), page 2 on /stream/three (3); no page is unknown",
        ]);
      });
    });

    it("stops counting the streams of a page that closed, or that went to another page", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await firstReading(page);
        await page.goto(`${app.origin}/stream/one`);
        const second = await page.context().newPage();
        await second.goto(`${app.origin}/stream/three`);
        await untilStreams(app, 4);
        // A page that closes reports nothing of its requests: the step still stops counting them.
        await second.close();
        const closed = await readStandingRequests(page.context(), { record });
        expect(closed.origins).toEqual([
          {
            origin: app.origin,
            protocols: ["http/1.1"],
            counted: true,
            standing: 1,
            events: 1,
            timing: 0,
            holders: [{ place: 1, path: "/stream/one", standing: 1, events: 1, timing: 0 }],
          },
        ]);
        await page.goto(`${app.origin}/nav/target`);
        const left = await readStandingRequests(page.context(), { record });
        expect(left).toEqual({
          origins: [{ origin: app.origin, protocols: ["http/1.1"], counted: true, standing: 0, events: 0, timing: 0, holders: [] }],
          unknown: [],
        });
        expect(lines).toEqual([
          "readStandingRequests: 1 standing request on origin 1 (http/1.1, counted; events 1, timing 0), held by page 1 on /stream/one (1); no page is unknown",
          "readStandingRequests: 0 standing requests on origin 1 (http/1.1, counted; events 0, timing 0); no page is unknown",
        ]);
      });
    });

    it("names a page that was open before the first reading as unknown, never as holding nothing, until it shows another document", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await page.goto(`${app.origin}/stream/one`);
        await untilStreams(app, 1);
        const before = await readStandingRequests(page.context(), { record });
        expect(before).toEqual({
          origins: [{ origin: app.origin, protocols: ["http/1.1"], counted: true, standing: 0, events: 0, timing: 0, holders: [] }],
          unknown: [{ place: 1, path: "/stream/one", reason: UNSEEN }],
        });
        await page.goto(`${app.origin}/stream/three`);
        await untilStreams(app, 3);
        const after = await readStandingRequests(page.context(), { record });
        expect(after.unknown).toEqual([]);
        expect(after.origins[0]).toMatchObject({ standing: 3, events: 3, holders: [{ place: 1, path: "/stream/three", standing: 3 }] });
        expect(lines).toEqual([
          `readStandingRequests: 0 standing requests on origin 1 (http/1.1, counted; events 0, timing 0); unknown: page 1 on /stream/one (${UNSEEN})`,
          "readStandingRequests: 3 standing requests on origin 1 (http/1.1, counted; events 3, timing 0), held by page 1 on /stream/three (3); no page is unknown",
        ]);
      });
    });

    it("names a page it cannot read within the bound as unknown, and its origin's protocol as not given", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await firstReading(page);
        // Its main thread is busy from 100 ms after its load, for two and a half seconds.
        await page.goto(`${app.origin}/stream/frozen`);
        await untilStreams(app, 1);
        await pause(250);
        const reading = await readStandingRequests(page.context(), { record, bounds: { readingMs: 300 } });
        expect(reading).toEqual({
          origins: [
            {
              origin: app.origin,
              protocols: [],
              counted: true,
              standing: 1,
              events: 1,
              timing: 0,
              holders: [{ place: 1, path: "/stream/frozen", standing: 1, events: 1, timing: 0 }],
            },
          ],
          unknown: [{ place: 1, path: "/stream/frozen", reason: "could not be read within 300 ms" }],
        });
        expect(lines).toEqual([
          "readStandingRequests: 1 standing request on origin 1 (protocol not given, counted; events 1, timing 0), held by page 1 on /stream/frozen (1); unknown: page 1 on /stream/frozen (could not be read within 300 ms)",
        ]);
      });
    });

    it("counts once a page whose own response still streams, though both readings show it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await firstReading(page);
        // The page never finishes loading: it has committed, and the rest of its response is still to come.
        await page.goto(`${app.origin}/stream/document`, { waitUntil: "commit" });
        await untilStreams(app, 1);
        const reading = await readStandingRequests(page.context(), { record });
        expect(reading).toEqual({
          origins: [
            {
              origin: app.origin,
              protocols: ["http/1.1"],
              counted: true,
              standing: 1,
              events: 1,
              timing: 1,
              holders: [{ place: 1, path: "/stream/document", standing: 1, events: 1, timing: 1 }],
            },
          ],
          unknown: [],
        });
        expect(lines).toEqual([
          "readStandingRequests: 1 standing request on origin 1 (http/1.1, counted; events 1, timing 1), held by page 1 on /stream/document (1); no page is unknown",
        ]);
      });
    });

    it("counts from the resource timing a request the events never showed, and still names its page as unknown", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await page.goto(`${app.origin}/stream/document`, { waitUntil: "commit" });
        await untilStreams(app, 1);
        const reading = await readStandingRequests(page.context(), { record });
        expect(reading).toEqual({
          origins: [
            {
              origin: app.origin,
              protocols: ["http/1.1"],
              counted: true,
              standing: 1,
              events: 0,
              timing: 1,
              holders: [{ place: 1, path: "/stream/document", standing: 1, events: 0, timing: 1 }],
            },
          ],
          unknown: [{ place: 1, path: "/stream/document", reason: UNSEEN }],
        });
        expect(lines).toEqual([
          "readStandingRequests: 1 standing request on origin 1 (http/1.1, counted; events 0, timing 1), held by page 1 on /stream/document (1); " +
            `unknown: page 1 on /stream/document (${UNSEEN})`,
        ]);
      });
    });

    it("does not count an origin served over HTTP/2 against the bound", async () => {
      await scene(backend, { secure: true }, async ({ app, page, record, lines }) => {
        const { readStandingRequests } = theSteps("readStandingRequests");
        await firstReading(page);
        await page.goto(`${app.secureOrigin}/stream/three`);
        const second = await page.context().newPage();
        await second.goto(`${app.secureOrigin}/stream/one`);
        await untilStreams(app, 4);
        const reading = await readStandingRequests(page.context(), { record });
        expect(reading).toEqual({
          origins: [
            {
              origin: app.secureOrigin,
              protocols: ["h2"],
              counted: false,
              standing: 4,
              events: 4,
              timing: 0,
              holders: [
                { place: 1, path: "/stream/three", standing: 3, events: 3, timing: 0 },
                { place: 2, path: "/stream/one", standing: 1, events: 1, timing: 0 },
              ],
            },
          ],
          unknown: [],
        });
        expect(lines).toEqual([
          "readStandingRequests: 4 standing requests on origin 1 (h2, not counted; events 4, timing 0), held by page 1 on /stream/three (3), page 2 on /stream/one (1); no page is unknown",
        ]);
      });
    });

    it("reads nothing when it refuses its arguments", async () => {
      const { readStandingRequests } = theSteps("readStandingRequests");
      await scene(backend, {}, async ({ page, record, lines }) => {
        const CONTEXT = "hand the step the browser context whose pages it reads — nothing was read";
        const cases = [
          [undefined, {}, CONTEXT],
          [page, {}, CONTEXT],
          [page.context(), { bounds: { readingMs: 0 } }, "readingMs must be a positive number of milliseconds — nothing was read"],
          [page.context(), { bounds: { pollMs: 5 } }, "there is no bound named pollMs — nothing was read"],
        ];
        for (const [context, options, reason] of cases) {
          const error = await refusal(readStandingRequests(context, { record, ...options }));
          expect(error.name).toBe("StepRefusal");
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`readStandingRequests refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(readStandingRequests(page.context()));
        expect(unrecorded.message).toBe("readStandingRequests refused (input): hand the step a record callback — nothing was done");
        expect(lines).toHaveLength(cases.length);
      });
    });
  });
}
