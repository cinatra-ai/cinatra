// Render section V of the ratified base page at the contract's pin, with the
// SAME capture browser the cells were shot with, so the requires are copied from
// the drawing rather than from memory.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const SPEC = process.argv[2];
const OUT = process.argv[3];
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.setContent(readFileSync(SPEC, "utf8"), { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
const h = p.locator('h2:has-text("V. The recommendation card")').first();
await h.scrollIntoViewIfNeeded();
// the section is everything from this heading to the next h2
const box = await p.evaluate(() => {
  const hs = [...document.querySelectorAll("h2")];
  const i = hs.findIndex((x) => /^\s*V\.\s*The recommendation card/.test(x.textContent ?? ""));
  const start = hs[i], end = hs[i + 1];
  const top = start.getBoundingClientRect().top + window.scrollY;
  const bottom = end.getBoundingClientRect().top + window.scrollY;
  const text = [];
  let n = start;
  while (n && n !== end) { text.push(n.innerText ?? ""); n = n.nextElementSibling; }
  return { top, bottom, height: bottom - top, text: text.join("\n") };
});
console.log("SECTION V height:", box.height);
writeFileSync(OUT.replace(/\.png$/, ".txt"), box.text);
await p.setViewportSize({ width: 1440, height: Math.min(Math.ceil(box.height) + 40, 12000) });
await p.evaluate((t) => window.scrollTo(0, t - 12), box.top);
await p.waitForTimeout(1200);
await p.screenshot({ path: OUT, scale: "device" });
const bytes = readFileSync(OUT);
console.log("PNG", bytes.readUInt32BE(16) + "x" + bytes.readUInt32BE(20));
await b.close();
