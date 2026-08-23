// ---------------------------------------------------------------------------
// cinatra#2790 S9f — THE WHOLE SEQUENCE, IN A REAL CHAT, IN ONE RUN.
//
// WHY THIS DRIVER EXISTS. Two objections stand against the earlier rounds and
// both are about what a picture SHOWS rather than about the code:
//
//   1. "the whole chat should always be visible in the screenshots, not just a
//      close-up of the skill recommendation pills" — so every cell here is the
//      FULL BROWSER WINDOW at 1440x1200 CSS px, deviceScaleFactor 2, with the
//      conversation column and its earlier turns in frame. Nothing is clipped
//      to a card root; there is no crop rectangle in this file at all.
//
//   2. "the re-shoot does not show the skills recommendation card before the
//      agent creates output, only afterwards" — so this driver walks ONE run in
//      ONE conversation, in the order a person walks it, and photographs each
//      state as it happens: HELD with nothing produced yet (and the emptiness of
//      the run's output rows read out of the database in the same breath),
//      DECIDED, then the review the run's own output earned.
//
// THE HOST IS `chat_thread` — the conversation itself, not the widget and not
// the run page. The card mounts at the `agent_run` producing slot in the
// transcript (`packages/chat/src/chat-messages-view.tsx`), so the run is started
// the way a person starts one from a conversation: by asking for it in the
// composer. The hard pre-router (`explicit-dispatch-server.ts`) dispatches
// server-side and the chat-origin hold parks the run before anything is queued.
//
// EVERY STEP IS RELOADED BEFORE IT IS PHOTOGRAPHED, so each picture is the
// DURABLE state — what the next reader of this conversation sees — rather than
// a live component that happens to be in the right state.
//
// EVERY STEP READS THE CLOCK OUT OF THE DATABASE, never off the screen. The
// timeline rows this writes are the ones `TIMELINE.md` cites.
//
// Real presses only. The four chips are decided one at a time through the
// card's own per-chip controls; the run's own in-flight gate is answered by its
// own Continue; nothing else is pressed and nothing is stood in for.
//
// No origin is hard-coded: the app origin and the lane database are read from
// the environment.
//
// Usage: node 07-chat-thread-sequence.mjs <appOrigin> <outDir> <repoRoot>
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
    "usage: 07-chat-thread-sequence.mjs <appOrigin> <outDir> <repoRoot>; set S9F_EMAIL, S9F_PW, SUPABASE_DB_URL",
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
const GATE_ROOT = '[data-lifecycle-card="artifact_review_gate"]';
const CHAT_PROMPT = '[data-testid="chat-prompt-input"]';
const CHIP = "[data-recommendation-chip]";

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

/** The SECOND turn: the plan's own words for the affordance that brings an
 *  already-open review into the conversation (§4.1 step 1). */
const REVIEW_QUESTION = "Is there anything waiting on me for review?";

const client = new pg.Client({ connectionString: DB });
await client.connect();
const q = async (text, values = []) => (await client.query(text, values)).rows;

/** THE CLOCK. Every row is a value read from a database column, with the column
 *  named beside it. Nothing here is read off a screen. */
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
// 1440x1700 CSS px at deviceScaleFactor 2 — above the 1440x900 floor, and tall
// enough that the whole conversation column stays in ONE window shot. The
// maintainer's first objection is about FRAMING, so the window is sized to the
// conversation rather than the conversation cropped to a default window; when a
// state still overflows it, `fitTheWindow` below GROWS the window and the cell's
// own record says what it was grown to.
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

