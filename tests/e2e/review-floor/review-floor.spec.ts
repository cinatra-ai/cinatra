// ---------------------------------------------------------------------------
// THE REVIEW FLOOR ON THE RUNNING APP (cinatra#3080, epic #3023) — acceptance
// item 9: "every mutation is proved on the real surface".
//
// One browser walk per surface, against a REAL `artifact_review_gates` row on a
// REAL run, decided through the shipped decision core: the review page, the run
// page's review step, the review card in the chat thread, and the review card
// inside a third-party application (the widget host). Each asserts the same two
// things the ratified drawing fixes — the floor is Comment · Regenerate ·
// Continue, and neither Reject nor Approve is drawn on a pending review — and
// then the walk drives the three acts and reads what the store did.
//
// NO MODEL IS INVOLVED. The gate comes from the harness's deterministic no-LLM
// fixture agent (`review-gate-fixture.ts`), which is exactly why the floor can
// be proven in a browser at all: the floor needs no model, so the language model
// may be the scripted test provider and nothing here waits on one.
//
// WHY THESE SPECS ARE AUTHORED HERE AND RUN ELSEWHERE. This is a LIVE spec: it
// needs the running app, a real Postgres, the real review store and an
// authenticated session, so it is not a per-PR gate — it runs on the stack, like
// its `agents-run` siblings. The lane that wrote this change authored the specs
// so CI runs them and booted no development server of its own; the graded
// light/dark captures of every changed surface follow in their own capture leg
// before any review is requested.
//
//   pnpm exec playwright test --config tests/e2e/config/review-floor.config.ts
// ---------------------------------------------------------------------------

import { Client } from "pg";
import { test, expect, type Page } from "@playwright/test";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  REVIEW_GATE_FIXTURE,
  seedLifecycleReviewGate,
  seedMarkedReviewGateRun,
  waitForMarkedReviewGate,
  type FixtureReviewTarget,
} from "../agents-run/review-gate-fixture";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
/**
 * THE ACTOR THE WALK SEEDS AS — the SAME person the browser is signed in as
 * (cinatra#3080, fix leg 9). The gate is minted on a run this user owns and read
 * back through that user's own authorization, so a seeding id that names anyone
 * else produces a 404 rather than a floor. The setup project records the
 * signed-in actor beside its cookie state; the environment may still state them
 * explicitly, and an instance that has neither self-skips as before.
 */
function signedInActor(): { userId: string; orgId: string } {
  const fromEnv = {
    userId: process.env.E2E_USER_ID ?? "",
    orgId: process.env.E2E_ORG_ID ?? "",
  };
  if (fromEnv.userId && fromEnv.orgId) return fromEnv;
  try {
    const recorded = JSON.parse(
      readFileSync("tests/e2e/review-floor/.auth/actor.json", "utf8"),
    ) as { userId?: unknown; orgId?: unknown };
    return {
      userId: typeof recorded.userId === "string" ? recorded.userId : "",
      orgId: typeof recorded.orgId === "string" ? recorded.orgId : "",
    };
  } catch {
    return { userId: "", orgId: "" };
  }
}


/** The floor, as the shipped bar emits it. The anchors — not the visible words —
 *  are what a surface is pinned on, because a relabel that kept the old act
 *  behind a new word would still read correctly to a text-only assertion. */
const FLOOR = {
  comment: '[data-action="comment-review -> annotated"]',
  regenerate: '[data-action="regenerate-review -> changes-requested"]',
  continue: '[data-action="continue-review -> resolved"]',
} as const;

/** The two retired acts, in every spelling a regression could bring back. */
const RETIRED = [
  '[data-action="approve-review -> resolved"]',
  '[data-action="reject-review -> resolved"]',
  'button:has-text("Approve")',
  'button:has-text("Reject")',
];

async function withPg<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * A pinned target the reviewer may actually read: an artifact revision that
 * already exists in this instance. Deliberately DISCOVERED rather than created —
 * the floor is what is under test, not the upload path, and inventing a row the
 * artifact reader would refuse would prove nothing about either.
 *
 * THE TABLE IS `representation`, KEYED ON `artifact_id` (cinatra#3080, fix leg
 * 9). This read used to name `object_representations (object_id)` — a table and
 * a column this product has never declared. Postgres answers `42P01`, the helper
 * throws, and every test below fails inside `openGate()` before a surface is
 * drawn: the suite that IS acceptance item 9's live proof reported a harness
 * error rather than a floor reading. The canonical row is
 * `cinatra.representation`, whose artifact key is `artifact_id`
 * (`buildCreateStoreSchemaQueries`, src/lib/drizzle-store.ts), and the node-tier
 * `tests/e2e/__tests__/review-floor-live-spec-tables.test.ts` now reconciles
 * every table named here against that DDL so the drift cannot come back
 * unnoticed.
 */
