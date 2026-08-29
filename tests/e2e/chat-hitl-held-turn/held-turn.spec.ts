/**
 * THE RUN PLAYS OUT INSIDE THE CHAT, AGAINST THE REAL DEV RUNTIME
 * (chat-hitl S9k, cinatra#2824 — epic #2784; PLAN: Agents Lifecycle §11/§12).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY NOTHING ALREADY LANDED COVERS IT
 * ---------------------------------------------------------------------------
 * Every gate in this epic so far is unit- or fixture-level: a jsdom mount over a
 * hand-built transcript, a store test over a hand-built park, a contract test over
 * a hand-written record. Each is true, and none of them can fail when the RUNTIME
 * stops creating the hold — because none of them ever asks the runtime for one.
 *
 * This flow asks. A browser types a message into `/chat`; from there exactly ONE
 * thing is stood in for and everything below it is real. The stand-in is the model
 * layer: on a key-free stack the deterministic provider makes the one decision a
 * model makes here — which tool this turn calls — and words the answer. The
 * conversation's own assistant then calls `agent_run` (cinatra#2935, lifecycle-b
 * W5d: nothing dispatches before the model any more), and the runtime creates a
 * real `agent_runs` row, evaluates the recommendation checkpoint, parks the run,
 * and answers `pending_input`. The transcript then draws the §V card at the
 * `agent_run` producing slot, the person decides ON THAT CARD, and the runtime
 * releases the park and enqueues the run. Every claim below is checked twice: once
 * in the DOM, and once against Postgres and Redis, because a card drawn over a run
 * that was dispatched anyway satisfies every selector here and is exactly the
 * defect this gate exists to catch.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES, STEP BY STEP
 * ---------------------------------------------------------------------------
 *   1. A browser dispatch from `/chat` creates a REAL held run: `agent_runs.status
 *      = pending_input`, `human_present = true`, a `recommendation` park row in
 *      `parked`, and ZERO queue jobs naming that run.
 *   2. The §V card renders in the transcript, at the `agent_run` slot
 *      (`data-transcript-slot`), on the `chat_thread` host, in state `held`, with
 *      the three per-chip controls the ratified redraw rules — and WITHOUT the
 *      retired row-level Confirm/Skip.
 *   3. The person decides IN the chat. Confirm in one held run; Skip in a SECOND,
 *      separately held run. One hold cannot be both, so each decision gets its own
 *      conversation and its own run.
 *   4. The same card settles IN PLACE: state `decided`, the decision recorded on
 *      the card's own root, no decision controls left, and the URL UNCHANGED
 *      across the decision.
 *   5. The run advances: the park reads `released` and EXACTLY ONE queue job names
 *      the run.
 *   6. A reload of the same thread brings the settled card back — the durable
 *      half, read off a cold page rather than a live React tree.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST LIMITS, stated rather than discovered
 * ---------------------------------------------------------------------------
 * · The screenshots are PROVISIONAL runtime evidence, recorded through the S9h
 *   recorder and labeled `development`. S9g alone adopts and canonicalizes AC-15
 *   records; this flow writes its index beside its own screenshots, never to the
 *   canonical one. A run mints into the gitignored scratch directory named at
 *   `RUN_EVIDENCE_DIR` below, so a PASSING run leaves the tree clean and the
 *   reference set pinned in history stays the frozen one.
 * · "Exactly one job" is measured as "jobs naming this run" — every job whose id is
 *   the run id OR whose payload carries the run id, across every queue state,
 *   de-duplicated by job id — so a second dispatch under another id is seen. A
 *   queue TOTAL would count every other run on the lane and answer nothing.
 * · The instance fixtures (a provider presence placeholder, the MCP base URL, one
 *   assigned skill) are world, not subject: see `fixtures.mts`. No hold, park, run
 *   or decision is ever seeded.
 *
 *   pnpm test:e2e:chat-hitl-held-turn
 */
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import {
  CARD_DECIDED,
  CARD_HELD,
  CARD_HOST_CHAT,
  CARD_ROOT,
  CARD_SETTLED,
  CHAT_HOLD_MARKER,
  CHAT_PROMPT,
  CHIP,
  CHIP_ADJUST,
  CHIP_CONFIRM,
  CHIP_ROW,
  CHIP_SKIP,
  CONVERSATION_LIST,
  DECISION_ATTR,
  HELD_TURN_AGENT_PACKAGE,
  HELD_TURN_MESSAGE,
  HELD_TURN_PAUSED_TEXT,
  HELD_TURN_RUNNING_TEXT,
  HELD_TURN_SKILL_ID,
  AGENT_RUN_SLOT,
  RETIRED_ROW_CONFIRM,
  RETIRED_ROW_SKIP,
  TRANSCRIPT_SLOT,
} from "./constants";
import {
  addDuplicateDispatchControl,
  assertRunIsForPackage,
  jobsNamingRun,
  removeDuplicateDispatchControl,
  readRecommendationParkStatus,
  readRejectedRecommendations,
  readRunFacts,
  readSelectedSkillRevisions,
  waitFor,
} from "./probes";
import {
  bootWindowRemainingMs,
  handshakeFailureFrom,
  retryWhileRouteMissing,
} from "./route-readiness";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/*
 * THE FROZEN REFERENCE SET — pinned in history, and never written by a run.
 *
 * The four graded PNGs and the provisional index this flow's PR posted as its
 * proof are a REFERENCE: a reader compares a run against them. They are no
 * longer carried in the working tree, so the reference is a HISTORICAL PERMALINK
 * at the last commit that held them — an immutable pin, which is what a frozen
 * set wanted to be all along. The hashes cited in the round comments stay true
 * for as long as that commit does. It is a citation and nothing in this file
 * reads it, so it is recorded here rather than bound to a dead constant:
 *
 *   https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2824-s9k
 */

