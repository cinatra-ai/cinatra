// ---------------------------------------------------------------------------
// cinatra#2790 S9f (PR #2890) — R6 RE-SHOOT: THE DECIDED RUN PAGE, WITH THE
// SETTLED `Recommendation` RAIL ENTRY THE DRAWING REQUIRES.
//
// WHY THIS FILE EXISTS. `09-chat-and-run-page-sequence.mjs` shot four states of
// one run and filed R6 as a FAIL: once the run left `pending_input` the run
// panel took the card over, the screen stopped hosting it, and the rail entry —
// and with it the whole two-column frame — stopped being drawn. The ratified
// run-surface drawing says a resolved gate stays: "A resolved gate stays on the
// rail as read-only history — its entry keeps its place and records how it was
// settled." `64c0b1412` fixes exactly that (`recommendationRailEntry`), so R6 is
// re-shot HERE, on that code, and NOTHING ELSE IS RE-SHOT: S1, S2 and R5 stand
// as they were recorded, and their records are untouched.
//
// ONE REAL RUN, THE SAME REAL PATH. The pictured run is asked for in the chat,
// parks itself at the recommendation hold, is decided chip by chip through the
// card's own per-chip controls, and dispatches itself. Nothing is seeded and
// nothing is staged: every SQL statement this file issues is a READ. The database
// does change while it runs — the run, the park, the selections, the release — but
// the SERVER writes all of it, through the surfaces this driver presses.
//
// WHAT SERVES THE MODEL, STATED PLAINLY, BECAUSE TWO DIFFERENT THINGS DO.
//
//   · THE CHAT TURN answers on the DETERMINISTIC BRIDGE. The turn carries
//     embedded `inputParams`, which takes the hard pre-router's brace-matched
//     fast path and dispatches server-side without consulting a model at all.
//     A real-model chat turn would need a publicly reachable MCP ingress, which
//     this environment does not have.
//   · THE AGENT'S OWN STEP is attempted FIRST against the REAL sealed
//     `openai_connection` row this lane seeded through the shipped writer
//     (`writeOpenAIConnection`) inside the operator's secret-manager wrapper.
//     The attempt is a REAL RUN, not a rehearsal: it is asked for in the chat
//     and decided the same way the pictured one is. If — and only if — its own
//     model call dies on the provider's fetch of this instance's public MCP
//     toolbox (`424 Failed Dependency` -> `POST /api/llm-bridge 500`, read off
//     the SERVER's own log and bound to that run's own bridge line, because the
//     call is server-to-server and no browser can see it), the
//     connection is removed through the shipped `clearOpenAIConnection`, ON THE
//     CLOCK and on the record, and the PICTURED run is driven after it with the
//     scripted runtime serving that one call. If the real call answers, the
//     first run IS the pictured one and no connection is removed.
//
// The hold, the chips, the decision, the release and the dispatch are the
// server's own shipped path in both attempts; what may be substituted is the
// model behind one call, and the record says which run got which.
//
// EVERY CELL IS THE FULL BROWSER WINDOW at 1440x1700 CSS px, deviceScaleFactor
// 2 — the committed walk contract of this lane. No `clip`, no `fullPage`.
//
// EVERY CELL IS RELOADED BEFORE IT IS PHOTOGRAPHED, so the picture is the
// DURABLE state of that run page rather than a live component caught mid-flight.
//
// EVERY LIFECYCLE TIMESTAMP IS READ FROM A DATABASE COLUMN, never off a screen.
//
// EDITED AFTER THE RUN THAT PRODUCED THE COMMITTED CELLS, and the edits are named
// here so nobody has to diff to find them. A convergence review pointed out three
// things this file did not check, all of them checkable:
//
//   · the chat-turn -> run BINDING. When the inline run panel's link-out does not
//     resolve, the driver falls back to the newest `agent_runs` row — which a
//     concurrent run could win. It now ALSO reads the SERVER's own binding out of
//     the database: the assistant turn in this run's thread carries the
//     pre-router's `agent_run` dispatch part, and that part names the run id. The
//     committed run was checked that way by hand against the database after the
//     fact, and the readback is in `logs/r6-db-readback.txt`.
//   · the HELD CHIP COUNT. The round expects four chips to decide; a run that
//     parked with fewer would have produced a different settled row in silence.
//   · the SELECTION COUNT after release — three kept of four decided, because one
//     is skipped.
//
// A FOURTH edit came out of the same review and is a WORDING fix, not a check: the
// two R6 cell notes claimed `runSurface` carried "the measurement behind every
// clause" of them. It does not — it measures the rail entry, the columns and the
// chip row's containment, not typography, status pills or chip wording. Both notes
// now say which half is measured and which half is read off the picture, here and
// on the committed records (each of which carries a `noteCorrection` saying so).
//
// None of them changes what the recorded run did or what it measured; the recorded
// artifacts are left verbatim.
//
// Usage: node 11-r6-settled-rail-sequence.mjs <appOrigin> <outDir> <repoRoot>
//        env: S9F_EMAIL, S9F_PW, SUPABASE_DB_URL, S9F_RUNTIME_NOTE, S9F_SERVER_LOG
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
/** THE SERVER'S OWN LOG. The agent's model call is a SERVER-TO-SERVER call: the
 *  runtime container posts to `/api/llm-bridge` on the host, so the browser
 *  never sees it and a wire list collected in the page is structurally unable to
 *  answer what the provider did. The bridge names the run it is serving on its
 *  own line (`[llm-bridge-run-select] ... run=<id>`), so the verdict for THIS
 *  run is read out of the running server's log, bound to that id. */