async function anyReadableTarget(): Promise<FixtureReviewTarget | null> {
  return withPg(async (c) => {
    const r = await c.query<{ artifact_id: string; representation_revision_id: string }>(
      `SELECT o.id AS artifact_id, r.id AS representation_revision_id
         FROM ${SCHEMA}.objects o
         JOIN ${SCHEMA}.representation r ON r.artifact_id = o.id
        WHERE o.deleted_at IS NULL
        ORDER BY r.created_at DESC
        LIMIT 1`,
    );
    return r.rows[0]
      ? {
          artifactId: r.rows[0].artifact_id,
          representationRevisionId: r.rows[0].representation_revision_id,
        }
      : null;
  });
}

/**
 * The gate's own row. The REVIEW TASK is part of the address (cinatra#3080, fix
 * leg 9): a run can carry more than one gate — the Regenerate walks open a
 * lifecycle-road gate beside the run's own flow-authored one — and a read keyed
 * on the run alone would answer with whichever row came back first. Omitted, it
 * reads the run's single gate exactly as it always did.
 */
async function gateDisposition(
  runId: string,
  reviewTaskId?: string,
): Promise<{ status: string; disposition: string | null }> {
  return withPg(async (c) => {
    const r = reviewTaskId
      ? await c.query<{ status: string; disposition: string | null }>(
          `SELECT status, disposition FROM ${SCHEMA}.artifact_review_gates
            WHERE run_id = $1 AND review_task_id = $2 LIMIT 1`,
          [runId, reviewTaskId],
        )
      : await c.query<{ status: string; disposition: string | null }>(
          `SELECT status, disposition FROM ${SCHEMA}.artifact_review_gates WHERE run_id = $1 LIMIT 1`,
          [runId],
        );
    return r.rows[0] ?? { status: "absent", disposition: null };
  });
}

