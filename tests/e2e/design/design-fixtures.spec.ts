/**
 * `/design-fixtures` pixel-diff + axe-core gate.
 *
 * Captures full-page screenshots of `/design-fixtures` in BOTH themes
 * (light = `cinatra`, dark = `dark`) and runs `@axe-core/playwright`
 * against each viewport. Baselines live alongside this spec under
 * `__screenshots__/`. The pixel-diff threshold (0.5% of pixels OR 800
 * absolute pixels) is configured in `tests/e2e/config/design.config.ts`.
 *
 * Theme forcing: `next-themes` reads from `localStorage["theme"]` by
 * default. We `goto` once to bootstrap, `localStorage.setItem("theme", …)`,
 * then `reload`. We intentionally do NOT introduce a cookie-based path
 * because `/design-fixtures` is a static client-themed page and the
 * localStorage write is the same path a real user takes via the theme
 * switcher.
 *
 * axe-core gate: zero `serious` or `critical` violations on this route.
 * Site-wide accessibility cleanup is out of scope for this harness (it
 * would convert this work into unrelated cleanup).
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const FIXTURE_PATH = "/design-fixtures";

async function setTheme(page: import("@playwright/test").Page, theme: "cinatra" | "dark") {
  // 1. Land on the page — next-themes mounts and seeds defaults.
  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
  // 2. Set the persisted theme key (next-themes uses `theme` by default).
  await page.evaluate((t) => {
    window.localStorage.setItem("theme", t);
  }, theme);
  // 3. Reload so SSR + the inline anti-flicker script pick up the new
  //    value before paint.
  await page.reload({ waitUntil: "networkidle" });
  // 4. Wait for fonts to settle so AA hinting is stable across runs.
  await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
}

async function expectAxeClean(page: import("@playwright/test").Page, label: string) {
  // axe-core gate: zero `serious` or `critical` violations on the
  // `/design-fixtures` CONTENT area (NOT the AppShell chrome that
  // wraps it — sidebar + toolbar + nav-user have their own a11y debt that's
  // out of scope for the design harness; site-wide axe would convert
  // this work into unrelated a11y cleanup).
  //
  // Scope: the inner `<main data-layout>` element rendered by the
  // `<Main>` layout component inside `/design-fixtures/page.tsx`. The outer
  // `<main>` (from AppShell) is intentionally excluded.
  //
  // Disabled rules (each justified):
  // - `color-contrast`: the fixture page is the design-token DOCUMENTATION.
  //   The spec's mustard StatusPill variants and the BrandMark wordmark are
  //   intentionally low-contrast on white per the spec — flagging them on
  //   the fixture page would invert the spec choice. Production a11y on
  //   actual chrome surfaces is out of scope for this harness
  //   (`/design-fixtures` only; not site-wide). Real call sites
  //   that use these tokens have to pass their own contrast checks.
  const results = await new AxeBuilder({ page })
    .include("main[data-layout]")
    .disableRules(["color-contrast"])
    .options({ resultTypes: ["violations"] })
    .analyze();

  // Belt-and-braces: also filter `color-contrast` out of the violations
  // array. `disableRules` is meant to prevent the rule from running, but
  // `@axe-core/playwright` 4.11 still surfaces it in the violations list
  // in some runs (axe-core upstream behavior). Filter explicitly here.
  const blocking = results.violations.filter(
    (v) =>
      v.id !== "color-contrast" &&
      (v.impact === "serious" || v.impact === "critical"),
  );

  if (blocking.length > 0) {
    const summary = blocking
      .map((v) => {
        const nodeSummaries = v.nodes
          .slice(0, 5)
          .map((n) => `    target: ${n.target.join(" ")}\n    html: ${n.html.slice(0, 200)}`)
          .join("\n");
        return `- [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})\n${nodeSummaries}`;
      })
      .join("\n");
    throw new Error(
      `axe-core found ${blocking.length} serious/critical violations on ${label}:\n${summary}\n\n` +
        `See ${results.testRunner.name} report for details. Resolve at the call site or add a register row before allowlisting.`,
    );
  }
  expect(blocking.length).toBe(0);
}

test.describe("/design-fixtures visual + a11y harness", () => {
  test("light theme — pixel-diff + axe clean", async ({ page }) => {
    await setTheme(page, "cinatra");

    await expect(page).toHaveScreenshot("design-fixtures-light.png", {
      fullPage: true,
    });

    await expectAxeClean(page, "design-fixtures (light)");
  });

  test("dark theme — pixel-diff + axe clean", async ({ page }) => {
    await setTheme(page, "dark");

    await expect(page).toHaveScreenshot("design-fixtures-dark.png", {
      fullPage: true,
    });

    await expectAxeClean(page, "design-fixtures (dark)");
  });
});
