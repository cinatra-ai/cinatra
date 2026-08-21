// S9b re-shoot, step 2 — the five chat_thread cells, each with the anchors read
// off the CARD'S OWN ROOT.
//
// REWRITTEN FOR THE RATIFIED §V DRAWING (cinatra#2841, merged; re-shot for round
// 5 of cinatra#2794). The previous driver clicked controls the redraw DELETED —
// a card-level `[data-action="confirm-run-recommendation"]` / `…skip…` pair and a
// `data-selected` chip toggle — so it could not reproduce any cell at this head.
// What it drives now is the drawing that actually ships:
//
//   THE CHIP ROW IS THE WHOLE CARD. One chip per candidate skill, each printing
//   the owning extension's manifest DISPLAY NAME (not the slug, not the package
//   id), and each carrying its OWN three affordances:
//       [data-skill-action="confirm"]  [data-skill-action="adjust"]  [data-skill-action="skip"]
//   ADJUST opens that skill's own panel, whose two controls are
//       [data-skill-action="adjust-keep"]  [data-skill-action="adjust-drop"]
//   There is NO heading plate, NO "Skills (n/m)" disclosure and NO row-level
//   Confirm/Skip pair. The row releases once, when every chip has been decided.
//
//   THE CARD STATE VOCABULARY MOVED WITH IT. `data-lifecycle-card-state` is
//   `held` while the hold is live and `decided` once it settles; WHICH decision
//   it settled into is `data-run-recommendation-decision` = confirmed | skipped,
//   published ON THE CARD ROOT (the redraw put the identity on the row itself and
//   deleted the `display: contents` wrapper that used to carry it).
//
// The doctrine this obeys (evidence/2787-s9c-envelope-visual/README.md): a file
// name claims nothing. Before every shot the driver reads
// `data-lifecycle-card`, `data-lifecycle-card-host` and
// `data-lifecycle-card-state` off the card's own root and writes them into the
// log beside the picture. Read the log, not the file name.
//
// It records, per shot, the facts a reader must be able to check WITHOUT
// trusting the picture:
//   * EXACTLY ONE `recommendation_hold` root per turn, on `chat_thread`,
//     OUTSIDE the inline run panel's subtree — in held and in both settled reads;
//   * NO second copy under the panel's "Agentic Run Progress" heading;
//   * every chip's DISPLAY NAME, beside the skill id it is NOT;
//   * the three ratified per-chip controls present on every held chip;
//   * the three DELETED controls absent — heading plate, disclosure, row pair.
//
// Nothing here is a harness. Every pixel is the shipped chat surface in a
// running instance, and every decision is pressed on a chip's own button.
//
// Usage: node 02-capture-chat-thread.mjs <baseUrl> <sessionDir> <outDir>
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:3794";
const SESSION = process.argv[3];
const OUT = process.argv[4];
if (!SESSION || !OUT) throw new Error("usage: 02-capture-chat-thread.mjs <baseUrl> <sessionDir> <outDir>");
mkdirSync(OUT, { recursive: true });

const REPO = process.env.S9B_REPO_ROOT || process.cwd();
const PG_CONTAINER = process.env.S9B_PG_CONTAINER || "x2794cap-postgres-1";
const REDIS_CONTAINER = process.env.S9B_REDIS_CONTAINER || "x2794cap-redis-1";
const QUEUE = process.env.BULLMQ_QUEUE_NAME || "cinatra-x2794cap-jobs";

// The one driving message. ZERO mention tokens: two mentions flip the thread
// into Slack layout, which suppresses `parts` and therefore every part-level
// mount. The pre-router accepts this legacy `cinatra_<slug>` form.
//
// WHY EVERY CHIP COMES BACK `data-forced`, MEASURED RATHER THAN GUESSED. The
// scorer is deterministic and public: `score = Σ (distinct run-intent tokens
// that also appear in the skill's own name/description/cue) × 0.08`, capped at
// 0.35, recommended at `>= 0.30`. Its input is the run's `inputParams`, and the
// CHAT pre-router dispatches with `input_params = {}` — verified on this stack
// by reading the row back. So on a chat-origin run the scorer has no intent to
// score against, every candidate lands at 0.00, none clears the threshold, and
// the row offers all of them as force-adds under §V's NAMED candidate-set
// deviation. Two prompts were tried, one deliberately loaded with the skills'
// own vocabulary; both produced the same `forced=true` on all three, because the
// words never reach the scorer. This is a property of the chat dispatch path,
// not of the drawing and not of anything the driver does — recorded here so no
// later round mistakes it for a capture defect. The recommended reading of the
// same row is proven on the run surface in `evidence/2841-v-redraw`.
const MESSAGE =
  "run cinatra_blog-draft-writer-agent to draft a blog post about onboarding";

