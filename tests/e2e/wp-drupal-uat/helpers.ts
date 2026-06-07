import { readFileSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import type { UatSeed } from "./global-setup";

export const WP_BASE = process.env.UAT_WP_BASE_URL ?? "http://localhost:8080";
export const DRUPAL_BASE = process.env.UAT_DRUPAL_BASE_URL ?? "http://localhost:8082";

export const WP_ADMIN_USER = process.env.UAT_WP_ADMIN_USER ?? "admin";
// Matches docker-compose.yml `WP_DEV_ADMIN_PASS: admin`.
export const WP_ADMIN_PASS = process.env.UAT_WP_ADMIN_PASS ?? "admin";
export const DRUPAL_ADMIN_USER = process.env.UAT_DRUPAL_ADMIN_USER ?? "admin";
export const DRUPAL_ADMIN_PASS = process.env.UAT_DRUPAL_ADMIN_PASS ?? "cinatra";

// Frozen widget DOM contract (post-rename): the bundle mounts on #cinatra-root
// and builds .cw-* elements. Specs assert against these.
export const SEL = {
  root: "#cinatra-root",
  circle: ".cw-circle",
  panel: ".cw-panel",
  textarea: ".cw-textarea",
  submit: ".cw-submit",
  assistant: ".cw-msg-assistant",
  diff: ".cw-diff, .cw-diff-footer",
} as const;

export function readSeed(): UatSeed {
  const file = path.join(__dirname, ".uat", "seed.json");
  return JSON.parse(readFileSync(file, "utf8")) as UatSeed;
}

export async function loginWordPress(page: Page): Promise<void> {
  await page.goto(`${WP_BASE}/wp-login.php`);
  await page.fill("#user_login", WP_ADMIN_USER);
  await page.fill("#user_pass", WP_ADMIN_PASS);
  await page.click("#wp-submit");
  await page.waitForURL(/wp-admin/);
}

export async function loginDrupal(page: Page): Promise<void> {
  await page.goto(`${DRUPAL_BASE}/user/login`);
  await page.fill("#edit-name", DRUPAL_ADMIN_USER);
  await page.fill("#edit-pass", DRUPAL_ADMIN_PASS);
  await page.click("#edit-submit");
  await page.waitForLoadState("networkidle");
}

/**
 * Open the assistant panel: the widget auto-mounts on #cinatra-root; click the
 * circle to open the chat panel, then wait for the textarea.
 */
export async function openWidget(page: Page): Promise<void> {
  // #cinatra-root is the Shadow-DOM host mount — a zero-size div, never
  // "visible" (the widget UI renders position:fixed inside its shadow root), so
  // wait for it ATTACHED, not visible.
  await page.waitForSelector(SEL.root, { state: "attached", timeout: 30_000 });
  // Wait for the IIFE to mark the mount before interacting.
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute("data-cinatra-mounted") === "true"
      || (document.querySelector(sel) as HTMLElement | null)?.dataset?.cinatraMounted === "true",
    SEL.root,
    { timeout: 30_000 },
  );
  // The circle lives in the shadow root (Playwright pierces open shadow DOM).
  await page.waitForSelector(SEL.circle, { state: "visible", timeout: 30_000 });
  await page.click(SEL.circle);
  await page.waitForSelector(SEL.panel, { timeout: 15_000 });
  await page.waitForSelector(SEL.textarea, { timeout: 15_000 });
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.fill(SEL.textarea, text);
  await page.click(SEL.submit);
}