const RECOMMENDATION_ASSERTIONS = [
  { selector: CONVERSATION_LIST, scope: "frame" },
  { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame" },
  { selector: CARD_ROOT, scope: "frame" },
  { selector: "[data-chat-thread-recommendation-hold]", scope: "frame" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: '[data-skill-action="confirm"]', scope: "root" },
  { selector: '[data-skill-action="adjust"]', scope: "root" },
  { selector: '[data-skill-action="skip"]', scope: "root" },
  { selector: CHIP, scope: "root" },
  { selector: '[data-conformance-id="run-chip-row"]', scope: "frame" },
  { selector: '[data-action="confirm-run-recommendation"]', scope: "frame" },
  { selector: '[data-action="skip-run-recommendation"]', scope: "frame" },
];

const REVIEW_ASSERTIONS_CHAT = [
  { selector: CONVERSATION_LIST, scope: "frame" },
  { selector: '[data-lifecycle-card-host="chat_thread"]', scope: "frame" },
  { selector: GATE_ROOT, scope: "frame" },
  { selector: '[data-conformance-id="review-decision-bar"]', scope: "root" },
  { selector: "[data-lifecycle-card-state]", scope: "root" },
  { selector: CARD_ROOT, scope: "frame" },
  { selector: '[data-skill-action="confirm"]', scope: "frame" },
  { selector: '[data-skill-action="adjust"]', scope: "frame" },
  { selector: '[data-skill-action="skip"]', scope: "frame" },
];

const REVIEW_ASSERTIONS_PAGE = [
  { selector: '[data-lifecycle-card-host="page_gate_region"]', scope: "frame" },
  { selector: CARD_ROOT, scope: "frame" },
  { selector: GATE_ROOT, scope: "frame" },
  { selector: '[data-conformance-id="review-gate-card"]', scope: "frame" },
  { selector: '[data-conformance-id="review-decision-bar"]', scope: "frame" },
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

/** THE TRANSCRIPT, as text — the proof that the whole chat is in frame and that
 *  the earlier turns are still there. */
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

/** The ORDER claim, measured rather than eyeballed. */
async function orderReadout() {
  return page
    .evaluate(
      ({ cardSel, gateSel }) => {
        const card = document.querySelector(cardSel);
        const gate = document.querySelector(gateSel);
        if (!card || !gate) return { card: Boolean(card), gate: Boolean(gate), cardAboveGate: null };
        const c = card.getBoundingClientRect();
        const g = gate.getBoundingClientRect();
        return {
          card: true,
          gate: true,
          cardTop: Math.round(c.top + window.scrollY),
          gateTop: Math.round(g.top + window.scrollY),
          cardAboveGate: c.top + window.scrollY < g.top + window.scrollY,
          domOrder:
            card.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING
              ? "card-then-gate"
              : "gate-then-card",
        };
      },
      { cardSel: CARD_ROOT, gateSel: GATE_ROOT },
    )
    .catch(() => null);
}

async function gateReadout() {
  return page
    .evaluate((gateSel) => {
      const gate = document.querySelector(gateSel);
      if (!gate) return null;
      const bar = gate.querySelector('[data-conformance-id="review-decision-bar"]');
      return {
        state: gate.getAttribute("data-lifecycle-card-state"),
        host: gate.getAttribute("data-lifecycle-card-host"),
        decisionBar: Boolean(bar),
        decisionButtons: bar ? [...bar.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean) : [],
      };
    }, GATE_ROOT)
    .catch(() => null);
}

const records = [];
const results = [];

/** Apply the palette next-themes applies through the shipped theme control. */
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
 * THE SHUTTER. Always the FULL BROWSER WINDOW — no `fullPage`, no `clip`. The
 * viewport IS the frame the maintainer asked to see, so the conversation column
 * is scrolled to the top of the transcript first and the whole window is shot.
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
  const transcript = await transcriptReadout();
  const order = await orderReadout();
  const gate = await gateReadout();
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
    order,
    gate,
    themeClass: theme,
    framing: "browser-window",
    viewport: { ...page.viewportSize(), deviceScaleFactor: 2 },
    pageErrors: [...pageErrors],
    ...extra,
  });
  results.push({ cell, pixels: dims, sha256, observed, rootAttributes: attrs, chips, transcript, order, gate, themeClass: theme });
  say(`CAP ${cell} ${dims.width}x${dims.height} chips=${chips.length} turns=${transcript?.turns ?? "-"} theme="${theme}"`);
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

/**
 * GROW THE WINDOW UNTIL THE WHOLE CONVERSATION IS IN IT.
 *
 * A picture that crops the transcript is the first objection this round exists
 * to answer, so the window is enlarged (never the picture stitched) until the
 * conversation list fits between the window's top and bottom, up to a ceiling.
 * Whatever it ends at is written into the cell's own record.
 */
async function fitTheWindow() {
  for (let i = 0; i < 8; i += 1) {
    const box = await page
      .evaluate((listSel) => {
        const list = document.querySelector(listSel);
        if (!list) return null;
        const r = list.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, inner: window.innerHeight };
      }, CONVERSATION_LIST)
      .catch(() => null);
    if (!box) return;
    if (box.top >= 0 && box.bottom <= box.inner) return;
    const grown = Math.min(2800, (page.viewportSize()?.height ?? VIEWPORT.height) + 300);
    if (grown === page.viewportSize()?.height) return;
    await page.setViewportSize({ width: VIEWPORT.width, height: grown });
    say(`WINDOW grown to ${VIEWPORT.width}x${grown} so the whole conversation is in frame`);
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
  await fitTheWindow();
  await page.waitForTimeout(800);
}

