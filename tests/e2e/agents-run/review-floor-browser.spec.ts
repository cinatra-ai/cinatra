/**
 * THE REVIEW FLOOR, DRIVEN IN A BROWSER (cinatra#3080, acceptance item 9).
 *
 * Item 9 asks for a browser test per surface against a development server with
 * a real Postgres and the real review store. Every surface draws the one
 * `ReviewDecisionBar` (the one-card source proof,
 * `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/__tests__/review-floor-surfaces.test.ts`),
 * so this spec drives the two hosts a person reaches it on: the review page
 * (which sends the reader to the run's own address, rail on the review step)
 * and the review card in the chat (the run panel's review slot, `run_card`).
 *
 * WHAT IS REAL. The gate is minted by the shipped run executor for a run of the
 * marked review gate fixture (`./review-gate-fixture.ts`, no LLM): a real run,
 * parked on a real `artifact_review_gates` row that pins a markdown artifact
 * uploaded through the product's own upload road. The floor is pressed in the
 * browser; the outcome is read back from the store the press wrote to. Only run
 * CREATION is seeded, as the fixture documents, and the chat thread is seeded
 * through `POST /api/assistants/threads`, the route the chat client itself
 * writes, as `./chat-render-parity-target.ts` does.
 *
 * WHAT IT ASSERTS, per surface:
 *   - Comment: the note is filed on the gate, the gate stays pending, the run
 *     stays parked where it was, the pinned revision is unchanged, no repair
 *     (successor lineage) exists, and the floor stays live (on the chat card
 *     this last point is a known defect, pinned by the last test below);
 *   - Continue: the gate resolves with the stored disposition `approve`, the
 *     floor reads "Continued", and the run is released and ends `completed`
 *     (`failed` or `stopped` fails at once; a run row that is gone fails too).
 * Regenerate is not driven here: this fixture reviews uploaded artifacts, which
 * no producing step filed, so no `regenerate` entry exists for them and the
 * canonical operation refuses Regenerate before any write. A successor gate
 * needs a producer whose filing node declares a Regenerate step and a runtime
 * with the step road (`regenerate_segment/1`).
 *
 * PRECONDITIONS. The fixture tree is staged into `extensions/`
 * (`stageReviewGateFixture`) BEFORE the server boots, so the dev boot registers
 * its template and the WayFlow runtime mounts it; the spec fails, with that
 * instruction, when the template row is missing. It depends on the `setup`
 * project (the signed-in admin and its active organization). Before the run,
 * stage the fixture with `stageReviewGateFixture` (`./review-gate-fixture.ts`)
 * into the checkout the dev server and the WayFlow runtime boot from.
 *
 *   E2E_REUSE_SERVER=1 pnpm exec playwright test \
 *     -c tests/e2e/config/agents-run.config.ts --project review-floor-browser
 */
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { Client } from "pg";

import { buildChatPath, DEFAULT_ASSISTANT_PACKAGE, DEFAULT_CHAT_ROUTE } from "@cinatra-ai/chat/chat-path-codec";
import { slugifyTitle } from "@cinatra-ai/chat/thread-slug";

import {
  REVIEW_GATE_FIXTURE,
  seedMarkedReviewGateRun,
  waitForMarkedReviewGates,
  type FixtureReviewTarget,
  type SeededReviewGate,
} from "./review-gate-fixture";
import { resolveTestActor } from "./seed";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const BASE_URL = process.env.E2E_AGENTS_RUN_BASE_URL ?? "http://localhost:3000";

/** The parked statuses: the run waits on a person while its gate is pending. */
const PARKED_STATUSES = new Set(["pending_input", "pending_approval"]);
/** The terminal statuses a released run must NOT reach. Continue resumes the
 *  run, the WayFlow runtime executes the flow's remaining EndNode and the run
 *  ends `completed`; the fixture has no LLM and no other step, so it is
 *  deterministic. `running` is written before WayFlow returns
 *  (artifact-review-resume-delivery.ts), so it is NOT proof of a release: a
 *  WayFlow failure after it turns the run `failed` (execution.ts). */
const FAILED_TERMINAL_STATUSES = new Set(["failed", "stopped"]);

const FLOOR = '[data-conformance-id="review-decision-bar"]';
const COMMENT = '[data-action="comment-review -> annotated"]';
const REGENERATE = '[data-action="regenerate-review -> successor-gate-opened"]';
const CONTINUE = '[data-action="continue-review -> resolved"]';
/** Every `data-action` anchor the floor draws, as the attribute's own words:
 *  the three decision buttons, in the sorted order `expectTheFloor` compares. */
