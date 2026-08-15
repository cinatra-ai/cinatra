import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, BASE } from "./lib-auth.mjs";

const OUT = ensureDir("/Users/ordnas/cinatra-lanes/2370-out/probe");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const steps = [];
await authenticate(context, steps);
await page.goto(`${BASE}/connectors`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(4000);
const html = await page.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find(
    (n) => n.children.length === 0 && (n.textContent ?? "").trim() === "Google Appointment Schedules",
  );
  const out = [];
  let node = el;
  for (let i = 0; i < 6 && node; i++) {
    out.push({ level: i, tag: node.tagName, cls: node.className?.toString?.().slice(0, 120), html: node.outerHTML.slice(0, 900) });
    node = node.parentElement;
  }
  return out;
});
writeFileSync(`${OUT}/dom.json`, JSON.stringify(html, null, 2));
console.log(JSON.stringify(html.slice(0, 5), null, 2).slice(0, 4000));
await browser.close();