const log = [];
const say = (m) => {
  log.push(m);
  console.log(m);
};
const flush = () => writeFileSync(join(OUT, "capture-log.txt"), log.join("\n") + "\n");

// ── the DECLARED display names, read from the extension manifests ────────────
// The card must print `cinatra.displayName`, never the slug on `data-skill-id`.
// Reading the manifests here — off disk, out of the browser — is what lets the
// log state that claim as a COMPARISON rather than as an impression of a picture.
function declaredDisplayNames() {
  const names = new Map();
  const root = join(REPO, "extensions", "cinatra-ai");
  let dirs = [];
  try {
    dirs = execFileSync("ls", [root], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return names;
  }
  for (const dir of dirs) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const c = manifest.cinatra;
    if (!c || c.kind !== "skill" || !c.displayName) continue;
    let slugs = [];
    try {
      slugs = execFileSync("ls", [join(root, dir, "skills")], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      // `deriveSkillRegistration`'s two branches: the reserved chat namespace
      // collapses the package to `@cinatra-ai/chat`, everything else keeps its own.
      const chatNamespaced = `@cinatra-ai/chat:${slug}`;
      const own = `${manifest.name}:${slug}`;
      if (!names.has(chatNamespaced)) names.set(chatNamespaced, c.displayName);
      if (!names.has(own)) names.set(own, c.displayName);
    }
  }
  return names;
}
const DECLARED = declaredDisplayNames();

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
  // The scorer's ONLY input. Read back so "every chip is a force-add" is a
  // measured consequence of an empty run intent, not an unexplained picture.
  let intent = "<none>";
  try {
    intent = psql(`select coalesce(input_params::text,'null') from cinatra.agent_runs where id = '${runId}';`);
  } catch (e) {
    intent = `<query failed: ${String(e).slice(0, 80)}>`;
  }
  return { row, park, intent };
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

/** The run's DURABLE per-skill evidence — what the settled chips must agree with. */
function decisionEvidence(runId) {
  const out = {};
  try {
    out.selected =
      psql(
        `select string_agg(skill_id || ':' || selection_source, ' ' order by skill_id) from cinatra.run_selected_skill_revisions where run_id = '${runId}';`,
      ) || "<none>";
  } catch (e) {
    out.selected = `<query failed: ${String(e).slice(0, 80)}>`;
  }
  try {
    out.rejected =
      psql(
        `select string_agg(skill_id || ':' || recommendation_source || ':' || coalesce(recommended_rank::text,'NULL'), ' ' order by skill_id) from cinatra.run_rejected_recommendations where run_id = '${runId}';`,
      ) || "<none>";
  } catch (e) {
    out.rejected = `<query failed: ${String(e).slice(0, 80)}>`;
  }
  try {
    out.marker =
      psql(
        `select count(*)::text || ' row(s); candidate_count=' || coalesce(max(candidate_count)::text,'-') from cinatra.run_recommendation_skips where run_id = '${runId}';`,
      ) || "0";
  } catch (e) {
    out.marker = `<query failed: ${String(e).slice(0, 80)}>`;
  }
  return out;
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

  // Any settled card drawn under the panel — the duplicate an earlier round named.
  const summariesInPanel = panels.flatMap((p) => [
    ...p.querySelectorAll("[data-run-recommendation-decision]"),
  ]).length;

  // THE CHIPS — the ratified face, read one chip at a time. `label` is the first
  // span's text, which is the chip's printed name; the id it must NOT be is on
  // `data-skill-id` beside it.
  const chips = card
    ? [...card.querySelectorAll("[data-recommendation-chip]")].map((c) => ({
        skillId: c.getAttribute("data-skill-id"),
        label: (c.querySelector("span")?.textContent || "").trim(),
        mark: c.getAttribute("data-chip-mark"),
        forced: c.hasAttribute("data-forced"),
        confirm: Boolean(c.querySelector('[data-skill-action="confirm"]')),
        adjust: Boolean(c.querySelector('[data-skill-action="adjust"]')),
        skip: Boolean(c.querySelector('[data-skill-action="skip"]')),
      }))
    : [];

  const cardText = card ? (card.textContent || "") : "";

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
    // the RATIFIED face
    chipRowInsideCard: Boolean(card && card.hasAttribute("data-run-recommendation-chip-row")),
    chips,
    perChipControls: chips.length > 0 && chips.every((c) => c.confirm && c.adjust && c.skip),
    // the DELETED face — every one of these must read false / 0 / null
    headingPlate: /Confirm the skills for this run/i.test(cardText),
    skillsDisclosure: /Skills\s*\(\d+\s*\/\s*\d+\)/.test(cardText),
    rowLevelConfirm: Boolean(q('[data-action="confirm-run-recommendation"]')),
    rowLevelSkip: Boolean(q('[data-action="skip-run-recommendation"]')),
    // the settled reading — published ON THE ROOT since the redraw
    decision: card ? card.getAttribute("data-run-recommendation-decision") : null,
    settled: card ? card.getAttribute("data-run-recommendation-settled") : null,
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
    // Wait for the chips too: the chat mount fetches candidates AFTER the card
    // draws, and a shot taken between the two would photograph "Loading
    // recommendations…" and call it the ratified face.
    if (a.cards > 0 && a.state === "held" && a.chips.length > 0) return a;
    await page.waitForTimeout(2000);
  }
  throw new Error(`[${label}] no held recommendation_hold card with chips appeared`);
}

