// ---------------------------------------------------------------------------
// cinatra#2754 — the CROSS-SITE ISLAND capture.
//
// One run against the live app, driving the REAL review card inside the REAL
// embedded widget, on a plain page served from a DIFFERENT LOOPBACK ORIGIN.
//
// WHY THE ORIGIN PAIR MATTERS, and it is the whole round. The app answers on
// `http://localhost:<appPort>`; the host page is served from
// `http://127.0.0.1:<sitePort>`. Those are different origins AND — this is the
// part a same-host/different-port pair would NOT give — different SITES: a
// cookie set for `localhost` is not sent with a subresource load addressed to a
// document nested inside a `127.0.0.1` top-level page, because SameSite is
// decided by the registrable domain and `localhost` and `127.0.0.1` are not the
// same one. A capture taken with the host page on `localhost:<other port>`
// would look identical on screen and prove nothing, because the session cookie
// would have ridden the island frame load and authenticated it. So the driver
// does not merely assert this: it RECORDS the request headers of the island
// document load itself.
//
// WHAT IS RECORDED BESIDE EVERY PICTURE: the anchors the card published, the
// frame the picture was taken in, and the wire — for `/api/lifecycle-views/*`
// and for the `/lifecycle/review-island` DOCUMENT load — with `cookie` and
// `x-cinatra-widget-user-token` reported as present/absent, never by value.
//
// NO SECRET IS EVER WRITTEN OUT. The island credential and the gate ref are
// sealed bearer values. This driver reports their PARAMETER NAMES, their
// LENGTHS and a truncated SHA-256 of the value, which is enough to show the
// address carries them and enough to prove the tampered credential in C3 is a
// different string from the good one — and is not itself usable.
//
// Usage: node 03-capture-island.mjs <hostPageUrl> <outDir> <repoRoot>
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.argv[2];
const OUT = process.argv[3];
const REPO_ROOT = process.argv[4];
const SHOT_DIR_REL = "evidence/2754-island-wire/captures";
mkdirSync(OUT, { recursive: true });
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const ACTOR = {
  email: process.env.ISL_EMAIL ?? "island-2754@example.com",
  password: process.env.ISL_PW ?? "island-2754-dev-12345",
};
const PROMPT = "Is there a review gate waiting for my approval?";

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};
const digest8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

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
        return req.url();
      }
    })(),
    resourceType: req.resourceType(),
    cookie: h["cookie"] ? "PRESENT" : "absent",
    widgetUserToken: h["x-cinatra-widget-user-token"] ? "present (cwu_)" : "absent",
    widgetOrigin: h["x-cinatra-widget-origin"] ?? null,
    secFetchSite: h["sec-fetch-site"] ?? null,
    secFetchDest: h["sec-fetch-dest"] ?? null,
  };
  wire.push(entry);
  say(`WIRE ${JSON.stringify(entry)}`);
}

const browser = await chromium.launch({ headless: true });
// NO storageState: this context starts with an EMPTY cookie jar, so every
// cookie it ever holds was set by the app during this run and can be reported.
const ctx = await browser.newContext({
  viewport: { width: 1228, height: 1400 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/lifecycle/review-island")) noteRequest(req, "island-document");
  else if (u.includes("/api/lifecycle-views/")) noteRequest(req, "lifecycle-resolve");
});

const embedFrame = () => page.frames().find((f) => f.url().includes("/embed/assistant"));
const islandFrame = () => page.frames().find((f) => f.url().includes("/lifecycle/review-island"));

// The dev runtime paints a full-viewport `<nextjs-portal>` overlay that swallows
// pointer events and sits in every screenshot. Dev-server furniture, not
// application UI: removing it changes no application behaviour.
const stripDevOverlay = async () => {
  for (const f of page.frames()) {
    await f
      .evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove()))
      .catch(() => {});
  }
};

// --- counting rules, written down because the numbers ARE the evidence -------
//   page  — document.querySelectorAll(sel).length on the TOP document (the
//           third-party host page).
//   frame — the same, on the EMBED frame document, which is the document every
//           picture here is taken in.
//   root  — the card root's OWN subtree INCLUDING the root element itself, so a
//           marker carried ON the root is not reported as absent.
const CARD_ROOT = '[data-conformance-id="review-gate-card"]';
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
  { selector: '[data-lifecycle-card="artifact_review_gate"]', scope: "frame" },
  { selector: '[data-conformance-id="review-decision-bar"]', scope: "root" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-conformance-id="review-target-island"]', scope: "root" },
  { selector: '[data-island-load-state="loaded"]', scope: "root" },
  { selector: `${CARD_ROOT} iframe`, scope: "frame" },
];

