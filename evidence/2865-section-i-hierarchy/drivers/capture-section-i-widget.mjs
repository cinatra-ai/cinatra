// ---------------------------------------------------------------------------
// cinatra#2865 — the §I recorder for the WIDGET cells (I4 light / I5 dark).
//
// WHAT THIS ROUND ADDS, and why it exists at all. The previous round delivered
// the §I input hierarchy on `/chat` (I1–I3) and WITHHELD the widget pair,
// writing that the embedded column "would not authenticate on this lane". That
// diagnosis was wrong. The frame sat at `data-phase="signin"` and its own
// hosted-PKCE popup died because THE LANE HAD NEVER PROVISIONED THE WIDGET —
// no `instances[]` row, no connect-site — not because the ceremony is
// unavailable here. `drivers/seed-widget-site.test.ts` writes both rows through
// the two SHIPPED writers the CMS OAuth exchange itself calls and asserts
// `deriveFrameBinding` closes; with that done the same popup completes and the
// frame mints its own `cwu_`. The recipe of record is
// `evidence/2754-island-wire/README.md`, which this follows rather than
// reinvents.
//
// CROSS-SITE, AND IT IS THE POINT. The app answers on one loopback origin and
// the host page is served from ANOTHER — `localhost` vs `127.0.0.1`, which are
// different ORIGINS and different SITES (not the same registrable domain), so
// the app's `SameSite=Lax` session cookie cannot ride the embed. A host page on
// `localhost:<other port>` would look identical on screen and prove nothing.
// Both origins arrive from the ENVIRONMENT; no port is written in this file.
//
// PICTURE FIRST, COUNTS SECOND — the same rule the /chat recorder states: the
// screenshot is taken before anything is counted, so a record's counts can only
// ever be at-or-after what the picture shows.
//
// FRAMED ON THE CONVERSATION COLUMN INSIDE THE EMBED FRAME — the element
// carrying both the transcript list and the widget's OWN primary composer —
// scrolled to the foot of the transcript, so the card's subordinate note field
// and that composer are in ONE frame. Identical framing across the pair.
//
// NO SECRET IS EVER WRITTEN OUT. Cookies and widget tokens are reported
// present/absent, never by value.
// ---------------------------------------------------------------------------
// The module may be CJS-interop (a bare ) or native ESM; take whichever
// half actually carries .
const __pwmod = await import(process.env.CAP_PLAYWRIGHT);
const pw = __pwmod.chromium ? __pwmod : __pwmod.default;
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const APP = process.env.CAP_BASE;            // the app's loopback origin
const HOST = process.env.CAP_HOST_PAGE_URL;  // the third-party page, another site
const REPO = process.env.CAP_REPO_ROOT;
const OUT = process.env.CAP_OUT_JSON;
const EMAIL = process.env.CAP_EMAIL;
const PW = process.env.CAP_PW;
const RUNTIME_NOTE = process.env.CAP_RUNTIME_NOTE ?? "";
for (const [k, v] of Object.entries({ CAP_BASE: APP, CAP_HOST_PAGE_URL: HOST, CAP_REPO_ROOT: REPO, CAP_OUT_JSON: OUT, CAP_EMAIL: EMAIL, CAP_PW: PW })) {
  if (!v) throw new Error(`missing ${k}`);
}

const PROMPT = "Is there a review gate waiting for my approval?";
const SHOT_DIR_REL = "evidence/2865-section-i-hierarchy/captures";
const CARD = '[data-conformance-id="review-gate-card"]';
// The shared conversation column: the ONE element that carries the transcript
// list AND the primary composer. `/embed/assistant` mounts the very same
// component `/chat` does, which is why the widget's composer is primary by
// construction rather than by a second opt-in.
const COL = 'div.relative.flex.min-h-0.flex-1.flex-col:has([data-conversation-list]):has([data-conformance-id="chat-composer-primary"])';

const log = [];
const say = (m) => { log.push(m); console.log(m); };

const results = [];

