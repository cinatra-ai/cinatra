// ---------------------------------------------------------------------------
// cinatra#2902 — the INLINE RUN PANEL'S SEED, photographed in the embedded
// column on a genuinely cross-site page.
//
// WHAT THE ROUND HAS TO SHOW, and each picture answers one half:
//   · the panel LOADS its run inside the widget — the pinned selectors present,
//     the failure line absent — with the seed request recorded: cookie ABSENT,
//     widget header PRESENT, 200;
//   · a run the credential does NOT bind is refused, with the same credential,
//     on the same screen, in the same conversation — the NEGATIVE CONTROL.
//
// CROSS-SITE, AND IT IS THE POINT. The app answers on `localhost` and the host
// page is served from the loopback IPv4 literal — different ORIGINS and
// different SITES (not the same registrable domain), so the app's
// `SameSite=Lax` session cookie cannot ride the embed. A host page on
// `localhost:<other port>` would look identical on screen and prove nothing.
// Both origins arrive from the ENVIRONMENT; neither host nor port is written in
// this file.
//
// THE WIRE IS RECORDED, NOT ASSERTED. The recorder notes every request to the
// seed route and to the embed document, reporting `cookie` and
// `x-cinatra-widget-user-token` as PRESENT/ABSENT — never by value — together
// with the response status. That log is the evidentiary payload beside the
// pixels, because "the panel drew" and "it drew from a credential-bound read"
// are two different claims.
//
// PICTURE FIRST, COUNTS SECOND — the recorder's standing rule: the screenshot is
// taken before anything is counted, so a record's counts can only ever be
// at-or-after what the picture shows.
//
// NO SECRET IS EVER WRITTEN OUT.
// ---------------------------------------------------------------------------
const __pwmod = await import(process.env.CAP_PLAYWRIGHT);
const pw = __pwmod.chromium ? __pwmod : __pwmod.default;
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HOST = process.env.CAP_HOST_PAGE_URL;   // the third-party page, another site
const REPO = process.env.CAP_REPO_ROOT;
const OUT = process.env.CAP_OUT_JSON;
const EMAIL = process.env.CAP_EMAIL;
const PW = process.env.CAP_PW;
const BOUND_RUN = process.env.CAP_BOUND_RUN_ID;
const UNBOUND_RUN = process.env.CAP_UNBOUND_RUN_ID;
const RUNTIME_NOTE = process.env.CAP_RUNTIME_NOTE ?? "";
for (const [k, v] of Object.entries({
  CAP_HOST_PAGE_URL: HOST, CAP_REPO_ROOT: REPO, CAP_OUT_JSON: OUT,
  CAP_EMAIL: EMAIL, CAP_PW: PW, CAP_BOUND_RUN_ID: BOUND_RUN, CAP_UNBOUND_RUN_ID: UNBOUND_RUN,
})) {
  if (!v) throw new Error(`missing ${k}`);
}

const SHOT_DIR_REL = "evidence/2902-widget-run-panel-seed/captures";
// The shared conversation column: the ONE element that carries the transcript
// list AND the primary composer. `/embed/assistant` mounts the very same
// component `/chat` does.
const COL =
  'div.relative.flex.min-h-0.flex-1.flex-col:has([data-conversation-list]):has([data-conformance-id="chat-composer-primary"])';
/** The one anchor that exists ONLY when the seed answered: the run-page link is
 *  built from `agentPackageName`, a field nothing but the seed response carries. */
const SEED_ONLY_ANCHOR = '[data-testid="inline-run-page-link"]';
const FAILURE_LINE = /Could not load agent run/i;

const log = [];
const say = (m) => { log.push(m); console.log(m); };
const results = [];