const SERVER_LOG = process.env.S9F_SERVER_LOG ?? null;
if (!APP || !OUT || !REPO_ROOT || !ACTOR.email || !ACTOR.password || !DB) {
  throw new Error(
    "usage: 11-r6-settled-rail-sequence.mjs <appOrigin> <outDir> <repoRoot>; set S9F_EMAIL, S9F_PW, SUPABASE_DB_URL",
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

/** ONE press per chip, in this order, so every mark the drawing names appears. */
const DECISION_ORDER = ["confirm", "adjust", "skip", "confirm"];
/** The four assigned skills all reach the chip row (three scored, one force-added),
 *  and one of the four presses is a SKIP — so four chips are offered and three
 *  selections are written. Both are asserted rather than assumed: a hold that
 *  offered a different number would settle into a different row than the one this
 *  round grades. */
const EXPECTED_HELD_CHIPS = 4;
const EXPECTED_SELECTIONS = 3;

/** The turn that starts the run — verbatim from `09`, so the pictured run is
 *  asked for exactly the way the round's other cells' run was. */
const IDEA = {
  title: "Connector rollout note",
  summary: "The connector ships this week and replaces the manual export step.",
  outline: ["Summary", "Rollout"],
};
const MESSAGE = `Please run cinatra_blog-draft-writer-agent for me with inputParams: ${JSON.stringify({ idea: IDEA })}`;

const client = new pg.Client({ connectionString: DB });
await client.connect();
const q = async (text, values = []) => (await client.query(text, values)).rows;

const timeline = [];
const stamp = async (step, what, rows) => {
  const row = { step, what, at: new Date().toISOString(), db: rows };
  timeline.push(row);
  say(`TIMELINE ${step} ${what} ${JSON.stringify(rows)}`);
  return row;
};

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
const VIEWPORT = { width: 1440, height: 1700 };
const ctx = await browser.newContext({ viewport: { ...VIEWPORT }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
/** The lifecycle wire, presence + status only — never a body, never a value. */
const wire = [];
page.on("response", (res) => {
  const p = new URL(res.url()).pathname;
  if (
    p.startsWith("/api/lifecycle-views/") ||
    p.startsWith("/api/chat") ||
    p.startsWith("/api/assistants")
  )
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

/** THE RUN PAGE'S SET — identical to `09`'s, so the new R6 records are directly
 *  comparable, cell for cell, with the R5 pair and with the R6 pair they replace. */
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

/**
 * THE RUN PAGE'S OWN READOUT — every claim this cell makes, MEASURED, with the
 * same field names `09` used so the pair that replaces its R6 can be diffed
 * against it line for line.
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
          railStepIndicatorText: step?.querySelector(indicatorSel)?.textContent.trim() ?? null,
          // THE COMPLETED READING, measured rather than described: the circle's
          // own text (empty — the numeral is replaced by the check glyph) and
          // whether the title carries a highlight class at all.
          railStepIndicatorHasCheckGlyph: Boolean(
            step?.querySelector(indicatorSel)?.querySelector("svg"),
          ),
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
 * STATED BECAUSE IT IS A SHORTCUT, verbatim from `09`: it writes only the class
 * next-themes writes, and no assertion in this file reads a class.
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

/** THE SHUTTER. Always the FULL BROWSER WINDOW — no `fullPage`, no `clip`. */
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
    transcript: null,
    runSurface,
    themeClass: theme,
    framing: "window",
    viewport: { ...page.viewportSize(), deviceScaleFactor: 2 },
    pageErrors: [...pageErrors],
    ...extra,
  });
  results.push({ cell, pixels: dims, sha256, observed, rootAttributes: attrs, chips, runSurface, themeClass: theme });
  say(
    `CAP ${cell} ${dims.width}x${dims.height} chips=${chips.length} railStep=${runSurface?.railStepPresent} settled=${runSurface?.railStepSettled} railCol=${runSurface?.railColumnPresent}`,
  );
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
  await page
    .evaluate((listSel) => {
      const list = document.querySelector(listSel);
      if (!list) return;
      list.scrollIntoView({ block: "start", behavior: "instant" });
      window.scrollTo(0, 0);
    }, CONVERSATION_LIST)
    .catch(() => {});
  await page.waitForTimeout(1200);
}

/** Ask for the agent in the chat, and do not call the turn sent until it is IN
 *  the transcript. A composer that re-mounts under the `/chat` redirect drops
 *  what was typed into the previous mount. */
async function askForTheAgent() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
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
        .evaluate((s) => (document.querySelector(s)?.innerText ?? "").includes("blog-draft-writer-agent"), CONVERSATION_LIST)
        .catch(() => false);
      if (inTranscript) return true;
    }
    say(`TURN attempt ${attempt + 1}: never reached the transcript`);
  }
  return false;
}