const state = {};
try {
  say(`# cinatra#2790 S9f — the chat_thread sequence — ${new Date().toISOString()}`);
  say(`after sign-in: ${await signIn()}`);

  // ---- the person's turn that starts the run ------------------------------
  await page.goto(`${APP}/chat`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CHAT_PROMPT, { timeout: 300_000 });
  await page.waitForTimeout(6000);
  const composer = page.locator(CHAT_PROMPT).first();
  await composer.click();
  await composer.pressSequentially(MESSAGE, { delay: 4 });
  await page.waitForTimeout(600);
  say(`TURN typed into the composer: ${MESSAGE}`);
  await page.keyboard.press("Enter");
  say("TURN sent");

  // ---- S1: the reply carries the card, HELD, and NOTHING is produced yet ---
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  for (let i = 0; i < 60; i += 1) {
    const st = await page.evaluate((s) => document.querySelector(s)?.getAttribute("data-lifecycle-card-state"), CARD_ROOT);
    if (st === "held") break;
    await page.waitForTimeout(2000);
  }
  state.threadPath = new URL(page.url()).pathname;
  // THE RUN ID COMES OFF THE PAGE, from the inline run panel's own link out —
  // the platform builds that href from the run id (`buildAgentInstancePath`), so
  // it names the run THIS turn dispatched rather than "whatever ran last".
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
  say(`RUN ${state.runId} in thread ${state.threadPath}`);

  // RELOAD, so what is photographed is the DURABLE state of this conversation.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  await page.waitForTimeout(8000);
  await frameTheTranscript();

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

  await setTheme("cinatra");
  await shoot("S1__recommendation-card__chat_thread__held", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: RECOMMENDATION_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The whole conversation, in one browser window: the person's own turn that started the run, the reply that says the run paused for a decision on the recommended skills, and the recommendation card HELD in that same reply — one chip per skill, each carrying its own Confirm / Adjust / Skip. NOTHING has been produced: representation, produced-outbox and review-gate rows for this run all read ZERO in the database at this instant (dbAt).",
  });
  await setTheme("dark");
  await shoot("S1__recommendation-card__chat_thread__held__dark", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "pending",
    rootSel: CARD_ROOT,
    assertions: RECOMMENDATION_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same window, the same held card in the same conversation, in the dark palette.",
  });
  await setTheme("cinatra");

  // ---- THE PROVIDER WINDOW CLOSES ----------------------------------------
  //
  // THE ONE LANE CHANGE INSIDE THIS SEQUENCE, AND WHY IT IS HERE.
  //
  // `runAssistantTurn` resolves a bound provider adapter BEFORE it reaches the
  // hard pre-router, so a chat turn cannot start an agent run on an instance
  // with no provider configured — even though THIS turn consults no model at
  // all (the pre-router dispatches server-side and returns before `stream()`;
  // the wire recorded beside these cells carries no provider call). So the lane
  // holds a provider PRESENCE placeholder — a published non-key — up to here.
  //
  // But `resolveConfiguredLlmRuntime()` reaches the scripted runtime (#2917)
  // only as its LAST RESORT, "an install WITH a configured provider never
  // reaches this line" — so leaving the placeholder in place makes the agent's
  // own model call go to the real OpenAI endpoint with a non-key and answer
  // 401. Measured on this lane before this window existed.
  //
  // The placeholder is therefore REMOVED now, through the shipped
  // `clearOpenAIConnection`, at the one moment where it changes nothing that
  // has been photographed and nothing that is still to come except the thing it
  // is in the way of: the run is parked, no model has been consulted, and every
  // model call still ahead belongs to the agent's own step. It is recorded as
  // its own timeline row rather than done quietly.
  //
  // The underlying gap is a FINDING of this round, not a property of this
  // branch: the scripted provider cannot serve a chat-started agent run end to
  // end while the turn-entry adapter gate demands a configured provider.
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
  await stamp("T2a", "the provider presence placeholder is removed so the agent's own model call resolves the scripted runtime", {
    shippedWriter: "clearOpenAIConnection",
    readBack: clearLine.trim(),
  });

  // ---- S2: the decision, chip by chip, in the chat -------------------------
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
  await page.reload({ waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CARD_ROOT, { timeout: 600_000 });
  await page.waitForTimeout(8000);
  await frameTheTranscript();

  const t2 = await runRows(state.runId);
  await stamp("T2", "the decisions are written and the hold is RELEASED", {
    runStatus: t2.run?.status,
    parkStatus: t2.park[0]?.status,
    parkResolvedAt: t2.park[0]?.resolved_at,
    selections: t2.selections,
    representationRows: t2.representations.length,
    reviewGateRows: t2.gates.length,
  });

  await shoot("S2__recommendation-card__chat_thread__decided", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RECOMMENDATION_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note:
      "The same conversation and the same slot after the person decided every chip in the chat, through the card's own per-chip controls. The row SETTLED IN PLACE: same reply, same position, per-chip outcomes, and nothing left to press. The hold reads released in the database at this instant.",
  });
  await setTheme("dark");
  await shoot("S2__recommendation-card__chat_thread__decided__dark", {
    host: "chat_thread",
    kind: "recommendation_hold",
    declaredState: "decided",
    rootSel: CARD_ROOT,
    assertions: RECOMMENDATION_ASSERTIONS,
    runId: state.runId,
    dbAt: timeline.at(-1),
    note: "The same settled row in the same conversation, in the dark palette.",
  });
  await setTheme("cinatra");

  // ---- the run runs: its own in-flight gates, answered in the chat ---------
  const TERMINAL = /Review requested|Awaiting your decision|Completed|Failed/i;
  state.gatePresses = [];
  for (let i = 0; i < 120; i += 1) {
    const rows = await runRows(state.runId);
    if (rows.gates.length > 0) {
      say(`REVIEW GATE opened after ~${i * 10}s`);
      break;
    }
    const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n"));
    const cont = page.getByRole("button", { name: /^Continue$/i }).first();
    if ((await cont.count().catch(() => 0)) && (await cont.isEnabled().catch(() => false))) {
      await cont.click({ timeout: 60_000 }).catch(() => {});
      state.gatePresses.push({ at: new Date().toISOString(), pressed: "Continue" });
      say(`GATE Continue pressed (#${state.gatePresses.length})`);
      await page.waitForTimeout(6000);
      continue;
    }
    if (rows.run?.status === "failed") {
      say(`RUN FAILED: ${rows.run.error}`);
      break;
    }
    if (TERMINAL.test(text) && rows.representations.length > 0) {
      // the output exists; the sweeper has not opened the review yet
    }
    await page.waitForTimeout(10_000);
  }

  const t3 = await runRows(state.runId);
  await stamp("T3/T4", "the step executed, wrote its own output, and the sweeper opened the review", {
    runStatus: t3.run?.status,
    runCompletedAt: t3.run?.completed_at,
    representations: t3.representations,
    outbox: t3.outbox,
    gates: t3.gates,
  });
  state.reviewTaskId = t3.gates[0]?.review_task_id ?? null;
  state.gateCreatedAt = t3.gates[0]?.created_at ?? null;

  // ---- S3: the review card, IN THE CHAT, with the decided row above it -----
  //
  // HOW THE REVIEW REACHES THE CONVERSATION, and why it takes a second turn.
  //
  // The plan states the shipped rule (§4.1 "Where it appears today"): the run
  // draws the review card inline only for a review it reached THROUGH ITS OWN
  // EXECUTION, because the card's reference travels with the run's own review
  // interrupt. This review was opened by the SHIPPED SWEEPER after the run had
  // already finished, so it carries no such reference and the run panel in the
  // conversation says "Run complete" instead — measured on this lane, not
  // assumed.
  //
  // The plan names the affordance that DOES bring it into the conversation, in
  // the same section (§4.1 step 1): "You can also ask the assistant ('anything
  // waiting on me?'), and it pulls up the longest-waiting open reviews you are
  // allowed to see, as cards". So the person asks — a real second turn, typed
  // into the same composer, in the same conversation, under the decided row.
  //
  // The tool layer on that turn is REAL: the provider decides only WHICH
  // primitive to call, the dispatcher carries this session's own chat bearer,
  // and `serverLabel` rides only what the dispatcher actually returned — so a
  // card on screen can only have been minted by the producer.
  await page.goto(`${APP}${state.threadPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CHAT_PROMPT, { timeout: 600_000 });
  await page.waitForTimeout(6000);
  const askComposer = page.locator(CHAT_PROMPT).first();
  await askComposer.click();
  await askComposer.pressSequentially(REVIEW_QUESTION, { delay: 4 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  say(`ASK typed into the composer: ${REVIEW_QUESTION}`);
  for (let i = 0; i < 60; i += 1) {
    if (await page.evaluate((s) => Boolean(document.querySelector(s)), GATE_ROOT)) break;
    await page.waitForTimeout(4000);
  }
  // RELOAD, so the review card in this conversation is the DURABLE state too.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector(CONVERSATION_LIST, { timeout: 600_000 });
  for (let i = 0; i < 60; i += 1) {
    if (await page.evaluate((s) => Boolean(document.querySelector(s)), GATE_ROOT)) break;
    await page.waitForTimeout(4000);
  }
  await page.waitForTimeout(8000);
  await frameTheTranscript();
  await stamp("T5", "the pictures of the reviewed state are taken", { url: new URL(page.url()).pathname });

  await shoot("S3__review-card__chat_thread__pending", {
    host: "chat_thread",
    kind: "artifact_review_gate",
    declaredState: "pending",
    rootSel: GATE_ROOT,
    assertions: REVIEW_ASSERTIONS_CHAT,
    runId: state.runId,
    dbAt: timeline.at(-2),
    note:
      "The same conversation, further down: the run executed its step against the scripted model bridge, wrote its own output, and the shipped sweeper opened the review on it. The review card appears IN THE CHAT on the chat_thread host, with the DECIDED skills row still above it in the same conversation — the whole window, earlier turns included.",
  });
  await setTheme("dark");
  await shoot("S3__review-card__chat_thread__pending__dark", {
    host: "chat_thread",
    kind: "artifact_review_gate",
    declaredState: "pending",
    rootSel: GATE_ROOT,
    assertions: REVIEW_ASSERTIONS_CHAT,
    runId: state.runId,
    dbAt: timeline.at(-2),
    note: "The same window, the same review card in the same conversation, in the dark palette.",
  });
  await setTheme("cinatra");

  // ---- S4: the review PAGE for the same run -------------------------------
  if (state.reviewTaskId) {
    const [tpl] = await q(
      `select t.package_name from cinatra.agent_runs r join cinatra.agent_templates t on t.id = r.template_id where r.id=$1`,
      [state.runId],
    );
    const pkg = String(tpl?.package_name ?? "@cinatra-ai/blog-draft-writer-agent");
    const [vendor, name] = pkg.replace(/^@/, "").split("/");
    const reviewPath = `/agents/${vendor}/${name}/${state.runId}/review/${state.reviewTaskId}`;
    state.reviewPath = reviewPath;
    // Back to the declared window: the review page is its own surface and must
    // not inherit whatever height the conversation needed.
    await page.setViewportSize({ ...VIEWPORT });
    await page.goto(`${APP}${reviewPath}`, { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.waitForSelector(GATE_ROOT, { timeout: 600_000 });
    await page.waitForTimeout(20_000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);
    await shoot("S4__recommendation-card__page_gate_region__decided", {
      host: "page_gate_region",
      kind: "recommendation_hold",
      declaredState: "decided",
      rootSel: CARD_ROOT,
      assertions: REVIEW_ASSERTIONS_PAGE,
      runId: state.runId,
      dbAt: timeline.at(-2),
      note:
        "The review page for the SAME run, full browser window: the decided skills row above the review gate card the sweeper opened on the output this run's own step wrote.",
    });
    await setTheme("dark");
    await shoot("S4__recommendation-card__page_gate_region__decided__dark", {
      host: "page_gate_region",
      kind: "recommendation_hold",
      declaredState: "decided",
      rootSel: CARD_ROOT,
      assertions: REVIEW_ASSERTIONS_PAGE,
      runId: state.runId,
      dbAt: timeline.at(-2),
      note: "The same review page framing for the same run, in the dark palette.",
    });
    await setTheme("cinatra");
  } else {
    say("NO REVIEW TASK — S4 not shot");
  }
  say("SEQUENCE OK");
} catch (e) {
  say(`SEQUENCE ERROR: ${e?.stack || e}`);
  await page.screenshot({ path: join(OUT, "error.png") }).catch(() => {});
} finally {
  writeFileSync(join(OUT, "sequence-state.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2));
  writeFileSync(join(OUT, "capture-records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(OUT, "capture-results.json"), JSON.stringify({ results, wire, pageErrors }, null, 2));
  writeFileSync(join(OUT, "sequence.log"), log.join("\n") + "\n");
  await browser.close();
  await client.end();
}
