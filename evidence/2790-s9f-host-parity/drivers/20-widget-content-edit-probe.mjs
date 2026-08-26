// ---------------------------------------------------------------------------
// cinatra#2790 S9f round 2 — CAN THE WIDGET'S OWN CONTENT-EDIT CARRIER REACH
// THE RECOMMENDATION HOLD?
//
// Round 1 (drivers/18) measured the widget asking for ANOTHER agent's run and
// recorded the refusal: a `public_site_widget` delegation's MCP allowlist is
// closed and holds no agent-dispatch primitive. This round measures the OTHER
// route — the one the widget owns. The widget's conversation asks, in the
// person's own words, for a content edit; the kind's own content-editor carrier
// (`wordpress_content_editor_run`) is the tool that performs it; and the
// question is whether the run that carrier creates opens the run-start
// recommendation moment.
//
// It asserts nothing about the answer and photographs nothing on its own. Its
// output is the transcript, the DB rows the turn produced — every `agent_runs`
// row with its MOMENT columns — and the presence or absence of the card. The
// block, if it is one, is a measurement rather than a claim.
//
// Usage: node 20-widget-content-edit-probe.mjs
//        env: HOST_PAGE, WIDGET_MESSAGE, S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, OUTDIR
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import pg from "pg";
import fs from "node:fs";

const HOST = process.env.HOST_PAGE;
const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
const MESSAGE = process.env.WIDGET_MESSAGE;
const OUT = process.env.OUTDIR;

const lines = [];
const say = (m) => { lines.push(m); console.log(m); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1228, height: 1400 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("response", (r) => {
  const p = new URL(r.url()).pathname;
  if (/\/api\/(assistants|agents|lifecycle-views|chat|widget-auth|mcp)/.test(p)) say(`RESP ${r.request().method()} ${p} ${r.status()}`);
});
const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
const strip = async () => { for (const f of page.frames()) await f.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {}); };

// Every agent_run with the columns that say WHAT MOMENT it is at — the whole
// point of the measurement.
const RUN_SQL = `select id, status, source_type, human_present, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, created_at
                 from cinatra.agent_runs order by created_at desc limit 6`;

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
await c.connect();
const before = (await c.query(RUN_SQL)).rows;
say(`runs BEFORE the turn: ${JSON.stringify(before)}`);