/**
 * Drive ONE run from the chat turn to the end of its own execution, and hand
 * back everything measured about it. The pictures are taken by the CALLER, on
 * whichever attempt is the one that gets photographed.
 *
 * `beforeDecision` runs AFTER the hold is parked and BEFORE the first chip is
 * pressed. That is the only moment where the provider connection can be removed
 * without breaking something: the chat turn that starts a run needs a configured
 * provider to reach its pre-router at all (measured here — with no connection the
 * assistant answers "The configured default LLM provider \"openai\" is not
 * available" and no run is created), and every model call still AHEAD of this
 * point belongs to the agent's own step.
 */
async function driveOneRun(label, { beforeDecision = null } = {}) {
  if (!(await askForTheAgent())) throw new Error(`${label}: the turn never reached the transcript`);
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  for (let i = 0; i < 60; i += 1) {
    const st = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state"), CARD_ROOT);
    if (st === "held") break;
    await page.waitForTimeout(2000);
  }
  const threadPath = new URL(page.url()).pathname;
  // THE RUN ID COMES OFF THE PAGE, from the inline run panel's own link out —
  // the platform builds that href from the run id, so it names the run THIS turn
  // dispatched rather than "whatever ran last".
  const linked = await page
    .evaluate(() => {
      const a = document.querySelector('[data-testid="inline-run-page-link"]');
      const m = (a?.getAttribute("href") ?? "").match(/([0-9a-fA-F-]{36})$/);
      return m ? m[1] : null;
    })
    .catch(() => null);
  const runId = linked ?? (await q(`select id from cinatra.agent_runs order by created_at desc limit 1`))[0]?.id;
  const runIdSource = linked ? "inline-run-page-link" : "newest agent_runs row";
  const [tplRow] = await q(
    `select t.package_name from cinatra.agent_runs r join cinatra.agent_templates t on t.id = r.template_id where r.id=$1`,
    [runId],
  );
  const packageName = String(tplRow?.package_name ?? "@cinatra-ai/blog-draft-writer-agent");
  // THE SERVER'S OWN BINDING between the typed turn and this run: the assistant
  // turn in THIS thread carries the pre-router's `agent_run` dispatch part, and
  // that part names the run id. It is the strong binding whether or not the
  // link-out resolved, because the server wrote it rather than the driver.
  const threadId = threadPath.split("/").pop();
  const [bound] = await q(
    `select id from cinatra.assistant_turns
      where thread_id = $1 and role = 'assistant'
        and content::text like '%' || $2 || '%'
        and content::text like '%explicit_dispatch_pre_router%'
      limit 1`,
    [threadId, runId],
  );
  const dispatchBinding = {
    threadId,
    boundByTheServer: Boolean(bound),
    turnId: bound?.id ?? null,
  };
  say(
    `${label}: RUN ${runId} in thread ${threadPath} (${packageName}, id from ${runIdSource}; ` +
      `server dispatch binding: ${dispatchBinding.boundByTheServer})`,
  );
  if (!dispatchBinding.boundByTheServer) {
    throw new Error(
      `${label}: no assistant turn in ${threadPath} names run ${runId} as its dispatch — the run this driver ` +
        `picked up is not provably the one this turn started`,
    );
  }

  await openThread(threadPath);
  const held = await runRows(runId);
  await stamp(`${label}/T1`, "held at the recommendation hold; the run has produced NOTHING", {
    runStatus: held.run?.status,
    parkCheckpoint: held.park[0]?.checkpoint,
    parkStatus: held.park[0]?.status,
    parkCreatedAt: held.park[0]?.created_at,
    representationRows: held.representations.length,
    reviewGateRows: held.gates.length,
    selectionRows: held.selections.length,
  });
  if (held.park[0]?.status !== "parked") throw new Error(`${label}: the hold never parked`);

  if (beforeDecision) await beforeDecision({ label, runId, threadPath });

  // ---- the decision, chip by chip, IN THE CHAT ----------------------------
  const heldChips = await chipReadout();
  if (heldChips.length !== EXPECTED_HELD_CHIPS) {
    throw new Error(
      `${label}: the hold offered ${heldChips.length} chips, not ${EXPECTED_HELD_CHIPS} — the settled row this round ` +
        `grades would not be the row it describes`,
    );
  }
  const presses = [];
  for (let i = 0; i < heldChips.length; i += 1) {
    const skillId = heldChips[i].skillId;
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
    presses.push({ skillId, action, cardStateAfter: after, at: new Date().toISOString() });
    say(`${label}: PRESS ${action} on ${skillId} -> card state ${after}`);
  }
  await page.waitForTimeout(12_000);

  const decided = await runRows(runId);
  if (decided.park[0]?.status !== "released") throw new Error(`${label}: the hold did not release`);
  if (decided.selections.length !== EXPECTED_SELECTIONS) {
    throw new Error(
      `${label}: ${decided.selections.length} selections were written, not ${EXPECTED_SELECTIONS} — one of the four ` +
        `presses is skipped, so three are kept`,
    );
  }
  await stamp(`${label}/T2`, "the decisions are written and the hold is RELEASED", {
    runStatus: decided.run?.status,
    parkStatus: decided.park[0]?.status,
    parkResolvedAt: decided.park[0]?.resolved_at,
    selections: decided.selections,
  });

  // ---- the run runs -------------------------------------------------------
  const gatePresses = [];
  for (let i = 0; i < 90; i += 1) {
    const rows = await runRows(runId);
    if (rows.gates.length > 0) {
      say(`${label}: REVIEW GATE opened after ~${i * 10}s`);
      break;
    }
    if (rows.run?.status === "completed" && rows.representations.length > 0) {
      say(`${label}: RUN COMPLETED with ${rows.representations.length} representation row(s)`);
      break;
    }
    const cont = page.getByRole("button", { name: /^Continue$/i }).first();
    if ((await cont.count().catch(() => 0)) && (await cont.isEnabled().catch(() => false))) {
      let pressError = null;
      try {
        await cont.click({ timeout: 60_000 });
      } catch (e) {
        pressError = e instanceof Error ? e.message : String(e);
      }
      gatePresses.push({ at: new Date().toISOString(), pressed: "Continue", landed: pressError === null, error: pressError });
      say(`${label}: GATE Continue ${pressError === null ? "pressed" : `FAILED (${pressError})`} (#${gatePresses.length})`);
      if (pressError !== null) throw new Error(`${label}: the run's own Continue gate could not be pressed: ${pressError}`);
      await page.waitForTimeout(6000);
      continue;
    }
    if (rows.run?.status === "failed") {
      say(`${label}: RUN FAILED: ${rows.run.error}`);
      break;
    }
    await page.waitForTimeout(10_000);
  }

  const done = await runRows(runId);
  await stamp(`${label}/T3`, "the step ran in the runtime and the run reached its state", {
    runStatus: done.run?.status,
    runCompletedAt: done.run?.completed_at,
    runError: done.run?.error,
    representations: done.representations,
    outbox: done.outbox,
    gates: done.gates,
  });
  return { label, runId, runIdSource, dispatchBinding, threadPath, packageName, heldChips, presses, gatePresses, rows: done };
}

