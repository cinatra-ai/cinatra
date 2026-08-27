// cinatra#2790 (S9f) — THE SEVEN WIDGET CELLS, from a REAL RUN started inside
// the embedded widget.
//
// THE ROAD. #2890 recorded the widget's seven cells as NON-PROOF because the
// only run-creating road the widget had (the content-editor carrier) launches
// with no present human and therefore never parks. #2996 (W5d, merged
// d13050cd8c82) gave the widget's own assistant a narrowly scoped start —
// `agent_named_start` — which builds its actor envelope with
// `humanPresent: true` and `launchOrigin: "chat"`
// (`src/lib/lifecycle/named-agent-start-mcp.ts:235`/`:259`). A run started that
// way satisfies `verifiedHumanPresence` and reaches
// `maybeHoldRunForRecommendation`, which parks it at the recommendation moment.
//
// So this driver types ONE sentence into the widget's own composer, naming the
// agent, and then does nothing a visitor could not do: it reads the card the
// hold puts in the transcript and presses that card's own per-chip controls.
// Nothing is seeded. No run, park, decision or record row is written by this
// file — every row it reads back was written by the app's own dispatch.
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const HOST = process.argv[2];
const OUT = process.argv[3];
const REPO_ROOT = process.argv[4];
const APP = process.argv[5];
const SHOT_DIR_REL = "evidence/2790-s9f-host-parity/captures";
mkdirSync(OUT, { recursive: true });
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const AGENT = process.env.S9F_AGENT ?? "@cinatra-ai/blog-draft-writer-agent";
const PROMPT = `Please start the agent ${AGENT} for me.`;
if (!HOST || !OUT || !REPO_ROOT || !APP || !ACTOR.email || !ACTOR.password || !DB_URL) {
  throw new Error("usage: <hostPageUrl> <outDir> <repoRoot> <appOrigin>; set S9F_EMAIL, S9F_PW, SUPABASE_DB_URL");
}

const log = [];
const say = (m) => { log.push(m); console.log(m); };
const startedAt = new Date();

async function q(sql, params = []) {
  const c = new Client({ connectionString: DB_URL });
  try { await c.connect(); return (await c.query(sql, params)).rows; }
  catch (e) { return [{ error: String(e?.message ?? e).slice(0, 200) }]; }
  finally { await c.end().catch(() => {}); }
}
let RUN_ID = null;
const readRunStatus = async () =>
  RUN_ID ? (await q(`select status from cinatra.agent_runs where id = $1`, [RUN_ID]))[0]?.status ?? null : null;

// --- the wire ---------------------------------------------------------------
const wire = [];
function noteRequest(req, label) {
  const h = req.headers();
  const e = {
    label,
    method: req.method(),
    path: (() => { try { return new URL(req.url()).pathname; } catch { return "<unparseable>"; } })(),
    resourceType: req.resourceType(),
    cookie: h["cookie"] ? "PRESENT" : "absent",
    widgetUserToken: h["x-cinatra-widget-user-token"] ? "present (cwu_)" : "absent",
    widgetOrigin: h["x-cinatra-widget-origin"] ? "present" : "absent",
    widgetAssistant: h["x-cinatra-widget-assistant"] ? "present" : "absent",
  };
  wire.push(e);
  say(`WIRE ${JSON.stringify(e)}`);
}
const wireResponses = [];
const decideOutcomes = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1228, height: 1400 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/api/lifecycle-views/recommendation-hold/decide")) noteRequest(r, "recommendation-decide");
  else if (u.includes("/api/lifecycle-views/recommendation-hold")) noteRequest(r, "recommendation-resolve");
});
page.on("response", async (res) => {
  const u = res.url();
  if (!u.includes("/api/lifecycle-views/recommendation-hold")) return;
  const path = (() => { try { return new URL(u).pathname; } catch { return "<unparseable>"; } })();
  wireResponses.push({ path, status: res.status() });
  if (u.includes("/decide")) {
    const body = await res.json().catch(() => null);
    const o = (body ?? {}).outcome ?? null;
    decideOutcomes.push({
      path, status: res.status(),
      outcomeOk: o && typeof o === "object" ? Boolean(o.ok) : null,
      outcomeError: o && typeof o === "object" ? (o.error ?? null) : null,
      outcomeDispatched: o && typeof o === "object" && "dispatched" in o ? o.dispatched : null,
    });
  }
});

const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
const strip = async () => { for (const f of page.frames()) await f.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {}); };

