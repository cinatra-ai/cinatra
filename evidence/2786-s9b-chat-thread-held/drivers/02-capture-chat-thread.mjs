// S9b re-shoot, step 2 — the five chat_thread cells, each with the anchors read
// off the CARD'S OWN ROOT.
//
// The doctrine this obeys (evidence/2787-s9c-envelope-visual/README.md): a file
// name claims nothing. Before every shot the driver reads
// `data-lifecycle-card`, `data-lifecycle-card-host` and
// `data-lifecycle-card-state` off the card's own root and writes them into the
// log beside the picture. Read the log, not the file name.
//
// It also records the two facts the round-8 review made acceptance criteria:
//   * EXACTLY ONE `recommendation_hold` root per turn, on `chat_thread`,
//     OUTSIDE the inline run panel's subtree — in held, confirmed and skipped;
//   * NO second copy under the panel's "Agentic Run Progress" heading.
//
// Nothing here is a harness. Every pixel is the shipped chat surface in a
// running instance, and every decision is pressed on the card's own controls.
//
// Usage: node 02-capture-chat-thread.mjs <baseUrl> <sessionDir> <outDir>
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:3794";
const SESSION = process.argv[3];
const OUT = process.argv[4];
if (!SESSION || !OUT) throw new Error("usage: 02-capture-chat-thread.mjs <baseUrl> <sessionDir> <outDir>");
mkdirSync(OUT, { recursive: true });

const PG_CONTAINER = process.env.S9B_PG_CONTAINER || "x2794cap-postgres-1";
const REDIS_CONTAINER = process.env.S9B_REDIS_CONTAINER || "x2794cap-redis-1";
const QUEUE = process.env.BULLMQ_QUEUE_NAME || "cinatra-x2794cap-jobs";

// The one driving message. ZERO mention tokens: two mentions flip the thread
// into Slack layout, which suppresses `parts` and therefore every part-level
// mount. The pre-router accepts this legacy `cinatra_<slug>` form.
const MESSAGE =
  "run cinatra_blog-draft-writer-agent to draft a blog post about onboarding";

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};
const flush = () => writeFileSync(join(OUT, "capture-log.txt"), log.join("\n") + "\n");

// ── the out-of-browser probes ───────────────────────────────────────────────
const psql = (sql) =>
  execFileSync(
    "docker",
    ["exec", "-i", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-A", "-t", "-c", sql],
    { encoding: "utf8" },
  ).trim();

const redis = (...args) =>
  execFileSync("docker", ["exec", "-i", REDIS_CONTAINER, "redis-cli", ...args], {
    encoding: "utf8",
  }).trim();

function newestRunId() {
  return psql("select id from cinatra.agent_runs order by created_at desc limit 1;");
}

function runFacts(runId) {
  const row = psql(
    `select status || '|' || coalesce(human_present::text,'null') from cinatra.agent_runs where id = '${runId}';`,
  );
  // The recommendation checkpoint's park row, on the shipped park store.
  let park = "<none>";
  try {
    park =
      psql(
        `select status from cinatra.lifecycle_continuation_park where run_id = '${runId}' and checkpoint = 'recommendation';`,
      ) || "<none>";
  } catch (e) {
    park = `<query failed: ${String(e).slice(0, 80)}>`;
  }
  return { row, park };
}

function queueFacts(runId) {
  const everRaw = redis("get", `bull:${QUEUE}:id`);
  const keys = redis("--scan", "--pattern", `bull:${QUEUE}:*`)
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean);
  const naming = keys.filter((k) => k.includes(runId));
  return {
    ever: everRaw || "<unset>",
    naming: naming.length,
    namingKeys: naming,
  };
}