/**
 * THE PROVIDER'S OWN LIMIT ON THIS MACHINE, READ OFF THE SERVER, BOUND TO THE RUN.
 *
 * The bridge prints `[llm-bridge-run-select] … run=<id>` for the call it is about
 * to serve, and — when the provider cannot fetch this instance's public MCP
 * toolbox — `[llm-bridge] LLM task failed: … (HTTP 424 Failed Dependency) …` right
 * after it, followed by `POST /api/llm-bridge 500`. This reads THAT window: the
 * lines after the run's own select line, so the verdict cannot be borrowed from
 * another run's failure.
 */
function bridgeVerdictFor(runId) {
  if (!SERVER_LOG) return { readable: false, why: "no S9F_SERVER_LOG given", lines: [] };
  let text = "";
  try {
    text = readFileSync(SERVER_LOG, "utf8");
  } catch (e) {
    return { readable: false, why: e instanceof Error ? e.message : String(e), lines: [] };
  }
  const lines = text.split("\n");
  const window = [];
  let inRun = false;
  for (const line of lines) {
    if (line.includes("[llm-bridge-run-select]")) inRun = line.includes(`run=${runId}`);
    if (!inRun) continue;
    if (line.includes("[llm-bridge]") || line.includes("POST /api/llm-bridge") || line.includes("[llm-bridge-run-select]"))
      window.push(line.trim().slice(0, 400));
  }
  return {
    readable: true,
    served: window.length > 0,
    lines: window.slice(0, 12),
    non2xx: window.some((l) => /POST \/api\/llm-bridge (4|5)\d\d/.test(l)),
    namesThePublicMcpFetch: window.some((l) => /424 Failed Dependency|public MCP server/i.test(l)),
  };
}

