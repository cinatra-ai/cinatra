// S9b re-shoot — the diagnostic that found why the turn did not dispatch.
// Read-only: it sends one turn and records the wire, the console and the
// rendered transcript text. It changes nothing.
//
// Usage: node 03-diagnose-turn.mjs <baseUrl> <sessionDir> <outDir>
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:3794";
const SESSION = process.argv[3];
const OUT = process.argv[4];
mkdirSync(OUT, { recursive: true });

const MESSAGE =
  "run cinatra_blog-draft-writer-agent to draft a blog post about onboarding";

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  storageState: join(SESSION, "state.json"),
  viewport: { width: 1440, height: 1200 },
});
const page = await ctx.newPage();

page.on("console", (m) => {
  const t = m.text();
  if (/error|warn|dispatch|agent_run|recommendation|provider/i.test(t)) {
    say(`CONSOLE[${m.type()}] ${t.slice(0, 400)}`);
  }
});
page.on("response", async (r) => {
  const u = r.url();
  if (!u.includes("/api/")) return;
  say(`WIRE ${r.request().method()} ${u.replace(BASE, "")} -> ${r.status()}`);
  if (/\/api\/chat/.test(u)) {
    const body = await r.text().catch(() => "<unreadable>");
    say(`  body(first 3000): ${body.slice(0, 3000)}`);
  }
});

try {
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("nextjs-portal")) el.remove();
  });
  const prompt = page.getByTestId("chat-prompt-input");
  await prompt.waitFor({ state: "visible", timeout: 120_000 });
  for (let i = 0; i < 60; i += 1) {
    if (await prompt.isEditable().catch(() => false)) break;
    await page.waitForTimeout(1000);
  }
  await prompt.click();
  await page.keyboard.insertText(MESSAGE);
  await prompt.press("Enter");
  say(`sent: ${MESSAGE}`);

  await page.waitForTimeout(60_000);

  const text = await page.evaluate(() => {
    const list = document.querySelector("[data-conversation-list]");
    return list ? (list.textContent || "").trim().slice(0, 4000) : "<no conversation list>";
  });
  say("--- transcript text ---");
  say(text);

  const marks = await page.evaluate(() => ({
    lifecycleCards: document.querySelectorAll("[data-lifecycle-card]").length,
    recHold: document.querySelectorAll('[data-lifecycle-card="recommendation_hold"]').length,
    chipRows: document.querySelectorAll("[data-run-recommendation-chip-row]").length,
    agenticPanels: [...document.querySelectorAll("h2")].filter(
      (h) => (h.textContent || "").trim() === "Agentic Run Progress",
    ).length,
    inlineRunLink: document.querySelectorAll('[data-testid="inline-run-page-link"]').length,
  }));
  say(`MARKERS ${JSON.stringify(marks)}`);
  await page.screenshot({ path: join(OUT, "diagnose.png"), fullPage: true });
} finally {
  writeFileSync(join(OUT, "03-diagnose.log"), log.join("\n") + "\n");
  await browser.close();
}
console.log("diagnose done");