/** The island's OWN document anchors, counted in the ISLAND frame. */
async function islandCounts() {
  const isl = islandFrame();
  if (!isl) return { body: 0, empty: 0, targets: null, text: "" };
  return isl
    .evaluate(() => {
      const body = document.querySelectorAll('[data-conformance-id="review-target-island-body"]');
      return {
        body: body.length,
        empty: document.querySelectorAll('[data-conformance-id="review-target-island-empty"]').length,
        targets: body[0]?.getAttribute("data-target-count") ?? null,
        text: (document.body?.innerText ?? "").replace(/\n{2,}/g, "\n").slice(0, 600),
      };
    })
    .catch(() => ({ body: 0, empty: 0, targets: null, text: "<unreadable>" }));
}

/** The island frame's ADDRESS, described — never disclosed. */
async function islandAddress() {
  const f = embedFrame();
  const raw = await f
    .evaluate((rootSel) => {
      const el = document.querySelector(`${rootSel} iframe`);
      return el ? el.getAttribute("src") : null;
    }, CARD_ROOT)
    .catch(() => null);
  if (!raw) return { present: false };
  const url = new URL(raw, "https://island.invalid");
  const described = {};
  for (const [k, v] of url.searchParams) {
    described[k] =
      k === "ref" || k === "ic"
        ? { length: v.length, sha256_8: digest8(v), shape: /^[A-Za-z0-9_-]+$/.test(v) ? "url-safe base64ish" : "other" }
        : v;
  }
  return {
    present: true,
    attribute: "iframe[src] on the element inside [data-conformance-id=\"review-target-island\"]",
    path: url.pathname,
    absolute: !/^\//.test(raw) ? "yes" : "no (root-relative, this origin)",
    paramNames: [...url.searchParams.keys()],
    params: described,
    totalLength: raw.length,
  };
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
  const isl = await islandCounts();
  const addr = await islandAddress();
  const cardText = await f
    .locator(CARD_ROOT)
    .first()
    .innerText()
    .then((t) => t.replace(/\n{2,}/g, "\n"))
    .catch(() => "");
  records.push({
    cell,
    declaredHost: "site_widget",
    declaredKind: "artifact_review_gate",
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
    runtime: process.env.ISL_RUNTIME_NOTE ?? "",
    note,
    islandObserved: isl,
    islandAddress: addr,
    ...extra,
  });
  results.push({ cell, pixels: dims, sha256, observed, island: isl, address: addr, cardText: cardText.slice(0, 1500) });
  say(`CAP ${cell} ${dims.width}x${dims.height} island(body=${isl.body} empty=${isl.empty} targets=${isl.targets})`);
  return dims;
}

