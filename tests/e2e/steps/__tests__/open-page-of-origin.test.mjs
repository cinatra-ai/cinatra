// openPageOfOrigin: a page of another origin than the page's, opened once by
// its address, in an empty browser context of its own or in the page's own.
//
// The defect these cases stand for: the application embedded in another site's
// page is reached on that site, a page of another origin, and openAddress
// types an address of the page's own origin only. The step opens the other
// origin's page in a new page: by default of a new context that holds none of
// the page's cookies, as a person who never signed in meets the site, and with
// `sameContext` of the page's own context, as the person's same browser. Its
// line names paths, never an origin or an address.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { SITE_PAGE_PATH } from "./fixture-app-site.mjs";

afterAll(closeBrowser);

const BOUNDS = Object.freeze({ loadMs: 5000 });
/** A cookie the page's context holds for the site's host, read in the context the step opens. */
const MARK = Object.freeze({ name: "fixture_mark", value: "1" });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`openPageOfOrigin [${labelOf(backend)}]`, () => {
    const start = async (page, app) => {
      await page.goto(`${app.origin}/nav/start`);
      await page.context().addCookies([{ ...MARK, url: app.siteOrigin }]);
    };
    const marked = async (context) => (await context.cookies()).some((cookie) => cookie.name === MARK.name);

    it("opens the page of another origin in a browser context of its own that holds none of the page's cookies", async () => {
      const { openPageOfOrigin } = theSteps("openPageOfOrigin");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await start(page, app);
        const result = await openPageOfOrigin(page, { address: `${app.siteOrigin}${SITE_PAGE_PATH}`, record, bounds: BOUNDS });
        try {
          expect(result).toMatchObject({ path: SITE_PAGE_PATH, status: 200, from: "/nav/start" });
          expect(result.furtherPage.context(), "the page opened in the page's own context").not.toBe(page.context());
          expect(await marked(page.context())).toBe(true);
          expect(await marked(result.furtherPage.context()), "a cookie of the page's context crossed into the new one").toBe(false);
          expect(result.furtherPage.viewportSize()).toEqual(page.viewportSize());
          expect(new URL(result.furtherPage.url()).origin).toBe(app.siteOrigin);
          expect(lines).toEqual([
            `openPageOfOrigin: typed the address of ${SITE_PAGE_PATH} on another origin than the page's on /nav/start into a page of a browser context of its own; it landed on ${SITE_PAGE_PATH} with status 200 after ${result.elapsedMs} ms`,
          ]);
        } finally {
          await result.furtherPage.context().close();
        }
      });
    });

    it("opens it in a further page of the page's own context with sameContext, where the page's cookies stand", async () => {
      const { openPageOfOrigin } = theSteps("openPageOfOrigin");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await start(page, app);
        const result = await openPageOfOrigin(page, { address: `${app.crossSiteOrigin}${SITE_PAGE_PATH}`, sameContext: true, record, bounds: BOUNDS });
        try {
          expect(result).toMatchObject({ path: SITE_PAGE_PATH, status: 200, from: "/nav/start" });
          expect(result.furtherPage.context()).toBe(page.context());
          expect(await marked(result.furtherPage.context())).toBe(true);
          expect(lines).toEqual([
            `openPageOfOrigin: typed the address of ${SITE_PAGE_PATH} on another origin than the page's on /nav/start into a further page of the page's own browser context; it landed on ${SITE_PAGE_PATH} with status 200 after ${result.elapsedMs} ms`,
          ]);
        } finally {
          await result.furtherPage.close();
        }
      });
    });

    it("answers and writes the values of the parameters the caller names, and no other", async () => {
      const { openPageOfOrigin } = theSteps("openPageOfOrigin");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await start(page, app);
        const result = await openPageOfOrigin(page, { address: `${app.siteOrigin}${SITE_PAGE_PATH}?tab=notes`, params: ["tab"], record, bounds: BOUNDS });
        try {
          expect(result).toMatchObject({ path: SITE_PAGE_PATH, status: 200, query: { tab: "notes" }, others: 0 });
          expect(lines).toEqual([
            `openPageOfOrigin: typed the address of ${SITE_PAGE_PATH} with the query tab="notes" on another origin than the page's on /nav/start into a page of a browser context of its own; it landed on ${SITE_PAGE_PATH} with the query tab="notes" with status 200 after ${result.elapsedMs} ms`,
          ]);
        } finally {
          await result.furtherPage.context().close();
        }
      });
    });

    it("refuses the page's own origin, which is openAddress's act, and opens nothing", async () => {
      const { openPageOfOrigin } = theSteps("openPageOfOrigin");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await start(page, app);
        const pages = page.context().pages().length;
        const error = await refusal(openPageOfOrigin(page, { address: `${app.origin}/nav/target`, record, bounds: BOUNDS }));
        expect(error.kind).toBe("same-origin");
        expect(error.message).toBe(
          "openPageOfOrigin refused (same-origin): the address names the origin of the page on /nav/start, and typing it is openAddress's act — nothing was opened",
        );
        expect(lines).toEqual([error.message]);
        expect(page.context().pages()).toHaveLength(pages);
        expect(app.requests.filter((request) => request.path === "/nav/target")).toHaveLength(0);
      });
    });

    it("refuses, before anything opens, an address with a user, a fragment, a parameter params does not name, or no origin", async () => {
      const { openPageOfOrigin } = theSteps("openPageOfOrigin");
      await scene(backend, { site: true }, async ({ app, page, record, lines }) => {
        await start(page, app);
        const pages = page.context().pages().length;
        const at = `${app.siteOrigin}${SITE_PAGE_PATH}`;
        const nothing = "nothing was opened";
        const cases = [
          [{ address: at.replace("://", "://someone@") }, `the address carries a user or a password, which a line could repeat and a step never types — ${nothing}`],
          [{ address: `${at}#notes` }, `name the page without a fragment — ${nothing}`],
          [{ address: `${at}?tab=notes` }, `the query of the address names a parameter that params does not name — ${nothing}`],
          [{ address: `${at}?tab=notes&secret=1`, params: ["tab"] }, `the query of the address names a parameter that params does not name — ${nothing}`],
          [{ address: SITE_PAGE_PATH }, `name the page by an absolute http or https address of another origin — ${nothing}`],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(openPageOfOrigin(page, { ...options, record, bounds: BOUNDS }));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`openPageOfOrigin refused (input): ${reason}`);
        }
        expect(lines).toEqual(cases.map(([, reason]) => `openPageOfOrigin refused (input): ${reason}`));
        for (const line of lines) {
          expect(line.includes("someone") || line.includes("secret"), "a line repeats a value of the address").toBe(false);
        }
        expect(page.context().pages()).toHaveLength(pages);
      });
    });
  });
}
