// S9c round-2 capture, diagnostic — why does the signed-in widget frame get a
// 401 from /api/assistants/chat/capabilities? Signs the frame in exactly as the
// capture does, then writes the EXACT headers the frame sent, so the server-side
// consume can be re-run against them and name its own refusal reason.
//
// Throwaway dev tokens on a throwaway stack; nothing here is committed with a
// live credential.
//
// Usage: node 06-diagnose-capabilities.mjs <hostPageUrl> <outFile>
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const HOST = process.argv[2];
const OUTFILE = process.argv[3] || "/tmp/s9c-capabilities-headers.json";
const ACTOR = { email: "s9c-capture@example.com", password: "s9c-capture-dev-12345" };

const captured = [];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();

page.on("response", async (res) => {
  const u = res.url();
  if (!u.includes("/api/assistants/chat/capabilities")) return;
  captured.push({
    status: res.status(),
    headers: res.request().headers(),
    body: await res.text().catch(() => "<unreadable>"),
  });
  console.log(`capabilities ${res.status()}`);
});

try {
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
  for (let i = 0; i < 60; i += 1) {
    const f = embedFrame();
    const ready = await f
      ?.evaluate(() => Boolean(document.querySelector("[data-embed-signin]")))
      .catch(() => false);
    if (ready) break;
    await page.waitForTimeout(2000);
  }
  const frame = embedFrame();
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 120_000 }),
    frame.locator("[data-embed-signin]").first().click(),
  ]);
  await popup.waitForLoadState("domcontentloaded", { timeout: 120_000 }).catch(() => {});
  if (!popup.isClosed()) {
    const email = popup.locator('input[type="email"], input[name="email"]').first();
    if ((await email.count().catch(() => 0)) > 0) {
      await email.fill(ACTOR.email).catch(() => {});
      await popup.locator('input[type="password"]').first().fill(ACTOR.password).catch(() => {});
      await popup.locator('button[type="submit"]').first().click().catch(() => {});
    }
  }
  await page.waitForTimeout(25_000);
} finally {
  writeFileSync(OUTFILE, JSON.stringify(captured, null, 2));
  console.log(`wrote ${captured.length} capability exchange(s) to ${OUTFILE}`);
  await browser.close();
}
