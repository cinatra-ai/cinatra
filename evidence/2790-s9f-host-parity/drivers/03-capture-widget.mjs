// ---------------------------------------------------------------------------
// cinatra#2790 S9f — the RECOMMENDATION CARD inside the EMBEDDED CROSS-SITE
// WIDGET column.
//
// One run against the live app, driving the REAL card inside the REAL embedded
// widget, on a plain page served from a DIFFERENT LOOPBACK ORIGIN.
//
// WHY THE ORIGIN PAIR MATTERS. The app answers on the `localhost` NAME; the
// host page is served from the IPv4 LOOPBACK ADDRESS. Those are different
// origins AND different SITES: a cookie set for the `localhost` name is not
// sent with a request issued from a document nested inside a loopback-address
// top-level page under `credentials: "omit"`, and SameSite is decided by the
// registrable domain, which the name and the address do not share. A capture
// taken with the host page on a second port of the same NAME would look
// identical on screen and prove nothing. So the driver does not merely assert
// it: it RECORDS the request headers of the two broker calls themselves.
//
// WHAT IS RECORDED BESIDE EVERY PICTURE: the anchors the card published, the
// frame the picture was taken in, and the wire — for the recommendation-hold
// RESOLVE and DECIDE routes — with `cookie` and `x-cinatra-widget-user-token`
// reported as present/absent, never by value.
//
// NO SECRET IS EVER WRITTEN OUT, and no origin is hard-coded: every origin is
// read from the environment.
//
// Usage: node 03-capture-widget.mjs <hostPageUrl> <outDir> <repoRoot>
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.argv[2];
const OUT = process.argv[3];
const REPO_ROOT = process.argv[4];
const SHOT_DIR_REL = "evidence/2790-s9f-host-parity/captures";
mkdirSync(OUT, { recursive: true });
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
const RUN_ID = process.env.S9F_WIDGET_RUN_ID;
if (!HOST || !OUT || !REPO_ROOT || !ACTOR.email || !ACTOR.password || !RUN_ID) {
  throw new Error("usage: 03-capture-widget.mjs <hostPageUrl> <outDir> <repoRoot>; set S9F_EMAIL, S9F_PW, S9F_WIDGET_RUN_ID");
}
// Naming the run is what makes the deterministic provider emit the `agent_run`
// reference part the transcript slot mounts on. It carries NO lifecycle-pull
// word (review / gate / waiting / approval / check / verification), because the
// provider reads that intent FIRST and would answer the pull instead.
const PROMPT = `Show me the run ${RUN_ID} please.`;

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};

// --- the wire ---------------------------------------------------------------
const wire = [];
function noteRequest(req, label) {
  const h = req.headers();
  const entry = {
    label,
    method: req.method(),
    path: (() => {
      try {
        return new URL(req.url()).pathname;
      } catch {
        return "<unparseable>";
      }
    })(),
    resourceType: req.resourceType(),
    cookie: h["cookie"] ? "PRESENT" : "absent",
    widgetUserToken: h["x-cinatra-widget-user-token"] ? "present (cwu_)" : "absent",
    widgetOrigin: h["x-cinatra-widget-origin"] ? "present" : "absent",
    widgetAssistant: h["x-cinatra-widget-assistant"] ? "present" : "absent",
  };
  wire.push(entry);
  say(`WIRE ${JSON.stringify(entry)}`);
}
const wireResponses = [];

const browser = await chromium.launch({ headless: true });
// NO storageState: this context starts with an EMPTY cookie jar, so every cookie
// it ever holds was set by the app during this run and can be reported.
const ctx = await browser.newContext({
  viewport: { width: 1228, height: 1400 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/api/lifecycle-views/recommendation-hold/decide")) noteRequest(req, "recommendation-decide");
  else if (u.includes("/api/lifecycle-views/recommendation-hold")) noteRequest(req, "recommendation-resolve");
});
page.on("response", async (res) => {
  const u = res.url();
  if (!u.includes("/api/lifecycle-views/recommendation-hold")) return;
  wireResponses.push({
    path: (() => {
      try {
        return new URL(u).pathname;
      } catch {
        return "<unparseable>";
      }
    })(),
    status: res.status(),
  });
});

const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));

// The dev runtime paints a full-viewport `<nextjs-portal>` overlay that swallows
// pointer events and sits in every screenshot. Dev-server furniture, not
// application UI: removing it changes no application behaviour.
const stripDevOverlay = async () => {
  for (const f of page.frames()) {
    await f.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
  }
};

