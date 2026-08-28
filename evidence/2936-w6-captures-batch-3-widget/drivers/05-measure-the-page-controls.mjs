// MEASURE EVERY PICTURE THIS ROUND FILED THAT IS NOT AN INDEX RECORD.
//
// The page controls are pictures of screens that draw no lifecycle card at all —
// which is the finding in most of them — so the capture contract has no
// vocabulary for them and they are deliberately not index records. What they owe
// instead is the same arithmetic every record carries: the digest of the file on
// disk, its pixels, and TWO luminances — the whole frame, and the widget's own
// region inside it. The second is the one a "dark" claim is about: the widget
// sits in a third-party page with its own light styling, so a whole-frame mean
// reads that page as much as the widget.
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.REPO_ROOT ?? process.cwd();
const R = "evidence/2936-w6-captures-batch-3-widget";
const NOTES = JSON.parse(readFileSync(join(REPO, R, "page-control-notes.json"), "utf8"));
const BOX = JSON.parse(process.env.WIDGET_FRAME_BOX ?? '{"x":20,"y":118,"width":720,"height":700}');
const SCALE = Number(process.env.DEVICE_SCALE ?? 2);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const p = await ctx.newPage();
const out = [];
try {
  for (const [name, note] of Object.entries(NOTES)) {
    const rel = `${R}/cells/${name}.png`;
    const abs = join(REPO, rel);
    const bytes = readFileSync(abs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const measured = await p.evaluate(async ({ data, box, scale }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const lum = (d) => {
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return s / (d.length / 4);
      };
      const whole = lum(g.getImageData(0, 0, c.width, c.height).data);
      const x = Math.max(0, Math.round(box.x * scale));
      const y = Math.max(0, Math.round(box.y * scale));
      const w = Math.min(c.width - x, Math.round(box.width * scale));
      const h = Math.min(c.height - y, Math.round(box.height * scale));
      const region = w > 0 && h > 0 ? lum(g.getImageData(x, y, w, h).data) : null;
      return { whole, region, width: c.width, height: c.height };
    }, { data: bytes.toString("base64"), box: BOX, scale: SCALE });
    out.push({
      name, screenshot: rel, sha256, bytes: bytes.length,
      pixels: { width: measured.width, height: measured.height },
      meanLuminance: Number(measured.whole.toFixed(1)),
      widgetRegionMeanLuminance: measured.region === null ? null : Number(measured.region.toFixed(1)),
      widgetRegionBox: BOX,
      note,
    });
    console.log(`${name} sha256=${sha256.slice(0, 16)}… whole=${measured.whole.toFixed(1)} widget=${measured.region?.toFixed(1)}`);
  }
  // Two files with the SAME digest are the SAME SCREEN, and that is a reading,
  // not an accident — it is said here rather than tidied away.
  const byDigest = new Map();
  for (const e of out) byDigest.set(e.sha256, [...(byDigest.get(e.sha256) ?? []), e.name]);
  const identical = [...byDigest.values()].filter((names) => names.length > 1);
  writeFileSync(join(REPO, R, "page-controls.json"), `${JSON.stringify({ controls: out, byteIdenticalGroups: identical }, null, 2)}\n`);
  console.log(`byte-identical groups: ${JSON.stringify(identical)}`);
} finally { await browser.close(); }
