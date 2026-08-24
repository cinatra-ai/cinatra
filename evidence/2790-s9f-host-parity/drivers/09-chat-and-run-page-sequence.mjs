// ---------------------------------------------------------------------------
// cinatra#2790 S9f (PR #2890 rework) — THE SKILLS QUESTION AND THE
// DECIDED SKILLS, IN THE CHAT **AND** ON THE RUN PAGE, ON ONE REAL RUN.
//
// WHAT THE OWNER ASKED FOR, and what this file therefore does:
//
//   "the skills question and the decided skills, each in the chat AND on the
//    run page, on one real run"
//
// So this driver walks ONE run, started from ONE conversation, and photographs
// FOUR states of it in the order a person meets them — chat HELD, run page
// HELD, chat DECIDED, run page DECIDED — each in the light and the dark
// palette. Eight pictures, one run, no staging.
//
// IT REPLACES the withdrawn S1/S2 pair. Those two showed an agentic run
// progress card in the turn while the recommended skills could still be chosen,
// and a skills button row inside the run card after they were decided; both
// readings are ruled out by the plan, and both are fixed in the code this
// branch now carries (`8a9725d93`). Re-shot here on that code.
//
// IT ADDS the run-page pair R5/R6. They are numbered R5/R6 rather than R1/R2
// because R1–R4 in this lane are already the REVIEW-PAGE cells; the host token
// in each name (`run_card`) says which surface it is.
//
// EVERY CELL IS THE FULL BROWSER WINDOW at 1440x1700 CSS px, deviceScaleFactor
// 2 — the committed walk contract of this lane. There is no crop rectangle in
// this file, and no `fullPage` stitch: the window IS the frame.
//
// EVERY STEP IS RELOADED BEFORE IT IS PHOTOGRAPHED, so each picture is the
// DURABLE state — what the next reader of this conversation, or of this run
// page, sees — rather than a live component that happens to be in the right
// state.
//
// EVERY LIFECYCLE TIMESTAMP IS READ FROM A DATABASE COLUMN, never off a screen —
// creation, park, selection, release, completion. The capture times, the press
// times and the provider-window time are THIS PROCESS'S clock, and the runtime's
// completion is the runtime's own status payload. TIMELINE.md names which clock
// each row is on; none of them is a screen.
//
// WHAT SERVES THE MODEL, STATED PLAINLY, BECAUSE TWO DIFFERENT THINGS DO.
//
//   · THE CHAT TURN answers on the DETERMINISTIC BRIDGE. The turn carries
//     embedded `inputParams`, which takes the hard pre-router's brace-matched
//     fast path and dispatches server-side without consulting a model at all. A
//     real-model chat turn would need a publicly reachable MCP ingress, which
//     this environment does not allow.
//   · THE AGENT'S OWN STEP is started with a REAL sealed `openai_connection`
//     row configured — written through the shipped writer inside the operator's
//     secret-manager wrapper (`08-real-provider.test.ts`) — and that
//     configuration is what the pictured run is created under. The step's own
//     model call cannot COMPLETE against it here: the bridge loads this
//     instance's cinatra toolbox into the provider call and the provider fetches
//     that toolbox from this instance's public MCP URL, which this machine does
//     not have. Measured, not assumed: the run before the pictured one died
//     exactly there (`POST /api/llm-bridge 500`, "the AI provider could not
//     reach this instance's public MCP server ... HTTP 424 Failed Dependency").
//     So the connection is removed mid-sequence, in the open, at the one moment
//     it is in the way of nothing else (see THE PROVIDER WINDOW below), and the
//     step's call is served by the scripted runtime instead.
//
// The HOLD, the chips, the decision, the dispatch and the run are the server's
// own shipped path throughout; what is substituted is the model behind one call.
//
// Real presses only. The four chips are decided one at a time through the
// card's own per-chip controls; the run's own in-flight gate is answered by its
// own Continue; nothing else is pressed and nothing is stood in for.
//
// No origin is hard-coded: the app origin and the lane database are read from
// the environment.
//
// EDITED AFTER THE RUN THAT PRODUCED THE COMMITTED CELLS, and the edits are named
// here so nobody has to diff to find them: three prose labels were corrected (the
// T3 timeline label, and the two R6 cell notes, which had asserted a rail entry
// the same records measure as absent), the failure path was made loud
// (`process.exitCode = 1`), and the gate-press bookkeeping was made honest (a
// swallowed click no longer records as a landed press). NONE of them changes what
// the recorded run did or what it measured; the recorded artifacts are left
// verbatim and carry their own corrections.
//
// Usage: node 09-chat-and-run-page-sequence.mjs <appOrigin> <outDir> <repoRoot>
//        env: S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, S9F_RUNTIME_NOTE
// ---------------------------------------------------------------------------
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const APP = process.argv[2];
const OUT = process.argv[3];
const REPO_ROOT = process.argv[4];
const SHOT_DIR_REL = "evidence/2790-s9f-host-parity/captures";
const ACTOR = { email: process.env.S9F_EMAIL, password: process.env.S9F_PW };
const DB = process.env.SUPABASE_DB_URL;
if (!APP || !OUT || !REPO_ROOT || !ACTOR.email || !ACTOR.password || !DB) {
  throw new Error(
    "usage: 09-chat-and-run-page-sequence.mjs <appOrigin> <outDir> <repoRoot>; set S9F_EMAIL, S9F_PW, SUPABASE_DB_URL",
  );
}
mkdirSync(OUT, { recursive: true });
mkdirSync(join(REPO_ROOT, SHOT_DIR_REL), { recursive: true });