async function runSession({ dark, cells }) {
  // The frame's hosted-PKCE sign-in opens a POPUP, so the popup blocker is off:
  // without it the window never appears and the frame never mints its `cwu_`.
  const browser = await pw.chromium.launch({
    headless: true,
    args: ["--disable-popup-blocking"],
  });
  // NO storageState: an EMPTY cookie jar, so every cookie this context ever
  // holds was set by the app during this run and can be reported.
  const ctx = await browser.newContext({
    viewport: { width: 1228, height: 1500 },
    deviceScaleFactor: 2,
    colorScheme: dark ? "dark" : "light",
  });
  // The app's theme is next-themes with `attribute="class"` and NO
  // `enableSystem`, so `prefers-color-scheme` alone cannot flip it; the stored
  // choice is what does. Written in EVERY frame, which for a cross-site embed
  // means the frame's partitioned store.
  if (dark) {
    await ctx.addInitScript(() => { try { localStorage.setItem("theme", "dark"); } catch {} });
  }
  const page = await ctx.newPage();

  const wire = [];
  const noteRequest = (req, label) => {
    const h = req.headers();
    const entry = {
      label,
      method: req.method(),
      path: (() => { try { return new URL(req.url()).pathname; } catch { return "<unparsed>"; } })(),
      resourceType: req.resourceType(),
      cookie: h["cookie"] ? "PRESENT" : "absent",
      widgetUserToken: h["x-cinatra-widget-user-token"] ? "present (cwu_)" : "absent",
      widgetAssistant: h["x-cinatra-widget-assistant"] ?? null,
      widgetOrigin: h["x-cinatra-widget-origin"] ? "present" : "absent",
      secFetchSite: h["sec-fetch-site"] ?? null,
      status: null,
      redirectedTo: null,
    };
    wire.push(entry);
    return entry;
  };
  const pending = new Map();
  page.on("request", (req) => {
    const u = req.url();
    let label = null;
    if (/\/api\/agents\/runs\//.test(u)) label = "run-seed";
    else if (u.includes("/embed/assistant")) label = "embed-document";
    if (!label) return;
    pending.set(req, noteRequest(req, label));
  });
  page.on("response", async (res) => {
    const entry = pending.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    const loc = res.headers()["location"];
    if (loc) entry.redirectedTo = (() => { try { return new URL(loc, "http://x").pathname; } catch { return "<unparsed>"; } })();
  });

  const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
  const stripDevOverlay = async () => {
    for (const f of page.frames()) {
      await f.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
    }
  };

  say(`\n# session ${dark ? "DARK" : "LIGHT"} — ${new Date().toISOString()}`);
  // The host page's ORIGIN is described, never written out: it is the loopback
  // IPv4 literal on a port this file never names, and what matters about it is
  // that it is a different SITE from the app's `localhost` — not which port the
  // lane happened to bind.
  say(`# top-level page (NOT the Cinatra app): the loopback IPv4 literal on another port — a different SITE from the app's localhost origin; path ${new URL(HOST).pathname}`);
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 180_000 });
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
        say(`frame left the anonymous state after ~${(i + 1) * 2}s`); break;
      }
    }
  } else {
    say("frame already carried a session (unexpected on a fresh context)");
  }

  // THE COOKIE FACT, measured. The popup was a top-level window on the app
  // origin, so a real session cookie exists in this context — and it still
  // cannot ride the embed, because the top-level page is another SITE.
  const appCookies = (await ctx.cookies()).map((c) => ({
    name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly,
  }));
  say(`COOKIE JAR after sign-in: ${JSON.stringify(appCookies)}`);

  // --- one turn per cell, typed into the WIDGET's own composer --------------
  for (const cell of cells) {
    const composer = embedFrame().locator('[role="textbox"][contenteditable="true"]').first();
    await composer.waitFor({ state: "visible", timeout: 240_000 });
    await composer.click();
    await composer.type(cell.prompt, { delay: 12 });
    await stripDevOverlay();
    await composer.press("Enter");
    say(`turn sent into the widget composer: "${cell.prompt}"`);

    // Wait for the run card's own settled state — either the seeded panel or
    // the refusal line. Never a fixed sleep standing in for an outcome.
    for (let i = 0; i < 90; i += 1) {
      await page.waitForTimeout(2000);
      const settled = await embedFrame()?.evaluate(
        ({ anchor }) =>
          Boolean(document.querySelector(anchor)) ||
          /is not available yet|do not have access|cannot be shown here|Could not load agent run/i.test(
            document.body?.innerText ?? "",
          ),
        { anchor: SEED_ONLY_ANCHOR },
      ).catch(() => false);
      if (settled) { say(`${cell.cell}: the run card settled after ~${(i + 1) * 2}s`); break; }
    }
    await page.waitForTimeout(4000);
    await stripDevOverlay();

    // Scroll to the FOOT of the transcript so the newest card is in frame.
    await embedFrame().evaluate(() => {
      const l = document.querySelector("[data-conversation-list]");
      for (const el of [l, l?.closest("[class*=overflow]"), l?.parentElement, document.scrollingElement]) {
        if (el) el.scrollTop = el.scrollHeight;
      }
    }).catch(() => {});
    await page.waitForTimeout(2500);
    await stripDevOverlay();

    // ---- PICTURE FIRST ----------------------------------------------------
    const rel = `${SHOT_DIR_REL}/${cell.cell}.png`;
    const abs = path.join(REPO, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await embedFrame().locator(COL).first().screenshot({ path: abs, scale: "device" });

    // ---- COUNTS SECOND ----------------------------------------------------
    const f = embedFrame();
    const pageCounts = await page.evaluate(() => ({ ".cw-frame": document.querySelectorAll(".cw-frame").length }));
    const frameCounts = await f.evaluate(({ anchor }) => {
      const n = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
      const text = document.body?.innerText ?? "";
      return {
        '[data-embed-assistant][data-phase="active"]': n('[data-embed-assistant][data-phase="active"]'),
        "[data-conversation-list]": n("[data-conversation-list]"),
        '[data-conformance-id="chat-composer-primary"]': n('[data-conformance-id="chat-composer-primary"]'),
        "[data-transcript-slot]": n("[data-transcript-slot]"),
        [anchor]: n(anchor),
        // MEASURED, not assumed: the inline run panel is not a lifecycle card and
        // declares no `data-lifecycle-card-host`. The count is recorded so the
        // capture index's own contract is read against an OBSERVATION rather than
        // an argument.
        '[data-lifecycle-card-host="site_widget"]': n('[data-lifecycle-card-host="site_widget"]'),
        "text:Agentic Run Progress": (text.match(/Agentic Run Progress/g) ?? []).length,
        "text:Could not load agent run": (text.match(/Could not load agent run/g) ?? []).length,
        "text:is not available yet": (text.match(/is not available yet/g) ?? []).length,
      };
    }, { anchor: SEED_ONLY_ANCHOR });

    const measured = await f.evaluate(() => {
      const html = document.documentElement;
      return {
        theme: {
          htmlClass: html.className,
          colorScheme: getComputedStyle(html).colorScheme,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        },
        columnText: (document.querySelector("[data-conversation-list]")?.innerText ?? "")
          .replace(/\n{2,}/g, "\n").slice(-1800),
      };
    });

    const bytes = fs.readFileSync(abs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pixels = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    const frameUrl = (() => { const u = new URL(f.url()); return u.pathname + (u.search ? "?<frame disambiguators>" : ""); })();

    results.push({
      cell: cell.cell,
      declaredHost: "site_widget",
      declaredSubject: "inline_agent_run_panel",
      declaredState: cell.state,
      finalUrl: "<a third-party page on another site; see frameUrl>",
      frameUrl,
      screenshot: rel,
      sha256,
      pixels,
      dark: !!dark,
      framedOn: "the conversation column inside the embed frame",
      assertions: [
        { selector: ".cw-frame", scope: "page", count: pageCounts[".cw-frame"] },
        ...Object.entries(frameCounts).map(([selector, count]) => ({ selector, scope: "frame", count })),
      ],
      measured,
      // The wire SO FAR in this session, so a record carries the requests that
      // produced it rather than a session-wide total nobody can attribute.
      wire: wire.map((w) => ({ ...w })),
      cookieJar: appCookies,
      recordedBy: "cinatra-run-panel-seed-recorder@1",
      recordedAt: new Date().toISOString(),
      runtime: RUNTIME_NOTE,
      note: cell.note,
    });
    say(`CAP ${cell.cell} ${pixels.width}x${pixels.height} counts=${JSON.stringify(frameCounts)}`);
    say(`WIRE ${JSON.stringify(wire.filter((w) => w.label === "run-seed"))}`);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  await ctx.close();
  await browser.close();
}

const ONLY = (process.env.CAP_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const wanted = (cell) => ONLY.length === 0 || ONLY.some((o) => cell.startsWith(o));

const BOUND_CELL = (suffix, dark) => ({
  cell: `W${dark ? 3 : 1}__run-panel__site_widget__loaded${suffix}`,
  prompt: `Show me agent run ${BOUND_RUN}`,
  state: "loaded",
  note:
    `The inline run panel INSIDE the embedded cross-site widget column, ${dark ? "DARK" : "LIGHT"}: the panel drew its run from a seed the widget's own credential authorized. The run-page link is present, which only the seed response can produce (it is built from \`agentPackageName\`, a field nothing else carries), and the "Could not load agent run" line is absent. The seed request is in \`wire\`: cookie absent, widget user token present, 200.`,
});
const UNBOUND_CELL = (suffix, dark) => ({
  cell: `W${dark ? 4 : 2}__run-panel__site_widget__unbound-run${suffix}`,
  prompt: `Show me agent run ${UNBOUND_RUN}`,
  state: "refused",
  note:
    `NEGATIVE CONTROL, ${dark ? "DARK" : "LIGHT"}: the SAME credential, the SAME conversation, the SAME screen — and a run that lives in ANOTHER organization. The binding refuses it, the panel draws no run, and the column is otherwise unmoved (the loaded panel from the previous turn is still above it). The seed request for this run is in \`wire\` beside the successful one: cookie absent, widget user token present, and the branch's one uniform refusal status.`,
});

const lightCells = [BOUND_CELL("", false), UNBOUND_CELL("", false)].filter((c) => wanted(c.cell));
const darkCells = [BOUND_CELL("__dark", true), UNBOUND_CELL("__dark", true)].filter((c) => wanted(c.cell));

try {
  if (lightCells.length) await runSession({ dark: false, cells: lightCells });
  if (darkCells.length) await runSession({ dark: true, cells: darkCells });
  say("CAPTURE OK");
} catch (e) {
  say(`CAPTURE ERROR: ${e?.stack || e}`);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  fs.writeFileSync(process.env.CAP_LOG_FILE ?? "/dev/null", log.join("\n") + "\n");
  console.log("CELLS DONE:", results.length);
}
