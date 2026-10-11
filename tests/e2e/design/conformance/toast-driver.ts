import { expect, type Locator, type Page } from "@playwright/test";
import type { SurfaceDriver } from "./contract";
import { CONFORMANCE_TOAST_MESSAGE } from "../../../../src/app/design-fixtures/conformance/toast-fixture-data";

const toastRoot = (page: Page) => page.locator("[data-sonner-toast]").filter({ hasText: CONFORMANCE_TOAST_MESSAGE });

async function showToast(page: Page, root: Locator) {
  await expect(async () => {
    if (await root.count() === 0) await page.getByTestId("show-conformance-toast").click();
    await expect(root).toHaveCount(1);
    await expect(root).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

async function ghostControls(page: Page, root: Locator) {
  const copy = root.getByRole("button", { name: "Copy", exact: true });
  const close = root.getByRole("button", { name: "Close toast", exact: true });
  for (const control of [copy, close]) {
    const assertGhostPaint = async () => {
      await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      for (const edge of ["top", "right", "bottom", "left"]) {
        await expect(control).toHaveCSS(`border-${edge}-width`, "0px");
      }
      const colors = await control.evaluate((node) => ({
        control: getComputedStyle(node).color,
        toast: getComputedStyle(node.closest("[data-sonner-toast]")!).color,
      }));
      expect(colors.control).toBe(colors.toast);
    };
    await page.mouse.move(0, 0);
    await expect(control).toHaveCSS("opacity", "0.55");
    await assertGhostPaint();
    await control.hover();
    await assertGhostPaint();
    await page.mouse.move(0, 0);
    await control.focus();
    await expect(control).toBeFocused();
    await assertGhostPaint();
  }
  await expect(copy.locator("svg")).toHaveAttribute("stroke-width", "2.2");
  await expect(close.locator("svg")).toHaveCSS("stroke-width", "2.4px");
  for (const glyph of [copy.locator("svg"), close.locator("svg")]) {
    await expect(glyph).toHaveCSS("width", "13px");
    await expect(glyph).toHaveCSS("height", "13px");
  }
}

export const TOAST_DRIVER: SurfaceDriver = {
  path: "/design-fixtures/conformance",
  root: toastRoot,
  present: async (page, root) => {
    await showToast(page, root);
    await ghostControls(page, root);
  },
  fields: {
    message: {
      source: "toast.message",
      assert: async (page, root) => {
        await showToast(page, root);
        await expect(root.locator("[data-title]")).toHaveText(CONFORMANCE_TOAST_MESSAGE);
      },
    },
  },
  actions: {
    "copy-message": {
      outcome: "message-copied",
      run: async (page, root) => {
        await showToast(page, root);
        // Read back the actual clipboard, never a fixture-written outcome.
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.evaluate(() => navigator.clipboard.writeText(""));
        const copy = root.getByRole("button", { name: "Copy", exact: true });
        await copy.focus();
        await expect(copy).toBeFocused();
        await copy.press("Enter");
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(CONFORMANCE_TOAST_MESSAGE);
      },
    },
    "close-toast": {
      outcome: "toast-dismissed",
      run: async (page, root) => {
        await showToast(page, root);
        const close = root.getByRole("button", { name: "Close toast", exact: true });
        await close.focus();
        await expect(close).toBeFocused();
        await close.press("Enter");
        await expect(root).toHaveCount(0);
      },
    },
  },
  states: {},
};