/** The run died on the provider's fetch of this instance's public MCP toolbox —
 *  recognised from what the SERVER wrote for THIS run, never assumed. */
function diedOnThePublicMcpFetch(attempt) {
  const bridge = bridgeVerdictFor(attempt.runId);
  const error = String(attempt.rows.run?.error ?? "").slice(0, 400);
  return {
    bridge,
    error,
    verdict: Boolean(bridge.readable && bridge.non2xx && bridge.namesThePublicMcpFetch),
  };
}

const state = { attempts: [] };
try {
  say(`# cinatra#2790 S9f — the R6 settled-rail sequence — ${new Date().toISOString()}`);
  say(`after sign-in: ${await signIn()}`);

  // ---- ATTEMPT 1: the REAL sealed provider --------------------------------
  const first = await driveOneRun("real-provider");
  state.attempts.push({
    label: first.label,
    runId: first.runId,
    runIdSource: first.runIdSource,
    dispatchBinding: first.dispatchBinding,
    threadPath: first.threadPath,
    status: first.rows.run?.status,
    error: String(first.rows.run?.error ?? "").slice(0, 400),
    bridge: bridgeVerdictFor(first.runId),
    presses: first.presses,
    gatePresses: first.gatePresses,
  });

  let pictured = first;
  const died = diedOnThePublicMcpFetch(first);
  state.realProviderOutcome = died;
  if (first.rows.run?.status !== "completed" && died.verdict) {
    // ---- THE PROVIDER WINDOW, AND WHERE IT HAS TO SIT --------------------
    //
    // Measured, not assumed: the run above was a REAL run with the REAL sealed
    // connection configured, and its own model call died on the provider's fetch
    // of this instance's public MCP toolbox — this machine has no public MCP
    // ingress for the provider to reach. So the connection is removed through
    // the SHIPPED `clearOpenAIConnection` and the PICTURED run's one model call
    // is served by the scripted runtime (#2917), which
    // `resolveConfiguredLlmRuntime()` reaches only as its last resort.
    //
    // THE REMOVAL SITS INSIDE THE PICTURED RUN, AT ITS HOLD — not before its
    // chat turn. The turn that STARTS a run needs a configured provider to reach
    // its pre-router at all; with the row already gone the assistant answers
    // "The configured default LLM provider \"openai\" is not available" and no
    // run is created (measured on this lane, on the attempt that tried it the
    // other way round). At the hold the run exists, no model has been consulted
    // — the turn took the hard pre-router's deterministic path — and every model
    // call still ahead belongs to the agent's own step.
    const second = await driveOneRun("scripted-runtime", {
      beforeDecision: async ({ runId }) => {
        const clearOut = execFileSync(
          "npx",
          ["vitest", "run", "--config", "evidence/2790-s9f-host-parity/drivers/06-chat-lane-fixture.config.ts"],
          { cwd: REPO_ROOT, env: { ...process.env, WALK_STEP: "PROVIDER_CLEAR" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        const clearLine = clearOut.split("\n").find((l) => l.includes("S9FCHAT PROVIDER_CLEAR")) ?? "";
        await stamp(
          "T1c",
          "the REAL provider connection is removed, at the pictured run's own hold, after a REAL run measured the limit here — the provider could not fetch this instance's public MCP toolbox — so the step's one model call resolves the scripted runtime",
          {
            shippedWriter: "clearOpenAIConnection",
            readBack: clearLine.trim(),
            measuredOn: first.runId,
            measured: died,
            removedWhilePicturedRunParked: runId,
          },
        );
      },
    });
    state.attempts.push({
      label: second.label,
      runId: second.runId,
      runIdSource: second.runIdSource,
    dispatchBinding: second.dispatchBinding,
      threadPath: second.threadPath,
      status: second.rows.run?.status,
      error: String(second.rows.run?.error ?? "").slice(0, 400),
      bridge: bridgeVerdictFor(second.runId),
      presses: second.presses,
      gatePresses: second.gatePresses,
    });
    pictured = second;
  }

  state.runId = pictured.runId;
  state.threadPath = pictured.threadPath;
  state.packageName = pictured.packageName;
  state.heldChips = pictured.heldChips;
  state.decisionPresses = pictured.presses;
  state.gatePresses = pictured.gatePresses;
  state.picturedAttempt = pictured.label;
  state.dispatchBinding = pictured.dispatchBinding;
  state.runtimeBehindTheStepsModelCall =
    pictured.label === "real-provider"
      ? "the REAL sealed openai_connection row this lane seeded through the shipped writer"
      : "the scripted runtime (#2917), reached as resolveConfiguredLlmRuntime()'s last resort after the real connection was removed";

  // ---- R6: the RUN PAGE for the pictured run, DECIDED ---------------------
  state.runPath = await openRunPage(pictured.runId, pictured.packageName);
  const t4 = await runRows(pictured.runId);
  await stamp("T4", "the run page is photographed with the question decided", {
    runStatus: t4.run?.status,
    parkStatus: t4.park[0]?.status,
    parkResolvedAt: t4.park[0]?.resolved_at,
    selections: t4.selections,
    url: state.runPath,
  });
  if (t4.park[0]?.status !== "released") throw new Error("R6 precondition broken: the hold is not released");

  await setTheme("cinatra");
  await shoot("R6__recommendation-card__run_card__decided", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: pictured.runId,
    dbAt: timeline.at(-1),
    note:
      "The run page for THIS run after its recommended skills were decided in the chat. What the drawing owes here is one sentence — “A resolved gate stays on the rail as read-only history — its entry keeps its place and records how it was settled” — and this cell is where it is read: the `Recommendation` entry is still on the rail down the LEFT, in the place it held while the question was live, drawn in its COMPLETED reading (the numeral replaced by the check in the circle, the title unhighlighted because the row is no longer the selected one). The run detail on the RIGHT is the run's own panel, not the gate's surface: a settled entry opens nothing of its own, because the decided summary it stands for is already inside that panel. The chips in it state their outcomes and nothing inside the card can be pressed — the three per-chip action counts all read 0 inside the card root. Read `runSurface` on this record for what was MEASURED of it: the entry's presence and its place in `railRowLabels`, its settled/selected attributes, its indicator's empty text and check glyph, the two instrumented columns, and where the chip row sits. The rest of the sentence above - the title's weight, the pill, the chip wording, the Error block and the controls under it - is a reading of the PIXELS, and `PLAN-WALK.md` grades it that way, on that side of the line.",
    extra: { picturedAttempt: pictured.label, modelBehindTheStep: state.runtimeBehindTheStepsModelCall },
  });
  await setTheme("dark");
  await shoot("R6__recommendation-card__run_card__decided__dark", {
    host: "run_card",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RUN_PAGE_ASSERTIONS,
    runId: pictured.runId,
    dbAt: timeline.at(-1),
    note:
      "The same decided run page, same run, same window, in the dark palette: the settled `Recommendation` entry still on the rail with its check, the run's own panel in the run detail beside it, the settled chips with nothing left to press. Same owed set as the light cell, and split the same way: the rail entry, the columns and the chip row's containment are MEASURED on this record's own `runSurface`; the palette, the pill and the chip wording are read off the picture.",
    extra: { picturedAttempt: pictured.label, modelBehindTheStep: state.runtimeBehindTheStepsModelCall },
  });
  await setTheme("cinatra");
  say("SEQUENCE OK");
} catch (e) {
  say(`SEQUENCE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png") }).catch(() => {});
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