function skipEvidence(runId) {
  let perSkill = "<none>";
  let marker = "<none>";
  try {
    perSkill =
      psql(
        `select string_agg(skill_id || ':' || recommendation_source || ':' || coalesce(recommended_rank::text,'NULL'), ' ') from cinatra.run_rejected_recommendations where run_id = '${runId}';`,
      ) || "<none>";
  } catch (e) {
    perSkill = `<query failed: ${String(e).slice(0, 80)}>`;
  }
  try {
    marker =
      psql(
        `select count(*)::text || ' row(s); candidate_count=' || coalesce(max(candidate_count)::text,'-') from cinatra.run_recommendation_skips where run_id = '${runId}';`,
      ) || "0";
  } catch (e) {
    marker = `<query failed: ${String(e).slice(0, 80)}>`;
  }
  return { perSkill, marker };
}

// ── the in-page anchor read, off the CARD'S OWN ROOT ────────────────────────
const ANCHORS = () => {
  const list = document.querySelector("[data-conversation-list]");
  // The inline run panel: the section that owns the "Agentic Run Progress"
  // heading. Its subtree is the `run_card` host.
  const panels = [...document.querySelectorAll("h2")]
    .filter((h) => (h.textContent || "").trim() === "Agentic Run Progress")
    .map((h) => h.closest("section"))
    .filter(Boolean);

  const roots = [...document.querySelectorAll('[data-lifecycle-card="recommendation_hold"]')];
  const inPanel = roots.filter((r) => panels.some((p) => p.contains(r)));
  const outside = roots.filter((r) => !panels.some((p) => p.contains(r)));
  const card = outside[0] || roots[0] || null;

  const q = (sel) => (card ? card.querySelector(sel) : null);
  const summary = card ? card.querySelector("[data-run-recommendation-decision]") : null;

  // Any settled summary drawn under the panel — the duplicate the review named.
  const summariesInPanel = panels.flatMap((p) => [
    ...p.querySelectorAll("[data-run-recommendation-decision]"),
  ]).length;

  return {
    // the card's OWN published identity
    cards: roots.length,
    kind: card ? card.getAttribute("data-lifecycle-card") : null,
    host: card ? card.getAttribute("data-lifecycle-card-host") : null,
    state: card ? card.getAttribute("data-lifecycle-card-state") : null,
    chatThreadMarker: card ? card.hasAttribute("data-chat-thread-recommendation-hold") : null,
    // where it sits
    conversationList: Boolean(list),
    insideConversationList: Boolean(card && list && list.contains(card)),
    inlineRunPanels: panels.length,
    cardsOutsideInlineRunPanel: outside.length,
    cardsInsideInlineRunPanel: inPanel.length,
    summariesInsideInlineRunPanel: summariesInPanel,
    // its controls
    chipRowInsideCard: Boolean(q('[data-conformance-id="run-chip-row"]')),
    confirmInsideCard: Boolean(q('[data-action="confirm-run-recommendation"]')),
    skipInsideCard: Boolean(q('[data-action="skip-run-recommendation"]')),
    decisionSummary: summary ? summary.getAttribute("data-run-recommendation-decision") : null,
    decisionSummaryText: summary ? (summary.textContent || "").trim() : null,
    composerVisible: Boolean(document.querySelector('[data-testid="chat-prompt-input"]')),
  };
};