async function repairCount(runId: string): Promise<number> {
  return withPg(async (c) => {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SCHEMA}.lifecycle_repair p
         JOIN ${SCHEMA}.artifact_review_gates g ON g.id = p.gate_id
        WHERE g.run_id = $1`,
      [runId],
    );
    return Number(r.rows[0]?.n ?? "0");
  });
}

/** ITEM 1, on whatever surface the page is currently showing. */
async function expectTheFloor(page: Page): Promise<void> {
  await expect(page.locator(FLOOR.comment)).toBeVisible();
  await expect(page.locator(FLOOR.regenerate)).toBeVisible();
  await expect(page.locator(FLOOR.continue)).toBeVisible();
  await expect(page.locator(FLOOR.comment)).toHaveText(/Comment/);
  await expect(page.locator(FLOOR.regenerate)).toHaveText(/Regenerate/);
  await expect(page.locator(FLOOR.continue)).toHaveText(/Continue/);
  for (const retired of RETIRED) {
    await expect(page.locator(retired)).toHaveCount(0);
  }
}

/**
 * DECLARE THE RUN'S PRODUCING STEP REPAIR-CAPABLE (cinatra#3080 item 4).
 *
 * Regenerate promises one thing: this work, made again, under a successor gate.
 * Since the canonical operation refuses a Regenerate it cannot keep that promise
 * for, a test that presses Regenerate has to be on a run that HAS a producing
 * step to send the words back to — otherwise it is measuring the refusal, which
 * is a different test. The declaration lives on the run's template, which is
 * exactly where the change road reads it from.
 */
async function declareProducerRepairCapable(runId: string): Promise<void> {
  await withPg(async (c) => {
    await c.query(
      `UPDATE ${SCHEMA}.agent_templates
          SET lifecycle_config = COALESCE(lifecycle_config::jsonb, '{}'::jsonb)
                                 || '{"repairCapable": true}'::jsonb
        WHERE id = (SELECT template_id FROM ${SCHEMA}.agent_runs WHERE id = $1)`,
      [runId],
    );
  });
}

/** A gate of the fixture agent, or null when this instance cannot make one. */
async function openGate(
  options: { inConversation?: boolean } = {},
): Promise<{ runId: string; reviewTaskId: string; threadId: string | null } | null> {
  // Read at CALL time, not at import time: the setup project writes this record,
  // and a module-level read would run before it in a worker that loaded the file
  // first.
  const { userId: USER_ID, orgId: ORG_ID } = signedInActor();
  if (!USER_ID || !ORG_ID) return null;
  const target = await anyReadableTarget();
  if (!target) return null;
  // The conversation is written BEFORE the job is enqueued, because the run
  // outbox injects the moment's card into the turn it finds AT GATE EMISSION: a
  // thread written afterwards is a thread the writer never saw.
  const threadId = options.inConversation === true ? randomUUID() : null;
  const runId = await seedMarkedReviewGateRun({
    userId: USER_ID,
    orgId: ORG_ID,
    targets: [target],
    ...(threadId === null ? {} : { chatTurn: { threadId } }),
  });
  const gate = await waitForMarkedReviewGate(runId);
  return { runId, reviewTaskId: gate.reviewTaskId, threadId };
}

/**
 * THE DEFAULT CONTAINER, READ OFF THE PRODUCT (cinatra#3080, fix leg 9).
 *
 * An unbound thread is addressed in the default assistant's container, and this
 * walk must not hardcode which one that is: a bare `/chat` redirects to the
 * canonical default, so the product itself names the container and the thread id
 * is appended to it. Hardcoding a vendor and a slug here would make the walk
 * pass or fail on a naming choice rather than on the floor.
 */
async function chatThreadUrl(page: Page, threadId: string): Promise<string> {
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const container = new URL(page.url()).pathname.replace(/\/+$/, "");
  // A session that expired lands on /sign-in, and appending a thread id to THAT
  // would measure the sign-in page and report a missing card. Say what happened
  // instead.
  expect(
    container.startsWith("/chat"),
    `/chat resolved to ${container} — the walk is not signed in`,
  ).toBe(true);
  return `${container}/${threadId}`;
}

test.describe("cinatra#3080 — the review floor on the real surfaces", () => {
  test.slow();

  test("item 1 — the REVIEW PAGE draws Comment · Regenerate · Continue and neither retired act", async ({
    page,
  }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    await page.goto(reviewPageUrl(gate!.runId, gate!.reviewTaskId));
    await expectTheFloor(page);
  });

  test("item 1 — the RUN PAGE's review step draws the same three", async ({ page }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    // THE RUN PAGE IS THE INSTANCE ROUTE (cinatra#3080, fix leg 9). This walk
    // used to open `/agents/runs/<runId>`, which this product has no route for
    // (`src/app/agents` carries `page.tsx`, `[vendor]/[packageName]/[instanceId]`,
    // `reviews` and `executions`, and nothing else): the app answered
    // "404 — Page not found", the card never appeared, and the failure read as a
    // missing floor rather than a missing route. The run page is the instance
    // route, which `runPageUrl` builds from the same fixture coordinates the
    // review route already uses.
    await page.goto(runPageUrl(gate!.runId));
    await expect(page.locator('[data-conformance-id="review-gate-card"]')).toBeVisible();
    await expectTheFloor(page);
  });

  test("item 1 — the CHAT thread's review card draws the same three", async ({ page }) => {
    const gate = await openGate({ inConversation: true });
    test.skip(gate === null, "no seedable review gate on this instance");
    // THE THREAD IS THE ADDRESS, NOT THE RUN (cinatra#3080, fix leg 9). This
    // walk used to open `/chat?run=<runId>`, a road this product does not serve:
    // `/chat` takes `<vendor>/<slug>[/instance]/<thread>` path segments and
    // reads no run parameter at all, so the page answered with the default
    // conversation, no card was ever there to find, and the failure read as a
    // missing floor rather than a missing address. The card is written into the
    // turn the run is playing out in, so the walk seeds that conversation and
    // opens IT.
    await page.goto(await chatThreadUrl(page, gate!.threadId!), {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-conformance-id="review-gate-card"]')).toBeVisible();
    await expectTheFloor(page);
  });

  test("item 7 — the display ISLAND inside the card carries no floor of its own", async ({
    page,
  }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    await page.goto(reviewPageUrl(gate!.runId, gate!.reviewTaskId));
    const island = page.frameLocator('[data-conformance-id="review-target-island"] iframe');
    // The island renders the work and nothing that decides it — the enclosing
    // card owns the floor, outside the frame.
    for (const anchor of [...Object.values(FLOOR), ...RETIRED]) {
      await expect(island.locator(anchor)).toHaveCount(0);
    }
  });

  test("item 3 — COMMENT records the note and leaves the gate open", async ({ page }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    await page.goto(reviewPageUrl(gate!.runId, gate!.reviewTaskId));
    await page.getByTestId("review-rationale").fill("a note that decides nothing");
    await page.locator(FLOOR.comment).click();
    await expect(page.locator('[data-review-outcome="annotated"]')).toContainText(
      "The gate stays open",
    );
    const after = await gateDisposition(gate!.runId);
    expect(after.status).toBe("pending");
    expect(await repairCount(gate!.runId)).toBe(0);
    // The floor is still live — a comment settled nothing.
    await expectTheFloor(page);
  });

  test("item 4 — REGENERATE refuses an empty note, then sends the words back", async ({ page }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    await declareProducerRepairCapable(gate!.runId);
    // THE GATE A REGENERATE CAN ACTUALLY BE SENT BACK THROUGH (fix leg 9). The
    // change road serves the lifecycle gate family and refuses every other one
    // by task id, so this walk stands at a lifecycle-road gate on the same run
    // and the same pinned target. Pressing Regenerate on the run's own
    // flow-authored gate measures the refusal instead — which is the arm below,
    // and it is a different test.
    const reviewTaskId = await seedLifecycleReviewGate(gate!.runId);
    await page.goto(reviewPageUrl(gate!.runId, reviewTaskId));

    // An empty note is refused WITH A REASON, and nothing settles.
    await page.locator(FLOOR.regenerate).click();
    await expect(page.locator('[data-review-outcome="error"]')).toContainText("needs a note");
    expect((await gateDisposition(gate!.runId, reviewTaskId)).status).toBe("pending");

    // With words, it settles the gate as superseded and opens one successor.
    await page.getByTestId("review-rationale").fill("make the opening tighter");
    await page.locator(FLOOR.regenerate).click();
    await expect(page.locator('[data-review-outcome="changes-requested"]')).toContainText(
      "Sent back to be made again",
    );
    const after = await gateDisposition(gate!.runId, reviewTaskId);
    expect(after.status).toBe("resolved");
    expect(after.disposition).toBe("changes_requested");
    expect(await repairCount(gate!.runId)).toBe(1);
  });

  test("item 4 — REGENERATE is REFUSED, with the gate left open, when nothing can make the work again", async ({
    page,
  }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    // No `declareProducerRepairCapable` here — that IS the arm. The fixture's
    // producing step declares no repair capability, so a Regenerate has nowhere
    // to send the words and no successor to open.
    const before = await gateDisposition(gate!.runId);
    test.skip(before.status !== "pending", "the seeded gate is not pending");
    await page.goto(reviewPageUrl(gate!.runId, gate!.reviewTaskId));

    await page.getByTestId("review-rationale").fill("make the opening tighter");
    await page.locator(FLOOR.regenerate).click();

    // A stated refusal on screen …
    await expect(page.locator('[data-review-outcome="error"]')).toContainText(
      "Comment or Continue instead",
    );
    // … and the review is still open, with its floor still live: nothing was
    // settled for a revision that was never coming.
    const after = await gateDisposition(gate!.runId);
    expect(after.status).toBe("pending");
    expect(after.disposition).toBeNull();
    expect(await repairCount(gate!.runId)).toBe(0);
    await expectTheFloor(page);
  });

  test("item 2 — CONTINUE resolves the gate and KEEPS STORING `approve`", async ({ page }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    await page.goto(reviewPageUrl(gate!.runId, gate!.reviewTaskId));
    await page.locator(FLOOR.continue).click();
    await expect(page.locator('[data-review-outcome="decided"]')).toContainText("Continued");

    const after = await gateDisposition(gate!.runId);
    expect(after.status).toBe("resolved");
    // NO MIGRATION: the word on screen changed, the value in the row did not.
    expect(after.disposition).toBe("approve");
    expect(await repairCount(gate!.runId)).toBe(0);
  });

  test("item 4 — a CONTINUE after a Regenerate is refused as stale; the first decision stands", async ({
    page,
    context,
  }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    await declareProducerRepairCapable(gate!.runId);
    // Same reason as the arm above: the race is between a Regenerate that lands
    // and a Continue that arrives after it, so the gate has to be one the change
    // road serves.
    const reviewTaskId = await seedLifecycleReviewGate(gate!.runId);
    const url = reviewPageUrl(gate!.runId, reviewTaskId);
    await page.goto(url);

    // A second tab, opened on the SAME pending gate, holds a live floor.
    const stale = await context.newPage();
    await stale.goto(url);
    await expectTheFloor(stale);

    // The first tab regenerates …
    await page.getByTestId("review-rationale").fill("again please");
    await page.locator(FLOOR.regenerate).click();
    await expect(page.locator('[data-review-outcome="changes-requested"]')).toBeVisible();

    // … and the second tab's Continue arrives at a gate that has moved: a BLOCK,
    // never a silent second decision.
    await stale.locator(FLOOR.continue).click();
    await expect(stale.locator('[data-conformance-id="review-gate-blocked"]')).toBeVisible();

    const after = await gateDisposition(gate!.runId, reviewTaskId);
    expect(after.disposition).toBe("changes_requested");
    expect(await repairCount(gate!.runId)).toBe(1);
    await stale.close();
  });

  // -------------------------------------------------------------------------
  // THE FLOOR MUST BE REACHABLE, not merely present (cinatra#3080 item 1).
  // -------------------------------------------------------------------------
  // A 1440x900 reading of the chat thread found the docked composer painted over
  // the lower part of the review card's decision floor: the three controls were
  // in the DOM, visible to a locator, and could not be pressed. So this measures
  // GEOMETRY — every floor control's box must end above the composer's top edge
  // — which is the only assertion that can tell "drawn" from "reachable".
  test("item 1 — at 1440x900 the card's floor is reachable ABOVE the chat composer", async ({
    page,
  }) => {
    const gate = await openGate({ inConversation: true });
    test.skip(gate === null, "no seedable review gate on this instance");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(await chatThreadUrl(page, gate!.threadId!), {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator('[data-conformance-id="review-gate-card"]')).toBeVisible();
    await expectTheFloor(page);

    // AT THE FOOT OF THE THREAD, which is where the defect lives. The composer
    // is docked over the bottom of the stream, and what keeps the newest card
    // out from under it is the room the stream RESERVES beneath its last element
    // (`composer-reserved-space.ts`) - so the reading has to be taken with the
    // stream at its bottom, the position the newest content is pinned to. Taken
    // higher up it measures the scroll offset instead, and a card taller than
    // the column reports its floor under the composer while the reservation
    // beneath it is perfectly correct.
    await page.evaluate(() => {
      const stream = document.querySelector("[data-conversation-stream]");
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
    // The scroll has to settle before a box means anything.
    await page.waitForTimeout(500);

    const composer = page.locator('[data-conformance-id="chat-composer-primary"]').first();
    const composerBox = await composer.boundingBox();
    expect(composerBox, "the docked composer").not.toBeNull();

    for (const [name, selector] of Object.entries(FLOOR)) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box, `${name} has a box`).not.toBeNull();
      expect(
        box!.y + box!.height,
        `${name} ends above the composer instead of under it`,
      ).toBeLessThanOrEqual(composerBox!.y);
    }

    // …and it is not only clear of the composer, it actually takes a press: a
    // Comment leaves the gate open, which is the cheapest live proof that the
    // control received the click rather than the composer swallowing it.
    await page.locator(FLOOR.comment).click();
    await expect(page.locator('[data-review-outcome="annotated"]')).toBeVisible();
    expect((await gateDisposition(gate!.runId)).status).toBe("pending");
  });
});

/** The review screen's route — the run, the gate, and the fixture's coordinates. */
function reviewPageUrl(runId: string, reviewTaskId: string): string {
  const { vendor, slug } = REVIEW_GATE_FIXTURE;
  return `/agents/${vendor}/${slug}/${runId}/review/${encodeURIComponent(reviewTaskId)}`;
}

/** The RUN page — the instance route the run opens at, same coordinates. */
function runPageUrl(runId: string): string {
  const { vendor, slug } = REVIEW_GATE_FIXTURE;
  return `/agents/${vendor}/${slug}/${runId}`;
}
