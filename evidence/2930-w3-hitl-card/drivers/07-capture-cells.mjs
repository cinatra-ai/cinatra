// THE CAPTURE, for a card kind the shipped recorder cannot record.
//
// `scripts/audit/lib/chat-hitl-capture-driver.mjs --walk` is the branch's own
// path from a browser to a record, and it REFUSES a cell of this kind: a
// chat_thread record must declare a `declaredKind` out of the four in
// `scripts/ci/lib/capture-record-contract.mjs` CARD_KINDS, and `agent_hitl_screen`
// is not one of them (`chat-hitl-capture-recorder.mjs:232` LIFECYCLE_KINDS,
// `:1063` the chat_thread rule, `:247` CAPTURE_STATES = pending/decided). The
// refusal was watched — README.md quotes it verbatim — so the pictures are taken
// here instead, in the SAME shape the canonical index records: the image, its
// SHA-256, the URL it was taken on, and every anchor counted in its own scope on
// that screen. Nothing below is submitted by the caller: every count and every
// control is read off the live page.
import { readFileSync, writeFileSync, mkdirSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "pg";

const APP = process.env.WALK_BASE;
const DB = process.env.SUPABASE_DB_URL;
const PLAN = process.env.CAPTURE_PLAN;
const OUT = process.env.OUT_JSON;
const CONTROLS_OUT = process.env.CONTROLS_JSON;
const RUNTIME = process.env.CAPTURE_RUNTIME;
for (const [n, v] of Object.entries({ WALK_BASE: APP, SUPABASE_DB_URL: DB, CAPTURE_PLAN: PLAN, OUT_JSON: OUT, CONTROLS_JSON: CONTROLS_OUT, CAPTURE_RUNTIME: RUNTIME }))
  if (!v) throw new Error(`the capture driver needs ${n}`);
if (process.env.CINATRA_TEST_LLM_PROVIDER) { console.log("ABORT the scripted provider switch is set"); process.exit(1); }

const plan = JSON.parse(readFileSync(PLAN, "utf8"));
const sha256 = (p) => new Promise((res, rej) => { const h = createHash("sha256"); const s = createReadStream(p); s.on("data", (c) => h.update(c)); s.on("end", () => res(h.digest("hex"))); s.on("error", rej); });

// EVERY anchor this card and this pull request name, counted in its own scope.
const ANCHORS = [
  { selector: '[data-lifecycle-card="agent_hitl_screen"]', scope: "frame" },
  { selector: '[data-lifecycle-card-host="__HOST__"]', scope: "frame", hostBound: true },
  { selector: '[data-conformance-id="agent-hitl-screen-card"]', scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-conformance-id="hitl-screen-fields"]', scope: "root" },
  { selector: '[data-action="submit-hitl-screen"]', scope: "root" },
  { selector: "[data-conversation-list]", scope: "frame" },
  { selector: '[data-conformance-id="agentic-run-progress"]', scope: "frame" },
  { selector: '[data-lifecycle-card="recommendation_hold"]', scope: "frame" },
  { selector: '[data-lifecycle-card="artifact_review_gate"]', scope: "frame" },
];

const db = new Client({ connectionString: DB });
await db.connect();
const browser = await chromium.launch();
const records = [];
const controls = [];
for (const cell of plan.cells) {
  const ctxDecl = plan.contexts[cell.context];
  const context = await browser.newContext({
    baseURL: APP,
    viewport: ctxDecl.viewport,
    deviceScaleFactor: ctxDecl.deviceScaleFactor,
    colorScheme: ctxDecl.colorScheme,
  });
  await context.addInitScript((t) => { try { window.localStorage.setItem("theme", t); } catch { /* the record says which theme resolved */ } }, ctxDecl.theme);
  const si = await context.request.post("/api/auth/sign-in/email", { headers: { Origin: APP }, data: { email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET } });
  if (!si.ok()) throw new Error(`sign-in ${si.status()}`);
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.setDefaultNavigationTimeout(300_000);
  await page.goto(cell.url, { waitUntil: "domcontentloaded" });
  for (const sel of cell.waitFor ?? []) await page.waitForSelector(sel, { timeout: 300_000 }).catch(() => {});
  await page.waitForTimeout(cell.settleMs ?? 6000);
  // BRING THE CARD INTO THE READING POSITION, where the plan asks for it. A
  // transcript's resting scroll leaves the last card's foot under the sticky
  // composer — measured, and written down in README.md — so a cell that has to
  // show the control scrolls the list to its end first, exactly as the reader
  // does. It moves the page; it measures nothing.
  if (cell.scrollTo) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const list = document.querySelector("[data-conversation-list]");
      const scroller = list?.closest("[class*='overflow']") ?? document.scrollingElement;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      el?.scrollIntoView({ block: "center" });
    }, cell.scrollTo);
    await page.waitForTimeout(2500);
  }

  const shutterAt = new Date().toISOString();
  mkdirSync(dirname(resolve(cell.screenshot)), { recursive: true });
  // FULL WINDOW, uncropped: the viewport as the person sees it, never fullPage
  // and never an element clip.
  await page.screenshot({ path: cell.screenshot, fullPage: false });
  const digest = await sha256(cell.screenshot);

  // THE MEASUREMENT. `root` is scoped to the card's own root when one is on the
  // page; a count of 0 for a root-scoped anchor with no root is recorded as 0.
  const measured = await page.evaluate((args) => {
    const { anchors, host } = args;
    const root = document.querySelector(`[data-conformance-id="agent-hitl-screen-card"]`);
    const painted = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = [];
    for (const a of anchors) {
      const sel = a.hostBound ? a.selector.replace("__HOST__", host) : a.selector;
      const scopeEl = a.scope === "root" ? root : document;
      const nodes = scopeEl ? Array.from(scopeEl.querySelectorAll(sel)) : [];
      // The canonical contract's `root` scope INCLUDES the root element itself
      // (a card whose own root carries `data-lifecycle-card-state` counts 1),
      // and `querySelectorAll` on an element never returns that element.
      if (a.scope === "root" && root && root.matches(sel)) nodes.unshift(root);
      out.push({ selector: sel, scope: a.scope, count: nodes.length, painted: nodes.filter(painted).length });
    }
    const cardEls = Array.from(document.querySelectorAll("[data-lifecycle-card]"));
    const desc = (el) => ({ tag: el.tagName.toLowerCase(), attributes: Object.fromEntries(Array.from(el.attributes).map((x) => [x.name, x.value])), text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400), painted: painted(el) });
    const inCard = (el) => (root ? root.contains(el) : false);
    return {
      assertions: out,
      cards: cardEls.map(desc),
      cardControls: Array.from(document.querySelectorAll("button, input, textarea, select, [role='button']"))
        .filter(inCard)
        .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), role: el.getAttribute("role"), text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80), placeholder: el.getAttribute("placeholder"), dataAction: el.getAttribute("data-action"), disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true", painted: painted(el) })),
      cardLabels: Array.from(document.querySelectorAll("label")).filter(inCard).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)),
      cardHeadings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(inCard).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160)),
      cardText: root ? (root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 800) : null,
      cardRect: root ? (() => { const r = root.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })() : null,
      resolvedTheme: document.documentElement.classList.contains("dark") || document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
      lifecycleToolCallsInTranscript: Array.from(document.querySelectorAll("[data-tool-name]")).map((e) => e.getAttribute("data-tool-name")),
      url: location.pathname + location.search,
    };
  }, { anchors: ANCHORS, host: cell.declaredHost });

  const dbAt = (await db.query(
    `SELECT id, status, started_at, completed_at, lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref, input_params, now() AS read_at FROM cinatra.agent_runs WHERE id=$1`,
    [cell.runId])).rows[0] ?? null;

  records.push({
    cell: cell.cell,
    declaredHost: cell.declaredHost,
    declaredKind: "agent_hitl_screen",
    declaredState: cell.declaredState ?? "asking",
    finalUrl: measured.url,
    screenshot: cell.screenshot,
    sha256: digest,
    assertions: measured.assertions.map(({ selector, scope, count }) => ({ selector, scope, count })),
    paintedCounts: measured.assertions.map(({ selector, scope, painted }) => ({ selector, scope, painted })),
    recordedBy: "cinatra-lifecycle-capture-recorder@1 (lane-local; see README.md — the shipped recorder refuses this kind)",
    recordedAt: shutterAt,
    runtime: RUNTIME,
    theme: { declared: cell.context, resolved: measured.resolvedTheme },
    viewport: { ...plan.contexts[cell.context].viewport, deviceScaleFactor: plan.contexts[cell.context].deviceScaleFactor },
    framing: "window",
    build: "development",
    runId: cell.runId,
    dbAt,
    requires: cell.requires,
    note: cell.note ?? null,
  });
  controls.push({
    cell: cell.cell,
    url: measured.url,
    cards: measured.cards,
    cardRect: measured.cardRect,
    cardHeadings: measured.cardHeadings,
    cardLabels: measured.cardLabels,
    cardControls: measured.cardControls,
    cardText: measured.cardText,
    lifecycleToolCallsInTranscript: measured.lifecycleToolCallsInTranscript,
    resolvedTheme: measured.resolvedTheme,
  });
  console.log(`shot ${cell.cell} -> ${cell.screenshot} sha256 ${digest.slice(0, 16)}… (${measured.assertions.map((a) => `${a.selector}=${a.count}`).join(", ")})`);
  await context.close();
}
await browser.close();
await db.end();
mkdirSync(dirname(resolve(OUT)), { recursive: true });
const existing = (() => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return { records: [] }; } })();
const byCell = new Map((existing.records ?? []).map((r) => [r.cell, r]));
for (const r of records) byCell.set(r.cell, r);
writeFileSync(OUT, `${JSON.stringify({ ...existing, records: [...byCell.values()] }, null, 2)}\n`);
const exControls = (() => { try { return JSON.parse(readFileSync(CONTROLS_OUT, "utf8")); } catch { return { records: [] }; } })();
const byCtl = new Map((exControls.records ?? []).map((r) => [r.cell, r]));
for (const c of controls) byCtl.set(c.cell, c);
writeFileSync(CONTROLS_OUT, `${JSON.stringify({ ...exControls, schemaVersion: 1, recorder: "cinatra-lifecycle-page-controls@1", records: [...byCtl.values()] }, null, 2)}\n`);
console.log(`wrote ${records.length} record(s) -> ${OUT} and the page-controls sidecar -> ${CONTROLS_OUT}`);