async function runCell({ cell, dark, note }) {
  const browser = await pw.chromium.launch({ headless: true });
  // NO storageState: an EMPTY cookie jar, so every cookie this context ever
  // holds was set by the app during this run and can be reported.
  const ctx = await browser.newContext({
    viewport: { width: 1228, height: 1400 },
    deviceScaleFactor: 2,
    colorScheme: dark ? "dark" : "light",
  });
  // The app's theme is next-themes with `attribute="class"`, themes
  // ["cinatra","dark"], and NO `enableSystem` — so `prefers-color-scheme` alone
  // cannot flip it; the stored choice is what does. Written in EVERY frame,
  // which for a cross-site embed means the frame's partitioned store.
  if (dark) {
    await ctx.addInitScript(() => { try { localStorage.setItem("theme", "dark"); } catch {} });
  }
  const page = await ctx.newPage();

  const wire = [];
  page.on("request", (req) => {
    const u = req.url();
    if (!u.includes("/api/lifecycle-views/") && !u.includes("/embed/assistant")) return;
    const h = req.headers();
    wire.push({
      label: u.includes("/embed/assistant") ? "embed-document" : "lifecycle-resolve",
      method: req.method(),
      path: (() => { try { return new URL(u).pathname; } catch { return "<unparsed>"; } })(),
      resourceType: req.resourceType(),
      cookie: h["cookie"] ? "PRESENT" : "absent",
      widgetUserToken: h["x-cinatra-widget-user-token"] ? "present (cwu_)" : "absent",
      widgetOrigin: h["x-cinatra-widget-origin"] ? "present" : "absent",
      secFetchSite: h["sec-fetch-site"] ?? null,
    });
  });

  const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
  const stripDevOverlay = async () => {
    for (const f of page.frames()) {
      await f.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
    }
  };

  say(`\n# ${cell} — ${dark ? "DARK" : "LIGHT"} — ${new Date().toISOString()}`);
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 180_000 });
  // The frame is created by the host page's own script and then has to compile
  // and answer, so it is WAITED FOR rather than assumed after a fixed pause.
  for (let i = 0; i < 90 && !embedFrame(); i += 1) await page.waitForTimeout(2000);
  if (!embedFrame()) throw new Error("the embed frame never loaded inside the host page");
  say("embed frame present");

  for (let i = 0; i < 120; i += 1) {
    const ready = await embedFrame()?.evaluate(() =>
      Boolean(document.querySelector("[data-embed-signin]")) ||
      Boolean(document.querySelector('[role="textbox"][contenteditable="true"]')),
    ).catch(() => false);
    if (ready) { say(`embed frame drew after ~${i * 2}s`); break; }
    await page.waitForTimeout(2000);
  }

  // --- the frame's OWN hosted-PKCE sign-in ---------------------------------
  // Nothing is injected into the context: the frame opens its own popup, the
  // popup is a top-level window on the APP origin, and the frame mints `cwu_`.
  const signin = embedFrame().locator("[data-embed-signin]").first();
  if ((await signin.count()) > 0) {
    say("frame is anonymous — running the frame's own hosted PKCE sign-in");
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 180_000 }),
      signin.click(),
    ]);
    const alive = () => !popup.isClosed();
    const settle = async (ms) => { if (alive()) await popup.waitForTimeout(ms).catch(() => {}); };
    await popup.waitForLoadState("domcontentloaded", { timeout: 180_000 }).catch(() => {});
    say(`popup opened on path: ${alive() ? new URL(popup.url()).pathname : "<closed immediately>"}`);
    await settle(3000);
    if (alive()) {
      const emailField = popup.locator('input[type="email"], input[name="email"]').first();
      if ((await emailField.count().catch(() => 0)) > 0) {
        await emailField.fill(EMAIL).catch(() => {});
        await popup.locator('input[type="password"], input[name="password"]').first().fill(PW).catch(() => {});
        await popup.locator('button[type="submit"]').first().click().catch(() => {});
        await settle(6000);
      }
    }
    for (let i = 0; i < 5 && alive(); i += 1) {
      const btn = popup.locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Authorize"), button:has-text("Sign in")').first();
      if ((await btn.count().catch(() => 0)) === 0) break;
      await btn.click({ timeout: 20_000 }).catch(() => {});
      await settle(3000);
    }
    if (alive()) await popup.waitForEvent("close", { timeout: 120_000 }).catch(() => {});
    say(`popup closed: ${popup.isClosed()}`);

    for (let i = 0; i < 90; i += 1) {
      await page.waitForTimeout(2000);
      const f = embedFrame();
      if (!f) continue;
      const stillAnonymous = await f.evaluate(() => Boolean(document.querySelector("[data-embed-signin]"))).catch(() => true);
      const text = await f.evaluate(() => document.body?.innerText?.slice(0, 120) ?? "").catch(() => "");
      if (!stillAnonymous && !/Waiting for the Cinatra sign-in/i.test(text)) {
        say(`frame left the anonymous state after ~${(i + 1) * 2}s`);
        break;
      }
    }
  } else {
    say("frame already carried a session (unexpected on a fresh context)");
  }

  // THE COOKIE FACT, measured. The popup was a top-level window on the app
  // origin, so a real session cookie exists in this context — and it still
  // cannot ride the embed, because the top-level page is another SITE.
  const appCookies = (await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly }));
  say(`COOKIE JAR after sign-in: ${JSON.stringify(appCookies)}`);

  // --- the turn that pulls the review card, typed into the WIDGET's own box --
  const composer = embedFrame().locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 240_000 });
  await composer.click();
  await composer.type(PROMPT, { delay: 15 });
  await stripDevOverlay();
  await composer.press("Enter");
  say(`turn sent into the widget composer: "${PROMPT}" (scripted provider names the primitive; the REAL self-MCP dispatch mints the envelope)`);

  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2000);
    const present = await embedFrame()?.evaluate((s) => Boolean(document.querySelector(s)), CARD).catch(() => false);
    if (present) { say(`card root appeared after ~${(i + 1) * 2}s`); break; }
  }
  await page.waitForTimeout(9000);
  await stripDevOverlay();

  // Scroll to the FOOT of the transcript so the card's note field and the
  // composer are in the same frame.
  await embedFrame().evaluate(() => {
    const l = document.querySelector("[data-conversation-list]");
    for (const el of [l, l?.closest("[class*=overflow]"), l?.parentElement, document.scrollingElement]) {
      if (el) el.scrollTop = el.scrollHeight;
    }
  }).catch(() => {});
  await page.waitForTimeout(3000);
  await stripDevOverlay();

  // ---- PICTURE FIRST -------------------------------------------------------
  const rel = `${SHOT_DIR_REL}/${cell}.png`;
  const abs = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await embedFrame().locator(COL).first().screenshot({ path: abs, scale: "device" });

  // ---- COUNTS SECOND -------------------------------------------------------
  const f = embedFrame();
  const pageCounts = await page.evaluate(() => ({ ".cw-frame": document.querySelectorAll(".cw-frame").length }));
  const frameCounts = await f.evaluate(() => {
    const n = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
    return {
      '[data-embed-assistant][data-phase="active"]': n('[data-embed-assistant][data-phase="active"]'),
      "[data-conversation-list]": n("[data-conversation-list]"),
      '[data-lifecycle-card-host="site_widget"]': n('[data-lifecycle-card-host="site_widget"]'),
      '[data-lifecycle-card="artifact_review_gate"]': n('[data-lifecycle-card="artifact_review_gate"]'),
      '[data-conformance-id="chat-composer-primary"]': n('[data-conformance-id="chat-composer-primary"]'),
      '[data-conformance-id="review-note-field-subordinate"]': n('[data-conformance-id="review-note-field-subordinate"]'),
      '[data-conformance-id="review-composer-bound"]': n('[data-conformance-id="review-composer-bound"]'),
      '[data-conformance-id="review-composer-unbound"]': n('[data-conformance-id="review-composer-unbound"]'),
      '[data-lifecycle-card="recommendation_hold"]': n('[data-lifecycle-card="recommendation_hold"]'),
      "[data-skill-action]": n("[data-skill-action]"),
    };
  });
  const rootCounts = await f.evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    const n = (s) => (root ? (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length : 0);
    return {
      '[data-conformance-id="review-decision-bar"]': n('[data-conformance-id="review-decision-bar"]'),
      "[data-lifecycle-card-state]": n("[data-lifecycle-card-state]"),
      '[data-conformance-id="review-note-field-subordinate"]': n('[data-conformance-id="review-note-field-subordinate"]'),
    };
  }, '[data-lifecycle-card="artifact_review_gate"]');

  // The measured weight difference, and the measured THEME — read back inside
  // the embed frame, which is the document the picture was taken in.
  const measured = await f.evaluate(() => {
    const html = document.documentElement;
    const note = document.querySelector('[data-conformance-id="review-note-field-subordinate"]');
    const ta = note ? note.querySelector("textarea") : null;
    const comp = document.querySelector('[data-conformance-id="chat-composer-primary"]');
    const cs = (e) => (e ? getComputedStyle(e) : null);
    const nb = cs(ta);
    const cb = cs(comp);
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; };
    return {
      theme: { htmlClass: html.className, colorScheme: getComputedStyle(html).colorScheme, bodyBg: getComputedStyle(document.body).backgroundColor },
      noteStyle: nb ? { borderBottomStyle: nb.borderBottomStyle, borderTopWidth: nb.borderTopWidth, borderBottomWidth: nb.borderBottomWidth, background: nb.backgroundColor, boxShadow: nb.boxShadow, disabled: !!(ta && ta.disabled) } : null,
      composerStyle: cb ? { borderStyle: cb.borderStyle, borderWidth: cb.borderWidth, borderColor: cb.borderColor, background: cb.backgroundColor, boxShadow: cb.boxShadow } : null,
      geometry: { note: box(ta), composer: box(comp) },
      cardText: (document.querySelector('[data-conformance-id="review-gate-card"]')?.innerText ?? "").replace(/\n{2,}/g, "\n").slice(0, 1600),
    };
  });

  const bytes = fs.readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pixels = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };

  const assertions = [
    { selector: ".cw-frame", scope: "page", count: pageCounts[".cw-frame"] },
    ...Object.entries(frameCounts).map(([selector, count]) => ({ selector, scope: "frame", count })),
    ...Object.entries(rootCounts).map(([selector, count]) => ({ selector, scope: "root", count })),
  ];

  const frameUrl = (() => { const u = new URL(f.url()); return u.pathname + (u.search ? "?<frame disambiguators>" : ""); })();
  const record = {
    cell,
    declaredHost: "site_widget",
    declaredKind: "artifact_review_gate",
    declaredState: "pending",
    finalUrl: "<a third-party page on another site; see frameUrl>",
    frameUrl,
    screenshot: rel,
    sha256,
    assertions,
    recordedBy: "cinatra-lifecycle-capture-recorder@1",
    recordedAt: new Date().toISOString(),
    runtime: RUNTIME_NOTE,
    note,
  };
  results.push({ record, pixels, dark: !!dark, framedOn: "the conversation column inside the embed frame", measured, wire });
  say(`CAP ${cell} ${pixels.width}x${pixels.height} theme=${JSON.stringify(measured.theme)}`);
  say(`COUNTS frame=${JSON.stringify(frameCounts)} root=${JSON.stringify(rootCounts)}`);
  // Written after EVERY cell, so a failure on a later cell cannot discard the
  // record of one already photographed.
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  await ctx.close();
  await browser.close();
}

const ONLY = (process.env.CAP_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const wanted = (cell) => ONLY.length === 0 || ONLY.some((o) => cell.startsWith(o));

if (wanted("I4")) await runCell({
  cell: "I4__review-card__site_widget__pending",
  dark: false,
  note: "§I input hierarchy inside the EMBEDDED CROSS-SITE widget column, LIGHT: a real held review card whose subordinate note field (dashed baseline, no box) and the widget's OWN primary composer are in one frame, on a page served by another site.",
});
if (wanted("I5")) await runCell({
  cell: "I5__review-card__site_widget__pending__dark",
  dark: true,
  note: "§I input hierarchy inside the EMBEDDED CROSS-SITE widget column, DARK: the same two inputs and the same weight difference on the dark field; the record carries the theme read-back measured inside the embed frame.",
});

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
fs.writeFileSync(process.env.CAP_LOG_FILE ?? "/dev/null", log.join("\n") + "\n");
console.log("WIDGET CELLS DONE:", results.length);