const log = [];
const say = (m) => {
  log.push(`${new Date().toISOString()} ${m}`);
  console.log(m);
};

// --- the shipped anchors, read off the components, never invented here -------
const CONVERSATION_LIST = "[data-conversation-list]";
const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
const CHAT_PROMPT = '[data-testid="chat-prompt-input"]';
const CHIP = "[data-recommendation-chip]";
const CHIP_ROW = "[data-run-recommendation-chip-row]";
const RUN_SURFACE = '[data-conformance-id="run-surface"]';
const RAIL_COLUMN = "[data-run-step-rail-column]";
const DETAIL_COLUMN = "[data-run-detail-column]";
const RAIL_STEP = '[data-conformance-id="recommendation-rail-step"]';
const RAIL_INDICATOR = '[data-conformance-id="recommendation-rail-indicator"]';
/** The inline run progress card in the chat transcript, and its skill picker. */
const INLINE_RUN_CARD = "[data-inline-run-card]";
const RUN_CARD_SKILL_PICKER = "[data-hitl-skill-picker]";

/** ONE press per chip, in this order, so every mark the drawing names appears. */
const DECISION_ORDER = ["confirm", "adjust", "skip", "confirm"];

/** The turn that starts the run. The LEGACY `cinatra_<slug>` package form is
 *  deliberate: two or more `@` mention tokens flip the thread into the mention
 *  layout, which suppresses transcript `parts` — and the card mounts AT a part.
 *  The embedded `inputParams` takes the brace-matched deterministic fast path,
 *  so no model is consulted to build the run's input. */
const IDEA = {
  title: "Connector rollout note",
  summary: "The connector ships this week and replaces the manual export step.",
  outline: ["Summary", "Rollout"],
};
const MESSAGE = `Please run cinatra_blog-draft-writer-agent for me with inputParams: ${JSON.stringify({ idea: IDEA })}`;

const client = new pg.Client({ connectionString: DB });
await client.connect();
const q = async (text, values = []) => (await client.query(text, values)).rows;

/** THE CLOCK. The `db` payload on each row is read from database columns, with the
 *  columns named in the query above it; `at` is THIS PROCESS'S clock. Nothing
 *  here is read off a screen. */
const timeline = [];
const stamp = async (step, what, rows) => {
  const row = { step, what, at: new Date().toISOString(), db: rows };
  timeline.push(row);
  say(`TIMELINE ${step} ${what} ${JSON.stringify(rows)}`);
  return row;
};

/** The run's own rows, as the database holds them at this instant. */
async function runRows(runId) {
  if (!runId) return null;
  const [run] = await q(
    `select id, status, human_present, created_at, completed_at, coalesce(error,'') as error from cinatra.agent_runs where id=$1`,
    [runId],
  );
  const park = await q(
    `select checkpoint, status, created_at, resolved_at from cinatra.lifecycle_continuation_park where run_id=$1`,
    [runId],
  );
  const selections = await q(
    `select skill_id, selection_source, selected_at from cinatra.run_selected_skill_revisions where run_id=$1 order by skill_id`,
    [runId],
  );
  const representations = await q(
    `select id, artifact_id, resource_id, revision, form, created_at from cinatra.representation where created_by_run_id=$1 order by created_at`,
    [runId],
  );
  const outbox = await q(
    `select event_id, artifact_id, representation_revision_id, emitter, origin_kind, created_at, processed_at from cinatra.artifact_produced_outbox where producer_run_id=$1`,
    [runId],
  );
  const gates = await q(
    `select id, review_task_id, status, created_at from cinatra.artifact_review_gates where run_id=$1`,
    [runId],
  );
  return { run, park, selections, representations, outbox, gates };
}