/**
 * WHERE A RUN MINTS.
 *
 * `test-results/` is the Playwright config's own `outputDir`: gitignored, already
 * uploaded by the CI job that runs this flow, and already the root other suites
 * mint into. A PASSING run therefore leaves `git status --porcelain` empty by
 * construction rather than by a `.gitignore` line aimed at one directory.
 *
 * It used to be a subdirectory of the committed reference set, because the S9h
 * recorder refused any screenshot path outside the tracked proof tree. That rule
 * now names this root instead (`CAPTURE_OUTPUT_ROOT` in the recorder): proof
 * pictures do not belong in the product tree, so there is no tracked root left
 * to be under.
 *
 * The env var still points a deliberate refresh anywhere:
 *
 *   E2E_CHAT_HITL_EVIDENCE_DIR=test-results/my-refresh pnpm test:e2e:chat-hitl-held-turn
 */
const RUN_EVIDENCE_DIR =
  process.env.E2E_CHAT_HITL_EVIDENCE_DIR ?? "test-results/chat-hitl-held-turn-captures";

/**
 * THE COLD-COMPILE BUDGET. On a cold dev route the FIRST `POST /api/chat` compiles
 * the route graph before the assistant calls anything at all — measured in minutes on
 * a constrained machine, with zero rows in `agent_runs` to show for it while it
 * happens. A 300 s budget produced two false reds on the S9b round for exactly this
 * reason. This is a compile ceiling, not a flake allowance: once the route is warm
 * the same wait resolves in seconds, and the SECOND turn below uses a much smaller
 * budget precisely because it can.
 */
const FIRST_TURN_MS = Number(process.env.E2E_CHAT_HITL_FIRST_TURN_MS ?? 900_000);
const WARM_TURN_MS = Number(process.env.E2E_CHAT_HITL_WARM_TURN_MS ?? 240_000);
const DECISION_MS = 120_000;

/**
 * Dev-server furniture. `nextjs-portal` swallows pointer events and covers the
 * surface; removing it changes no application behaviour and is what makes a click
 * on the card's own control reach the card's own control.
 */
async function stripDevOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("nextjs-portal")) el.remove();
  });
}

/** Everything the card's OWN root publishes, read off the element rather than assumed. */
interface CardAnchors {
  roots: number;
  kind: string | null;
  host: string | null;
  state: string | null;
  chatThreadMarker: boolean;
  insideConversationList: boolean;
  /** The `data-transcript-slot` value of the container the card was drawn in. */
  slot: string | null;
  /**
   * Whether that SAME container is the `agent_run` part's own — measured by the
   * name the container carries: `data-agent-run-slot="<runId>"`.
   * `null` when the caller passed no run id (nothing to pin against yet).
   *
   * `slot !== null` alone would only say "inside some marked slot container", and
   * `chat-messages-view.tsx` marks three different ones. Moving the card's mount
   * from the `agent_run` container to the generic produced-views container breaks
   * S9i's positional rule and leaves every non-null read intact.
   */
  slotIsProducingAgentRun: boolean | null;
  chipRow: boolean;
  chips: number;
  confirmControls: number;
  adjustControls: number;
  skipControls: number;
  retiredRowControls: number;
  /**
   * The settled outcome, read OFF THE ROOT — `data-run-recommendation-decision` is
   * an attribute of the card's own outermost element, not of something inside it,
   * because under §V the row IS the card. Reading it with `querySelector` finds
   * nothing and silently reports "never settled", which is a much worse failure
   * than a wrong answer: it looks exactly like the runtime not settling the card.
   */
  decision: string | null;
  settled: boolean;
  /** Which skills the settled row names, and the mark each one carries. */
  chipSkillIds: Array<string | null>;
  chipMarks: Array<string | null>;
}

async function readAnchors(page: Page, runId?: string): Promise<CardAnchors> {
  await stripDevOverlay(page);
  return page.evaluate(
    ({
      root,
      list,
      slotSel,
      chipRowSel,
      chipSel,
      confirm,
      adjust,
      skip,
      retiredA,
      retiredB,
      marker,
      decisionAttr,
      runSlotSel,
      pinnedRunId,
    }) => {
      const roots = [...document.querySelectorAll(root)];
      const card = roots[0] ?? null;
      const conversationList = document.querySelector(list);
      const q = (sel: string) => (card ? card.querySelectorAll(sel).length : 0);
      const chipEls = card ? [...card.querySelectorAll(chipSel)] : [];
      const slotContainer = card ? card.closest(slotSel) : null;
      // The `agent_run` container names its own run — the container the card was
      // drawn in must be the one dispatched for THIS run.
      const slotIsProducingAgentRun =
        pinnedRunId === null
          ? null
          : slotContainer
            ? slotContainer.matches(runSlotSel) &&
              slotContainer.getAttribute("data-agent-run-slot") === pinnedRunId
            : false;
      return {
        roots: roots.length,
        kind: card ? card.getAttribute("data-lifecycle-card") : null,
        host: card ? card.getAttribute("data-lifecycle-card-host") : null,
        state: card ? card.getAttribute("data-lifecycle-card-state") : null,
        chatThreadMarker: card ? card.matches(marker) : false,
        insideConversationList: Boolean(card && conversationList && conversationList.contains(card)),
        slot: slotContainer?.getAttribute("data-transcript-slot") ?? null,
        slotIsProducingAgentRun,
        // `matches` ALONE, never a descendant lookup. §V declares the chip row to
        // BE the card's own outermost element, so a `querySelector` fallback is
        // dead against correct code and alive only against the wrapper regression
        // (a card root containing a heading plate around a nested row) that §V
        // retired — which is the one thing this assertion exists to catch.
        chipRow: card ? card.matches(chipRowSel) : false,
        chips: q(chipSel),
        confirmControls: q(confirm),
        adjustControls: q(adjust),
        skipControls: q(skip),
        retiredRowControls: q(retiredA) + q(retiredB),
        // OFF THE ROOT, both of them — see the field docs.
        decision: card ? card.getAttribute(decisionAttr) : null,
        settled: card ? card.getAttribute("data-run-recommendation-settled") === "true" : false,
        chipSkillIds: chipEls.map((c) => c.getAttribute("data-skill-id")),
        chipMarks: chipEls.map((c) => c.getAttribute("data-chip-mark")),
      };
    },
    {
      root: CARD_ROOT,
      list: CONVERSATION_LIST,
      slotSel: TRANSCRIPT_SLOT,
      chipRowSel: CHIP_ROW,
      chipSel: CHIP,
      confirm: CHIP_CONFIRM,
      adjust: CHIP_ADJUST,
      skip: CHIP_SKIP,
      retiredA: RETIRED_ROW_CONFIRM,
      retiredB: RETIRED_ROW_SKIP,
      marker: CHAT_HOLD_MARKER,
      decisionAttr: DECISION_ATTR,
      runSlotSel: AGENT_RUN_SLOT,
      pinnedRunId: runId ?? null,
    },
  );
}

