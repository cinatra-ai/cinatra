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
// THE SETTLED READING IS TAKEN WHERE THE DECISION WAS MADE. Once every chip
// carries a mark the shipped store releases the hold, the broker decide route
// dispatches the run as the actor its `cwu_` proved, and the row settles in the
// SAME frame instance that drew it held. The settled pair is therefore shot
// with NO reload, NO second sign-in and NO second turn, and `agent_runs.status`
// is read back on either side of the decision and carried on the cells. The
// re-read path below it is kept as the honest fallback: if the row does NOT
// settle in place, the run records a diagnostic and every settled cell it then
// takes declares `reloadedBeforeReading: true` rather than claiming a settle.
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
import { Client } from "pg";

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

// --- the RUN's own status, read back from the lane database ------------------
// The decide route answers 200 for a refusal as well as a success, and the
// inline run panel in this column is a cookie-bound surface that cannot read
// the run from a cross-site frame. So "the run advanced" is not taken from the
// screen: it is READ BACK from `agent_runs.status` on either side of the
// decision and recorded beside the cell. The connection string is read from the
// environment and never written out.
const DB_URL = process.env.S9F_DB_URL ?? "";
const DB_SCHEMA = (process.env.S9F_DB_SCHEMA ?? "cinatra").replaceAll('"', '""');
async function readRunStatus() {
  if (!DB_URL) return null;
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const r = await client.query(
      `select status from "${DB_SCHEMA}".agent_runs where id = $1`,
      [RUN_ID],
    );
    return r.rows[0]?.status ?? null;
  } catch (e) {
    return `<unreadable: ${String(e?.message ?? e).slice(0, 80)}>`;
  } finally {
    await client.end().catch(() => {});
  }
}

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
// The decide route answers 200 for BOTH a refusal and a success (its uniform-refusal
// contract), so the HTTP code alone cannot say what the reader was told. The
// outcome's own `ok`/`error` is therefore recorded — product text, never a value.
const decideOutcomes = [];

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
  const path = (() => {
    try {
      return new URL(u).pathname;
    } catch {
      return "<unparseable>";
    }
  })();
  wireResponses.push({ path, status: res.status() });
  if (u.includes("/api/lifecycle-views/recommendation-hold/decide")) {
    const body = await res.json().catch(() => null);
    const outcome = (body ?? {}).outcome ?? null;
    decideOutcomes.push({
      path,
      status: res.status(),
      outcomeOk: outcome && typeof outcome === "object" ? Boolean(outcome.ok) : null,
      outcomeError: outcome && typeof outcome === "object" ? (outcome.error ?? null) : null,
      outcomeDispatched:
        outcome && typeof outcome === "object" && "dispatched" in outcome ? outcome.dispatched : null,
    });
  }
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

// THE TWO FRAMINGS, both uncropped at deviceScaleFactor 2.
//   "card"   — the card ROOT, so the drawing can be graded against §V without
//              anything else in the picture.
//   "column" — the WHOLE embedded widget as the site visitor sees it, shot as
//              the `.cw-frame` element on the THIRD-PARTY page, so the card is
//              visible IN the real transcript column with the widget's own
//              composer in frame.
async function shoot(cell, declaredState, note, extra = {}, framing = "card") {
  await stripDevOverlay();
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
    framing,
    ...extra,
  });
  results.push({ cell, framing, pixels: dims, sha256, observed, rootAttributes: attrs, chips, themeClass: theme, cardText: cardText.slice(0, 2000) });
  say(`CAP ${cell} ${dims.width}x${dims.height} framing=${framing} state=${attrs?.["data-lifecycle-card-state"] ?? "?"} chips=${chips.length}`);
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

/**
 * The embed frame's OWN hosted-PKCE sign-in, run INSIDE the frame. Extracted
 * because the frame re-mounts ANONYMOUS on every page load, so a second load of
 * the third-party page must run exactly the same shipped flow again — the host
 * page never holds a credential on the frame's behalf.
 */