const stripDevOverlay = () => {
  // Dev-server furniture: it swallows pointer events and covers the surface.
  // Removing it changes no application behaviour.
  for (const el of document.querySelectorAll("nextjs-portal")) el.remove();
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  storageState: join(SESSION, "state.json"),
  viewport: { width: 1440, height: 1200 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

async function anchors() {
  await page.evaluate(stripDevOverlay);
  return page.evaluate(ANCHORS);
}

async function shot(name, selector) {
  await page.evaluate(stripDevOverlay);
  const path = join(OUT, name);
  if (selector) {
    try {
      await page.locator(selector).first().screenshot({ path });
      say(`captured ${name} (element: ${selector})`);
      return;
    } catch (e) {
      // Never let a geometry quirk cost the round: fall back to the full page
      // and SAY so, so the log records which kind of picture this is.
      say(`element shot failed for ${name} (${String(e).slice(0, 120)}) — full page instead`);
    }
  }
  await page.screenshot({ path, fullPage: true });
  say(`captured ${name} (full page)`);
}

async function freshThread() {
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForTimeout(5000);
  const cards = await page.evaluate(
    () => document.querySelectorAll('[data-lifecycle-card="recommendation_hold"]').length,
  );
  say(`fresh thread: ${page.url()} (recommendation_hold roots on entry = ${cards})`);
  return page.url();
}

async function sendTurn(label) {
  const prompt = page.getByTestId("chat-prompt-input");
  await prompt.waitFor({ state: "visible", timeout: 180_000 });
  // The prompt is contentEditable="false" while a chat SSE turn is active.
  for (let i = 0; i < 120; i += 1) {
    if (await prompt.isEditable().catch(() => false)) break;
    await page.waitForTimeout(1000);
  }
  await page.evaluate(stripDevOverlay);
  await prompt.click();
  await page.keyboard.insertText(MESSAGE);
  await prompt.press("Enter");
  const mentions = (MESSAGE.match(/@/g) || []).length;
  say(`[${label}] sent, mention tokens = ${mentions}: "${MESSAGE}"`);
}

async function waitForHeldCard(label) {
  // Generous: on a COLD dev route the first `POST /api/chat` compiles for
  // minutes before the pre-router dispatches at all. A 300s budget failed this
  // way twice on this stack, with zero rows in `agent_runs` to show for it.
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const a = await anchors();
    if (a.cards > 0 && a.state === "held") return a;
    await page.waitForTimeout(2000);
  }
  throw new Error(`[${label}] no held recommendation_hold card appeared`);
}

async function waitForState(label, want) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const a = await anchors();
    if (a.state === want) return a;
    await page.waitForTimeout(1500);
  }
  throw new Error(`[${label}] card never reached state=${want}`);
}

function record(label, a) {
  say(`${label} anchors: ${JSON.stringify(a, null, 1)}`);
}

function recordBackend(label, runId) {
  const { row, park } = runFacts(runId);
  const q = queueFacts(runId);
  say(`${label} db: status|human_present = ${row}; park = ${park}`);
  say(`${label} queue:`);
  say(`    jobs_ever_created=${q.ever}`);
  say(`    jobs_naming_this_run=${q.naming}`);
  say(`    job_keys_naming_this_run=${q.namingKeys.join(" ") || "<none>"}`);
  return q;
}