const FLOOR_ACTIONS = [
  "comment-review -> annotated",
  "continue-review -> resolved",
  "regenerate-review -> successor-gate-opened",
];

async function withPg<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface GateState {
  id: string;
  status: string;
  disposition: string | null;
  pinnedTargets: string;
  runStatus: string;
  gateCount: number;
  repairs: number;
  notes: string[];
}

/** The store's own reading of one gate, its run, its run's gate count, its
 *  repair lineages and the notes filed on it. */
async function readGateState(gate: SeededReviewGate): Promise<GateState> {
  return withPg(async (c) => {
    const g = await c.query<{ id: string; status: string; disposition: string | null; pinned_targets: unknown }>(
      `SELECT id, status, disposition, pinned_targets FROM ${SCHEMA}.artifact_review_gates WHERE id = $1`,
      [gate.gateId],
    );
    const r = await c.query<{ status: string }>(`SELECT status FROM ${SCHEMA}.agent_runs WHERE id = $1`, [gate.runId]);
    const n = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SCHEMA}.artifact_review_gates WHERE run_id = $1`,
      [gate.runId],
    );
    const repairs = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SCHEMA}.lifecycle_repair WHERE gate_id = $1`,
      [gate.gateId],
    );
    const notes = await c.query<{ body: string }>(
      `SELECT body FROM ${SCHEMA}.gate_advisory_comments WHERE gate_id = $1 ORDER BY created_at`,
      [gate.gateId],
    );
    const row = g.rows[0];
    if (!row) throw new Error(`gate ${gate.gateId} is gone from the store`);
    // A run row that is gone is a failure of its own: a destructive press that
    // deleted the run must never read as a status that passes a check.
    const run = r.rows[0];
    if (!run) throw new Error(`run ${gate.runId} is gone from the store`);
    return {
      id: row.id,
      status: row.status,
      disposition: row.disposition,
      pinnedTargets: JSON.stringify(row.pinned_targets),
      runStatus: run.status,
      gateCount: Number(n.rows[0]?.n ?? 0),
      repairs: Number(repairs.rows[0]?.n ?? 0),
      notes: notes.rows.map((x) => x.body),
    };
  });
}

/** Upload one markdown document through the product's own upload road and
 *  return the revision it froze — the review target the run will pin. */