try {
  say(`# cinatra#2754 cross-site island capture — ${new Date().toISOString()}`);
  say(`# top-level page (NOT the Cinatra app): ${HOST}`);
  await page.goto(HOST, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForTimeout(6000);

  let frame = embedFrame();
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

  // --- the frame's own hosted-PKCE sign-in -------------------------------
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

  // --- THE COOKIE FACT, measured -----------------------------------------
  // The popup was a TOP-LEVEL window on the app origin, so the app's session
  // cookie now exists in this context. Reported by NAME and ATTRIBUTES only.
  const appCookies = (await ctx.cookies()).filter((c) => /localhost|127\.0\.0\.1/.test(c.domain));
  say(
    `COOKIE JAR after sign-in: ${JSON.stringify(
      appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly, secure: c.secure })),
    )}`,
  );

  // --- the turn that pulls the review card --------------------------------
  frame = embedFrame();
  const composer = frame.locator('[role="textbox"][contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 240_000 });
  await composer.click();
  await composer.type(PROMPT, { delay: 15 });
  await stripDevOverlay();
  await composer.press("Enter");
  say(`turn sent: "${PROMPT}" (scripted provider + REAL self-MCP dispatch, no LLM call)`);

  // --- wait for the card, then for the ISLAND to paint --------------------
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2000);
    const f = embedFrame();
    const present = await f?.evaluate((s) => Boolean(document.querySelector(s)), CARD_ROOT).catch(() => false);
    if (present) {
      say(`card root appeared after ~${(i + 1) * 2}s`);
      break;
    }
  }
  for (let i = 0; i < 90; i += 1) {
    const isl = await islandCounts();
    if (isl.body > 0 || isl.empty > 0) {
      say(`island document answered after ~${i * 2}s: ${JSON.stringify({ body: isl.body, empty: isl.empty, targets: isl.targets })}`);
      break;
    }
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(4000);

  // ---- C1 — the painted island, cross-site --------------------------------
  await shoot(
    "C1__review-card__site_widget__pending",
    "pending",
    "The review card in the embedded conversation column on a THIRD-PARTY page, with the target island PAINTED inside the frame. The island document is authenticated by the server-minted `?ic=` credential alone: the island document request carried no cookie (see `wire`).",
  );

  // ---- C2 — the same card with the island EXPANDED, and the ADDRESS ------
  const expand = frame.locator('[data-conformance-id="review-target-island"]').first().locator("xpath=..").locator("button").first();
  const expandByText = frame.getByRole("button", { name: /expand|show more|full/i }).first();
  if ((await expandByText.count().catch(() => 0)) > 0) {
    await expandByText.click().catch(() => {});
    await page.waitForTimeout(2500);
    say("island expanded via its own control");
  } else if ((await expand.count().catch(() => 0)) > 0) {
    await expand.click().catch(() => {});
    await page.waitForTimeout(2500);
    say("island expanded via the control beside it");
  } else {
    say("no expand control found; C2 is shot on the same drawn state as C1 and says so");
  }
  const addrBefore = await islandAddress();
  await shoot(
    "C2__review-card__site_widget__pending",
    "pending",
    "The SAME cross-site card with the island's own expand control pressed, so more of the painted target is on screen. This record's evidentiary payload is `islandAddress`: the frame's `src` attribute, read off the DOM, carries BOTH `ref` and the opaque credential parameter `ic`. Their VALUES are never written out — they are sealed bearer strings — so each is reported by length, url-safe shape and a truncated digest.",
  );
  say(`ISLAND ADDRESS (described, never disclosed): ${JSON.stringify(addrBefore)}`);

  // Collapse again, so C3 is photographed at the SAME clamped island height as
  // C1 and the two are directly comparable: one frame painted, one frame blank,
  // everything else on the card identical.
  const collapse = frame.getByRole("button", { name: /collapse/i }).first();
  if ((await collapse.count().catch(() => 0)) > 0) {
    await collapse.click().catch(() => {});
    await page.waitForTimeout(2000);
    say("island collapsed again for the C1/C3 comparison");
  }

  // ---- C3 — the negative control: a TAMPERED credential -------------------
  // One character of `ic` is flipped in the DOM and the frame is re-addressed.
  // Everything else about the request is identical, so the ONLY difference is
  // the credential — which is what makes this a control rather than a re-run.
  const tamper = await frame
    .evaluate((rootSel) => {
      const el = document.querySelector(`${rootSel} iframe`);
      if (!el) return { ok: false, why: "no island iframe" };
      const raw = el.getAttribute("src");
      const u = new URL(raw, window.location.origin);
      const ic = u.searchParams.get("ic");
      if (!ic) return { ok: false, why: "the island src carries no ic parameter" };
      // Flip the FIRST character to a different url-safe character. The string
      // stays the same length and the same shape; only its bytes differ, so the
      // island's own ladder is the only thing that can tell them apart.
      const flipped = (ic[0] === "A" ? "B" : "A") + ic.slice(1);
      u.searchParams.set("ic", flipped);
      const next = u.pathname + u.search;
      el.setAttribute("src", next);
      return { ok: true, icLength: ic.length, flippedLength: flipped.length, changedChars: 1 };
    }, CARD_ROOT)
    .catch((e) => ({ ok: false, why: String(e) }));
  say(`TAMPER ${JSON.stringify(tamper)}`);
  if (!tamper.ok) throw new Error(`C3 could not tamper the credential: ${tamper.why}`);

  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(2000);
    const isl = await islandCounts();
    if (isl.empty > 0 && isl.body === 0) {
      say(`island re-answered with its REFUSAL after ~${(i + 1) * 2}s`);
      break;
    }
  }
  await page.waitForTimeout(4000);
  await shoot(
    "C3__review-card__site_widget__pending",
    "pending",
    "NEGATIVE CONTROL, framed at the SAME clamped island height as C1 so the two are directly comparable. One character of the island credential was flipped in the DOM and the frame re-addressed; everything else about the request is byte-identical. The island document answered with its REFUSAL — the single empty-island element every denial draws, which is why the framed region is blank — and the card around it is UNMOVED: still `Review requested / Awaiting your decision`, still carrying its decision floor. Not an error page, not a crash, not a sign-in form inside third-party chrome.",
  );

  writeFileSync(join(OUT, "wire.json"), JSON.stringify(wire, null, 2));
  writeFileSync(
    join(OUT, "capture-results.json"),
    JSON.stringify({ results, wire, cookieJar: appCookies.map((c) => ({ name: c.name, domain: c.domain, sameSite: c.sameSite, httpOnly: c.httpOnly })) }, null, 2),
  );
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  say("CAPTURE OK");
} catch (e) {
  say(`CAPTURE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png"), fullPage: true }).catch(() => {});
  writeFileSync(join(OUT, "records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire }, null, 2));
} finally {
  writeFileSync(join(OUT, "capture.log"), log.join("\n") + "\n");
  await browser.close();
}
