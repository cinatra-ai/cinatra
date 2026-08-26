// ---------------------------------------------------------------------------
// cinatra#2790 S9f — CAN THE WIDGET'S OWN CONVERSATION START THIS RUN?
//
// The re-shoot was asked for as ONE chain starting in the widget's own
// conversation. `packages/mcp-server/src/delegated-widget-tool-policy.ts` says it
// cannot: a `public_site_widget` delegation's MCP allowlist is CLOSED and holds
// no general `agent_run` primitive, only the kind's own content-editor dispatch
// and four read-only lifecycle pulls.
//
// This driver does not argue from the source. It drives the real embedded
// cross-site widget on a third-party page, signs the frame in through its own
// hosted PKCE flow, types the SAME request the chain needs into the widget's own
// composer, and writes down what the transcript says — with the real provider
// configured and the instance's own public MCP surface reachable.
//
// It asserts nothing and photographs nothing: its output is the transcript and
// the run rows (there are none), so the block is a measurement rather than a
// claim.
//
// Usage: node 18-widget-real-turn-probe.mjs
//        env: HOST_PAGE, WIDGET_MESSAGE, S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, OUTDIR
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import pg from "pg";
const HOST = process.env.HOST_PAGE;
const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
const MESSAGE = process.env.WIDGET_MESSAGE;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1228, height: 1400 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const say = (m) => console.log(m);
page.on("response", (r) => { const p = new URL(r.url()).pathname; if (/\/api\/(assistants|lifecycle-views|chat|widget-auth)/.test(p)) say(`RESP ${r.request().method()} ${p} ${r.status()}`); });
const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
const strip = async () => { for (const f of page.frames()) await f.evaluate(() => document.querySelectorAll("nextjs-portal").forEach(n=>n.remove())).catch(()=>{}); };
try {
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 180000 });
  let frame = null;
  for (let i = 0; i < 90 && !frame; i++) { await page.waitForTimeout(2000); frame = embedFrame(); }
  if (!frame) throw new Error("no embed frame");
  say("frame: " + new URL(frame.url()).pathname);
  for (let i = 0; i < 120; i++) {
    const ready = await embedFrame()?.evaluate(() => Boolean(document.querySelector("[data-embed-signin]")) || Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'))).catch(()=>false);
    if (ready) { say(`frame drew after ~${i*2}s`); break; }
    await page.waitForTimeout(2000);
  }
  frame = embedFrame();
  const signin = frame.locator("[data-embed-signin]").first();
  if ((await signin.count()) > 0) {
    say("running the frame's own hosted PKCE sign-in");
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 180000 }), signin.click()]);
    await popup.waitForLoadState("domcontentloaded", { timeout: 180000 }).catch(()=>{});
    const settle=async(ms)=>{ if(!popup.isClosed()) await popup.waitForTimeout(ms).catch(()=>{}); };
    await settle(4000);
    if (!popup.isClosed()) {
      const em = popup.locator('input[type="email"], input[name="email"]').first();
      if ((await em.count().catch(()=>0)) > 0) {
        await em.fill(ACTOR.email).catch(()=>{});
        await popup.locator('input[type="password"], input[name="password"]').first().fill(ACTOR.password).catch(()=>{});
        await popup.locator('button[type="submit"]').first().click().catch(()=>{});
        await settle(6000);
      }
    }
    for (let i = 0; i < 4 && !popup.isClosed(); i++) {
      const btn = popup.locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Sign in")').first();
      if ((await btn.count().catch(()=>0)) === 0) break;
      await btn.click({ timeout: 20000 }).catch(()=>{});
      await settle(3000);
    }
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 120000 }).catch(()=>{});
    say("popup closed: " + popup.isClosed());
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);
      const f = embedFrame(); if (!f) continue;
      const anon = await f.evaluate(() => Boolean(document.querySelector("[data-embed-signin]"))).catch(()=>true);
      const t = await f.evaluate(() => document.body?.innerText?.slice(0,120) ?? "").catch(()=>"");
      if (!anon && !/Waiting for the Cinatra sign-in/i.test(t)) { say(`frame left anonymous after ~${(i+1)*2}s`); break; }
    }
  } else say("frame already had a session");
  frame = embedFrame();
  const composer = frame.locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 240000 });
  await composer.click();
  await composer.type(MESSAGE, { delay: 8 });
  await strip();
  await composer.press("Enter");
  say("TURN sent through the widget's own composer");
  const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL }); await c.connect();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);
    const f = embedFrame();
    const card = await f?.evaluate(() => Boolean(document.querySelector('[data-lifecycle-card="recommendation_hold"]'))).catch(()=>false);
    const runs = (await c.query(`select id, status, source_type, human_present, created_at from cinatra.agent_runs order by created_at desc limit 3`)).rows;
    if (i % 3 === 0 || card || runs.length) say(`t=${(i+1)*5}s card=${card} runs=${JSON.stringify(runs)}`);
    if (card) break;
  }
  const f = embedFrame();
  const text = await f?.evaluate(() => document.querySelector("[data-conversation-list]")?.innerText?.replace(/\n{2,}/g,"\n").slice(0,2500) ?? "<no list>").catch(()=>"<err>");
  say("TRANSCRIPT:\n" + text);
  await strip();
  await page.screenshot({ path: process.env.OUTDIR + "/widget-probe.png", fullPage: false });
  await c.end();
} catch (e) { say("PROBE ERROR: " + (e?.stack || e)); await page.screenshot({ path: process.env.OUTDIR + "/widget-probe-error.png" }).catch(()=>{}); }
finally { await b.close(); }
