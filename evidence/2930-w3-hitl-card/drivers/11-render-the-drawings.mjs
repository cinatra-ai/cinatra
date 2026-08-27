// RENDER THE RATIFIED DRAWINGS AT THE CONTRACT'S OWN PIN, so the requires can be
// read off the drawing rather than paraphrased. The two files are fetched with
// two files are fetched with a read-only contents API call at the exact pin the
// anchor contract states in its own `specCommit`, served from loopback, and
// photographed with the same browser the cells were shot with.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
const BASE = process.env.SPEC_BASE, OUTDIR = process.env.SPEC_OUT;
if (!BASE || !OUTDIR) throw new Error("needs SPEC_BASE and SPEC_OUT");
const shots = [
  { file: "app-lifecycle-cards.html", anchorText: "I. The conversation", out: `${OUTDIR}/DRAWING-1__lifecycle-cards-section-I.png` },
  // §I's INPUT RULE, which is what every cell in this set is graded against.
  { file: "app-lifecycle-cards.html", anchorText: "One input, not two.", out: `${OUTDIR}/DRAWING-1b__section-I-one-input-not-two.png` },
  { file: "app-lifecycle-cards.html", anchorText: "The rule, wherever a card meets a chat box", out: `${OUTDIR}/DRAWING-1c__section-I-the-rule.png` },
  { file: "app-lifecycle-cards.html", anchorText: "IX. Where each card appears", out: `${OUTDIR}/DRAWING-2__lifecycle-cards-section-IX.png` },
  { file: "app-components.html", anchorText: "Retiring the in-stepper trigger HITL", out: `${OUTDIR}/DRAWING-3__components-no-pause-screen.png` },
];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
const p = await ctx.newPage(); p.setDefaultTimeout(120000);
for (const s of shots) {
  await p.goto(`${BASE}/${s.file}`, { waitUntil: "load" });
  await p.waitForTimeout(2500);
  const found = await p.evaluate((t) => {
    const el = Array.from(document.querySelectorAll("h1,h2,h3,h4,strong,b,span")).find((h) => (h.textContent || "").replace(/\s+/g, " ").trim().startsWith(t));
    if (el) { el.scrollIntoView({ block: "start" }); return true; }
    return false;
  }, s.anchorText);
  await p.waitForTimeout(1500);
  mkdirSync(dirname(resolve(s.out)), { recursive: true });
  await p.screenshot({ path: s.out, fullPage: false });
  console.log(`${found ? "PASS" : "FAIL"} ${s.anchorText} -> ${s.out}`);
}
await b.close();