try {
  say(`base=${BASE} queue=${QUEUE}`);
  say(`runtime: development (pnpm dev), CINATRA_TEST_LLM_PROVIDER=scripted`);
  // ONE TURN PER THREAD, for both cells. The acceptance criterion is stated per
  // TURN ("each turn contains exactly one recommendation_hold root"), so each
  // decision gets its own fresh conversation and the count in the log is that
  // turn's count, with nothing from an earlier turn in the same transcript.
  await freshThread();

  // ══ TURN 1 — held, then CONFIRM ═══════════════════════════════════════════
  const runsBefore = psql("select count(*) from cinatra.agent_runs;");
  await sendTurn("held");
  const held = await waitForHeldCard("held");
  const runId = newestRunId();
  say(`runId=${runId}   (agent_runs before this turn = ${runsBefore})`);
  record("HELD", held);
  recordBackend("HELD", runId);
  await shot("S9b-1__chat_thread__recommendation-hold-held.png");
  // The close-up. NOTE: the card's own identity root is `display: contents`, so
  // it has NO BOX and cannot be photographed as an element — the shot targets
  // the chip row INSIDE that root instead. The root's three attributes are in
  // the HELD anchors above, which is where this cell's claim actually rests.
  await shot(
    "S9b-2__chat_thread__hold-wrapper-anchors.png",
    '[data-lifecycle-card="recommendation_hold"] [data-conformance-id="run-chip-row"]',
  );

  // tick the skill chip inside the conversation
  const chip = page
    .locator('[data-lifecycle-card="recommendation_hold"] [data-skill-id]')
    .first();
  await chip.waitFor({ state: "visible", timeout: 60_000 });
  say(
    `chip before select: data-skill-id=${await chip.getAttribute("data-skill-id")} data-selected=${await chip.getAttribute("data-selected")} data-forced=${await chip.getAttribute("data-forced")}`,
  );
  await page.evaluate(stripDevOverlay);
  await chip.click();
  await page.waitForTimeout(500);
  say(`chip after select: data-selected=${await chip.getAttribute("data-selected")}`);
  const picked = await anchors();
  record("SELECTED", picked);
  await shot("S9b-2b__chat_thread__skill-selected-in-chat.png");

  // Confirm, on the card's own floor, inside the conversation.
  // The URL is read IMMEDIATELY BEFORE the press, so the comparison brackets
  // the decision itself and nothing earlier in the session.
  const urlAtConfirm = page.url();
  await page.evaluate(stripDevOverlay);
  await page
    .locator('[data-lifecycle-card="recommendation_hold"] [data-action="confirm-run-recommendation"]')
    .first()
    .click();
  say("pressed Confirm INSIDE the conversation");
  const confirmed = await waitForState("confirmed", "confirmed");
  record("CONFIRMED", confirmed);
  recordBackend("CONFIRMED", runId);
  say(`CONFIRMED url at decision : ${urlAtConfirm}`);
  say(`CONFIRMED url after settle: ${page.url()}`);
  say(`CONFIRMED settled without navigation: ${page.url() === urlAtConfirm}`);
  say(`CONFIRMED settled without reload: true (the driver issues no reload)`);
  await shot("S9b-3__chat_thread__confirmed-settled-in-place.png");

  // ══ TURN 2 — held, then SKIP, in its OWN conversation ═════════════════════
  await freshThread();
  await sendTurn("skip");
  const held2 = await waitForHeldCard("skip");
  const runId2 = newestRunId();
  say(`second runId=${runId2}`);
  record("HELD-BEFORE-SKIP", held2);
  recordBackend("HELD-BEFORE-SKIP", runId2);

  const urlAtSkip = page.url();
  await page.evaluate(stripDevOverlay);
  await page
    .locator('[data-lifecycle-card="recommendation_hold"] [data-action="skip-run-recommendation"]')
    .first()
    .click();
  say("pressed Skip INSIDE the conversation");
  const skipped = await waitForState("skip", "skipped");
  record("SKIPPED", skipped);
  recordBackend("SKIPPED", runId2);
  const ev = skipEvidence(runId2);
  say(`SKIPPED per-skill evidence rows: ${ev.perSkill}`);
  say(`SKIPPED run-level marker in run_recommendation_skips: ${ev.marker}`);
  say(`SKIPPED url at decision : ${urlAtSkip}`);
  say(`SKIPPED url after settle: ${page.url()}`);
  say(`SKIPPED settled without navigation: ${page.url() === urlAtSkip}`);
  say(`SKIPPED settled without reload: true (the driver issues no reload)`);
  await shot("S9b-4__chat_thread__skipped-settled-in-place.png");

  say("");
  say("=== ACCEPTANCE, as the round-8 review set it ===");
  for (const [name, a] of [
    ["held", held],
    ["confirmed", confirmed],
    ["skipped", skipped],
  ]) {
    say(
      `${name}: recommendation_hold roots=${a.cards} host=${a.host} state=${a.state} ` +
        `outsideInlinePanel=${a.cardsOutsideInlineRunPanel} insideInlinePanel=${a.cardsInsideInlineRunPanel} ` +
        `summariesUnderAgenticRunProgress=${a.summariesInsideInlineRunPanel}`,
    );
  }
} catch (err) {
  say(`FAILED: ${String(err)}`);
  await page
    .screenshot({ path: join(OUT, "failure.png"), fullPage: true })
    .catch(() => {});
  throw err;
} finally {
  flush();
  await browser.close();
}
console.log("capture done");