async function uploadReviewTarget(request: APIRequestContext, label: string): Promise<FixtureReviewTarget> {
  const name = `review-floor-${label}-${randomUUID().slice(0, 8)}.md`;
  const response = await request.post("/api/artifacts/upload", {
    headers: {
      "content-type": "text/markdown",
      "x-artifact-filename": name,
      "x-artifact-title": name.replace(/\.md$/, ""),
    },
    data: Buffer.from(`# The ${label} review\n\nA document the review floor decides on.\n`, "utf8"),
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { artifactId?: string; representationRevisionId?: string };
  expect(body.artifactId, "the upload road returned no artifact").toBeTruthy();
  expect(body.representationRevisionId, "the upload road returned no revision").toBeTruthy();
  return { artifactId: body.artifactId as string, representationRevisionId: body.representationRevisionId as string };
}

/**
 * The fixture's template is installed into one organization, and the run
 * executor refuses (`cross_org`) a run whose actor stands in another. So the
 * signed-in actor is made a member of the template's organization and that
 * organization is made the session's active one, through Better Auth's own
 * set-active route. A canonical dev database already has the membership; a
 * fresh lane database does not. Fails, with the staging instruction, when the
 * template is not registered.
 */
async function alignActorWithFixtureOrg(request: APIRequestContext): Promise<void> {
  const template = await withPg(async (c) => {
    const r = await c.query<{ org_id: string | null }>(
      `SELECT org_id FROM ${SCHEMA}.agent_templates WHERE package_name = $1 LIMIT 1`,
      [REVIEW_GATE_FIXTURE.packageName],
    );
    return r.rows[0] ?? null;
  });
  expect(
    template,
    `${REVIEW_GATE_FIXTURE.packageName} is not registered: stage ${REVIEW_GATE_FIXTURE.fixtureRoot} into ` +
      "extensions/ (stageReviewGateFixture) before the server and the WayFlow runtime boot",
  ).not.toBeNull();
  const orgId = template?.org_id ?? null;
  if (!orgId) return;
  const { userId, orgId: activeOrgId } = await resolveTestActor();
  if (activeOrgId === orgId) return;
  await withPg((c) =>
    c.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
       SELECT $1, $2, $3, 'member', now()
        WHERE NOT EXISTS (SELECT 1 FROM public."member" WHERE "organizationId" = $2 AND "userId" = $3)`,
      [randomUUID(), orgId, userId],
    ),
  );
  const setActive = await request.post("/api/auth/organization/set-active", {
    headers: { Origin: BASE_URL },
    data: { organizationId: orgId },
  });
  expect(setActive.ok(), `set-active failed (${setActive.status()}): ${await setActive.text()}`).toBe(true);
  expect((await resolveTestActor()).orgId, "the session's active organization").toBe(orgId);
}

/** A run of the fixture parked on ONE pending single-target gate. */
async function parkRunOnGate(request: APIRequestContext, label: string): Promise<SeededReviewGate> {
  await alignActorWithFixtureOrg(request);
  const actor = await resolveTestActor();
  const target = await uploadReviewTarget(request, label);
  const runId = await seedMarkedReviewGateRun({ ...actor, targets: [target] });
  const gates = await waitForMarkedReviewGates(runId);
  expect(gates, `run ${runId} should hold exactly one gate`).toHaveLength(1);
  const [gate] = gates;
  expect(gate.status).toBe("pending");
  // The gate pins exactly the uploaded revision (the row also carries the
  // executor's declared review plan beside each target).
  expect(
    gate.pinnedTargets.map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId })),
  ).toEqual([target]);
  // The run reaches its parked status with the gate (the executor writes both).
  await expect
    .poll(async () => (await readGateState(gate)).runStatus, { timeout: 60_000 })
    .toMatch(/^pending_(input|approval)$/);
  return gate;
}

/** Press Comment with a note and prove item 3 on the store. */
async function commentKeepsTheGateOpen(
  floor: Locator,
  gate: SeededReviewGate,
  { floorStaysLive = true }: { floorStaysLive?: boolean } = {},
): Promise<void> {
  const before = await readGateState(gate);
  const note = `Tighten the opening (${randomUUID().slice(0, 8)}).`;
  await floor.getByTestId("review-rationale").fill(note);
  await floor.locator(COMMENT).click();
  // A development server compiles the decision's server action on its first
  // press, so the landed outcome gets a generous bound.
  await expect(floor.locator('[data-review-outcome="annotated"]')).toBeVisible({ timeout: 90_000 });
  await expect(floor.locator(REGENERATE)).toBeVisible();
  await expect(floor.locator('[data-review-outcome="decided"]')).toHaveCount(0);
  if (floorStaysLive) await expectTheFloorLive(floor);

  await expect.poll(async () => (await readGateState(gate)).notes, { timeout: 15_000 }).toContain(note);
  const after = await readGateState(gate);
  expect(after.status, "Comment must leave the gate pending").toBe("pending");
  expect(after.disposition).toBeNull();
  expect(after.runStatus, "Comment must leave the run parked where it was").toBe(before.runStatus);
  expect(PARKED_STATUSES.has(after.runStatus)).toBe(true);
  expect(after.pinnedTargets, "Comment must leave the frozen revision unchanged").toBe(before.pinnedTargets);
  expect(after.repairs, "Comment must open no successor lineage").toBe(0);
  expect(after.gateCount, "Comment must mint no other gate").toBe(before.gateCount);
}

/** Comment decides nothing, so the floor it was pressed on stays live. */
async function expectTheFloorLive(floor: Locator): Promise<void> {
  await expect(floor.locator(CONTINUE)).toBeEnabled({ timeout: 60_000 });
  await expect(floor.locator(REGENERATE)).toBeEnabled();
  await expect(floor.locator(COMMENT)).toBeEnabled();
  await expect(floor.getByTestId("review-rationale")).toBeEditable();
}

/** How long the known-defect pin gives the chat card's floor to become live
 *  after a Comment (the review page's floor clears at once). */
const LIVENESS_BOUND_MS = 30_000;

/** One reading of the floor's liveness: every decision control is attached
 *  and enabled, and the note is editable. A missing control reads not live. */
async function floorIsLive(floor: Locator): Promise<boolean> {
  const readings = await Promise.all(
    [floor.locator(CONTINUE), floor.locator(REGENERATE), floor.locator(COMMENT)].map(async (l) =>
      (await l.count()) === 1 ? l.isEnabled() : false,
    ),
  );
  const note = floor.getByTestId("review-rationale");
  const noteEditable = (await note.count()) === 1 ? await note.isEditable() : false;
  return readings.every(Boolean) && noteEditable;
}

/** Press Continue and prove item 2 on the store: resolved, `approve`, released.
 *  `surface` is the host the card lives in: once the decision lands the host
 *  refreshes and the card draws its settled reading in place of the floor. */
async function continueResolvesTheGate(surface: Locator, floor: Locator, gate: SeededReviewGate): Promise<void> {
  await floor.locator(CONTINUE).click();
  // The floor's own notice, or the settled card that replaces the floor after
  // the refresh: either way the reading is "Continued" and no floor is left.
  await expect(surface.getByText(/^Continued\b/).first()).toBeVisible({ timeout: 90_000 });
  await expect(surface.locator(CONTINUE)).toHaveCount(0, { timeout: 30_000 });
  await expect(surface.getByRole("button", { name: /^(Reject|Approve)$/ })).toHaveCount(0);

  await expect.poll(async () => (await readGateState(gate)).status, { timeout: 15_000 }).toBe("resolved");
  const after = await readGateState(gate);
  expect(after.disposition, "Continue keeps storing the disposition approve").toBe("approve");
  expect(after.repairs).toBe(0);
  await expectRunCompleted(gate);
}

/** Poll the run until it is `completed`. `failed` or `stopped` fails at once;
 *  a run row that is gone fails at once (readGateState throws); a run that is
 *  still queued or running when the bound expires fails with its last status. */
async function expectRunCompleted(gate: SeededReviewGate, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  for (;;) {
    status = (await readGateState(gate)).runStatus;
    if (status === "completed") return;
    if (FAILED_TERMINAL_STATUSES.has(status)) {
      throw new Error(`Continue must complete run ${gate.runId}, but it ended ${status}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`run ${gate.runId} did not complete within ${timeoutMs} ms after Continue (last status: ${status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** The three actions and no fourth, on a pending gate: exactly three
 *  `data-action` anchors whose words are the three decision actions, and exactly
 *  three buttons, so a fourth control fails whether or not it carries the anchor. */
async function expectTheFloor(floor: Locator): Promise<void> {
  await expect(floor.locator("[data-action]")).toHaveCount(FLOOR_ACTIONS.length);
  await expect(floor.getByRole("button")).toHaveCount(FLOOR_ACTIONS.length);
  const actions = await floor.locator("[data-action]").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-action") ?? "").sort(),
  );
  expect(actions, "the floor's action anchors").toEqual(FLOOR_ACTIONS);
  await expect(floor.locator(COMMENT)).toHaveText("Comment");
  await expect(floor.locator(REGENERATE)).toHaveText("Regenerate");
  await expect(floor.locator(CONTINUE)).toHaveText("Continue");
  await expect(floor.getByRole("button", { name: /^(Reject|Approve)$/ })).toHaveCount(0);
}

/** Seed a chat thread whose assistant turn carries the run's `agent_run` part,
 *  bind and slug it as the app does at rest, and return its canonical path. */
async function seedChatThreadForRun(request: APIRequestContext, runId: string): Promise<string> {
  const threadId = randomUUID();
  const nowIso = new Date().toISOString();
  const title = `review floor ${threadId}`;
  const seed = await request.post("/api/assistants/threads", {
    headers: { "content-type": "application/json", Origin: BASE_URL },
    data: {
      id: threadId,
      title,
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: [
        { id: randomUUID(), role: "user", content: "Run the review fixture.", createdAt: nowIso },
        {
          id: randomUUID(),
          role: "assistant",
          content: "",
          createdAt: nowIso,
          parts: [
            { kind: "tool_call", id: randomUUID(), name: "agent_run", status: "completed", runId },
            { kind: "text", content: "The run is waiting on your review." },
          ],
        },
      ],
    },
  });
  expect(seed.ok(), `seeding the chat thread failed (${seed.status()})`).toBe(true);
  const titleSlug = slugifyTitle(title);
  await withPg(async (c) => {
    const res = await c.query(
      `UPDATE ${SCHEMA}.assistant_threads
          SET assistant_package = $1, instance_id = NULL, title_slug = $2, updated_at = now()
        WHERE id = $3`,
      [DEFAULT_ASSISTANT_PACKAGE, titleSlug, threadId],
    );
    expect(res.rowCount, "binding the seeded thread").toBe(1);
  });
  return buildChatPath({ vendor: DEFAULT_CHAT_ROUTE.vendor, slug: DEFAULT_CHAT_ROUTE.slug, titleSlug });
}

/** The review page's address for a gate. It sends the reader to the run. */
function reviewPagePath(gate: SeededReviewGate): string {
  return [
    "",
    "agents",
    REVIEW_GATE_FIXTURE.vendor,
    REVIEW_GATE_FIXTURE.slug,
    encodeURIComponent(gate.runId),
    "review",
    encodeURIComponent(gate.reviewTaskId),
  ].join("/");
}

async function floorOnReviewPage(page: Page, gate: SeededReviewGate): Promise<{ surface: Locator; floor: Locator }> {
  await page.goto(reviewPagePath(gate), { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(new RegExp(`/${gate.runId}`));
  const floor = page.locator(FLOOR);
  await expect(floor).toHaveCount(1, { timeout: 120_000 });
  return { surface: page.locator("main").last(), floor };
}

async function floorOnChatCard(
  page: Page,
  request: APIRequestContext,
  gate: SeededReviewGate,
): Promise<{ surface: Locator; floor: Locator }> {
  const chatPath = await seedChatThreadForRun(request, gate.runId);
  await page.goto(chatPath, { waitUntil: "domcontentloaded" });
  return chatCardFloor(page, gate);
}

/** The floor of the run's review card in the chat thread on screen. */
async function chatCardFloor(page: Page, gate: SeededReviewGate): Promise<{ surface: Locator; floor: Locator }> {
  const card = page.locator(
    `[data-inline-run-card="${gate.runId}"] [data-run-review-slot="review"] [data-conformance-id="review-gate-card"]`,
  );
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  const floor = card.locator(FLOOR);
  await expect(floor).toBeVisible({ timeout: 30_000 });
  return { surface: page.locator(`[data-inline-run-card="${gate.runId}"]`), floor };
}

test.describe("the review floor on a real gate, in the browser (cinatra#3080 item 9)", () => {
  // A run, an upload, two presses and a release, each on a development server
  // that compiles on first use: longer than the suite's 180 s default.
  test.describe.configure({ timeout: 480_000 });

  test("review page: Comment keeps the gate pending, Continue resolves it", async ({ page, request }) => {
    const gate = await parkRunOnGate(request, "page");
    const { surface, floor } = await floorOnReviewPage(page, gate);
    await expectTheFloor(floor);
    await commentKeepsTheGateOpen(floor, gate);
    await continueResolvesTheGate(surface, floor, gate);
  });

  test("chat card: Comment keeps the gate pending, Continue resolves it", async ({ page, request }) => {
    const gate = await parkRunOnGate(request, "chat");
    const first = await floorOnChatCard(page, request, gate);
    await expectTheFloor(first.floor);
    // The floor's liveness after a Comment is the known defect pinned by the
    // next test; the store reading of the Comment is asserted here in full.
    await commentKeepsTheGateOpen(first.floor, gate, { floorStaysLive: false });
    // Read the card again from the server, as a returning reader does: the
    // gate is still pending, so the floor is drawn again, live.
    await page.reload({ waitUntil: "domcontentloaded" });
    const card = await chatCardFloor(page, gate);
    await expectTheFloor(card.floor);
    await expectTheFloorLive(card.floor);
    await continueResolvesTheGate(card.surface, card.floor, gate);
  });

  // KNOWN DEFECT, found by this spec: on the chat card, after a Comment lands
  // ("Comment recorded. The gate stays open"), Comment, Continue and the Note
  // stay disabled (the floor's own pending state never clears; observed for
  // 90 s on a warm development server while the review page's floor clears at
  // once). A reader has to reload the thread to Continue.
  //
  // The pin covers ONLY the liveness reading. The gate, the render and the
  // Comment (with its full store reading) are hard assertions: any failure
  // there fails this test. Then the floor is given LIVENESS_BOUND_MS to become
  // live; the test FAILS if it does (the defect is fixed: remove this pin and
  // assert `expectTheFloorLive` in the chat card test above) and passes while
  // the floor stays drawn with Continue disabled.
  test("chat card: the floor stays disabled after a Comment (known defect pin)", async ({ page, request }) => {
    const gate = await parkRunOnGate(request, "chat-live");
    const { floor } = await floorOnChatCard(page, request, gate);
    await expectTheFloor(floor);
    await commentKeepsTheGateOpen(floor, gate, { floorStaysLive: false });

    const becameLive = await expect
      .poll(() => floorIsLive(floor), { timeout: LIVENESS_BOUND_MS })
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    expect(
      becameLive,
      "KNOWN DEFECT FIXED: the chat card's floor became live after a Comment. Remove this pin " +
        "and assert expectTheFloorLive after the Comment in the chat card test.",
    ).toBe(false);
    // The defect's own reading: the floor is still drawn and Continue is
    // disabled (a floor that vanished is a different failure, not the defect).
    await expect(floor.locator(CONTINUE)).toHaveCount(1);
    await expect(floor.locator(CONTINUE)).toBeDisabled();
  });
});
