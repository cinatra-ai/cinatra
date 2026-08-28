// Render the ratified drawing at the contract's pin with the SAME capture
// browser the cells are shot with, and write each numbered section's own text
// out, so every `requires` in this round is COPIED from the drawing rather than
// recalled. Nothing is interpreted here: the text is what the page renders.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SPEC = process.argv[2];
const OUT = process.argv[3];
if (!SPEC || !OUT) throw new Error("usage: 00-render-the-drawing.mjs <spec.html> <out.json>");

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.setContent(readFileSync(SPEC, "utf8"), { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
const sections = await p.evaluate(() => {
  // The drawing puts each heading in its own `div.sect` plate and lets the
  // section's prose FOLLOW that plate as siblings, up to the next plate. So the
  // section is the plate plus everything after it until the next one. Reading
  // only the plate (or only the heading's siblings) reports a section as three
  // lines long, which is how a `requires` ends up recalled instead of copied.
  const plates = [...document.querySelectorAll("div.sect")].filter((d) => d.querySelector("h2"));
  return plates.map((plate, i) => {
    const end = plates[i + 1] ?? null;
    const parts = [];
    let n = plate;
    while (n && n !== end) { parts.push(n.innerText ?? ""); n = n.nextElementSibling; }
    return {
      heading: (plate.querySelector("h2")?.innerText ?? "").trim(),
      text: parts.join("\n"),
    };
  });
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ spec: SPEC.split("/").pop(), sections }, null, 2)}\n`);
console.log(sections.map((s, i) => `${i}: ${s.heading} (${s.text.length} chars)`).join("\n"));
await b.close();
