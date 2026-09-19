import type { Page } from "@playwright/test";

export function assertScreenshotFixtureRuntime(env: Record<string, string | undefined> = process.env) {
  if (env.CINATRA_RUNTIME_MODE !== "development") {
    throw new Error("Screenshot fixtures require CINATRA_RUNTIME_MODE=development");
  }
}

/** Facts come from the same browser operation as the PNG, never CLI metadata. */
export async function captureScreenshot(page: Page, readySelector: string) {
  await page.locator(readySelector).waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const capturedUrl = page.url();
  const parsed = new URL(capturedUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("A screenshot needs an HTTP(S) page without URL credentials");
  }
  const viewport = page.viewportSize();
  if (!viewport || viewport.width < 1 || viewport.height < 1) {
    throw new Error("A screenshot needs a fixed, positive browser viewport");
  }
  const capturedAt = new Date().toISOString();
  const bytes = await page.screenshot({ type: "png", fullPage: false, animations: "disabled" });
  const after = page.viewportSize();
  if (page.url() !== capturedUrl || after?.width !== viewport.width || after?.height !== viewport.height) {
    throw new Error("The page navigated or resized during capture; retry after it settles");
  }
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error("The browser did not return a nonempty PNG");
  }
  return { bytes, facts: { capturedUrl, viewport, capturedAt } };
}

export type CapturedScreenshot = Awaited<ReturnType<typeof captureScreenshot>>;
