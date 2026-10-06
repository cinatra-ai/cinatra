// armPageTape and readPageTape: the document's time origin, and the main
// frame's navigations counted from the moment the tape is armed, new documents
// and changes of the address in place apart.
//
// The gap these cases stand for: a check that a page changed in place (the same
// document, no reload, between two moments) had no step to stand on, since no
// step read the document's time origin or counted the navigations of the main
// frame. The browser leg is what proves how the tape tells a new document from
// a change of the address in place: a new document is one a navigation request
// of the main frame led to, and a change in place is one no request led to.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, pause, refusal, scene, theSteps } from "./backends.mjs";
import { THEME_ISLAND_PATH } from "./fixture-app-controls.mjs";

afterAll(closeBrowser);

/** The reading of an untouched tape armed at `timeOrigin` on `path`. */
const untouched = (path, timeOrigin) => ({ path, timeOrigin, armedTimeOrigin: timeOrigin, documents: 0, addressChanges: 0, sameDocument: true });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`armPageTape and readPageTape [${labelOf(backend)}]`, () => {
    const start = async (page, app, path = "/tape/start") => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("armPageTape", "readPageTape");
    };

    it("reads an untouched page as the same document: no new document, no change of the address, the same time origin", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const armed = await armPageTape(page, { record });
        expect(armed).toEqual({ path: "/tape/start", timeOrigin: expect.any(Number), rearmed: false });
        await pause(300);
        const tape = await readPageTape(page, { record });
        expect(tape).toEqual(untouched("/tape/start", armed.timeOrigin));
        expect(lines).toEqual([
          `armPageTape: {"path":"/tape/start","timeOrigin":${armed.timeOrigin}}`,
          `readPageTape: {"path":"/tape/start","timeOrigin":${armed.timeOrigin},"armedTimeOrigin":${armed.timeOrigin},"documents":0,"addressChanges":0,"sameDocument":true}`,
        ]);
      });
    });

    it("reads a reload as a new document: a new time origin, one document, and not the same document", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const armed = await armPageTape(page, { record });
        await page.reload();
        const tape = await readPageTape(page, { record });
        expect(tape).toEqual({
          path: "/tape/start",
          timeOrigin: expect.any(Number),
          armedTimeOrigin: armed.timeOrigin,
          documents: 1,
          addressChanges: 0,
          sameDocument: false,
        });
        expect(tape.timeOrigin, "the reloaded document kept the time origin").toBeGreaterThan(armed.timeOrigin);
        expect(lines[1]).toBe(
          `readPageTape: {"path":"/tape/start","timeOrigin":${tape.timeOrigin},"armedTimeOrigin":${armed.timeOrigin},"documents":1,"addressChanges":0,"sameDocument":false}`,
        );
      });
    });

    it("reads the page's own change of the address in place as one change of the address of the same document", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const armed = await armPageTape(page, { record });
        // The link's own handler asks the app for the page, then pushes the address.
        await page.locator('a[href="/tape/moved"]').click();
        await page.waitForURL((url) => url.pathname === "/tape/moved");
        const tape = await readPageTape(page, { record });
        expect(tape).toEqual({ ...untouched("/tape/moved", armed.timeOrigin), addressChanges: 1 });
        expect(lines[1]).toBe(
          `readPageTape: {"path":"/tape/moved","timeOrigin":${armed.timeOrigin},"armedTimeOrigin":${armed.timeOrigin},"documents":0,"addressChanges":1,"sameDocument":true}`,
        );
      });
    });

    it("never counts a state written at the same address, and counts a new fragment as a change of the address", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const armed = await armPageTape(page, { record });
        // A router that writes its state into the history at the same address announces a navigation all the same.
        await page.evaluate(() => history.replaceState({ kept: true }, "", location.href));
        await page.evaluate(() => {
          location.hash = "tab";
        });
        await page.waitForURL((url) => url.hash === "#tab");
        const tape = await readPageTape(page, { record });
        expect(tape).toEqual({ ...untouched("/tape/start", armed.timeOrigin), addressChanges: 1 });
      });
    });

    it("reads a link to another page as a new document", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const armed = await armPageTape(page, { record });
        await page.locator('a[href="/tape/other"]').click();
        await page.waitForURL((url) => url.pathname === "/tape/other");
        const tape = await readPageTape(page, { record });
        expect(tape).toEqual({ path: "/tape/other", timeOrigin: expect.any(Number), armedTimeOrigin: armed.timeOrigin, documents: 1, addressChanges: 0, sameDocument: false });
        expect(tape.timeOrigin).not.toBe(armed.timeOrigin);
      });
    });

    it("counts the main frame only: a frame inside the page that loads another document is no navigation of the page", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape, switchTheme } = await start(page, app, "/theme/follows");
        const armed = await armPageTape(page, { record });
        // The toggle points the review island's frame at the other theme, and switchTheme waits until the frame reports it.
        await switchTheme(page, { to: "dark", record, frameSrcPath: THEME_ISLAND_PATH });
        const tape = await readPageTape(page, { record });
        expect(tape).toEqual(untouched("/theme/follows", armed.timeOrigin));
        expect(lines).toHaveLength(3);
      });
    });

    it("holds one tape per page: two pages count their own navigations", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const second = await page.context().newPage();
        await second.goto(`${app.origin}/tape/start`);
        const first = await armPageTape(page, { record });
        const other = await armPageTape(second, { record });
        expect(other.rearmed, "the second page found the first page's tape").toBe(false);
        await page.reload();
        await second.locator('a[href="/tape/moved"]').click();
        await second.waitForURL((url) => url.pathname === "/tape/moved");
        const firstTape = await readPageTape(page, { record });
        const secondTape = await readPageTape(second, { record });
        expect(firstTape).toMatchObject({ path: "/tape/start", armedTimeOrigin: first.timeOrigin, documents: 1, addressChanges: 0, sameDocument: false });
        expect(secondTape).toEqual({ ...untouched("/tape/moved", other.timeOrigin), addressChanges: 1 });
        expect(other.timeOrigin).not.toBe(first.timeOrigin);
      });
    });

    it("starts the count again when it is armed again on the same page, and says so on its line", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const first = await armPageTape(page, { record });
        await page.reload();
        const again = await armPageTape(page, { record });
        expect(again).toEqual({ path: "/tape/start", timeOrigin: expect.any(Number), rearmed: true });
        expect(again.timeOrigin).not.toBe(first.timeOrigin);
        const tape = await readPageTape(page, { record });
        expect(tape).toEqual(untouched("/tape/start", again.timeOrigin));
        expect(lines).toEqual([
          `armPageTape: {"path":"/tape/start","timeOrigin":${first.timeOrigin}}`,
          `armPageTape: {"path":"/tape/start","timeOrigin":${again.timeOrigin},"rearmed":true}`,
          `readPageTape: {"path":"/tape/start","timeOrigin":${again.timeOrigin},"armedTimeOrigin":${again.timeOrigin},"documents":0,"addressChanges":0,"sameDocument":true}`,
        ]);
      });
    });

    it("refuses by name a page with no tape, and a closed page, whose tape ended with it", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const none = await refusal(readPageTape(page, { record }));
        expect(none.name).toBe("StepRefusal");
        expect(none.step).toBe("readPageTape");
        expect(none.kind).toBe("no-tape");
        expect(none.message).toBe("readPageTape refused (no-tape): no tape is armed on the page on /tape/start — arm one with armPageTape first; nothing was read");
        await armPageTape(page, { record });
        await page.close();
        const closed = await refusal(readPageTape(page, { record }));
        expect(closed.kind).toBe("closed");
        expect(closed.message).toBe("readPageTape refused (closed): the page on /tape/start is closed, and its tape ended with it — nothing was read");
        const arm = await refusal(armPageTape(page, { record }));
        expect(arm.kind).toBe("closed");
        expect(arm.message).toBe("armPageTape refused (closed): the page on /tape/start is closed — no tape was armed");
        expect([lines[0], ...lines.slice(2)]).toEqual([none.message, closed.message, arm.message]);
      });
    });

    it("refuses by name a reading the driver could not take within its bound, and keeps the tape it had", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        await armPageTape(page, { record });
        // Its main thread is busy from 100 ms after its load, for two and a half seconds.
        await page.goto(`${app.origin}/stream/frozen`);
        await pause(250);
        const read = await refusal(readPageTape(page, { record, bounds: { readingMs: 300 } }));
        expect(read.kind).toBe("driver-failure");
        expect(read.message).toBe("readPageTape refused (driver-failure): the page on /stream/frozen could not be read within 300 ms — nothing was read");
        const arm = await refusal(armPageTape(page, { record, bounds: { readingMs: 300 } }));
        expect(arm.kind).toBe("driver-failure");
        expect(arm.message).toBe("armPageTape refused (driver-failure): the page on /stream/frozen could not be read within 300 ms — no tape was armed");
        expect(lines.slice(1)).toEqual([read.message, arm.message]);
      });
    });

    it("arms nothing and reads nothing when it refuses its arguments", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const { armPageTape, readPageTape } = await start(page, app);
        const bound = await refusal(armPageTape(page, { record, bounds: { waitMs: 5 } }));
        expect(bound.message).toBe("armPageTape refused (input): there is no bound named waitMs — no tape was armed");
        const reading = await refusal(readPageTape(page, { record, bounds: { readingMs: 0 } }));
        expect(reading.message).toBe("readPageTape refused (input): readingMs must be a positive number of milliseconds — nothing was read");
        expect(lines).toEqual([bound.message, reading.message]);
        for (const step of [armPageTape, readPageTape]) {
          const unrecorded = await refusal(step(page, {}));
          expect(unrecorded.kind).toBe("input");
          expect(unrecorded.message).toBe(`${step.name} refused (input): hand the step a record callback — nothing was done`);
        }
        // Nothing was armed by the refused calls.
        expect((await refusal(readPageTape(page, { record }))).kind).toBe("no-tape");
      });
    });
  });
}

describe("armPageTape and readPageTape, their bound", () => {
  it("name their one bound: the reading of the page", () => {
    const steps = theSteps("armPageTape", "readPageTape");
    expect(steps.PAGE_TAPE_BOUNDS).toEqual({ readingMs: steps.READING_BOUND_MS });
  });
});
