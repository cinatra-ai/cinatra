// S9c round-2 capture, probe — does the embed frame boot inside a plain page and
// does the bridge handshake close? Prints what the frame drew and what it asked
// for, so the capture step can be written against facts.
//
// Usage: node 03-probe-widget-frame.mjs <hostPageUrl> <outDir>
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.argv[2] || "http://localhost:5573/site-widget-host-page.html";
const OUT = process.argv[3] || "/tmp/s9c-widget-probe";
mkdirSync(OUT, { recursive: true });

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();

page.on("console", (m) => say(`console[${m.type()}] ${m.text().slice(0, 300)}`));
page.on("requestfailed", (r) => say(`requestfailed ${r.url().slice(0, 160)} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/") || u.includes("/embed/")) say(`resp ${r.status()} ${u.slice(0, 180)}`);
});

try {
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForTimeout(9000);

  const bridge = await page.evaluate(() => window.__s9cBridgeLog || []).catch(() => []);
  say(`--- bridge log ---\n${bridge.join("\n")}`);

  const frames = page.frames().map((f) => ({ name: f.name(), url: f.url() }));
  say(`frames: ${JSON.stringify(frames, null, 1)}`);

  const embed = page.frames().find((f) => f.url().includes("/embed/assistant"));
  if (!embed) {
    say("NO EMBED FRAME — the iframe did not load the embed document");
  } else {
    const text = await embed.evaluate(() => document.body?.innerText?.slice(0, 1200) ?? "").catch((e) => `ERR ${e}`);
    say(`--- embed body text ---\n${text}`);
    const anchors = await embed
      .evaluate(() =>
        [...document.querySelectorAll("[data-conformance-id],[data-embed-signin],[data-lifecycle-card]")].map((e) => ({
          conformance: e.getAttribute("data-conformance-id"),
          signin: e.hasAttribute("data-embed-signin"),
          card: e.getAttribute("data-lifecycle-card"),
        })),
      )
      .catch((e) => `ERR ${e}`);
    say(`embed anchors: ${JSON.stringify(anchors)}`);
    const buttons = await embed
      .evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent?.trim()).filter(Boolean))
      .catch((e) => `ERR ${e}`);
    say(`embed buttons: ${JSON.stringify(buttons)}`);
  }

  await page.screenshot({ path: join(OUT, "probe-host-page.png"), fullPage: true });
} finally {
  writeFileSync(join(OUT, "03-probe.log"), log.join("\n") + "\n");
  await browser.close();
}
console.log("probe done");