/**
 * Open a FRESH conversation, and prove it is fresh before using it.
 *
 * Both checks are load-bearing, and neither is paranoia. #2824's acceptance is
 * stated PER TURN — "the §V card renders in the transcript", "exactly one" — so a
 * transcript carrying an earlier turn would let a previous card answer this turn's
 * question, and would let a previous turn's text satisfy a `toContain`. The Skip
 * half is the one that needs it most: it must be a SECOND, SEPARATELY held run, and
 * a silently reused thread is exactly how that quietly becomes the first one again.
 */
async function freshThread(page: Page): Promise<string> {
  await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.locator(CHAT_PROMPT).waitFor({ state: "visible", timeout: 180_000 });
  const before = await readAnchors(page);
  expect(before.roots, "a fresh thread draws no recommendation_hold card").toBe(0);
  const transcript = await page
    .locator(CONVERSATION_LIST)
    .innerText()
    .catch(() => "");
  expect(
    transcript,
    "a fresh thread carries no earlier turn — otherwise a previous turn could answer this one's assertions",
  ).not.toContain(HELD_TURN_MESSAGE);
  return page.url();
}

async function sendDrivingMessage(page: Page): Promise<void> {
  const prompt = page.locator(CHAT_PROMPT);
  await prompt.waitFor({ state: "visible", timeout: 180_000 });
  // The composer is contentEditable="false" while an SSE turn is active.
  await expect
    .poll(async () => prompt.isEditable().catch(() => false), { timeout: 120_000 })
    .toBe(true);
  await stripDevOverlay(page);
  await prompt.click();
  await page.keyboard.insertText(HELD_TURN_MESSAGE);
  await prompt.press("Enter");
}

/**
 * The turn-level refusals that mean NO run will ever be dispatched. Each one ends
 * the wait immediately with its own cause, instead of letting the (deliberately
 * large) cold-compile budget expire and reporting "no held card" — which is true,
 * useless, and points at the wrong subsystem. The MCP one is not hypothetical, which
 * is why the setup project measures that route before the flow starts.
 */
const TURN_REFUSALS = [
  // The public MCP URL missed its 2500 ms reachability probe (a cold route). The
  // setup project now measures that route for exactly this reason.
  "Cinatra tools are unavailable",
  // No provider adapter bound, so the turn was refused for want of a model before
  // the assistant could call anything.
  "No LLM provider configured",
  // The assistant DID call `agent_run` and the start was refused — an opt-in agent
  // that is registered but not installed, or one whose connector needs are unmet.
  // The sentence relays the boundary's own words, and it names the cause far better than a
  // fifteen-minute silence followed by "no held card" ever could. It covers the
  // template-scope refusal (`agent-template-scope: … cross_org`) that a test user
  // outside the agent's own organization gets, which is otherwise invisible: the
  // dispatch is refused BEFORE any run row exists, so there is nothing in
  // `agent_runs` to look at afterwards.
  "I tried to dispatch",
] as const;

/**
 * THE RUN ID, TAKEN FROM THE BROWSER — never from the database.
 *
 * The dispatch boundary prints the run id into the very turn that carries the card
 * (`Dispatched … (runId: …, status: pending_input)`), so the transcript is the one
 * place that says WHICH run the card on screen belongs to. Reading it from there
 * makes attribution flow browser → database.
 *
 * The tempting alternative — "the newest row in `agent_runs`" — is not the run on
 * screen. It is whatever was written last, by anyone. A concurrent run, or a
 * leftover from an earlier attempt, would satisfy every status, park and queue
 * assertion in this file while the card being measured belonged to something else:
 * a vacuous pass of exactly the DOM↔runtime pairing the suite exists to establish.
 */
async function runIdFromTranscript(page: Page): Promise<string> {
  const transcript = await page.locator(CONVERSATION_LIST).innerText();
  const match = transcript.match(
    /runId:\s*`?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`?/,
  );
  if (!match) {
    throw new Error(
      "the transcript does not name a runId — the dispatch boundary prints one into the " +
        "held turn, so its absence means no dispatch happened in this turn",
    );
  }
  return match[1]!;
}

/**
 * THE HELD INVARIANT, OBSERVED ALL AT ONCE.
 *
 * Four facts, polled TOGETHER until they hold in the same observation rather than
 * read once each. The card's own state becomes visible through a server action,
 * while these are read over a separate database connection, so a single-shot read
 * taken the instant the card appears can catch the runtime mid-write and fail on
 * timing rather than on truth. Under `retries: 0` that is not a flake to be
 * absorbed later — it is a red build, so the wait belongs here.
 *
 * They are also polled together rather than in sequence because the four are only
 * meaningful as one statement: "this run is parked, with nothing queued behind it".
 * Three of them holding at different moments does not say that.
 */
