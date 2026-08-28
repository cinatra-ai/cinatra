// W5c picture leg — the ground each frame was taken on, measured out of the
// PNG itself. Not "it looks dark": the mean luminance of every pixel the file
// holds, decoded by the same engine that took it, with no image library and
// nothing re-rendered.
//   node 19-frame-luminance.mjs <file.png> [...]
import { chromium } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
const rows = [];
for (const file of files) {
  const bytes = fs.readFileSync(file);
  const measured = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    return { width: c.width, height: c.height, meanLuminance: Math.round((sum / n) * 10) / 10 };
  }, bytes.toString("base64"));
  rows.push({
    file: path.basename(file),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    ...measured,
  });
}
await browser.close();
console.log(JSON.stringify(rows, null, 2));