try {
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 180000 });
  say("host page: " + HOST.split("?")[0] + " (a page on another site, embedding the frame)");
  let frame = null;
  for (let i = 0; i < 90 && !frame; i++) { await page.waitForTimeout(2000); frame = embedFrame(); }
  if (!frame) throw new Error("no embed frame");
  say("frame: " + new URL(frame.url()).pathname + new URL(frame.url()).search);
  for (let i = 0; i < 120; i++) {
    const ready = await embedFrame()?.evaluate(() => Boolean(document.querySelector("[data-embed-signin]")) || Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'))).catch(() => false);
    if (ready) { say(`frame drew after ~${i * 2}s`); break; }
    await page.waitForTimeout(2000);
  }
  frame = embedFrame();
  const signin = frame.locator("[data-embed-signin]").first();
  if ((await signin.count()) > 0) {
    say("running the frame's own hosted PKCE sign-in");
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 180000 }), signin.click()]);
    await popup.waitForLoadState("domcontentloaded", { timeout: 180000 }).catch(() => {});
    const settle = async (ms) => { if (!popup.isClosed()) await popup.waitForTimeout(ms).catch(() => {}); };
    await settle(4000);
    if (!popup.isClosed()) {
      const em = popup.locator('input[type="email"], input[name="email"]').first();
      if ((await em.count().catch(() => 0)) > 0) {
        await em.fill(ACTOR.email).catch(() => {});
        await popup.locator('input[type="password"], input[name="password"]').first().fill(ACTOR.password).catch(() => {});
        // The shipped hosted-login form's control reads "Login"; the consent step
        // that follows it reads Continue / Allow / Approve / Authorize. Both are
        // matched by name rather than by type, because the form's control is not
        // a `button[type=submit]`.
        const login = popup.locator('button:has-text("Login"), button:has-text("Sign in"), button[type="submit"]').first();
        await login.click({ timeout: 30000 }).catch(() => {});
        await settle(7000);
      }
    }
    for (let i = 0; i < 6 && !popup.isClosed(); i++) {
      const btn = popup
        .locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Authorize"), button:has-text("Sign in")')
        .first();
      if ((await btn.count().catch(() => 0)) === 0) break;
      say("popup step: " + ((await btn.innerText().catch(() => "")) || "<unnamed>").trim());
      await btn.click({ timeout: 20000 }).catch(() => {});
      await settle(4000);
    }
    if (!popup.isClosed()) say("popup still open at: " + popup.url().split("?")[0]);
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 120000 }).catch(() => {});
    say("popup closed: " + popup.isClosed());
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);
      const f = embedFrame(); if (!f) continue;
      const anon = await f.evaluate(() => Boolean(document.querySelector("[data-embed-signin]"))).catch(() => true);
      const t = await f.evaluate(() => document.body?.innerText?.slice(0, 120) ?? "").catch(() => "");
      if (!anon && !/Waiting for the Cinatra sign-in/i.test(t)) { say(`frame left anonymous after ~${(i + 1) * 2}s`); break; }
    }
  } else say("frame already had a session");

  frame = embedFrame();
  const composer = frame.locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 240000 });
  await composer.click();
  await composer.type(MESSAGE, { delay: 8 });
  await strip();
  await composer.press("Enter");
  say(`TURN sent through the widget's own composer at ${new Date().toISOString()}`);
  // THE CMS CHROME'S OWN ANNOUNCEMENT, read off the parent page rather than
  // asserted in prose (convergence round 3). The host page records every bridge
  // message it sends and receives on `window.__s9fBridgeLog`; the CONTEXT line is
  // the one that names the open post.
  for (const line of await page.evaluate(() => window.__s9fBridgeLog ?? []).catch(() => [])) {
    say("BRIDGE " + String(line).slice(0, 400));
  }

  let sawCard = false;
  for (let i = 0; i < 72; i++) {
    await page.waitForTimeout(5000);
    const f = embedFrame();
    const card = await f?.evaluate(() => Boolean(document.querySelector('[data-lifecycle-card="recommendation_hold"]'))).catch(() => false);
    const runs = (await c.query(RUN_SQL)).rows;
    const fresh = runs.filter((r) => !before.some((x) => x.id === r.id));
    if (i % 3 === 0 || card || fresh.length) say(`t=${(i + 1) * 5}s card=${card} newRuns=${JSON.stringify(fresh)}`);
    if (card) { sawCard = true; break; }
  }
  say(`card ever seen: ${sawCard}`);

  const f = embedFrame();
  const text = await f?.evaluate(() => document.querySelector("[data-conversation-list]")?.innerText?.replace(/\n{2,}/g, "\n").slice(0, 3000) ?? "<no list>").catch(() => "<err>");
  say("TRANSCRIPT:\n" + text);

  const after = (await c.query(RUN_SQL)).rows;
  say(`runs AFTER the turn: ${JSON.stringify(after)}`);
  const fresh = after.filter((r) => !before.some((x) => x.id === r.id));
  say(`NEW runs this turn: ${fresh.length}`);
  for (const r of fresh) {
    let parks = [];
    try {
      parks = (await c.query(
        `select id, checkpoint, status, created_at from cinatra.lifecycle_continuation_park where run_id = $1 order by created_at`,
        [r.id],
      )).rows;
    } catch (parkErr) {
      parks = [`<park read failed: ${String(parkErr?.message ?? parkErr).slice(0, 120)}>`];
    }
    say(`run ${r.id}: status=${r.status} human_present=${r.human_present} moment=${r.lifecycle_moment ?? "NULL"} cardKind=${r.lifecycle_card_kind ?? "NULL"} cardRef=${r.lifecycle_card_ref ?? "NULL"} parks=${JSON.stringify(parks)}`);
  }
  await strip();
  await page.screenshot({ path: OUT + "/content-edit-probe.png", fullPage: false });
} catch (e) {
  say("PROBE ERROR: " + (e?.stack || e));
  await page.screenshot({ path: OUT + "/content-edit-probe-error.png" }).catch(() => {});
} finally {
  await c.end().catch(() => {});
  await b.close();
  fs.writeFileSync(OUT + "/content-edit-probe.txt", lines.join("\n") + "\n");
}