async function expectHeldInvariant(runId: string): Promise<void> {
  let last = "";
  await waitFor(
    `the held invariant for ${runId} (pending_input + human_present + park parked + 0 jobs)`,
    async () => {
      const facts = await readRunFacts(runId);
      const park = await readRecommendationParkStatus(runId);
      const jobs = await jobsNamingRun(runId);
      last = `status=${facts.status} human_present=${facts.humanPresent} park=${park} jobs=${jobs}`;
      return (
        facts.status === "pending_input" &&
        facts.humanPresent === true &&
        park === "parked" &&
        jobs === 0
      );
    },
    { timeoutMs: DECISION_MS },
  ).catch((err) => {
    throw new Error(`${String(err)} — last observation: ${last}`);
  });
}

/**
 * THE RELEASED INVARIANT, likewise observed all at once: the park is released, the
 * run has LEFT `pending_input`, and exactly one queue job names it.
 *
 * The "left `pending_input`" clause is the one that is easy to omit and expensive
 * to omit: a build that released the park and enqueued the job while leaving the
 * run's authoritative status stuck in the held state would satisfy the other two
 * and still not have advanced the run. The next status itself is deliberately NOT
 * pinned — that belongs to the run's own lifecycle, not to this decision — so the
 * assertion is that it moved, and the value it moved to is reported.
 */
async function expectReleasedInvariant(runId: string): Promise<string> {
  let last = "";
  let finalStatus = "";
  await waitFor(
    `the released invariant for ${runId} (park released + run left pending_input + exactly 1 job)`,
    async () => {
      const facts = await readRunFacts(runId);
      const park = await readRecommendationParkStatus(runId);
      const jobs = await jobsNamingRun(runId);
      last = `status=${facts.status} park=${park} jobs=${jobs}`;
      finalStatus = facts.status;
      return park === "released" && facts.status !== "pending_input" && jobs === 1;
    },
    { timeoutMs: DECISION_MS },
  ).catch((err) => {
    throw new Error(`${String(err)} — last observation: ${last}`);
  });
  return finalStatus;
}

/**
 * THE NEGATIVE CONTROL FOR "EXACTLY ONE JOB NAMES THIS RUN".
 *
 * An invariant nobody has watched fail is a claim, not a gate. The released arm
 * above asserts `jobs === 1`; this proves that arm can SEE a second dispatch —
 * the one shape the invariant exists to catch and the one the previous
 * `getJob(runId)` probe was blind to: a duplicate job carrying the same `runId`
 * under a DIFFERENT job id.
 *
 * It is run inside the live flow rather than as a unit arm because the thing
 * under test is the probe against the REAL queue, not the pure rule (which has
 * its own coverage in `__tests__/state-rules.test.ts`).
 *
 * The control is added an hour into the future under an unregistered job name and
 * removed in a `finally`, so it is counted and never executed, and a failure here
 * leaves the queue exactly as it found it.
 */
async function expectDuplicateDispatchWouldBeSeen(runId: string): Promise<void> {
  expect(
    await jobsNamingRun(runId),
    "the control starts from the released state's own count",
  ).toBe(1);
  try {
    await addDuplicateDispatchControl(runId);
    expect(
      await jobsNamingRun(runId),
      "a SECOND job naming this run under a different id is counted — the arm can go red",
    ).toBe(2);
  } finally {
    await removeDuplicateDispatchControl(runId);
  }
  expect(
    await jobsNamingRun(runId),
    "and the control left the queue as it found it",
  ).toBe(1);
}

/**
 * THE STREAM HANDSHAKE, AND WHY THE CARD PROBE COULD NOT SEE IT FAIL.
 *
 * `/chat` negotiates the S1 stream contract before it will put a turn on the wire
 * (`negotiateAssistantChatContract`), and that negotiation fails CLOSED: there is
 * no legacy wire to fall back to, so a failed handshake means NO TURN, no dispatch,
 * no run, and therefore no card — ever. It is reported through `console.error`
 * ("[chat] AG-UI stream handshake request failed: …") and NOTHING about it reaches
 * the transcript, which is the only thing `waitForHeldCard` reads. So on the run
 * that saw that handshake answered 404 about two minutes after boot, the probe
 * could do nothing but wait out its whole 900 000 ms cold-compile budget and then
 * report "no held card" — true, useless, and pointing at the card.
 *
 * Two things change that, and they are deliberately separate:
 *
 *   1. `installHandshakeBootWindowRetry` — a 404 on that route during the boot
 *      window is RETRIED, in the same bounded back-off the setup uses, so the
 *      compile race is absorbed rather than reported. Test-only, at the network
 *      seam: the shipped client is not touched, and nothing about the negotiation
 *      it performs changes.
 *   2. `watchHandshakeFailures` — the console line is kept, so a handshake that
 *      fails for ANY OTHER reason ends the wait immediately, quoting the browser's
 *      own words. That is the difference between "a 404 with another cause" being
 *      reported as itself and being reported as a fifteen-minute timeout.
 */
const HANDSHAKE_BOOT_WINDOW_MS = 60_000;
const HANDSHAKE_ROUTE = "**/api/assistants/chat/capabilities";
const HANDSHAKE_FAILURE_LINES = new WeakMap<Page, string[]>();

/** Keep every console line that reports a failed handshake — and only those, so a
 *  fifteen-minute turn does not accumulate a dev server's whole console. */
function watchHandshakeFailures(page: Page): void {
  const lines: string[] = [];
  HANDSHAKE_FAILURE_LINES.set(page, lines);
  page.on("console", (message) => {
    const text = message.text();
    if (handshakeFailureFrom([text])) lines.push(text);
  });
}

/** The first handshake failure this page reported, or `null`. */
function handshakeFailure(page: Page): string | null {
  return handshakeFailureFrom(HANDSHAKE_FAILURE_LINES.get(page) ?? []);
}