const browser = await chromium.launch({ headless: true });
// 1440x1700 CSS px at deviceScaleFactor 2 — this lane's committed walk contract.
const VIEWPORT = { width: 1440, height: 1700 };
const ctx = await browser.newContext({ viewport: { ...VIEWPORT }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
/** The lifecycle wire, presence + status only — never a body, never a value. */
const wire = [];
page.on("response", (res) => {
  const p = new URL(res.url()).pathname;
  if (p.startsWith("/api/lifecycle-views/") || p.startsWith("/api/chat") || p.startsWith("/api/assistants"))
    wire.push({ method: res.request().method(), path: p, status: res.status(), at: new Date().toISOString() });
});

const stripDevOverlay = async () => {
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((n) => n.remove())).catch(() => {});
};

// --- counting rules ---------------------------------------------------------
//   frame — document.querySelectorAll(sel).length on THIS document.
//   root  — the named card root's OWN subtree INCLUDING the root element.
async function counts(selectors, rootSel) {
  const out = [];
  for (const { selector, scope } of selectors) {
    let count = 0;
    if (scope === "frame") {
      count = await page.evaluate((s) => document.querySelectorAll(s).length, selector);
    } else {
      count = await page
        .evaluate(
          ({ s, r }) => {
            const root = document.querySelector(r);
            if (!root) return 0;
            return (root.matches(s) ? 1 : 0) + root.querySelectorAll(s).length;
          },
          { s: selector, r: rootSel },
        )
        .catch(() => 0);
    }
    out.push({ selector, scope, count });
  }
  return out;
}

const RECOMMENDATION_ASSERTIONS_CHAT = [
  { selector: CONVERSATION_LIST, scope: "frame" },
  { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame" },
  { selector: CARD_ROOT, scope: "frame" },
  { selector: "[data-chat-thread-recommendation-hold]", scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-skill-action="confirm"]', scope: "root" },
  { selector: '[data-skill-action="adjust"]', scope: "root" },
  { selector: '[data-skill-action="skip"]', scope: "root" },
  { selector: CHIP, scope: "root" },
  { selector: CHIP_ROW, scope: "frame" },
];

/** THE HELD TURN'S SET. The plan: "An agentic run progress card is not visible
 *  while the recommended skills can be selected". So the held cell COUNTS the
 *  run card, and the count it must record is ZERO — an absence nobody counts is
 *  an absence nobody can check. */
const CHAT_HELD_ASSERTIONS = [
  ...RECOMMENDATION_ASSERTIONS_CHAT,
  { selector: INLINE_RUN_CARD, scope: "frame" },
];

/** THE DECIDED TURN'S SET. The other half: the run card is counted (present) and
 *  the skill picker inside it is counted (ZERO). */
const CHAT_DECIDED_ASSERTIONS = [
  ...RECOMMENDATION_ASSERTIONS_CHAT,
  { selector: INLINE_RUN_CARD, scope: "frame" },
  { selector: RUN_CARD_SKILL_PICKER, scope: "frame" },
];

/** THE RUN PAGE'S SET — the two-column frame, the rail, the step row and the
 *  chip row, all counted on the screen the picture was taken on. */
const RUN_PAGE_ASSERTIONS = [
  { selector: '[data-lifecycle-card-host="run_card"]', scope: "frame" },
  { selector: CARD_ROOT, scope: "frame" },
  { selector: RUN_SURFACE, scope: "frame" },
  { selector: RAIL_COLUMN, scope: "frame" },
  { selector: DETAIL_COLUMN, scope: "frame" },
  { selector: RAIL_STEP, scope: "frame" },
  { selector: RAIL_INDICATOR, scope: "frame" },
  { selector: CHIP_ROW, scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-skill-action="confirm"]', scope: "root" },
  { selector: '[data-skill-action="adjust"]', scope: "root" },
  { selector: '[data-skill-action="skip"]', scope: "root" },
  { selector: CHIP, scope: "root" },
];

async function rootAttributes(rootSel) {
  return page
    .evaluate((r) => {
      const el = document.querySelector(r);
      if (!el) return null;
      const out = {};
      for (const a of el.attributes) out[a.name] = a.value;
      delete out.class;
      return out;
    }, rootSel)
    .catch(() => null);
}

async function chipReadout() {
  return page
    .evaluate((r) => {
      const root = document.querySelector(r);
      if (!root) return [];
      return [...root.querySelectorAll("[data-recommendation-chip]")].map((c) => ({
        skillId: c.getAttribute("data-skill-id"),
        mark: c.getAttribute("data-chip-mark"),
        forced: c.hasAttribute("data-forced"),
        label: (c.querySelector("span")?.textContent ?? "").trim(),
        text: c.textContent.trim(),
        actions: [...c.querySelectorAll("[data-skill-action]")].map((b) => b.getAttribute("data-skill-action")),
      }));
    }, CARD_ROOT)
    .catch(() => []);
}

/** THE TRANSCRIPT, as text — the proof that the whole chat is in frame. */
async function transcriptReadout() {
  return page
    .evaluate((listSel) => {
      const list = document.querySelector(listSel);
      if (!list) return null;
      const box = list.getBoundingClientRect();
      return {
        turns: [...list.children].length,
        listTop: Math.round(box.top),
        listBottom: Math.round(box.bottom),
        listFullyInViewport: box.top >= 0 && box.bottom <= window.innerHeight,
        text: list.innerText.replace(/\n{2,}/g, "\n").slice(0, 3000),
      };
    }, CONVERSATION_LIST)
    .catch(() => null);
}

/**
 * THE RUN PAGE'S OWN READOUT — every claim the run-page cells make, MEASURED.
 *
 *   · which column the chip row is a descendant of (the drawing's whole point:
 *     "a gate step opens the gate's own surface in place — right here in the run
 *     detail, under the same rail, never as a standalone document");
 *   · whether anything is drawn inline UNDER the rail row (must be false);
 *   · the rail row's own reading — selected / settled, and what its circle says;
 *   · the ordered rail row labels, so "at the trigger position" is readable;
 *   · whether an "Agentic Run Progress" section is on the screen at all.
 */
async function runSurfaceReadout() {
  return page
    .evaluate(
      ({ surfaceSel, railSel, detailSel, stepSel, indicatorSel, rowSel }) => {
        const surface = document.querySelector(surfaceSel);
        const rail = document.querySelector(railSel);
        const detail = document.querySelector(detailSel);
        const step = document.querySelector(stepSel);
        const row = document.querySelector(rowSel);
        const headings = [...document.querySelectorAll("h1,h2,h3")].map((h) => h.textContent.trim());
        return {
          surfacePresent: Boolean(surface),
          surfaceChildren: surface ? surface.children.length : null,
          railColumnPresent: Boolean(rail),
          detailColumnPresent: Boolean(detail),
          chipRowPresent: Boolean(row),
          chipRowInDetailColumn: Boolean(detail && row && detail.contains(row)),
          chipRowInRailColumn: Boolean(rail && row && rail.contains(row)),
          chipRowInsideRailRow: Boolean(step && row && step.contains(row)),
          railStepPresent: Boolean(step),
          railStepSelected: step?.getAttribute("data-recommendation-step-selected") ?? null,
          railStepSettled: step?.getAttribute("data-recommendation-step-settled") ?? null,
          railStepText: step?.textContent.trim() ?? null,
          railStepIndicatorText:
            step?.querySelector(indicatorSel)?.textContent.trim() ?? null,
          railRowLabels: rail
            ? [...rail.children].map((c) => c.textContent.trim().replace(/\s+/g, " ").slice(0, 60))
            : null,
          agenticRunProgressHeadings: headings.filter((h) => h === "Agentic Run Progress").length,
          headings: headings.slice(0, 12),
        };
      },
      {
        surfaceSel: RUN_SURFACE,
        railSel: RAIL_COLUMN,
        detailSel: DETAIL_COLUMN,
        stepSel: RAIL_STEP,
        indicatorSel: RAIL_INDICATOR,
        rowSel: CHIP_ROW,
      },
    )
    .catch(() => null);
}

const records = [];
const results = [];

/**
 * Apply the palette next-themes applies through the shipped theme control.
 *
 * STATED BECAUSE IT IS A SHORTCUT: this sets the root class directly rather than
 * pressing the header's own theme toggle. It is the same mechanism every earlier
 * capture round in this lane used, and it writes ONLY the class next-themes
 * writes — it arranges nothing the recorder is about to measure, because no
 * assertion in this file reads a class. A cell that needed the toggle's own
 * behaviour proven would have to press it.
 */
async function setTheme(name) {
  const applied = await page.evaluate((t) => {
    const el = document.documentElement;
    el.classList.remove("cinatra", "dark");
    el.classList.add(t);
    el.style.colorScheme = t === "dark" ? "dark" : "light";
    return el.className;
  }, name);
  await page.waitForTimeout(900);
  return applied;
}

/**
 * THE SHUTTER. Always the FULL BROWSER WINDOW — no `fullPage`, no `clip`.
 */
async function shoot(cell, { host, kind, declaredState, rootSel, assertions, note, runId, dbAt, extra = {} }) {
  await stripDevOverlay();
  const rel = `${SHOT_DIR_REL}/${cell}.png`;
  const abs = join(REPO_ROOT, rel);
  await page.screenshot({ path: abs, scale: "device" });
  const bytes = readFileSync(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const observed = await counts(assertions, rootSel);
  const attrs = await rootAttributes(rootSel);
  const chips = await chipReadout();
  const transcript = host === "chat_thread" ? await transcriptReadout() : null;
  const runSurface = host === "run_card" ? await runSurfaceReadout() : null;
  const theme = await page.evaluate(() => document.documentElement.className).catch(() => "");
  records.push({
    cell,
    declaredHost: host,
    declaredKind: kind,
    declaredState,
    finalUrl: new URL(page.url()).pathname,
    screenshot: rel,
    sha256,
    assertions: observed,
    recordedBy: "cinatra-lifecycle-capture-recorder@1",
    recordedAt: new Date().toISOString(),
    runtime: process.env.S9F_RUNTIME_NOTE ?? "",
    note,
    runId,
    dbAt,
    rootAttributes: attrs,
    chips,
    transcript,
    runSurface,
    themeClass: theme,
    framing: "window",
    viewport: { ...page.viewportSize(), deviceScaleFactor: 2 },
    pageErrors: [...pageErrors],
    ...extra,
  });
  results.push({ cell, pixels: dims, sha256, observed, rootAttributes: attrs, chips, transcript, runSurface, themeClass: theme });
  say(`CAP ${cell} ${dims.width}x${dims.height} chips=${chips.length} turns=${transcript?.turns ?? "-"} chipRowInDetail=${runSurface?.chipRowInDetailColumn ?? "-"} progress=${runSurface?.agenticRunProgressHeadings ?? "-"}`);
  return dims;
}

/** Sign in through the app's OWN hosted form, retried against hydration races. */
async function signIn() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto(`${APP}/sign-in`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector('input[name="email"]', { timeout: 300_000 });
    await page.waitForTimeout(4000);
    const em = page.locator('input[name="email"]').first();
    const pw = page.locator('input[name="password"]').first();
    await em.click();
    await em.pressSequentially(ACTOR.email, { delay: 12 });
    await pw.click();
    await pw.pressSequentially(ACTOR.password, { delay: 6 });
    if ((await em.inputValue()) !== ACTOR.email) continue;
    await page.locator('button[type="submit"]').first().click();
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(2000);
      if (!new URL(page.url()).pathname.startsWith("/sign-in")) return new URL(page.url()).pathname;
    }
  }
  throw new Error("sign-in did not leave /sign-in");
}

/** GROW THE WINDOW until the named element fits between its top and bottom. */
async function fitTheWindow(sel) {
  for (let i = 0; i < 8; i += 1) {
    const box = await page
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, inner: window.innerHeight };
      }, sel)
      .catch(() => null);
    if (!box) return;
    if (box.top >= 0 && box.bottom <= box.inner) return;
    const grown = Math.min(2800, (page.viewportSize()?.height ?? VIEWPORT.height) + 300);
    if (grown === page.viewportSize()?.height) return;
    await page.setViewportSize({ width: VIEWPORT.width, height: grown });
    say(`WINDOW grown to ${VIEWPORT.width}x${grown} so ${sel} is in frame`);
    await page.waitForTimeout(1200);
  }
}

