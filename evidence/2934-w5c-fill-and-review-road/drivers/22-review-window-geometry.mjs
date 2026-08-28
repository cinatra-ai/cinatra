import { openAs, stamp, write } from "./03-capture-lib.mjs";
const { browser, page } = await openAs(process.env.OWNER_EMAIL, process.env.OWNER_PW, { theme: process.env.THEME ?? "light" });
page.setDefaultTimeout(300000);
await page.goto(process.env.REVIEW_PATH, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(35000);
const g = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const decide = buttons.filter((b) => /^(Approve|Reject|Comment)$/.test((b.textContent || "").trim()));
  if (decide.length === 0) return { ok: false, reason: "no decision bar", buttons: buttons.map(b=>(b.textContent||"").trim()).slice(0,30) };
  let bar = decide[0].parentElement;
  for (let i = 0; i < 6 && bar; i += 1) { if (decide.every((b) => bar.contains(b))) break; bar = bar.parentElement; }
  const win = document.querySelector("[data-run-window-placement]") ?? document.querySelector('[data-conformance-id="review-prompt-window"]');
  if (!bar || !win) return { ok: false, reason: "bar or window not found" };
  const b = bar.getBoundingClientRect(); const w = win.getBoundingClientRect();
  const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return { ok: true,
    bar: { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height), left: Math.round(b.left), right: Math.round(b.right) },
    window: { top: Math.round(w.top), bottom: Math.round(w.bottom), height: Math.round(w.height), left: Math.round(w.left), right: Math.round(w.right) },
    verticalOverlapPx: Math.round(Math.max(0, Math.min(b.bottom, w.bottom) - Math.max(b.top, w.top))),
    horizontalOverlapPx: Math.round(Math.max(0, Math.min(b.right, w.right) - Math.max(b.left, w.left))),
    barCentre: { x: cx, y: cy },
    barCentreResolvesInsideTheBar: Boolean(hit && bar.contains(hit)),
    barCentreResolvesInsideTheWindow: Boolean(hit && win.contains(hit)),
    windowPlacement: win.getAttribute("data-run-window-placement"),
    windowFollowsTheBarInDocumentOrder: Boolean(bar.compareDocumentPosition(win) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
});
stamp("geometry", g);
write(process.env.OUT_NAME ?? "geometry.json", g);
console.log(JSON.stringify(g, null, 1));
await browser.close();