async function installHandshakeBootWindowRetry(page: Page): Promise<void> {
  // THE WINDOW IS MEASURED FROM THE INSTALL, not from each request. The second
  // turn happens many minutes after boot; giving it another full window would
  // delay a genuine late 404 by the whole bound before reporting it — the exact
  // "reported as a timeout instead of as itself" fault this change exists to end.
  const installedAt = Date.now();
  await page.route(HANDSHAKE_ROUTE, async (route) => {
    // Only the first-party POST handshake. The GET advertisement belongs to the
    // cross-origin embed and is none of this flow's business.
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const windowMs = bootWindowRemainingMs(installedAt, Date.now(), HANDSHAKE_BOOT_WINDOW_MS);
    if (windowMs <= 0) {
      // Past the boot window: no interception at all, the answer is the answer.
      await route.fallback();
      return;
    }
    let outcome;
    try {
      outcome = await retryWhileRouteMissing<APIResponse>(
        async (_attemptIndex, remainingMs) => {
          // The rest of the window is the request's own timeout (never 0, which
          // Playwright reads as "no timeout"), so the window bounds the wall clock.
          const response = await route.fetch({ timeout: remainingMs });
          return { status: response.status(), value: response };
        },
        {
          timeoutMs: windowMs,
          onRetry: ({ attempts, delayMs }) =>
            console.log(
              `[S9k] the stream handshake answered 404 (attempt ${attempts}) — the dev runtime ` +
                `has not compiled /api/assistants/chat/capabilities yet; retrying in ${delayMs}ms`,
            ),
        },
      );
    } catch {
      // A TRANSPORT fault is not a 404 and is not retried — the request fails now,
      // exactly as it did before this interceptor existed.
      await route.abort();
      return;
    }
    // The LAST answer is served through, 404 or not: past the bound this is a real
    // answer the client must see, and the fail-fast below reports what it was.
    if (outcome.value) await route.fulfill({ response: outcome.value });
    else await route.abort();
  });
}

/** Wait until a HELD card is on screen, then return the anchors it published. */
async function waitForHeldCard(page: Page, timeoutMs: number): Promise<CardAnchors> {
  let last: CardAnchors | null = null;
  await waitFor(
    "the §V recommendation_hold card to render in the transcript in state 'held'",
    async () => {
      // FAIL FAST ON A FAILED HANDSHAKE. It never reaches the transcript, so this
      // is checked first and separately: without it the only report available is
      // the full cold-compile budget expiring against a card that could not come.
      const handshake = handshakeFailure(page);
      if (handshake) {
        throw new Error(
          "the chat stream handshake FAILED, so the turn was never put on the wire — no run was " +
            `created, and no hold and no card could follow. The browser reported: ${handshake}. ` +
            "This is a transport fault, not a card fault.",
        );
      }
      const transcript = await page
        .locator(CONVERSATION_LIST)
        .innerText()
        .catch(() => "");
      for (const refusal of TURN_REFUSALS) {
        if (transcript.includes(refusal)) {
          throw new Error(
            `the turn was REFUSED before any dispatch ("${refusal}") — no run was created, ` +
              "so no hold and no card could follow. This is an environment fault, not a card fault.",
          );
        }
      }
      last = await readAnchors(page);
      return last.roots > 0 && last.state === "held";
    },
    { timeoutMs, intervalMs: 2_000, throwOnError: true },
  );
  return last!;
}

async function waitForDecidedCard(
  page: Page,
  want: string,
  runId?: string,
): Promise<CardAnchors> {
  let last: CardAnchors | null = null;
  await waitFor(
    `the card to settle in place with decision "${want}"`,
    async () => {
      last = await readAnchors(page, runId);
      return last.state === "decided" && last.decision === want;
    },
    { timeoutMs: DECISION_MS, intervalMs: 1_500 },
  );
  return last!;
}

/**
 * PIN THE CARD TO THE `agent_run` PART'S OWN CONTAINER.
 *
 * S9i's rule is positional: the card is drawn at the slot of the step that
 * PRODUCED it. `data-transcript-slot` is a part index and three different
 * containers carry it, so a non-null slot only says "inside some marked
 * container" — a mount moved into the generic produced-views container satisfies
 * it while breaking the rule outright.
 *
 * The `agent_run` container is the only one that also carries the inline run panel
 * for this run, so that is what the card's own slot container is required to hold.
 * This is the runtime half of the jsdom matrix's `slotOf(card) === producingSlot`.
 *
 * It is WAITED for rather than read once: the panel resolves its own seed over the
 * run API, so its link appears a beat after the card. A container that never gets
 * the link fails here, naming the container the card was actually drawn in.
 */
async function expectCardAtProducingSlot(
  page: Page,
  runId: string,
  want: "held" | "decided",
): Promise<CardAnchors> {
  let last: CardAnchors | null = null;
  await waitFor(
    `the ${want} card's own slot container to be the \`agent_run\` producing container for ${runId}`,
    async () => {
      last = await readAnchors(page, runId);
      return last.state === want && last.slotIsProducingAgentRun === true;
    },
    { timeoutMs: DECISION_MS, intervalMs: 1_000 },
  ).catch((err) => {
    throw new Error(
      `${String(err)} — the card was drawn at slot ${
        last?.slot ?? "(none)"
      }, whose container is not the one named for run ${runId}: it is a marked ` +
        "transcript slot, but not the `agent_run` part's own",
    );
  });
  return last!;
}

/**
 * PROVISIONAL runtime evidence, through the S9h recorder — the only path from a
 * browser to a record, and one that observes rather than takes dictation.
 *
 * `tier: "audit"` is the stricter of the two: it requires the extras this recorder
 * produces (painted counts, measured absences, the pinned instance), so a record
 * this flow writes is graded on everything it claims. A violation FAILS the test
 * rather than being logged, because an evidence file nobody validated is worse than
 * no evidence file.
 *
 * The records go to `RUN_EVIDENCE_DIR`, NEVER to the canonical capture index:
 * S9g alone adopts and canonicalizes AC-15 records, and `build: "development"`
 * labels every one of these as dev-runtime per the 2026-08-13 capture ruling.
 */
