// EVERY FILED FRAME, MEASURED: its sha256, its pixel size, and its MEAN
// LUMINANCE decoded from the file itself in the capture browser's own canvas.
//
// A frame filed as `dark` above 128/255 is refused here rather than filed and
// explained — that is the mistake the sibling round made and named, and this is
// the check that catches it before the record is written.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const CELLS = process.env.CELLS_DIR;
const OUT = process.env.OUT_JSON;
if (!CELLS || !OUT) throw new Error("the measuring driver needs CELLS_DIR and OUT_JSON");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
await page.setContent("<html><body></body></html>", { waitUntil: "domcontentloaded" });

const files = readdirSync(CELLS).filter((f) => f.endsWith(".png")).sort();
const measured = [];
for (const f of files) {
  const bytes = readFileSync(join(CELLS, f));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;
  const px = await page.evaluate(async (uri) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return { width: c.width, height: c.height, meanLuminance: sum / (d.length / 4) };
  }, dataUri);
  const declaredDark = /__dark\.png$/.test(f);
  const record = {
    file: f,
    bytes: bytes.length,
    sha256,
    width: px.width,
    height: px.height,
    meanLuminance: Number(px.meanLuminance.toFixed(2)),
    declaredPalette: declaredDark ? "dark" : "light",
    honest: declaredDark ? px.meanLuminance <= 128 : px.meanLuminance > 128,
  };
  measured.push(record);
  console.log(`${record.honest ? "PASS" : "REFUSED"} ${f} ${record.width}x${record.height} luminance=${record.meanLuminance} sha256=${sha256.slice(0, 16)}…`);
}
const allHonest = measured.every((m) => m.honest);
console.log(allHonest ? "PASS every filed frame's palette is the palette its name declares" : "FAIL a frame's palette does not match its name");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), measured }, null, 2) + "\n");
await browser.close();
process.exitCode = allHonest ? 0 : 1;