const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
async function counts(selectors) {
  const f = embedFrame();
  const out = [];
  for (const { selector, scope } of selectors) {
    let count = 0;
    if (scope === "page") count = await page.evaluate((s) => document.querySelectorAll(s).length, selector);
    else if (scope === "frame") count = await f.evaluate((s) => document.querySelectorAll(s).length, selector).catch(() => 0);
    else count = await f.evaluate(({ s, rootSel }) => {
      const root = document.querySelector(rootSel);
      if (!root) return 0;
      return (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length;
    }, { s: selector, rootSel: CARD_ROOT }).catch(() => 0);
    out.push({ selector, scope, count });
  }
  return out;
}
const ASSERTIONS = [
  { selector: ".cw-frame", scope: "page" },
  { selector: '[data-embed-assistant][data-phase="active"]', scope: "frame" },
  { selector: "[data-conversation-list]", scope: "frame" },
  { selector: '[data-lifecycle-card-host="site_widget"]', scope: "frame" },
  { selector: '[data-lifecycle-card="recommendation_hold"]', scope: "frame" },
  { selector: '[data-lifecycle-card="artifact_review_gate"]', scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-skill-action="confirm"]', scope: "root" },
  { selector: '[data-skill-action="adjust"]', scope: "root" },
  { selector: '[data-skill-action="skip"]', scope: "root" },
  { selector: "[data-recommendation-chip]", scope: "root" },
  { selector: '[data-conformance-id="run-chip-row"]', scope: "frame" },
];
const rootAttributes = async () =>
  embedFrame().evaluate((rootSel) => {
    const el = document.querySelector(rootSel);
    if (!el) return null;
    const o = {};
    for (const a of el.attributes) o[a.name] = a.value;
    delete o.class;
    return o;
  }, CARD_ROOT).catch(() => null);
const chipReadout = async () =>
  embedFrame().evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return [];
    return [...root.querySelectorAll("[data-recommendation-chip]")].map((c) => ({
      skillId: c.getAttribute("data-skill-id"),
      mark: c.getAttribute("data-chip-mark"),
      forced: c.hasAttribute("data-forced"),
      label: (c.querySelector("span")?.textContent ?? "").trim(),
      text: (c.textContent ?? "").replace(/\s+/g, " ").trim(),
      actions: [...c.querySelectorAll("[data-skill-action]")].map((b) => b.getAttribute("data-skill-action")),
    }));
  }, CARD_ROOT).catch(() => []);

const records = [];
const results = [];
async function shoot(cell, declaredState, note, extra = {}, framing = "card") {
  await strip();
  const f = embedFrame();
  const rel = `${SHOT_DIR_REL}/${cell}.png`;
  const abs = join(REPO_ROOT, rel);
  const target = framing === "column" ? page.locator(".cw-frame").first() : f.locator(CARD_ROOT).first();
  await target.screenshot({ path: abs, scale: "device" });
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const observed = await counts(ASSERTIONS);
  const attrs = await rootAttributes();
  const chips = await chipReadout();
  const theme = await f.evaluate(() => document.documentElement.className).catch(() => "");
  const cardText = await f.locator(CARD_ROOT).first().innerText().then((t) => t.replace(/\n{2,}/g, "\n")).catch(() => "");
  const columnText = await f.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 900)).catch(() => "");
  records.push({
    cell,
    declaredHost: "site_widget",
    declaredKind: "recommendation_hold",
    declaredState,
    finalUrl: new URL(page.url()).pathname,
    frameUrl: (() => { const u = new URL(f.url()); return u.pathname + (u.search ? "?<frame disambiguators>" : ""); })(),
    screenshot: rel,
    sha256,
    assertions: observed,
    recordedBy: "cinatra-lifecycle-capture-recorder@1",
    recordedAt: new Date().toISOString(),
    runtime: process.env.S9F_RUNTIME_NOTE ?? "",
    note,
    rootAttributes: attrs,
    chips,
    themeClass: theme,
    framing,
    runId: RUN_ID,
    ...extra,
  });
  results.push({ cell, framing, pixels: dims, sha256, observed, rootAttributes: attrs, chips, themeClass: theme, cardText: cardText.slice(0, 2000), columnText });
  say(`CAP ${cell} ${dims.width}x${dims.height} framing=${framing} state=${attrs?.["data-lifecycle-card-state"] ?? "?"} chips=${chips.length} theme=${theme}`);
  return dims;
}