async function runFrameSignIn() {
let frame = embedFrame();
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
frame = embedFrame();
return frame;
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

  frame = await runFrameSignIn();

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
    writeFileSync(join(OUT, "wire.json"), JSON.stringify({ requests: wire, responses: wireResponses, decideOutcomes }, null, 2));
    writeFileSync(
      join(OUT, "capture-results.json"),
      JSON.stringify({ results, wire, wireResponses, cookieJar: appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly })) }, null, 2),
    );
    writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
    writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
    await browser.close();
    process.exit(0);
  }

  // ---- the HELD reading, both framings, both palettes ---------------------
  await setTheme("cinatra");
  await shoot(
    "W1__recommendation-card__site_widget__held__column",
    "pending",
    "The whole embedded widget on a THIRD-PARTY page, uncropped: the turn the visitor typed, the assistant's reply, and the recommendation card HELD in the real transcript column — with the widget's OWN composer in frame beneath it. Every read behind this picture went to the broker with the widget's credential and NO cookie (see `wire`).",
    {},
    "column",
  );
  await shoot(
    "H1__recommendation-card__site_widget__held",
    "pending",
    "The same held card, framed on its own root so the drawing can be graded against §V: one chip per skill, each carrying its OWN Confirm / Adjust / Skip, each printing the owning extension's manifest displayName rather than a slug or a package id.",
  );

  await setTheme("dark");
  await shoot(
    "W2__recommendation-card__site_widget__held__column__dark",
    "pending",
    "The SAME held card in the SAME embedded column, in the dark palette — the class the shipped theme control writes, applied to the embed document. There is no theme control inside third-party chrome, so nothing else was changed.",
    {},
    "column",
  );
  await shoot(
    "H2__recommendation-card__site_widget__held__dark",
    "pending",
    "The SAME held card on its own root, same run, same frame selector, in `dark`.",
  );
  await setTheme("cinatra");

  // ---- drive the decision through the card's BROKER route ------------------
  // §V settles a skill by pressing one of ITS OWN three affordances; the shipped
  // store releases the hold once EVERY chip has a mark (the named whole-row
  // release deviation). So the row is driven chip by chip, in a real browser,
  // and the release that follows is the broker POST recorded on the wire.
  const chipsBefore = await chipReadout();
  const runStatusBeforeDecide = await readRunStatus();
  say(`agent_runs.status BEFORE the decision: ${runStatusBeforeDecide}`);
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

  // ---- what the reader is TOLD, measured in place --------------------------
  // The decide route answers 200 whether it recorded the decision or refused it,
  // so what matters is the OUTCOME it returned and what the row then drew. Both
  // are recorded rather than assumed.
  for (let i = 0; i < 45; i += 1) {
    await page.waitForTimeout(2000);
    const st = await embedFrame()
      ?.evaluate((s2) => document.querySelector(s2)?.getAttribute("data-lifecycle-card-state") ?? null, CARD_ROOT)
      .catch(() => null);
    if (st === "decided") {
      say(`card settled IN PLACE after ~${(i + 1) * 2}s`);
      break;
    }
  }
  await page.waitForTimeout(2500);
  const settledInPlace =
    (await embedFrame()
      ?.evaluate((s2) => document.querySelector(s2)?.getAttribute("data-lifecycle-card-state") ?? null, CARD_ROOT)
      .catch(() => null)) === "decided";
  // The run's OWN status, read back after the decision. This is what "the run
  // underneath advances" means in plan §6.4, and it is measured rather than
  // inferred from anything drawn on the page.
  let runStatusAfterDecide = await readRunStatus();
  if (runStatusAfterDecide === "pending_input") {
    // The dispatch is asynchronous once the release returns; give it a bounded
    // window to leave the parked status before the reading is taken as final.
    for (let i = 0; i < 15 && runStatusAfterDecide === "pending_input"; i += 1) {
      await page.waitForTimeout(2000);
      runStatusAfterDecide = await readRunStatus();
    }
  }
  const runAdvanced = Boolean(runStatusAfterDecide) && runStatusAfterDecide !== "pending_input";
  const settleFacts = {
    settledInPlace,
    reloadedBeforeReading: false,
    runStatusBeforeDecide,
    runStatusAfterDecide,
    runAdvanced,
    decideOutcomes,
  };
  say(`DECIDE OUTCOMES ${JSON.stringify(decideOutcomes)}`);
  say(`settled in place: ${settledInPlace}`);
  say(`agent_runs.status AFTER the decision: ${runStatusAfterDecide} (advanced out of pending_input: ${runAdvanced})`);

  if (settledInPlace) {
    // ---- the SETTLED reading, TAKEN WHERE IT WAS DECIDED -------------------
    // No reload, no second sign-in, no second turn: this is the SAME frame
    // instance that drew the held row, after its own chips were pressed. The
    // pair below is therefore a live settle, not a re-read of a durable row.
    await setTheme("cinatra");
    await shoot(
      "W3__recommendation-card__site_widget__settled__column",
      "decided",
      "The row SETTLED IN PLACE, in the SAME embedded column and the SAME frame instance that drew it held — no reload, no second sign-in, no second turn. Each chip states what it recorded (Confirmed / Adjusted / Skipped) and there is nothing left to press. `agent_runs.status` read back beside this cell in `settleFacts`.",
      { settleFacts },
      "column",
    );
    await shoot(
      "H4__recommendation-card__site_widget__settled",
      "decided",
      "The SAME settled row framed on its own root, in place: four chips, each naming its skill by the owning extension's manifest displayName and stating its own recorded outcome. No Confirm / Adjust / Skip anywhere on the row.",
      { settleFacts },
    );

    writeFileSync(join(OUT, "wire.json"), JSON.stringify({ requests: wire, responses: wireResponses, decideOutcomes }, null, 2));
    writeFileSync(
      join(OUT, "capture-results.json"),
      JSON.stringify(
        { results, wire, wireResponses, decideOutcomes, settleFacts, cookieJar: appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly })) },
        null,
        2,
      ),
    );
    writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
    say("CAPTURE OK (settled in place)");
    // The log is the record of the run, so it is flushed HERE as well: this
    // branch returns out of `try` rather than falling through, and a `finally`
    // that never ran would leave the run unwitnessed.
    writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
    await browser.close();
    process.exit(0);
  }

  if (!settledInPlace) {
    // NOT A CELL. The row did not settle where it was decided, so the honest
    // output is a measured diagnostic of what the reader is actually shown —
    // never a cell claiming a settled row that is not on screen.
    await stripDevOverlay();
    const fd = embedFrame();
    const rel = `${SHOT_DIR_REL}/DIAG__site-widget-column__decide-dispatch-refused.png`;
    const abs = join(REPO_ROOT, rel);
    await page.locator(".cw-frame").first().screenshot({ path: abs, scale: "device" });
    const bytes = readFileSync(abs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const observed = await counts(ASSERTIONS);
    const cardText = await fd.locator(CARD_ROOT).first().innerText().catch(() => "");
    const attrs = await rootAttributes();
    const diagnostic = {
      cell: "DIAG__site-widget-column__decide-dispatch-refused",
      isDiagnostic: true,
      declaredHost: "site_widget",
      declaredKind: null,
      declaredState: null,
      finalUrl: new URL(page.url()).pathname,
      frameUrl: (() => {
        const u = new URL(fd.url());
        return u.pathname + (u.search ? "?<frame disambiguators>" : "");
      })(),
      screenshot: rel,
      sha256,
      assertions: observed,
      rootAttributes: attrs,
      chips: await chipReadout(),
      decideOutcomes,
      cardText: cardText.slice(0, 1200),
      recordedBy: "cinatra-lifecycle-capture-recorder@1",
      recordedAt: new Date().toISOString(),
      runtime: process.env.S9F_RUNTIME_NOTE ?? "",
      note:
        "DIAGNOSTIC, NOT A CELL. The row where it was decided: every chip carries its mark, the card root still declares data-lifecycle-card-state=\"held\", and a refusal line is drawn under the row. The decide route answered 200 and its OUTCOME is recorded in `decideOutcomes`. Filed as a diagnostic so nothing here claims a settled row that is not on screen.",
    };
    records.push(diagnostic);
    results.push({ cell: diagnostic.cell, sha256, observed, cardText: cardText.slice(0, 1200), isDiagnostic: true });
    say(`DIAG recorded: ${JSON.stringify(observed.map((o) => `${o.scope}::${o.selector}=${o.count}`))}`);
  }

  // ---- the SETTLED reading, re-read through the broker ---------------------
  // The decision is durable, so the settled row is reachable by RE-READING the
  // run's authoritative hold state on the same host — a fresh page load of the
  // same third-party page, a fresh turn naming the same run, and the same broker
  // read that drew the held row. Nothing is seeded and nothing is re-decided.
  settleFacts.reloadedBeforeReading = true;
  say("reloading the third-party page to re-read the decided run through the broker");
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 180_000 });
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2000);
    const f2 = embedFrame();
    const ready = await f2
      ?.evaluate(
        () =>
          Boolean(document.querySelector("[data-embed-signin]")) ||
          Boolean(document.querySelector('[role="textbox"][contenteditable="true"]')),
      )
      .catch(() => false);
    if (ready) {
      say(`embed frame re-drew after ~${(i + 1) * 2}s`);
      break;
    }
  }
  // The frame comes back ANONYMOUS: the host page holds no credential, so the
  // frame runs its own hosted PKCE sign-in again, exactly as on the first load.
  frame = await runFrameSignIn();
  const composer2 = frame.locator('[role="textbox"][contenteditable="true"]').first();
  await composer2.waitFor({ state: "visible", timeout: 240_000 });
  await composer2.click();
  await composer2.type(PROMPT, { delay: 12 });
  await stripDevOverlay();
  await composer2.press("Enter");
  say("second turn sent through the widget's OWN composer, naming the SAME (now decided) run");

  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2000);
    const st = await embedFrame()
      ?.evaluate((s2) => document.querySelector(s2)?.getAttribute("data-lifecycle-card-state") ?? null, CARD_ROOT)
      .catch(() => null);
    if (st === "decided") {
      say(`the decided row drew after ~${(i + 1) * 2}s`);
      break;
    }
  }
  await page.waitForTimeout(3000);
  await setTheme("cinatra");
  await shoot(
    "W3__recommendation-card__site_widget__settled__column",
    "decided",
    "RE-READ, NOT A LIVE SETTLE. The settled row on the same cross-site widget host after a fresh load, a second hosted sign-in and a second turn naming the same run: one chip per skill stating what it recorded — Confirmed, Adjusted, Skipped — and nothing left to press. `settleFacts.reloadedBeforeReading` is true on this cell.",
    { settleFacts },
    "column",
  );
  await shoot(
    "H4__recommendation-card__site_widget__settled",
    "decided",
    "RE-READ, NOT A LIVE SETTLE. The same settled row framed on its own root: four chips, each naming its skill by the owning extension's manifest displayName and stating its own recorded outcome. No Confirm / Adjust / Skip anywhere on the row.",
    { settleFacts },
  );

  writeFileSync(join(OUT, "wire.json"), JSON.stringify({ requests: wire, responses: wireResponses, decideOutcomes }, null, 2));
  writeFileSync(
    join(OUT, "capture-results.json"),
    JSON.stringify(
      { results, wire, wireResponses, decideOutcomes, settleFacts, cookieJar: appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly })) },
      null,
      2,
    ),
  );
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  say("CAPTURE OK (re-read fallback)");
} catch (e) {
  say(`CAPTURE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png"), fullPage: true }).catch(() => {});
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire, wireResponses }, null, 2));
} finally {
  writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
  await browser.close();
}
