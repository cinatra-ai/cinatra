/**
 * `/personal` Dashboards-tab live-verify (cinatra#2807 fix leg 4; keeps the
 * cinatra#1119 regression guard).
 *
 * WHAT THIS SUITE NOW PINS. cinatra#2807 fix leg 3 replaced this landing's
 * multi-dashboard CANVAS — an Overview selector, a grey toolbar band with an
 * "Edit dashboard" control, an "Add card" call to action and a dashboard
 * rendered inline inside a page-wide dashed frame — with the ratified
 * drawing's Dashboards tab body. This suite therefore asserts the drawing's
 * own sentences on the real stack (real Postgres + Better Auth session + DOM),
 * and nothing the drawing does not give:
 *
 *   - "On a personal scope the tab shows the acting user's own dashboards",
 *     drawn under the caption "The dashboards you own."
 *   - Row anatomy: "Each row carries a leading dashboard glyph, the dashboard
 *     name, the updated time, and an Open affordance", and "Open navigates to
 *     the dashboard's canonical surface … the tab points, it never renders a
 *     dashboard inline".
 *   - "a personal user scope and the whole-workspace scope are not add-to-scope
 *     targets — they carry no Add", read together with "Suppression, not a
 *     disabled control: a management action the member cannot take is not
 *     rendered."
 *   - The empty reading, in the drawing's words: "No dashboards in this scope
 *     yet". (The helper line under it names a manager's Add, which this scope
 *     does not have; fix leg 3 recorded that substitution as a named gap in the
 *     drawing and renders "Dashboards homed or listed here will appear on this
 *     tab." here instead. This suite pins what the product renders and names
 *     the gap rather than asserting a sentence the scope cannot show.)
 *   - The Application Design page's frame rule for a tab body: "no bespoke
 *     panel, and no page-wide dashed frame".
 *
 * WHAT IT KEEPS FROM cinatra#1119. `/personal` was the one entity-dashboard
 * surface that fell through to drizzle-cube's raw built-in "No Portlets"
 * screen. That screen must still never render on this route, so the #1119
 * assertion stays exactly as it was.
 *
 * Two readings, both live: the seeded session user owns dashboards (the suite's
 * own fixtures home three user-level rows), so the populated reading is read on
 * that session; a second, freshly-registered member owns none, so the empty
 * reading is read on a fresh context rather than by mutating shared fixtures.
 *
 * Screenshots are written to `PERSONAL_EVIDENCE_DIR` (defaults to
 * `test-results/`) for the PR evidence.
 */
import fs from "node:fs";
import path from "node:path";

import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

import { waitForHydration } from "../config/hydration";

const EVIDENCE_DIR =
  process.env.PERSONAL_EVIDENCE_DIR ?? path.join(process.cwd(), "test-results");

function evidencePath(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, name);
}

/** The tab body the drawing gives every scope, personal included. */
const TAB = '[data-conformance-id="scope-dashboards-tab"]';

/** The chrome the old canvas drew and the drawing does not: none of it may
 *  appear on this landing any more. */
async function expectNoOldCanvasChrome(page: Page): Promise<void> {
  // The toolbar band and its edit control. Scoped to the page body so this
  // reads the landing's own chrome, not the app shell around it.
  const body = page.locator("main");
  await expect(page.locator("[data-cinatra-dashboard-toolbar]")).toHaveCount(0);
  await expect(body.getByRole("toolbar")).toHaveCount(0);
  await expect(body.getByRole("button", { name: /Edit dashboard/ })).toHaveCount(0);
  // The Overview selector and the create band.
  await expect(body.getByRole("button", { name: /New dashboard/ })).toHaveCount(0);
  await expect(body.getByRole("button", { name: /Select dashboard/ })).toHaveCount(0);
  // The old empty state, its title and its lede.
  await expect(page.getByTestId("dashboard-empty-state")).toHaveCount(0);
  await expect(page.getByText("No cards yet")).toHaveCount(0);
  await expect(
    page.getByText("Your private dashboards, built from the cards you add."),
  ).toHaveCount(0);
}

/** §IX.2 read on this scope: no Add affordance at all — suppressed, not
 *  disabled, so it is absent rather than present-and-inert. */