async function waitForDecision(label, want) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const a = await anchors();
    if (a.state === "decided" && a.decision === want) return a;
    await page.waitForTimeout(1500);
  }
  throw new Error(`[${label}] card never settled into decision=${want}`);
}

/** Wait for ONE chip to carry a mark, with the row still live. */
async function waitForChipMark(label, skillId, want) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const a = await anchors();
    const chip = a.chips.find((c) => c.skillId === skillId);
    if (chip && chip.mark === want) return a;
    await page.waitForTimeout(500);
  }
  throw new Error(`[${label}] chip ${skillId} never reached mark=${want}`);
}

/** Press one chip's OWN button. Never a row-level control — there is none. */
async function pressChip(skillId, action) {
  await page.evaluate(stripDevOverlay);
  await page
    .locator(
      `[data-lifecycle-card="recommendation_hold"] [data-skill-action="${action}"][data-skill-id="${skillId}"]`,
    )
    .first()
    .click();
  say(`pressed the "${action}" button ON THE CHIP for ${skillId}`);
}

/** ADJUST opens that skill's own panel; the panel PORTALS OUT of the card. */
async function pressAdjustPanel(skillId, action) {
  await page.evaluate(stripDevOverlay);
  await page
    .locator(`[data-skill-action="${action}"][data-skill-id="${skillId}"]`)
    .first()
    .click();
  say(`pressed "${action}" in the ADJUST panel for ${skillId}`);
}

function record(label, a) {
  say(`${label} anchors: ${JSON.stringify(a, null, 1)}`);
}

/** State the display-name claim as a comparison against the manifests. */
function recordLabels(label, a, declared) {
  say(`${label} chip labels — the DISPLAY NAME, checked against the manifest:`);
  for (const c of a.chips) {
    const want = declared[c.skillId];
    const ok = want !== undefined ? c.label === want : "<no manifest declaration>";
    say(
      `    id=${c.skillId}` +
        `  printed="${c.label}"  manifest.cinatra.displayName="${want ?? "<none>"}"` +
        `  matches=${ok}  isNotTheId=${c.label !== c.skillId}  mark=${c.mark}` +
        `  forced=${c.forced}`,
    );
  }
}

