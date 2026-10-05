import { expect, test } from "@playwright/test";
import { TOAST_DRIVER } from "./toast-driver";

// CSS cascade and keyboard readings need the real product palette. Native
// fixture tests cover the copy/dismiss callbacks, but cannot prove this paint.
for (const palette of ["cinatra", "dark"] as const) {
  test.describe(`toast ghost controls (${palette})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem("theme", theme), palette);
      await page.goto(TOAST_DRIVER.path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${palette}\\b`));
    });

    test("both controls retain ghost paint at rest, under the pointer and at keyboard focus", async ({ page }) => {
      await TOAST_DRIVER.present(page, TOAST_DRIVER.root(page));
      await TOAST_DRIVER.fields.message.assert(page, TOAST_DRIVER.root(page));
    });

    test("keyboard Copy writes the message to the real clipboard", async ({ page }) => {
      const action = TOAST_DRIVER.actions["copy-message"];
      if (Array.isArray(action)) throw new Error("Copy must have exactly one outcome");
      await action.run(page, TOAST_DRIVER.root(page));
    });

    test("keyboard Close dismisses the actual toast", async ({ page }) => {
      const action = TOAST_DRIVER.actions["close-toast"];
      if (Array.isArray(action)) throw new Error("Close must have exactly one outcome");
      await action.run(page, TOAST_DRIVER.root(page));
    });
  });
}