/**
 * THE THEME, THROUGH THE APP'S OWN CONTROL.
 *
 * There is no theme control inside a third-party page's chrome; the reader's
 * palette is the one they chose in Cinatra. The app's shipped `ThemeSwitch`
 * (`src/components/theme-switch.tsx`) drives next-themes, which is mounted with
 * `attribute="class"` and the two themes `cinatra` / `dark`
 * (`src/app/providers.tsx:48`) and persists the choice for the app ORIGIN. The
 * embed frame is a document on that SAME origin, so it reads the same choice.
 *
 * So the palette is changed the way a reader changes it: a real press on the
 * shipped control in an app tab of the SAME browser context. The frame is then
 * polled until IT reports the class — the flip is measured, never assumed, and
 * never written onto the document by this file.
 */
let appTab = null;
async function pressAppThemeControl(want) {
  if (!appTab) {
    appTab = await ctx.newPage();
    await appTab.goto(`${APP}/chat`, { waitUntil: "domcontentloaded", timeout: 600_000 });
    await appTab.waitForTimeout(6000);
  }
  await appTab.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
  const before = await appTab.evaluate(() => document.documentElement.className);
  const control = appTab.locator('button:has(.sr-only:text("Toggle theme")), button:has-text("Toggle theme")').first();
  let pressed = false;
  if ((await control.count().catch(() => 0)) > 0) {
    await control.click({ timeout: 60_000 }).catch(() => {});
    pressed = true;
  }
  say(`THEME CONTROL pressed=${pressed} appClassBefore="${before}" appClassAfter="${await appTab.evaluate(() => document.documentElement.className)}"`);
  // the frame is polled until it reports the palette itself
  let seen = "";
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(500);
    seen = await embedFrame().evaluate(() => document.documentElement.className).catch(() => "");
    if (want === "dark" ? /\bdark\b/.test(seen) : !/\bdark\b/.test(seen)) break;
  }
  await page.waitForTimeout(1200);
  say(`FRAME palette after the press: "${seen}" (wanted ${want})`);
  return { pressed, frameClass: seen, followed: want === "dark" ? /\bdark\b/.test(seen) : !/\bdark\b/.test(seen) };
}