async function recordCapture(
  page: Page,
  spec: { cell: string; state: "pending" | "decided"; file: string },
): Promise<Record<string, unknown>> {
  // The recorder and its Playwright adapter are plain `.mjs` — deliberately, so the
  // audit tier stays dependency-free and runnable without an install. Their shapes
  // are declared HERE, at the one boundary that crosses into them, rather than
  // letting TypeScript infer parameter types from JSDoc defaults (which reads
  // `kind = undefined` as the TYPE `undefined` and rejects every real call). This
  // is a boundary declaration, not a cast that hides anything: every field below is
  // one the recorder documents.
  type CapturePort = unknown;
  const driver = (await import(
    "../../../scripts/audit/lib/chat-hitl-capture-driver.mjs"
  )) as unknown as { playwrightPage: (p: Page) => CapturePort };
  const recorder = (await import(
    "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs"
  )) as unknown as {
    observeCapture: (args: {
      page: CapturePort;
      cell: string;
      declaredHost: string;
      kind: string;
      state: string;
      screenshot: string;
      build: string;
      repoRoot: string;
    }) => Promise<Record<string, unknown>>;
    validateCaptureRecord: (
      record: Record<string, unknown>,
      io: { repoRoot: string; tier: "graded" | "audit" },
    ) => unknown[];
  };
  const { playwrightPage } = driver;
  const { observeCapture, validateCaptureRecord } = recorder;

  // WAIT FOR THE PIXELS BEFORE OPENING THE SHUTTER.
  //
  // The recorder requires every anchor to be PAINTED, not merely attached — a
  // card behind `display:none` satisfies a selector and appears nowhere in the
  // screenshot the record is filed with, so "attached DOM is not a photograph" is
  // a refusal rather than a warning. That is exactly right, and it is also why the
  // capture cannot be taken the instant an assertion passes: a decision triggers
  // `router.refresh()`, and during that re-render the transcript is briefly
  // attached and unpainted. A capture taken in that window measures zero cards and
  // the record is refused — which is a REAL red, on a page that is perfectly
  // healthy a moment later.
  //
  // Measured: this reddened one run in two, on the confirm-settled cell, and
  // nowhere else. `retries: 0` means it has to be waited for rather than absorbed.
  //
  // THE AWAITED CONDITION IS THE ROW'S OWN SETTLED STATE, not merely a visible
  // transcript and a visible card root. The decision runs through a server action
  // and then `router.refresh()` (`run-recommendation-chip-row.tsx`), so between the
  // press and the settle the card root is legitimately on screen in its PREVIOUS
  // state — a capture taken there is a photograph of the wrong moment, filed
  // against a record that declares the new one. So the state the record declares is
  // what is waited for: the settled row publishes `data-run-recommendation-settled`
  // beside `data-lifecycle-card-state="decided"`, and the held row publishes its
  // own `held` state with its chips already drawn.
  //
  // This cannot mask a genuine disappearance: the card is already asserted in the
  // state being recorded by this point, and a card that never comes back fails here
  // loudly instead of producing a refused record.
  const stateSelector =
    spec.state === "decided"
      ? `${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}${CARD_SETTLED}`
      : `${CARD_ROOT}${CARD_HOST_CHAT}${CARD_HELD}`;
  await expect(page.locator(CONVERSATION_LIST)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(stateSelector).first()).toBeVisible({ timeout: 60_000 });
  if (spec.state === "pending") {
    // A held row mid-load draws "Loading recommendations…" and no chip; the record
    // claims a card the reader could have acted on, so wait for the chips.
    await expect(page.locator(`${stateSelector} ${CHIP}`).first()).toBeVisible({
      timeout: 60_000,
    });
  }
  await stripDevOverlay(page);
  const screenshot = `${RUN_EVIDENCE_DIR}/${spec.file}`;
  const record = await observeCapture({
    page: playwrightPage(page),
    cell: spec.cell,
    declaredHost: "chat_thread",
    kind: "recommendation_hold",
    state: spec.state,
    screenshot,
    build: "development",
    repoRoot: REPO_ROOT,
  });
  // NO INJECTED HASHER. This is a REAL capture on a real disk, so it takes the
  // shipped resolved-path check: the screenshot must be a regular, singly-linked
  // file inside the real capture root. Supplying a reader here used to be read
  // as "this caller brings its own filesystem" and skipped that check on the one
  // producer that actually writes captures.
  const violations = validateCaptureRecord(record, {
    repoRoot: REPO_ROOT,
    tier: "audit",
  });
  expect(
    violations,
    `capture "${spec.cell}" did not satisfy its own declared host/kind/state`,
  ).toEqual([]);
  return record as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The flow. ONE test, deliberately: steps 1-6 are one causal chain over one
// runtime, and splitting them into independent tests would either re-drive the
// whole chain per test (minutes each) or share mutable state between tests that
// Playwright is free to reorder.
// ---------------------------------------------------------------------------
test("a chat dispatch holds, draws its card in the transcript, is decided there, and survives a reload", async ({
  page,
}, testInfo) => {
  const records: Array<Record<string, unknown>> = [];

  // Before the first navigation, so no handshake can happen unwatched or unretried.
  watchHandshakeFailures(page);
  await installHandshakeBootWindowRetry(page);

  // ══ TURN 1 — dispatch → hold → CONFIRM ═══════════════════════════════════
  const threadUrl = await freshThread(page);
  await sendDrivingMessage(page);

  await waitForHeldCard(page, FIRST_TURN_MS);

  // ── (1) A REAL held run, behind THIS card ───────────────────────────────
  //    The id comes from the transcript, and is then checked to belong to the
  //    package the flow dispatched, so every probe below measures the run the
  //    browser is showing rather than whatever row was written most recently.
  const runId = await runIdFromTranscript(page);
  await assertRunIsForPackage(runId, HELD_TURN_AGENT_PACKAGE);
  await expectHeldInvariant(runId);

  // ── (2) The card, at the `agent_run` producing slot, on the chat host ────
  //    The anchors are re-read PINNED to the run id, because "at the producing
  //    slot" is only answerable once the run the slot must belong to is known.
  const held = await expectCardAtProducingSlot(page, runId, "held");
  expect(held.roots, "exactly one recommendation_hold card in the turn").toBe(1);
  expect(held.kind).toBe("recommendation_hold");
  expect(held.host, "the card declares the chat_thread host").toBe("chat_thread");
  expect(held.state).toBe("held");
  expect(held.chatThreadMarker, "the transcript's own mount marker is on the card root").toBe(true);
  expect(held.insideConversationList, "the card is IN the transcript").toBe(true);
  expect(held.slot, "the card is drawn at a marked transcript slot (S9i)").not.toBeNull();
  expect(
    held.slotIsProducingAgentRun,
    "and that slot container is the `agent_run` part's OWN — it carries the inline run panel " +
      "for this run, which no other marked container does (S9i)",
  ).toBe(true);
  expect(held.chipRow, "the row IS the card").toBe(true);
  expect(held.chips, "one chip per assigned skill").toBe(1);
  // §V's three per-chip controls, and nothing above them.
  expect(held.confirmControls).toBe(1);
  expect(held.adjustControls).toBe(1);
  expect(held.skipControls).toBe(1);
  expect(
    held.retiredRowControls,
    "the redraw deleted the row-level Confirm/Skip — a revival must not pass unnoticed",
  ).toBe(0);
  // The SAME fact, read a second way: a compound selector resolved by Playwright's
  // own engine rather than by the in-page reader above. If the two ever disagree,
  // the reader is wrong — and a reader that is wrong about the card is the one bug
  // this whole file could not otherwise detect.
  await expect(page.locator(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_HELD}`)).toHaveCount(1);

  // ── The turn's own text: the server said the run PAUSED, not that it runs ──
  const transcript = (await page.locator(CONVERSATION_LIST).innerText()).trim();
  expect(transcript, "the held turn states the run's condition").toContain(HELD_TURN_PAUSED_TEXT);
  expect(transcript, "and never claims the agent is running").not.toContain(HELD_TURN_RUNNING_TEXT);

  records.push(
    await recordCapture(page, {
      cell: "S9k-1__recommendation-hold__chat_thread__held",
      state: "pending",
      file: "S9k-1__recommendation-hold__chat_thread__held.png",
    }),
  );

  // ── (3) The decision happens IN the chat, on the card's own control ──────
  //    The URL is read IMMEDIATELY before the press, so the comparison brackets
  //    the decision itself and nothing earlier in the session.
  // THE BASELINE IS THE URL THE DECISION IS TAKEN AT, not the one the thread was
  // opened at. Sending the first message CREATES the thread and pushes its own
  // route, so `/chat` is legitimately no longer the address by the time the card
  // exists. The acceptance criterion is that the card settles with the URL
  // unchanged ACROSS THE DECISION, so the comparison brackets the decision itself
  // and nothing earlier in the turn.
  const urlAtConfirm = page.url();
  expect(
    urlAtConfirm,
    "the decision is taken on a thread route, which the first message created",
  ).not.toBe(threadUrl);
  await stripDevOverlay(page);
  await page.locator(`${CARD_ROOT} ${CHIP_CONFIRM}`).first().click();

  // ── (4) The same card settles IN PLACE, URL unchanged ───────────────────
  const confirmed = await waitForDecidedCard(page, "confirmed", runId);
  expect(confirmed.roots, "still exactly one card — it settled, it did not multiply").toBe(1);
  expect(confirmed.host, "on the same host").toBe("chat_thread");
  expect(confirmed.insideConversationList, "in the same transcript").toBe(true);
  expect(confirmed.slot, "at the same producing slot").toBe(held.slot);
  expect(
    confirmed.slotIsProducingAgentRun,
    "and still the `agent_run` part's own container — settling did not re-parent the card",
  ).toBe(true);
  expect(confirmed.confirmControls + confirmed.adjustControls + confirmed.skipControls,
    "a settled card offers nothing to press").toBe(0);
  expect(confirmed.settled, "and says so on its own root").toBe(true);
  // Asserted by SKILL ID rather than by the chip's rendered label: the label is a
  // display name that a copy change may move, while the id is the thing the
  // decision was actually recorded against.
  expect(confirmed.chipSkillIds, "the settled row names the skill it kept").toEqual([
    HELD_TURN_SKILL_ID,
  ]);
  expect(confirmed.chipMarks, "and marks it confirmed").toEqual(["confirmed"]);
  await expect(page.locator(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`)).toHaveCount(1);
  await expect(page.locator(`${CARD_ROOT}${CARD_HELD}`)).toHaveCount(0);
  expect(page.url(), "settling the card NAVIGATED NOWHERE").toBe(urlAtConfirm);

  // ── (5) The run advanced — exactly one job ───────────────────────────────
  const confirmedStatus = await expectReleasedInvariant(runId);
  console.log(`[S9k] confirm released run ${runId}: pending_input -> ${confirmedStatus}`);
  // The "exactly one" arm, driven red on purpose and put back.
  await expectDuplicateDispatchWouldBeSeen(runId);
  expect(
    await readSelectedSkillRevisions(runId),
    "the confirmed selection is durable",
  ).toContain(HELD_TURN_SKILL_ID);

  records.push(
    await recordCapture(page, {
      cell: "S9k-2-confirmed__recommendation-hold__chat_thread__settled",
      state: "decided",
      file: "S9k-2-confirmed__recommendation-hold__chat_thread__settled.png",
    }),
  );

  // ── (6) Reload the SAME thread — the settled card comes back ─────────────
  //    Read off a cold page, not a live React tree: this is the durable half.
  await page.goto(urlAtConfirm, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await waitForDecidedCard(page, "confirmed", runId);
  // Re-read pinned: the durable half must come back AT ITS PRODUCING SLOT too, or
  // "the card survives a reload" would be satisfied by a card that came back
  // somewhere else in the transcript.
  const reloaded = await expectCardAtProducingSlot(page, runId, "decided");
  expect(page.url(), "the reload landed on the same thread").toBe(urlAtConfirm);
  expect(reloaded.roots, "the settled card reappeared, once").toBe(1);
  expect(reloaded.host).toBe("chat_thread");
  expect(reloaded.insideConversationList).toBe(true);
  expect(reloaded.decision, "with its recorded decision intact").toBe("confirmed");
  expect(reloaded.chipSkillIds).toEqual([HELD_TURN_SKILL_ID]);
  expect(reloaded.chipMarks).toEqual(["confirmed"]);
  expect(
    reloaded.confirmControls + reloaded.adjustControls + reloaded.skipControls,
    "and it is still settled after the reload",
  ).toBe(0);

  records.push(
    await recordCapture(page, {
      cell: "S9k-3-after-reload__recommendation-hold__chat_thread__settled",
      state: "decided",
      file: "S9k-3-after-reload__recommendation-hold__chat_thread__settled.png",
    }),
  );

  // ══ TURN 2 — a SECOND, separately held run, decided by SKIP ══════════════
  //    A hold cannot be both confirmed and skipped, so Skip gets its own run in
  //    its own conversation. Anything else would be asserting one decision twice.
  const skipThreadUrl = await freshThread(page);
  await sendDrivingMessage(page);

  await waitForHeldCard(page, WARM_TURN_MS);
  const runId2 = await runIdFromTranscript(page);
  expect(
    runId2,
    "the Skip half is a SECOND, SEPARATELY held run — one hold cannot be both decisions",
  ).not.toBe(runId);
  await assertRunIsForPackage(runId2, HELD_TURN_AGENT_PACKAGE);
  await expectHeldInvariant(runId2);
  const held2 = await expectCardAtProducingSlot(page, runId2, "held");
  expect(held2.roots).toBe(1);
  expect(held2.state).toBe("held");
  expect(held2.host).toBe("chat_thread");
  expect(
    held2.slotIsProducingAgentRun,
    "the second card is at ITS OWN run's `agent_run` producing slot",
  ).toBe(true);
  expect(held2.skipControls, "the chip carries its own Skip").toBe(1);

  // Same baseline rule as the confirm half: the thread route, read immediately
  // before the press.
  const urlAtSkip = page.url();
  expect(urlAtSkip).not.toBe(skipThreadUrl);
  await stripDevOverlay(page);
  await page.locator(`${CARD_ROOT} ${CHIP_SKIP}`).first().click();

  const skipped = await waitForDecidedCard(page, "skipped", runId2);
  expect(skipped.roots).toBe(1);
  expect(skipped.host).toBe("chat_thread");
  expect(skipped.slot, "the skipped card settled at its own producing slot").toBe(held2.slot);
  expect(
    skipped.slotIsProducingAgentRun,
    "which is still the `agent_run` part's own container for this run",
  ).toBe(true);
  expect(
    skipped.confirmControls + skipped.adjustControls + skipped.skipControls,
    "a skipped card offers nothing to press either",
  ).toBe(0);
  expect(skipped.settled).toBe(true);
  // The settled SKIP row draws its chips off the durable per-skill rejection
  // evidence, so this is the DOM half of the `run_rejected_recommendations`
  // assertion below — the same fact, read from both ends.
  expect(skipped.chipSkillIds, "the skipped row names the skill it dropped").toEqual([
    HELD_TURN_SKILL_ID,
  ]);
  expect(skipped.chipMarks, "and marks it skipped").toEqual(["skipped"]);
  expect(page.url(), "SKIP settled the card without navigating").toBe(urlAtSkip);

  const skippedStatus = await expectReleasedInvariant(runId2);
  console.log(`[S9k] skip released run ${runId2}: pending_input -> ${skippedStatus}`);
  expect(
    await readRejectedRecommendations(runId2),
    "the skip wrote its per-skill rejection evidence",
  ).toContain(`${HELD_TURN_SKILL_ID}:user_skipped`);

  records.push(
    await recordCapture(page, {
      cell: "S9k-4-skipped__recommendation-hold__chat_thread__settled",
      state: "decided",
      file: "S9k-4-skipped__recommendation-hold__chat_thread__settled.png",
    }),
  );

  // Reload the SKIP thread too — the settled card is durable on both outcomes.
  await page.goto(urlAtSkip, { waitUntil: "domcontentloaded", timeout: 180_000 });
  const skipReloaded = await waitForDecidedCard(page, "skipped", runId2);
  expect(skipReloaded.roots).toBe(1);
  expect(skipReloaded.host).toBe("chat_thread");
  expect(skipReloaded.insideConversationList).toBe(true);

  // ── The PROVISIONAL index. Written as an artifact of the run, labeled
  //    dev-runtime, and adopted by nobody. ─────────────────────────────────
  const indexPath = resolve(REPO_ROOT, RUN_EVIDENCE_DIR, "capture-index.provisional.json");
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    `${JSON.stringify(
      {
        $comment:
          "PROVISIONAL dev-runtime capture records for chat-hitl S9k (cinatra#2824), written by " +
          "the S9k Playwright flow through the S9h recorder and validated at the `audit` tier. " +
          "NOT the canonical index: S9g alone adopts and canonicalizes AC-15 records. Every " +
          "record is labeled build=development per the 2026-08-13 capture ruling.",
        issue: 2824,
        epic: 2784,
        schemaVersion: 1,
        records,
      },
      null,
      2,
    )}\n`,
  );
  await testInfo.attach("s9k-capture-index", { path: indexPath, contentType: "application/json" });
  console.log(`[S9k] ${records.length} provisional record(s) -> ${relative(REPO_ROOT, indexPath)}`);
});
