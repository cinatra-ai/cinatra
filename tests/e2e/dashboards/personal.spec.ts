/**
 * /personal empty-state live-verify (cinatra#1119).
 *
 * `/personal` seeds an EMPTY dashboard on purpose ("built from the cards you
 * add"), so it was the ONE entity-dashboard surface that fell through to
 * drizzle-cube's raw built-in "No Portlets" screen — off-column, in the
 * library's own visual language, with none of the app chrome its seeded peers
 * (`/projects`, `/teams`, …) show. This suite proves the app now renders its
 * OWN empty state on the real stack (real Postgres + Better Auth session +
 * the drizzle-cube/client bundle + DOM), keeping the grey toolbar frame and a
 * centred, card-framed message with a single "Add card" primary action.
 *
 * What it asserts:
 *   1. `/personal` is served (no 500) and the page chrome renders.
 *   2. The app empty state (`data-testid="dashboard-empty-state"`) is visible.
 *   3. drizzle-cube's raw "No Portlets" / "Add your first portlet" screen is
 *      GONE (the exact divergence #1119 describes).
 *   4. The grey dashboard toolbar frame is present ABOVE the empty state
 *      (so an empty Personal reads as the same surface type as its peers).
 *   5. The empty-state content is horizontally CENTRED in the content column
 *      (directly refutes the "floats off to the right" symptom).
 *   6. The single primary action "Add card" is present and, when clicked,
 *      opens the add-portlet modal (the same handler the toolbar uses).
 *
 * Screenshots (empty state + add-card modal) are written to
 * `PERSONAL_EVIDENCE_DIR` (defaults to `test-results/`) for the PR evidence.
 */
import fs from "node:fs";
import path from "node:path";

import { test, expect, type ConsoleMessage } from "@playwright/test";

import { waitForHydration } from "../config/hydration";

const EVIDENCE_DIR =
  process.env.PERSONAL_EVIDENCE_DIR ?? path.join(process.cwd(), "test-results");

function evidencePath(name: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, name);
}

test.describe("/personal empty-state live-verify (cinatra#1119)", () => {
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

  test("renders the app empty state (not drizzle-cube's raw 'No Portlets' screen), centred, with toolbar chrome + a working Add-card CTA", async ({
    page,
  }) => {
    // 1. Route resolution + chrome.
    await page.goto("/personal");
    await expect(page).toHaveURL(/\/personal$/);
    await waitForHydration(page);
    await expect(
      page.getByText("Your private dashboard, built from the cards you add."),
    ).toBeVisible();

    // 2. The app empty state mounted.
    const empty = page.getByTestId("dashboard-empty-state");
    await expect(empty).toBeVisible();
    await expect(empty.getByText("No cards yet")).toBeVisible();

    // 3. drizzle-cube's raw empty screen is GONE (the #1119 divergence).
    await expect(page.getByText("No Portlets")).toHaveCount(0);
    await expect(
      page.getByText("Add your first portlet to start visualizing your data"),
    ).toHaveCount(0);

    // 4. The grey toolbar frame is present, ABOVE the empty state.
    const toolbar = page.locator("[data-cinatra-dashboard-toolbar]");
    await expect(toolbar).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit dashboard" }),
    ).toBeVisible();

    const toolbarBox = await toolbar.boundingBox();
    const emptyBox = await empty.boundingBox();
    expect(toolbarBox, "toolbar bounding box").not.toBeNull();
    expect(emptyBox, "empty-state bounding box").not.toBeNull();
    // Toolbar sits above the empty state (chrome ordering).
    expect(toolbarBox!.y).toBeLessThan(emptyBox!.y);

    // 5. The empty-state CONTENT is horizontally centred within its column —
    // directly refutes the "floats off to the right" symptom. The title's
    // horizontal centre must sit near the empty-state panel's centre.
    const title = empty.getByText("No cards yet");
    const titleBox = await title.boundingBox();
    expect(titleBox, "title bounding box").not.toBeNull();
    const panelCentre = emptyBox!.x + emptyBox!.width / 2;
    const titleCentre = titleBox!.x + titleBox!.width / 2;
    expect(
      Math.abs(titleCentre - panelCentre),
      `empty-state title centre (${titleCentre}) should be near the panel centre (${panelCentre})`,
    ).toBeLessThan(40);

    await page.screenshot({
      path: evidencePath("personal-empty-state.png"),
      fullPage: true,
    });

    // 6. The single primary action opens the add-portlet modal (same handler
    // the toolbar uses). Clicking "Add card" flips no live portlet yet — it
    // opens the picker modal; a dialog must appear.
    const addCard = page.getByRole("button", { name: "Add card" });
    await expect(addCard).toBeVisible();
    await addCard.click();

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog.first()).toBeVisible();

    await page.screenshot({
      path: evidencePath("personal-add-card-modal.png"),
      fullPage: true,
    });

    // No uncaught render crashes / console errors from our packages.
    const relevant = pageErrors.filter((e) =>
      /@cinatra|drizzle-cube|DashboardStoreProvider|Empty|dashboard-empty/i.test(
        e,
      ),
    );
    expect(relevant, `unexpected page errors:\n${relevant.join("\n")}`).toEqual(
      [],
    );
  });
});