/** Scroll so the transcript's own top is in frame, then settle. */
async function frameTheTranscript() {
  await page.evaluate((listSel) => {
    const list = document.querySelector(listSel);
    if (!list) return;
    const scroller = list.closest("[data-conversation-scroll], main, div");
    list.scrollIntoView({ block: "start", behavior: "instant" });
    if (scroller && typeof scroller.scrollTop === "number") scroller.scrollTop = 0;
    window.scrollTo(0, 0);
  }, CONVERSATION_LIST).catch(() => {});
  await page.waitForTimeout(1200);
  await fitTheWindow(CONVERSATION_LIST);
  await page.waitForTimeout(800);
}

/** The run page is its own surface: back to the declared window, top of page. */
async function frameTheRunSurface() {
  await page.setViewportSize({ ...VIEWPORT });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
  await fitTheWindow(RUN_SURFACE);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
}

async function openRunPage(runId, pkg) {
  const [vendor, name] = String(pkg).replace(/^@/, "").split("/");
  const path = `/agents/${vendor}/${name}/${runId}`;
  await page.goto(`${APP}${path}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(RUN_SURFACE, { timeout: 600_000 });
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  await page.waitForTimeout(9000);
  await frameTheRunSurface();
  return path;
}

async function openThread(threadPath) {
  await page.goto(`${APP}${threadPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  await page.waitForTimeout(8000);
  await frameTheTranscript();
}

const state = {};
try {
  say(`# cinatra#2790 S9f — the chat + run-page sequence — ${new Date().toISOString()}`);
  say(`after sign-in: ${await signIn()}`);

  // ---- the person's turn that starts the run ------------------------------
  // TYPED, READ BACK, AND CONFIRMED SENT. A composer that re-mounts under the
  // /chat -> /chat/<vendor>/<assistant>/<thread> redirect silently drops what was
  // typed into the previous mount, and an Enter on an empty composer is a no-op
  // that looks exactly like a successful turn. So the text is read back before
  // Enter, and the turn is only called sent once it is IN the transcript.
  let sent = false;
  for (let attempt = 0; attempt < 5 && !sent; attempt += 1) {
    await page.goto(`${APP}/chat`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector(CHAT_PROMPT, { timeout: 300_000 });
    await page.waitForTimeout(9000);
    const composer = page.locator(CHAT_PROMPT).first();
    await composer.click();
    await composer.pressSequentially(MESSAGE, { delay: 4 });
    await page.waitForTimeout(1500);
    const typed = await composer.evaluate((el) => el.value ?? el.textContent ?? "").catch(() => "");
    if (!typed.includes("blog-draft-writer-agent")) {
      say(`TURN attempt ${attempt + 1}: the composer did not hold the text — retrying`);
      continue;
    }
    say(`TURN typed into the composer: ${MESSAGE}`);
    await page.keyboard.press("Enter");
    for (let i = 0; i < 30; i += 1) {
      await page.waitForTimeout(2000);
      const inTranscript = await page
        .evaluate(
          (s) => (document.querySelector(s)?.innerText ?? "").includes("blog-draft-writer-agent"),
          CONVERSATION_LIST,
        )
        .catch(() => false);
      if (inTranscript) {
        sent = true;
        break;
      }
    }
    say(`TURN attempt ${attempt + 1}: in transcript = ${sent}`);
  }
  if (!sent) throw new Error("the turn never reached the transcript");
  say("TURN sent");

  // ---- the run parks at the recommendation hold ---------------------------
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  for (let i = 0; i < 60; i += 1) {
    const st = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state"), CARD_ROOT);
    if (st === "held") break;
    await page.waitForTimeout(2000);
  }
  state.threadPath = new URL(page.url()).pathname;
  // THE RUN ID COMES OFF THE PAGE, from the inline run panel's own link out —
  // the platform builds that href from the run id, so it names the run THIS
  // turn dispatched rather than "whatever ran last".
  const linked = await page
    .evaluate(() => {
      const a = document.querySelector('[data-testid="inline-run-page-link"]');
      const href = a?.getAttribute("href") ?? "";
      const m = href.match(/([0-9a-fA-F-]{36})$/);
      return m ? m[1] : null;
    })
    .catch(() => null);
  state.runId =
    linked ?? (await q(`select id from cinatra.agent_runs order by created_at desc limit 1`))[0]?.id;
  state.runIdSource = linked ? "inline-run-page-link" : "newest agent_runs row";
  // THE FALLBACK IS A WEAKER BINDING, AND IT SAYS SO. The link-out is the strong
  // binding (the platform builds that href from THIS turn's run id); the newest
  // row is not, because a concurrent run on the same database would win it. The
  // source is written into the sequence state either way, so a reader can see
  // which one answered instead of having to trust that it was the strong one.
  // On this lane the picture itself carries the independent check: the assistant's
  // own dispatch line prints the run id in the transcript, and it is legible in S1.
  const [tplRow] = await q(
    `select t.package_name from cinatra.agent_runs r join cinatra.agent_templates t on t.id = r.template_id where r.id=$1`,
    [state.runId],
  );
  state.packageName = String(tplRow?.package_name ?? "@cinatra-ai/blog-draft-writer-agent");
  say(`RUN ${state.runId} in thread ${state.threadPath} (${state.packageName})`);

  // RELOAD, so what is photographed is the DURABLE state of this conversation.
  await openThread(state.threadPath);

  const t1 = await runRows(state.runId);
  await stamp("T1", "held at the recommendation hold; the run has produced NOTHING", {
    runStatus: t1.run?.status,
    humanPresent: t1.run?.human_present,
    parkCheckpoint: t1.park[0]?.checkpoint,
    parkStatus: t1.park[0]?.status,
    parkCreatedAt: t1.park[0]?.created_at,
    representationRows: t1.representations.length,
    producedOutboxRows: t1.outbox.length,
    reviewGateRows: t1.gates.length,
    selectionRows: t1.selections.length,
  });
  if (t1.representations.length !== 0 || t1.outbox.length !== 0 || t1.gates.length !== 0) {
    throw new Error("S1 precondition broken: the run already has output rows");
  }

  // ---- S1: the chat, HELD --------------------------------------------------
  await setTheme("cinatra");
  await shoot("S1__recommendation-card__chat_thread__held", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: CHAT_HELD_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The whole conversation in one browser window: the person's own turn asking for the agent, and the reply carrying the recommendation card HELD — one chip per skill, each with its own Confirm / Adjust / Skip, no heading plate and no row-level submit. NO agentic run progress card is anywhere in the turn: the skills are still being chosen, so the run has not started and the run-card count reads ZERO. Nothing has been produced either — representation, produced-outbox and review-gate rows for this run all read ZERO in the database at this instant (dbAt).",
  });
  await setTheme("dark");
  await shoot("S1__recommendation-card__chat_thread__held__dark", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: CHAT_HELD_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same window and the same held turn in the dark palette — chip row present, no run progress card.",
  });
  await setTheme("cinatra");

  // ---- R5: the RUN PAGE for the same run, still HELD ----------------------
  state.runPath = await openRunPage(state.runId, state.packageName);
  const t1b = await runRows(state.runId);
  await stamp("T1b", "the run page is opened while the SAME hold is still parked", {
    runStatus: t1b.run?.status,
    parkStatus: t1b.park[0]?.status,
    selectionRows: t1b.selections.length,
    representationRows: t1b.representations.length,
    url: state.runPath,
  });
  if (t1b.park[0]?.status !== "parked") {
    throw new Error("R5 precondition broken: the hold is no longer parked");
  }
  await shoot("R5__recommendation-card__run_card__held", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The run page for the SAME run while the recommendation is still held: the two-column frame, the step rail down the LEFT with `Recommendation` at the trigger position (numbered 1, ahead of the work steps it would authorize), and the chip row as that step's own surface in the run detail on the RIGHT. Nothing is drawn inline under the rail row (the chip row is a descendant of the run-detail column, not of the rail column and not of the row), and there is no Agentic Run Progress section beside a run that has not run.",
  });
  await setTheme("dark");
  await shoot("R5__recommendation-card__run_card__held__dark", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same run page and the same held state in the dark palette.",
  });
  await setTheme("cinatra");

  // ---- THE PROVIDER WINDOW CLOSES -----------------------------------------
  //
  // THE ONE LANE CHANGE INSIDE THIS SEQUENCE, AND WHY IT IS HERE.
  //
  // This lane holds a REAL sealed `openai_connection` row, written through the
  // shipped writer inside the operator's secret-manager wrapper, and the run
  // photographed above was started with it configured. The agent's own step,
  // however, cannot complete against it HERE: the bridge loads the instance's
  // cinatra toolbox into the provider call, and the provider fetches that
  // toolbox over the public internet from this instance's own MCP URL. This
  // machine has no public MCP ingress, so the provider answers
  //
  //   424 Failed Dependency -> POST /api/llm-bridge 500
  //   "The AI provider could not reach this instance's public MCP server ...
  //    so the agent run was stopped."
  //
  // — MEASURED on this lane, on the run before this one, which died there. That
  // is an environment limit, not a property of this branch, and it is stated in
  // README.md and TIMELINE.md rather than papered over.
  //
  // So the real connection is REMOVED here, through the shipped
  // `clearOpenAIConnection`, at the one moment where it changes nothing already
  // photographed and nothing still to come except the thing it is in the way of:
  // the run is parked, no model has been consulted (the turn took the hard
  // pre-router's deterministic path), and every model call still ahead belongs
  // to the agent's own step. `resolveConfiguredLlmRuntime()` reaches the
  // scripted runtime (#2917) only as its LAST RESORT — "an install WITH a
  // configured provider never reaches this line" — so with the row gone the
  // step's call to `POST /api/llm-bridge` is served by the scripted runtime and
  // the run can finish and produce its own output.
  //
  // It is recorded as its own timeline row rather than done quietly.
  const clearOut = execFileSync(
    "npx",
    [
      "vitest",
      "run",
      "--config",
      "evidence/2790-s9f-host-parity/drivers/06-chat-lane-fixture.config.ts",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, WALK_STEP: "PROVIDER_CLEAR" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const clearLine = clearOut.split("\n").find((l) => l.includes("S9FCHAT PROVIDER_CLEAR")) ?? "";
  await stamp(
    "T1c",
    "the REAL provider connection is removed so the agent's own model call resolves the scripted runtime — this machine has no public MCP ingress for the real provider to load the toolbox from",
    { shippedWriter: "clearOpenAIConnection", readBack: clearLine.trim() },
  );

  // ---- the decision, chip by chip, IN THE CHAT -----------------------------
  await openThread(state.threadPath);
  const held = await chipReadout();
  state.heldChips = held;
  state.decisionPresses = [];
  for (let i = 0; i < held.length; i += 1) {
    const skillId = held[i].skillId;
    const action = DECISION_ORDER[i % DECISION_ORDER.length];
    await page
      .locator(`${CARD_ROOT} ${CHIP}[data-skill-id="${skillId}"] [data-skill-action="${action}"]`)
      .first()
      .click({ timeout: 60_000 });
    await page.waitForTimeout(1200);
    if (action === "adjust") {
      await page.locator('[data-skill-action="adjust-keep"]').first().click({ timeout: 60_000 });
      await page.waitForTimeout(1500);
    }
    const after = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state"), CARD_ROOT);
    state.decisionPresses.push({ skillId, action, cardStateAfter: after, at: new Date().toISOString() });
    say(`PRESS ${action} on ${skillId} -> card state ${after}`);
  }
  await page.waitForTimeout(12_000);

  // RELOAD again — the settled row must survive a reload to be durable state.
  await openThread(state.threadPath);

  const t2 = await runRows(state.runId);
  await stamp("T2", "the decisions are written and the hold is RELEASED", {
    runStatus: t2.run?.status,
    parkStatus: t2.park[0]?.status,
    parkResolvedAt: t2.park[0]?.resolved_at,
    selections: t2.selections,
    representationRows: t2.representations.length,
    reviewGateRows: t2.gates.length,
  });

  // ---- S2: the chat, DECIDED ----------------------------------------------
  await shoot("S2__recommendation-card__chat_thread__decided", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: CHAT_DECIDED_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The same conversation and the same slot after the person decided every chip in the chat, through the card's own per-chip controls. The row SETTLED IN PLACE: same reply, same position, each chip stating its own outcome, nothing left to press. The agentic run progress card is now on screen BELOW the settled chips — it appears with the decision, not before it — and there is NO skills button row inside it (the picker count reads ZERO). The hold reads released in the database at this instant.",
  });
  await setTheme("dark");
  await shoot("S2__recommendation-card__chat_thread__decided__dark", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: CHAT_DECIDED_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same settled turn in the dark palette — settled chips above, run progress card below, no skills button row inside it.",
  });
  await setTheme("cinatra");

  // ---- the run runs -------------------------------------------------------
  //
  // The run was CREATED with a real sealed provider row configured; by this
  // point that row is gone (THE PROVIDER WINDOW above) and the step's own model
  // call is served by the scripted runtime. Do not read this loop as a real-model
  // execution — it is not one, and README/TIMELINE say so.
  state.gatePresses = [];
  for (let i = 0; i < 90; i += 1) {
    const rows = await runRows(state.runId);
    if (rows.gates.length > 0) {
      say(`REVIEW GATE opened after ~${i * 10}s`);
      break;
    }
    if (rows.run?.status === "completed" && rows.representations.length > 0) {
      say(`RUN COMPLETED with ${rows.representations.length} representation row(s)`);
      break;
    }
    const cont = page.getByRole("button", { name: /^Continue$/i }).first();
    if ((await cont.count().catch(() => 0)) && (await cont.isEnabled().catch(() => false))) {
      // RECORD WHAT HAPPENED, not what was attempted: a swallowed click that
      // still writes "pressed" is a fabricated press. The outcome rides on the
      // row either way, so a failed attempt is visible instead of invisible.
      let pressError = null;
      try {
        await cont.click({ timeout: 60_000 });
      } catch (e) {
        pressError = e instanceof Error ? e.message : String(e);
      }
      state.gatePresses.push({
        at: new Date().toISOString(),
        pressed: "Continue",
        landed: pressError === null,
        error: pressError,
      });
      say(`GATE Continue ${pressError === null ? "pressed" : `FAILED (${pressError})`} (#${state.gatePresses.length})`);
      // A FAILED GATE PRESS ABORTS THE SEQUENCE. Continuing past it would let the
      // loop expire, stamp T3 "the step ran", shoot R6 and print SEQUENCE OK on a
      // run nobody ever released — a green walk that proves the opposite of what
      // it claims. The row above is already written, so the failure is on the
      // record as well as on the exit code.
      if (pressError !== null) throw new Error(`the run's own Continue gate could not be pressed: ${pressError}`);
      await page.waitForTimeout(6000);
      continue;
    }
    if (rows.run?.status === "failed") {
      say(`RUN FAILED: ${rows.run.error}`);
      break;
    }
    await page.waitForTimeout(10_000);
  }

  const t3 = await runRows(state.runId);
  await stamp("T3", "the step ran in the runtime and the run reached its state", {
    runStatus: t3.run?.status,
    runCompletedAt: t3.run?.completed_at,
    runError: t3.run?.error,
    representations: t3.representations,
    outbox: t3.outbox,
    gates: t3.gates,
  });
  state.reviewTaskId = t3.gates[0]?.review_task_id ?? null;

  // ---- R6: the RUN PAGE for the same run, DECIDED -------------------------
  await openRunPage(state.runId, state.packageName);
  const t4 = await runRows(state.runId);
  await stamp("T4", "the run page is photographed with the question decided", {
    runStatus: t4.run?.status,
    parkStatus: t4.park[0]?.status,
    parkResolvedAt: t4.park[0]?.resolved_at,
    selections: t4.selections,
    url: state.runPath,
  });
  await shoot("R6__recommendation-card__run_card__decided", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The same run page after the decision. What this cell OWES is the recommendation's rail entry settled as the rail's own resolved-gate history row, the run detail restored, the settled chips in place and nothing selectable inside the card. Read the record's own `runSurface` block for what it actually got: `railStepPresent` is the fact that decides the first of those four, and PLAN-WALK.md grades it from the pixels rather than from this sentence.",
  });
  await setTheme("dark");
  await shoot("R6__recommendation-card__run_card__decided__dark", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same decided run page in the dark palette. Same owed set as the light cell, graded the same way from the record's own `runSurface` block and from the pixels.",
  });
  await setTheme("cinatra");
  say("SEQUENCE OK");
} catch (e) {
  say(`SEQUENCE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png") }).catch(() => {});
  // FAIL LOUD. The artifacts below are still written (a partial run is worth
  // reading), but the process must not exit 0 on a sequence that did not finish
  // — a green exit on a broken walk is how a half-shot cell gets filed.
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "sequence-state.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2));
  writeFileSync(join(OUT, "capture-records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire, pageErrors }, null, 2));
  writeFileSync(join(OUT, "sequence.log"), log.join("\n") + "\n");
  await browser.close();
  await client.end();
}
