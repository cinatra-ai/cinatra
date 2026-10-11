import { expect, test, type Page } from "@playwright/test";
import {
  LIFECYCLE_RESOLVE_FIXTURES,
  LIFECYCLE_RESOLVE_PATH,
  lifecycleResolveAnswer,
} from "../../../src/app/design-fixtures/conformance/lifecycle-resolve-fixture-data";

const FIXTURE_PATH = "/design-fixtures/run-step-rail";
const RUN_ID = "review-ground-3242";
const reviewFixture = LIFECYCLE_RESOLVE_FIXTURES.find(
  (row) => row.mount === "suggestion-floor" && row.kind === "artifact_review_gate",
);
if (!reviewFixture) throw new Error("The existing pending-review resolve fixture is required");

async function openReviewPalette(page: Page, theme: "cinatra" | "dark") {
  // Seed only the actual read/resolve ports, as the existing lifecycle suite
  // does. Unknown refs are refused, and no card DOM or CSS is supplied here.
  await page.route(`**/api/agents/runs/${RUN_ID}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      status: "pending_approval",
      reviewGate: { ref: reviewFixture!.ref, awaiting: true, producedReviewPark: true },
    }),
  }));
  await page.route(`**${LIFECYCLE_RESOLVE_PATH}`, async (route) => {
    let request: { ref?: unknown; viewType?: unknown } = {};
    try {
      request = JSON.parse(route.request().postData() ?? "{}");
    } catch {
      // Malformed requests receive the same refusal as an unknown ref.
    }
    const authorizedFixture = request.ref === reviewFixture!.ref
      && request.viewType === reviewFixture!.kind;
    await route.fulfill({
      status: authorizedFixture ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(authorizedFixture
        ? lifecycleResolveAnswer(reviewFixture!)
        : { error: "unauthorized" }),
    });
  });
  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
  await page.evaluate((value) => localStorage.setItem("theme", value), theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
}

for (const theme of ["cinatra", "dark"] as const) {
  test(`run review slot computes the strong surface ground — ${theme}`, async ({ page }) => {
    await openReviewPalette(page, theme);
    const slot = page.getByTestId("run-gate-card-ground-host")
      .locator('[data-run-review-slot="review"]');
    await expect(slot).toHaveCount(1);
    await expect(slot).toBeVisible();
    // The authorized resolve must have drawn the real card, not an empty frame.
    await expect(slot.locator(
      '[data-conformance-id="review-gate-card"][data-lifecycle-card-state="pending"]',
    )).toBeVisible();

    const ground = await slot.evaluate((element) => {
      const style = getComputedStyle(element);
      const token = style.getPropertyValue("--surface-strong").trim();
      // Resolve both tokens in the card's actual inherited palette. The probes
      // are temporary siblings, never a replacement card or a style on it.
      const probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      element.parentElement!.append(probe);
      try {
        probe.style.backgroundColor = "var(--surface-strong)";
        const expected = getComputedStyle(probe).backgroundColor;
        probe.style.backgroundColor = "var(--surface)";
        const ordinary = getComputedStyle(probe).backgroundColor;
        return { actual: style.backgroundColor, expected, ordinary, token };
      } finally {
        probe.remove();
      }
    });
    expect(ground.token, "the actual palette declares --surface-strong").not.toBe("");
    expect(ground.expected, "the strong surface token resolves to an opaque ground")
      .not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
    expect(ground.expected, "ordinary surface must not substitute for strong ground")
      .not.toBe(ground.ordinary);
    expect(ground.actual, "the actual review-slot computed background")
      .toBe(ground.expected);
  });
}