async function expectNoAddAffordance(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /^Add\b/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Add\b/ })).toHaveCount(0);
  await expect(page.getByText("Add card", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Add dashboard", { exact: true })).toHaveCount(0);
}

/** The cinatra#1119 divergence: drizzle-cube's own empty screen. */
async function expectNoRawPortletScreen(page: Page): Promise<void> {
  await expect(page.getByText("No Portlets")).toHaveCount(0);
  await expect(
    page.getByText("Add your first portlet to start visualizing your data"),
  ).toHaveCount(0);
}

test.describe("/personal Dashboards tab live-verify (cinatra#2807, cinatra#1119)", () => {
  const pageErrors: string[] = [];

  test.beforeEach(({ page }) => {
    pageErrors.length = 0;
    page.on("pageerror", (err: Error) => {
      pageErrors.push(`${err.name}: ${err.message}`);
    });
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() === "error") pageErrors.push(`[console.error] ${m.text()}`);
    });
  });

  test.afterEach(() => {
    const relevant = pageErrors.filter((e) =>
      /@cinatra|drizzle-cube|DashboardStoreProvider|Empty|dashboard-empty|scope-dashboards/i.test(
        e,
      ),
    );
    expect(relevant, `unexpected page errors:\n${relevant.join("\n")}`).toEqual([]);
  });

  test("shows the acting user's own dashboards under the drawn caption, each row Opening its canonical surface, with no Add and none of the old canvas chrome", async ({
    page,
  }) => {
    await page.goto("/personal");
    await expect(page).toHaveURL(/\/personal$/);
    await waitForHydration(page);

    // "On a personal scope the tab shows the acting user's own dashboards."
    const tab = page.locator(TAB);
    await expect(tab).toBeVisible();

    // The drawn caption, verbatim.
    const caption = page.getByTestId("scope-dashboards-caption");
    await expect(caption).toBeVisible();
    expect((await caption.innerText()).trim()).toBe("The dashboards you own.");

    // The seeded fixtures home user-level dashboards on this session, so the
    // tab reads its populated state: rows, each with a name, an updated time
    // and an Open affordance.
    await expect(tab).toHaveAttribute("data-state", "kind:artifact");
    const rows = tab.locator("li");
    await expect(rows.first()).toBeVisible();
    const rowCount = await rows.count();
    expect(rowCount, "the seeded personal scope lists its own dashboards").toBeGreaterThan(0);
    const names: string[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i);
      // "a leading dashboard glyph, the dashboard name, the updated time, and
      // an Open affordance" — the drawn row anatomy, read in that order.
      await expect(row.locator("span[aria-hidden] svg").first()).toBeVisible();
      const name = row.locator("span.font-semibold").first();
      await expect(name).toBeVisible();
      names.push((await name.innerText()).trim());
      await expect(row).toContainText(/updated /);
      const open = row.locator('a[data-action="open-dashboard -> dashboard-canonical"]');
      await expect(open).toHaveCount(1);
      await expect(open).toHaveText("Open");
      // "the tab points": Open is a link to the dashboard's canonical surface.
      // A personal (unanchored) dashboard's canonical address is the flat one.
      expect(await open.getAttribute("href")).toMatch(/^\/dashboards\/[^/]+$/);
    }
    // "the acting user's OWN dashboards": every dashboard this suite's fixtures
    // home on the acting user is listed, and a dashboard owned by the
    // ORGANIZATION rather than by this user is not — the tab reads the personal
    // collection, not everything the user can see.
    for (const owned of [
      "E2E apiVersion 1.2 Analytics",
      "E2E 1914 dims-only",
      "E2E 1911 executable surface",
    ]) {
      expect(names, `the personal tab must list ${owned}`).toContain(owned);
    }
    expect(
      names,
      "an organization-owned dashboard is not one of the acting user's own",
    ).not.toContain("E2E 2058 Org-Anchored");

    // "the tab points, it never renders a dashboard inline" — no dashboard grid
    // is mounted on this landing.
    await expect(page.locator(".react-grid-layout")).toHaveCount(0);
    await expect(page.locator(".recharts-wrapper")).toHaveCount(0);

    // No Add on this scope; none of the old canvas chrome; no raw #1119 screen.
    await expectNoAddAffordance(page);
    await expectNoOldCanvasChrome(page);
    await expectNoRawPortletScreen(page);

    // "no bespoke panel, and no page-wide dashed frame" — the populated tab
    // body draws no dashed frame at all.
    await expect(page.locator(`${TAB} .border-dashed`)).toHaveCount(0);

    await page.screenshot({
      path: evidencePath("personal-dashboards-tab.png"),
      fullPage: true,
    });

    // "Open navigates to the dashboard's canonical surface": follow one row and
    // land on that surface rather than staying on the tab.
    const firstOpen = rows
      .first()
      .locator('a[data-action="open-dashboard -> dashboard-canonical"]');
    const href = await firstOpen.getAttribute("href");
    await firstOpen.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test("a personal scope owning no dashboards reads the drawn empty state, centred inside the tab body and not a page-wide dashed frame", async ({
    browser,
  }) => {
    // A fresh member, so the empty reading is read live without mutating the
    // fixtures the sibling specs depend on. Registration was opened by this
    // suite's setup project; the root layout admits any signed-in user to the
    // default organization as a member.
    const email = `personal-empty-${Date.now()}@local.test`;
    const password = "PersonalEmpty2026!";
    const context = await browser.newContext({ storageState: undefined });
    try {
      const signUp = await context.request.post("/api/auth/sign-up/email", {
        data: { email, password, name: "Personal Empty" },
        failOnStatusCode: false,
      });
      expect(
        [200, 400, 422],
        `sign-up status unexpected: ${signUp.status()}`,
      ).toContain(signUp.status());
      if (signUp.status() !== 200) {
        const signIn = await context.request.post("/api/auth/sign-in/email", {
          data: { email, password },
          failOnStatusCode: false,
        });
        expect(signIn.ok(), `sign-in failed: ${signIn.status()}`).toBeTruthy();
      }
      // The root layout's bootstrap gives this member the default organization.
      const bootstrap = await context.request.get("/not-authorized");
      expect(bootstrap.ok(), `bootstrap GET failed: ${bootstrap.status()}`).toBeTruthy();

      const page = await context.newPage();
      page.on("pageerror", (err: Error) => {
        pageErrors.push(`${err.name}: ${err.message}`);
      });
      page.on("console", (m: ConsoleMessage) => {
        if (m.type() === "error") pageErrors.push(`[console.error] ${m.text()}`);
      });

      await page.goto("/personal");
      await expect(page).toHaveURL(/\/personal$/);
      await waitForHydration(page);

      const tab = page.locator(TAB);
      await expect(tab).toBeVisible();
      await expect(tab).toHaveAttribute("data-state", "empty");
      const caption = page.getByTestId("scope-dashboards-caption");
      expect((await caption.innerText()).trim()).toBe("The dashboards you own.");

      // The drawn empty reading, in the drawing's own words.
      const empty = tab.getByTestId("scope-dashboards-empty");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No dashboards in this scope yet");
      // This scope carries no Add, so the drawing's manager helper cannot be
      // shown here (fix leg 3's named gap); the tab says what it will hold.
      await expect(empty).toContainText(
        "Dashboards homed or listed here will appear on this tab.",
      );
      await expect(
        empty.getByText("A manager can", { exact: false }),
      ).toHaveCount(0);

      // Centred where the drawing centres it: the headline's horizontal centre
      // sits on the panel's centre.
      const emptyBox = await empty.boundingBox();
      const headline = empty.getByText("No dashboards in this scope yet");
      const headlineBox = await headline.boundingBox();
      expect(emptyBox, "empty panel bounding box").not.toBeNull();
      expect(headlineBox, "empty headline bounding box").not.toBeNull();
      const panelCentre = emptyBox!.x + emptyBox!.width / 2;
      const headlineCentre = headlineBox!.x + headlineBox!.width / 2;
      expect(
        Math.abs(headlineCentre - panelCentre),
        `empty headline centre (${headlineCentre}) should sit on the panel centre (${panelCentre})`,
      ).toBeLessThan(40);

      // "no page-wide dashed frame": the drawn dashed panel is inside the tab
      // body, and NO dashed element on this page spans it.
      await expect(tab.locator(".border-dashed")).toHaveCount(1);
      const viewport = page.viewportSize();
      expect(viewport, "viewport size").not.toBeNull();
      const dashed = page.locator(".border-dashed");
      const dashedCount = await dashed.count();
      for (let i = 0; i < dashedCount; i += 1) {
        const box = await dashed.nth(i).boundingBox();
        expect(box, "dashed element bounding box").not.toBeNull();
        expect(
          box!.width,
          "a dashed panel must sit inside the content column, never span the page",
        ).toBeLessThan(viewport!.width - 40);
      }

      // Nothing of the old canvas, and no raw #1119 screen on the empty read
      // either — the exact divergence cinatra#1119 describes.
      await expectNoAddAffordance(page);
      await expectNoOldCanvasChrome(page);
      await expectNoRawPortletScreen(page);

      await page.screenshot({
        path: evidencePath("personal-dashboards-tab-empty.png"),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });
});