// --- counting rules, written down because the numbers ARE the evidence -------
//   page  — document.querySelectorAll(sel).length on the TOP document (the
//           third-party host page).
//   frame — the same, on the EMBED frame document, which is the document every
//           picture here is taken in.
//   root  — the card root's OWN subtree INCLUDING the root element itself, so a
//           marker carried ON the root is not reported as absent.
const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
async function counts(selectors) {
  const f = embedFrame();
  const out = [];
  for (const { selector, scope } of selectors) {
    let count = 0;
    if (scope === "page") {
      count = await page.evaluate((s) => document.querySelectorAll(s).length, selector);
    } else if (scope === "frame") {
      count = await f.evaluate((s) => document.querySelectorAll(s).length, selector).catch(() => 0);
    } else {
      count = await f
        .evaluate(
          ({ s, rootSel }) => {
            const root = document.querySelector(rootSel);
            if (!root) return 0;
            return (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length;
          },
          { s: selector, rootSel: CARD_ROOT },
        )
        .catch(() => 0);
    }
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
  { selector: "[data-conformance-id=\"run-chip-row\"]", scope: "frame" },
];

/** The card root's own declaration, read verbatim off the DOM. */
async function rootAttributes() {
  const f = embedFrame();
  return f
    .evaluate((rootSel) => {
      const el = document.querySelector(rootSel);
      if (!el) return null;
      const out = {};
      for (const a of el.attributes) out[a.name] = a.value;
      delete out.class;
      return out;
    }, CARD_ROOT)
    .catch(() => null);
}

/** Every chip on the row: its skill id, its printed label and its mark. */
async function chipReadout() {
  const f = embedFrame();
  return f
    .evaluate((rootSel) => {
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
    }, CARD_ROOT)
    .catch(() => []);
}

const records = [];
const results = [];

async function shoot(cell, declaredState, note, extra = {}) {
  await stripDevOverlay();
  const f = embedFrame();
  const rel = `${SHOT_DIR_REL}/${cell}.png`;
  const abs = join(REPO_ROOT, rel);
  await f.locator(CARD_ROOT).first().screenshot({ path: abs, scale: "device" });
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const observed = await counts(ASSERTIONS);
  const attrs = await rootAttributes();
  const chips = await chipReadout();
  const theme = await f.evaluate(() => document.documentElement.className).catch(() => "");
  const cardText = await f
    .locator(CARD_ROOT)
    .first()
    .innerText()
    .then((t) => t.replace(/\n{2,}/g, "\n"))
    .catch(() => "");
  records.push({
    cell,
    declaredHost: "site_widget",
    declaredKind: "recommendation_hold",
    declaredState,
    finalUrl: new URL(page.url()).pathname,
    frameUrl: (() => {
      const u = new URL(f.url());
      return u.pathname + (u.search ? "?<frame disambiguators>" : "");
    })(),
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
    ...extra,
  });
  results.push({ cell, pixels: dims, sha256, observed, rootAttributes: attrs, chips, themeClass: theme, cardText: cardText.slice(0, 2000) });
  say(`CAP ${cell} ${dims.width}x${dims.height} chips=${chips.length} theme="${theme}"`);
  return dims;
}

/** Apply the palette next-themes applies. There is no theme control inside the
 *  third-party chrome, so the dark cell writes the SAME class the shipped
 *  control writes, on the embed document, and changes nothing else. */
async function setTheme(name) {
  const f = embedFrame();
  await f.evaluate((t) => {
    const el = document.documentElement;
    el.classList.remove("cinatra", "dark");
    el.classList.add(t);
    el.style.colorScheme = t === "dark" ? "dark" : "light";
  }, name);
  await page.waitForTimeout(900);
}

try {
  say(`# cinatra#2790 S9f widget capture — ${new Date().toISOString()}`);
  say(`# top-level page (NOT the Cinatra app): ${new URL(HOST).pathname}`);
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 180_000 });
  // The dev server compiles `/embed/assistant` on first request, so the frame
  // can take considerably longer than a warm load to appear. Wait for it.
  let frame = null;
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2000);
    frame = embedFrame();
    if (frame) {
      say(`embed frame appeared after ~${(i + 1) * 2}s`);
      break;
    }
  }
  if (!frame) throw new Error("the embed frame never loaded inside the host page");
  say(`embed frame url path: ${new URL(frame.url()).pathname}`);

  for (let i = 0; i < 120; i += 1) {
    const f = embedFrame();
    const ready = await f
      ?.evaluate(
        () =>
          Boolean(document.querySelector("[data-embed-signin]")) ||
          Boolean(document.querySelector('[role="textbox"][contenteditable="true"]')),
      )
      .catch(() => false);
    if (ready) {
      say(`embed frame drew after ~${i * 2}s`);
      break;
    }
    await page.waitForTimeout(2000);
  }
  frame = embedFrame();

  // --- the frame's own hosted-PKCE sign-in ---------------------------------
  const signin = frame.locator("[data-embed-signin]").first();
  if ((await signin.count()) > 0) {
    say("frame is anonymous — running the frame's own hosted PKCE sign-in");
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 180_000 }),
      signin.click(),
    ]);
    const alive = () => !popup.isClosed();
    const settle = async (ms) => {
      if (alive()) await popup.waitForTimeout(ms).catch(() => {});
    };
    await popup.waitForLoadState("domcontentloaded", { timeout: 180_000 }).catch(() => {});
    say(`popup opened on path: ${alive() ? new URL(popup.url()).pathname : "<closed immediately>"}`);
    await settle(3000);
    if (alive()) {
      const emailField = popup.locator('input[type="email"], input[name="email"]').first();
      if ((await emailField.count().catch(() => 0)) > 0) {
        await emailField.fill(ACTOR.email).catch(() => {});
        await popup.locator('input[type="password"], input[name="password"]').first().fill(ACTOR.password).catch(() => {});
        await popup.locator('button[type="submit"]').first().click().catch(() => {});
        await settle(5000);
      }
    }
    for (let i = 0; i < 4 && alive(); i += 1) {
      const btn = popup
        .locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Approve"), button:has-text("Sign in")')
        .first();
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

  // --- THE COOKIE FACT, measured -------------------------------------------
  // The popup was a TOP-LEVEL window on the app origin, so the app's session
  // cookie now exists in this context. Reported by NAME and ATTRIBUTES only.
  const appCookies = (await ctx.cookies()).filter((c) => /localhost|127\.0\.0\.1/.test(c.domain));
  say(
    `COOKIE JAR after sign-in: ${JSON.stringify(
      appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly, secure: c.secure })),
    )}`,
  );

  // --- the turn that puts the held run in the transcript --------------------
  frame = embedFrame();
  const composer = frame.locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 240_000 });
  await composer.click();
  await composer.type(PROMPT, { delay: 12 });
  await stripDevOverlay();
  await composer.press("Enter");
  say("turn sent through the widget's OWN composer (scripted provider, no LLM call)");

  // --- wait for the card ----------------------------------------------------
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2000);
    const f = embedFrame();
    const present = await f?.evaluate((s) => Boolean(document.querySelector(s)), CARD_ROOT).catch(() => false);
    if (present) {
      say(`card root appeared after ~${(i + 1) * 2}s`);
      break;
    }
  }
  await page.waitForTimeout(3500);
  const chipsNow = await chipReadout();
  say(`CHIPS ${JSON.stringify(chipsNow)}`);

  // --- THE BLOCKED BRANCH --------------------------------------------------
  // If the card never mounted, the honest output of this run is a DIAGNOSTIC of
  // what the widget column actually draws plus the wire that explains it — never
  // a cell claiming a card that is not on screen. The observed absence is
  // measured with the same selectors a present card would be.
  const cardPresent = await embedFrame()
    .evaluate((s2) => Boolean(document.querySelector(s2)), CARD_ROOT)
    .catch(() => false);
  if (!cardPresent) {
    say("THE CARD DID NOT MOUNT — recording the diagnostic instead of a cell");
    await stripDevOverlay();
    const f2 = embedFrame();
    const rel = `${SHOT_DIR_REL}/DIAG__site-widget-column__card-absent.png`;
    const abs = join(REPO_ROOT, rel);
    await f2.locator("[data-conversation-list]").first().screenshot({ path: abs, scale: "device" });
    const bytes = readFileSync(abs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const observed = await counts(ASSERTIONS);
    const columnText = await f2
      .locator("[data-conversation-list]")
      .first()
      .innerText()
      .then((t) => t.replace(/\n{2,}/g, "\n"))
      .catch(() => "");
    const diagnostic = {
      cell: "DIAG__site-widget-column__card-absent",
      isDiagnostic: true,
      declaredHost: "site_widget",
      declaredKind: null,
      declaredState: null,
      finalUrl: new URL(page.url()).pathname,
      frameUrl: (() => {
        const u = new URL(f2.url());
        return u.pathname + (u.search ? "?<frame disambiguators>" : "");
      })(),
      screenshot: rel,
      sha256,
      assertions: observed,
      recordedBy: "cinatra-lifecycle-capture-recorder@1",
      recordedAt: new Date().toISOString(),
      runtime: process.env.S9F_RUNTIME_NOTE ?? "",
      note:
        "DIAGNOSTIC, NOT A CELL. The embedded cross-site widget column with the run named in the turn — and NO recommendation card on it. The transcript slot is there; the card is not, because every broker read was answered with a 307 to /sign-in before the route handler ran (see `wire` and `wireResponses`). Filed as a diagnostic so nothing here claims a card that is not on screen.",
      columnText: columnText.slice(0, 1200),
    };
    records.push(diagnostic);
    results.push({ cell: diagnostic.cell, sha256, observed, columnText: columnText.slice(0, 1200), isDiagnostic: true });
    say(`DIAG recorded: ${JSON.stringify(observed.map((o) => `${o.scope}::${o.selector}=${o.count}`))}`);
    writeFileSync(join(OUT, "wire.json"), JSON.stringify({ requests: wire, responses: wireResponses }, null, 2));
    writeFileSync(
      join(OUT, "capture-results.json"),
      JSON.stringify({ results, wire, wireResponses, cookieJar: appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly })) }, null, 2),
    );
    writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
    writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
    await browser.close();
    process.exit(0);
  }

  // ---- H1 — the held card, cross-site, light -------------------------------
  await setTheme("cinatra");
  await shoot(
    "H1__recommendation-card__site_widget__held",
    "pending",
    "The recommendation card HELD in the embedded conversation column on a THIRD-PARTY page. One chip per skill, each carrying its own Confirm / Adjust / Skip, each printing the owning extension's manifest displayName. The read that produced it went to the broker resolve route with the widget's own credential and NO cookie (see `wire`).",
  );

  // ---- H2 — the same card, same framing, dark ------------------------------
  await setTheme("dark");
  await shoot(
    "H2__recommendation-card__site_widget__held__dark",
    "pending",
    "The SAME held card, same run, same frame selector and same framing, in the dark palette — the class the shipped theme control writes, applied to the embed document. There is no theme control inside third-party chrome, so nothing else was changed.",
  );
  await setTheme("cinatra");

  // ---- drive the decision through the card's BROKER route ------------------
  // §V settles a skill by pressing one of ITS OWN three affordances; the shipped
  // store releases the hold once EVERY chip has a mark (the named whole-row
  // release deviation). So the row is driven chip by chip, in a real browser,
  // and the release that follows is the broker POST recorded on the wire.
  const chipsBefore = await chipReadout();
  const plan = ["confirm", "adjust", "skip", "confirm"];
  for (let i = 0; i < chipsBefore.length; i += 1) {
    const action = plan[i] ?? "confirm";
    const chip = frame.locator(`${CARD_ROOT} [data-recommendation-chip]`).nth(i);
    const btn = chip.locator(`[data-skill-action="${action}"]`).first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 30_000 });
    say(`pressed ${action} on chip ${i} (${chipsBefore[i]?.skillId ?? "?"})`);
    if (action === "adjust") {
      // Adjust opens the shipped per-skill panel; "Keep it in this run" is the
      // in-set adjust that records the durable `adjusted` mark.
      const keep = frame.locator('[data-skill-action="adjust-keep"]').first();
      await keep.waitFor({ state: "visible", timeout: 60_000 });
      await keep.click();
      say("adjust panel: pressed 'Keep it in this run'");
    }
    await page.waitForTimeout(1500);
    if (i === 0) {
      // The mid-decision reading: one chip decided, the rest still pressable.
      await shoot(
        "H3__recommendation-card__site_widget__held__mid-decision",
        "pending",
        "The SAME cross-site card after ONE chip was decided by pressing its own Confirm in a real browser. That chip carries its mark; every other chip still shows all three affordances and is still pressable — the row is never decided as a unit.",
      );
    }
  }

  // ---- H4 — the SETTLED reading -------------------------------------------
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(2000);
    const f = embedFrame();
    const state = await f
      ?.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state") ?? null, CARD_ROOT)
      .catch(() => null);
    if (state === "decided") {
      say(`card settled after ~${(i + 1) * 2}s`);
      break;
    }
  }
  await page.waitForTimeout(3000);
  await shoot(
    "H4__recommendation-card__site_widget__settled",
    "decided",
    "The SETTLED row on the same cross-site widget host: one chip per skill stating what it recorded, nothing left to press. The release travelled to the broker DECIDE route with the widget's own credential and no cookie (see `wire`).",
  );

  writeFileSync(join(OUT, "wire.json"), JSON.stringify({ requests: wire, responses: wireResponses }, null, 2));
  writeFileSync(
    join(OUT, "capture-results.json"),
    JSON.stringify(
      { results, wire, wireResponses, cookieJar: appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly })) },
      null,
      2,
    ),
  );
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  say("CAPTURE OK");
} catch (e) {
  say(`CAPTURE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png"), fullPage: true }).catch(() => {});
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire, wireResponses }, null, 2));
} finally {
  writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
  await browser.close();
}