function recordBackend(label, runId) {
  const { row, park, intent } = runFacts(runId);
  const q = queueFacts(runId);
  say(`${label} db: status|human_present = ${row}; park = ${park}`);
  say(`${label} run intent the scorer reads (agent_runs.input_params): ${intent}`);
  say(`${label} queue:`);
  say(`    jobs_naming_this_run=${q.naming}`);
  say(`    job_keys_naming_this_run=${q.namingKeys.join(" ") || "<none>"}`);
  return q;
}

try {
  say(`base=${BASE} queue=${QUEUE}`);
  say(`runtime: development (node scripts/dev-server.mjs), CINATRA_TEST_LLM_PROVIDER=scripted`);
  say(
    "face under proof: the RATIFIED §V redraw (cinatra#2841) — the chip row IS the card, " +
      "one chip per skill printing its manifest display name, each with its own " +
      "Confirm/Adjust/Skip. No heading plate, no Skills(n/m) disclosure, no row-level pair.",
  );
  const declared = Object.fromEntries(DECLARED);
  // ONE TURN PER THREAD, for both decisions. The acceptance criterion is stated
  // per TURN ("each turn contains exactly one recommendation_hold root"), so each
  // decision gets its own fresh conversation and the count in the log is that
  // turn's count, with nothing from an earlier turn in the same transcript.
  await freshThread();

  // ══ TURN 1 — held, one chip ADJUSTED in place, then the row releases ═══════
  const runsBefore = psql("select count(*) from cinatra.agent_runs;");
  await sendTurn("held");
  const held = await waitForHeldCard("held");
  const runId = newestRunId();
  say(`runId=${runId}   (agent_runs before this turn = ${runsBefore})`);
  record("HELD", held);
  recordLabels("HELD", held, declared);
  recordBackend("HELD", runId);
  await shot("S9b-1__chat_thread__recommendation-hold-held.png");
  // The close-up. Since the §V redraw the card's identity root IS the chip row —
  // a real box with real geometry — so this frames THE ROOT ITSELF, which the
  // pre-redraw driver could not do (the old root was `display: contents`).
  await shot(
    "S9b-2__chat_thread__hold-wrapper-anchors.png",
    '[data-lifecycle-card="recommendation_hold"]',
  );

  // ── S9b-2b — ONE SKILL SHAPED IN CHAT, the row still live. ────────────────
  // The pre-redraw cell ticked a selection pill. §V deleted that: a skill is
  // shaped by pressing ITS OWN Adjust and choosing inside that skill's panel.
  // Two or more chips is what makes the per-chip model VISIBLE — the row does
  // not release until every chip is decided, so this photographs one chip
  // carrying its mark while its neighbours are still undecided.
  const adjustTarget = held.chips[0].skillId;
  await pressChip(adjustTarget, "adjust");
  await page.waitForTimeout(800);
  await pressAdjustPanel(adjustTarget, "adjust-keep");
  const shaped = await waitForChipMark("shaped", adjustTarget, "adjusted");
  record("SHAPED-IN-CHAT", shaped);
  recordLabels("SHAPED-IN-CHAT", shaped, declared);
  say(
    `SHAPED-IN-CHAT: chip "${adjustTarget}" reads mark=adjusted while the card root still reads ` +
      `state=${shaped.state} and ${shaped.chips.filter((c) => c.mark === "undecided").length} ` +
      `chip(s) stay undecided — nothing released, no row-level control was pressed (there is none).`,
  );
  await shot("S9b-2b__chat_thread__skill-selected-in-chat.png");

  // ── Decide the rest, chip by chip, until the row releases as CONFIRMED. ───
  // The URL is read IMMEDIATELY BEFORE the last press, so the comparison
  // brackets the release itself and nothing earlier in the session.
  const rest = held.chips.slice(1);
  let confirmedAnchors;
  for (let i = 0; i < rest.length; i += 1) {
    const isLast = i === rest.length - 1;
    // Confirm the first of the rest, Skip any others: the release keeps at least
    // one skill, so it takes the CONFIRM path, and the settled row then carries
    // all three §V marks at once.
    const action = i === 0 ? "confirm" : "skip";
    if (isLast) {
      const urlAtRelease = page.url();
      await pressChip(rest[i].skillId, action);
      const confirmed = await waitForDecision("confirmed", "confirmed");
      record("CONFIRMED", confirmed);
      recordLabels("CONFIRMED", confirmed, declared);
      recordBackend("CONFIRMED", runId);
      const ev = decisionEvidence(runId);
      say(`CONFIRMED durable selection rows: ${ev.selected}`);
      say(`CONFIRMED durable rejection rows: ${ev.rejected}`);
      say(`CONFIRMED url at release : ${urlAtRelease}`);
      say(`CONFIRMED url after settle: ${page.url()}`);
      say(`CONFIRMED settled without navigation: ${page.url() === urlAtRelease}`);
      say(`CONFIRMED settled without reload: true (the driver issues no reload)`);
      await shot("S9b-3__chat_thread__confirmed-settled-in-place.png");
      confirmedAnchors = confirmed;
    } else {
      await pressChip(rest[i].skillId, action);
      await waitForChipMark("confirm-turn", rest[i].skillId, action === "confirm" ? "confirmed" : "skipped");
    }
  }

  // ══ TURN 2 — held, then SKIP EVERY CHIP, in its OWN conversation ══════════
  await freshThread();
  await sendTurn("skip");
  const held2 = await waitForHeldCard("skip");
  const runId2 = newestRunId();
  say(`second runId=${runId2}`);
  record("HELD-BEFORE-SKIP", held2);
  recordLabels("HELD-BEFORE-SKIP", held2, declared);
  recordBackend("HELD-BEFORE-SKIP", runId2);

  let skipped;
  for (let i = 0; i < held2.chips.length; i += 1) {
    const isLast = i === held2.chips.length - 1;
    if (isLast) {
      const urlAtSkip = page.url();
      await pressChip(held2.chips[i].skillId, "skip");
      skipped = await waitForDecision("skipped", "skipped");
      record("SKIPPED", skipped);
      recordLabels("SKIPPED", skipped, declared);
      recordBackend("SKIPPED", runId2);
      const ev = decisionEvidence(runId2);
      say(`SKIPPED durable selection rows: ${ev.selected}`);
      say(`SKIPPED per-skill evidence rows: ${ev.rejected}`);
      say(`SKIPPED run-level marker in run_recommendation_skips: ${ev.marker}`);
      say(`SKIPPED url at decision : ${urlAtSkip}`);
      say(`SKIPPED url after settle: ${page.url()}`);
      say(`SKIPPED settled without navigation: ${page.url() === urlAtSkip}`);
      say(`SKIPPED settled without reload: true (the driver issues no reload)`);
      await shot("S9b-4__chat_thread__skipped-settled-in-place.png");
    } else {
      await pressChip(held2.chips[i].skillId, "skip");
      await waitForChipMark("skip-turn", held2.chips[i].skillId, "skipped");
    }
  }

  say("");
  say("=== ACCEPTANCE — the ONE-CARD criteria, unchanged ===");
  for (const [name, a] of [
    ["held", held],
    ["shaped", shaped],
    ["confirmed", confirmedAnchors],
    ["skipped", skipped],
  ]) {
    say(
      `${name}: recommendation_hold roots=${a.cards} host=${a.host} state=${a.state} ` +
        `decision=${a.decision ?? "-"} ` +
        `outsideInlinePanel=${a.cardsOutsideInlineRunPanel} insideInlinePanel=${a.cardsInsideInlineRunPanel} ` +
        `summariesUnderAgenticRunProgress=${a.summariesInsideInlineRunPanel}`,
    );
  }
  say("");
  say("=== CONFORMANCE TO THE RATIFIED §V FACE, graded per shot ===");
  for (const [name, a] of [
    ["held", held],
    ["shaped", shaped],
    ["confirmed", confirmedAnchors],
    ["skipped", skipped],
  ]) {
    const idsPrinted = a.chips.filter((c) => c.label === c.skillId).length;
    say(
      `${name}: chips=${a.chips.length} perChipConfirmAdjustSkip=${a.perChipControls} ` +
        `chipsPrintingTheRawId=${idsPrinted} ` +
        `headingPlate=${a.headingPlate} skillsDisclosure=${a.skillsDisclosure} ` +
        `rowLevelConfirm=${a.rowLevelConfirm} rowLevelSkip=${a.rowLevelSkip} ` +
        `marks=${a.chips.map((c) => `${c.label}:${c.mark}`).join(",")}`,
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
