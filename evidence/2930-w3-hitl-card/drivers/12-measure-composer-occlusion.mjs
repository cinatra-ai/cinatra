import { chromium } from "@playwright/test";
const APP = process.env.WALK_BASE;
const b = await chromium.launch();
const c = await b.newContext({ baseURL: APP, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await c.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
const p = await c.newPage(); p.setDefaultTimeout(180000);
await p.goto(process.env.PROBE_URL, { waitUntil: "domcontentloaded" });
await p.waitForSelector('[data-action="submit-hitl-screen"]');
await p.waitForTimeout(8000);
const m = async (label) => console.log(label, JSON.stringify(await p.evaluate(() => {
  const btn = document.querySelector('[data-action="submit-hitl-screen"]');
  const card = document.querySelector('[data-conformance-id="agent-hitl-screen-card"]');
  const r = btn?.getBoundingClientRect();
  const cr = card?.getBoundingClientRect();
  const mid = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
  return {
    btn: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    card: cr ? { y: Math.round(cr.y), bottom: Math.round(cr.bottom) } : null,
    viewportH: window.innerHeight,
    topmostAtButtonCentre: mid ? `${mid.tagName.toLowerCase()}${mid.getAttribute("data-action") ? "[" + mid.getAttribute("data-action") + "]" : ""}` : null,
    buttonIsTopmost: mid ? (btn === mid || btn.contains(mid)) : false,
  };
})));
await m("BEFORE-SCROLL");
await p.evaluate(() => { const l = document.querySelector("[data-conversation-list]"); const s = l?.closest("[class*='overflow']") ?? document.scrollingElement; if (s) s.scrollTop = s.scrollHeight; document.querySelector('[data-action="submit-hitl-screen"]')?.scrollIntoView({ block: "center" }); });
await p.waitForTimeout(2500);
await m("AFTER-SCROLL");
await b.close();