const state = {};
try {
  say(`# cinatra#2790 S9f — the widget's seven cells from a REAL widget-started run — ${startedAt.toISOString()}`);
  say(`# top-level page (NOT the Cinatra app): ${new URL(HOST).pathname}`);
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 600_000 });
  let frame = null;
  for (let i = 0; i < 150; i += 1) { await page.waitForTimeout(2000); frame = embedFrame(); if (frame) break; }
  if (!frame) throw new Error("the embed frame never loaded inside the host page");
  for (let i = 0; i < 150; i += 1) {
    const ready = await embedFrame()?.evaluate(() => Boolean(document.querySelector("[data-embed-signin]")) || Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'))).catch(() => false);
    if (ready) break;
    await page.waitForTimeout(2000);
  }
  await strip();
  await page.waitForTimeout(2500);

  // the frame's OWN hosted PKCE sign-in
  const signin = embedFrame().locator("[data-embed-signin]").first();
  if ((await signin.count()) > 0) {
    say("frame is anonymous — running the frame's own hosted PKCE sign-in");
    const opened = [];
    ctx.on("page", (pg) => opened.push(pg));
    await signin.click({ timeout: 120_000 });
    let popup = null;
    for (let i = 0; i < 120 && !popup; i += 1) { await page.waitForTimeout(1000); popup = opened[0] ?? null; }
    if (!popup) throw new Error("the sign-in press opened no window");
    await popup.waitForLoadState("domcontentloaded", { timeout: 300_000 }).catch(() => {});
    say(`popup opened on path: ${popup.isClosed() ? "<closed>" : new URL(popup.url()).pathname}`);
    await popup.waitForTimeout(3000).catch(() => {});
    if (!popup.isClosed()) {
      const ef = popup.locator('input[type="email"], input[name="email"]').first();
      if ((await ef.count().catch(() => 0)) > 0) {
        await ef.fill(ACTOR.email).catch(() => {});
        await popup.locator('input[type="password"], input[name="password"]').first().fill(ACTOR.password).catch(() => {});
        await popup.locator('button[type="submit"]').first().click().catch(() => {});
        await popup.waitForTimeout(6000).catch(() => {});
      }
    }
    for (let i = 0; i < 4 && !popup.isClosed(); i += 1) {
      const b = popup.locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Sign in")').first();
      if ((await b.count().catch(() => 0)) === 0) break;
      await b.click({ timeout: 30_000 }).catch(() => {});
      await popup.waitForTimeout(3000).catch(() => {});
    }
    if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 180_000 }).catch(() => {});
    for (let i = 0; i < 150; i += 1) {
      await page.waitForTimeout(2000);
      const f = embedFrame(); if (!f) continue;
      const anon = await f.evaluate(() => Boolean(document.querySelector("[data-embed-signin]"))).catch(() => true);
      const t = await f.evaluate(() => document.body?.innerText?.slice(0, 120) ?? "").catch(() => "");
      if (!anon && !/Waiting for the Cinatra sign-in/i.test(t)) { say(`frame left the anonymous state after ~${(i + 1) * 2}s`); break; }
    }
  }
  const appCookies = (await ctx.cookies()).filter((c) => /localhost|127\.0\.0\.1/.test(c.domain));
  say(`COOKIE JAR after sign-in: ${JSON.stringify(appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly })))}`);

  // --- THE TURN THAT STARTS THE AGENT ---------------------------------------
  const composer = embedFrame().locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 600_000 });
  await composer.click();
  await composer.type(PROMPT, { delay: 12 });
  await strip();
  const turnSentAt = new Date();
  await composer.press("Enter");
  say(`TURN SENT through the widget's OWN composer at ${turnSentAt.toISOString()}: ${JSON.stringify(PROMPT)}`);
  state.prompt = PROMPT;
  state.turnSentAt = turnSentAt.toISOString();

  // --- the run the app's own dispatch created --------------------------------
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(5000);
    const rows = await q(`select id, status, human_present, template_id, created_at from cinatra.agent_runs where created_at > $1 order by created_at desc limit 1`, [startedAt.toISOString()]);
    if (rows[0]?.id) { RUN_ID = rows[0].id; say(`RUN ROW ${JSON.stringify(rows[0])}`); state.run = rows[0]; break; }
  }
  if (!RUN_ID) throw new Error("no agent_runs row appeared for the widget turn");
  const parkRows = await q(`select id, run_id, checkpoint, status, created_at from cinatra.lifecycle_continuation_park where run_id = $1`, [RUN_ID]);
  say(`PARK ROW ${JSON.stringify(parkRows)}`);
  state.park = parkRows[0] ?? null;

  // --- the card ---------------------------------------------------------------
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2000);
    const present = await embedFrame()?.evaluate((s) => Boolean(document.querySelector(s)), CARD_ROOT).catch(() => false);
    if (present) { say(`card root appeared after ~${(i + 1) * 2}s`); break; }
  }
  await page.waitForTimeout(3500);
  await strip();
  say(`CHIPS ${JSON.stringify(await chipReadout())}`);
  if (!(await embedFrame().evaluate((s) => Boolean(document.querySelector(s)), CARD_ROOT).catch(() => false))) {
    throw new Error("the recommendation card did not mount in the widget column");
  }

  // ---- HELD, light ---------------------------------------------------------
  const statusBefore = await readRunStatus();
  say(`agent_runs.status BEFORE the decision: ${statusBefore}`);
  state.statusBefore = statusBefore;
  await shoot("W1__recommendation-card__site_widget__held__column", "held", "The third-party page's embedded widget: the visitor's typed turn that STARTED the agent, the platform's own report sentence, the held card with its chips, and the widget's own composer.", { runStatusAtShutter: statusBefore }, "column");
  await shoot("H1__recommendation-card__site_widget__held", "held", "The same held card on its own root, so the drawing can be graded against section V with nothing else in the picture.", { runStatusAtShutter: statusBefore }, "card");

  // ---- HELD, dark, through the app's own theme control ----------------------
  state.themeToDark = await pressAppThemeControl("dark");
  await shoot("W2__recommendation-card__site_widget__held__column__dark", "held", "The same column, the same run, in dark — the palette chosen with the app's own shipped theme control, which the widget follows.", { runStatusAtShutter: await readRunStatus(), themeFacts: state.themeToDark }, "column");
  await shoot("H2__recommendation-card__site_widget__held__dark", "held", "The same card root in dark.", { themeFacts: state.themeToDark }, "card");

  // ---- back to light, through the same control ------------------------------
  state.themeToLight = await pressAppThemeControl("light");

  // ---- the decision, chip by chip, on the card's OWN controls ---------------
  const chips = await chipReadout();
  const f = embedFrame();
  const press = async (idx, action) => {
    const btn = f.locator(`${CARD_ROOT} [data-recommendation-chip]`).nth(idx).locator(`[data-skill-action="${action}"]`).first();
    await btn.click({ timeout: 60_000 });
    say(`pressed ${action} on chip ${idx} (${chips[idx]?.skillId})`);
  };

  // H3 — one chip decided by a real press on its OWN Confirm; the rest still
  // pressable. The IN-FLIGHT window is measured here rather than claimed.
  const t0 = Date.now();
  await press(0, "confirm");
  let inFlightMs = null;
  for (let i = 0; i < 400; i += 1) {
    const mark = await f.evaluate((s) => document.querySelector(s)?.querySelector("[data-recommendation-chip]")?.getAttribute("data-chip-mark") ?? null, CARD_ROOT).catch(() => null);
    if (mark && mark !== "undecided") { inFlightMs = Date.now() - t0; break; }
    await page.waitForTimeout(25);
  }
  say(`IN-FLIGHT window for one chip's decision: ${inFlightMs === null ? "not observed" : `${inFlightMs} ms`}`);
  state.inFlightMs = inFlightMs;
  await page.waitForTimeout(900);
  await shoot("H3__recommendation-card__site_widget__held__mid-decision", "held", "After ONE chip was decided by pressing its own Confirm in a real browser: that chip carries its confirmed mark; every other chip still shows all three affordances and is still pressable. The row is never decided as a unit.", { inFlightMs }, "card");

  await press(1, "adjust");
  await page.waitForTimeout(1200);
  const keep = f.locator('button:has-text("Keep it in this run")').first();
  if ((await keep.count().catch(() => 0)) > 0) { await keep.click({ timeout: 60_000 }); say("adjust panel: pressed 'Keep it in this run'"); }
  await page.waitForTimeout(1200);
  await press(2, "skip");
  await page.waitForTimeout(1200);
  await press(3, "confirm");

  // ---- SETTLED, taken WHERE IT WAS DECIDED ---------------------------------
  let settledInPlace = false;
  for (let i = 0; i < 120; i += 1) {
    await page.waitForTimeout(1000);
    const st = await f.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state") ?? null, CARD_ROOT).catch(() => null);
    if (st === "decided") { settledInPlace = true; say(`card settled IN PLACE after ~${i + 1}s`); break; }
  }
  state.settledInPlace = settledInPlace;
  const statusAfter = await readRunStatus();
  say(`agent_runs.status AFTER the decision: ${statusAfter}`);
  state.statusAfter = statusAfter;
  await page.waitForTimeout(1500);
  await shoot("W3__recommendation-card__site_widget__settled__column", "settled", "The row SETTLED IN PLACE in the same embedded column, composer in frame — same page load, same frame instance, same card instance that drew the held row. Nothing left to press.", { settledInPlace, reloadedBeforeReading: false, runStatusAtShutter: statusAfter }, "column");
  await shoot("H4__recommendation-card__site_widget__settled", "settled", "The same settled row on its own root.", { settledInPlace, reloadedBeforeReading: false, runStatusAtShutter: statusAfter }, "card");

  // ---- readbacks -----------------------------------------------------------
  state.decisionRows = await q(`select run_id, skill_id, selection_source, selected_at from cinatra.run_selected_skill_revisions where run_id = $1 order by skill_id`, [RUN_ID]);
  state.skipRows = await q(`select * from cinatra.run_recommendation_skips where run_id = $1`, [RUN_ID]);
  state.parkAfter = await q(`select id, checkpoint, status, event_id, created_at, resolved_at from cinatra.lifecycle_continuation_park where run_id = $1`, [RUN_ID]);
  state.usage = await q(`select provider, model, created_at from cinatra.usage_events where created_at > $1 order by created_at`, [startedAt.toISOString()]);
  state.offered = await q(`select * from cinatra.run_recommendation_offered_set where run_id = $1`, [RUN_ID]);
  say(`DECIDE OUTCOMES ${JSON.stringify(decideOutcomes)}`);
  say(`WIRE RESPONSES ${JSON.stringify(wireResponses)}`);
  say(`READBACK ${JSON.stringify(state)}`);
} catch (e) {
  say(`SEQUENCE ERROR: ${String(e?.stack ?? e).slice(0, 900)}`);
  state.error = String(e?.message ?? e).slice(0, 400);
} finally {
  writeFileSync(join(OUT, "widget-capture.txt"), log.join("\n"));
  writeFileSync(join(OUT, "capture-records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, "widget-wire.json"), JSON.stringify({ wire, wireResponses, decideOutcomes }, null, 2));
  writeFileSync(join(OUT, "state.json"), JSON.stringify(state, null, 2));
  await browser.close();
}
