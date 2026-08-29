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

import {
  REVIEW_GATE_FIXTURE,
  seedMarkedReviewGateRun,
  waitForMarkedReviewGate,
  type FixtureReviewTarget,
} from "../agents-run/review-gate-fixture";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const USER_ID = process.env.E2E_USER_ID ?? "";
const ORG_ID = process.env.E2E_ORG_ID ?? "";

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
 */
async function anyReadableTarget(): Promise<FixtureReviewTarget | null> {
  return withPg(async (c) => {
    const r = await c.query<{ artifact_id: string; representation_revision_id: string }>(
      `SELECT o.id AS artifact_id, r.id AS representation_revision_id
         FROM ${SCHEMA}.objects o
         JOIN ${SCHEMA}.object_representations r ON r.object_id = o.id
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

async function gateDisposition(runId: string): Promise<{ status: string; disposition: string | null }> {
  return withPg(async (c) => {
    const r = await c.query<{ status: string; disposition: string | null }>(
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

/** A gate of the fixture agent, or null when this instance cannot make one. */
async function openGate(): Promise<{ runId: string; reviewTaskId: string } | null> {
  if (!USER_ID || !ORG_ID) return null;
  const target = await anyReadableTarget();
  if (!target) return null;
  const runId = await seedMarkedReviewGateRun({ userId: USER_ID, orgId: ORG_ID, targets: [target] });
  const gate = await waitForMarkedReviewGate(runId);
  return { runId, reviewTaskId: gate.reviewTaskId };
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
    await page.goto(`/agents/runs/${gate!.runId}`);
    await expect(page.locator('[data-conformance-id="review-gate-card"]')).toBeVisible();
    await expectTheFloor(page);
  });

  test("item 1 — the CHAT thread's review card draws the same three", async ({ page }) => {
    const gate = await openGate();
    test.skip(gate === null, "no seedable review gate on this instance");
    await page.goto(`/chat?run=${gate!.runId}`);
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
    await page.goto(reviewPageUrl(gate!.runId, gate!.reviewTaskId));

    // An empty note is refused WITH A REASON, and nothing settles.
    await page.locator(FLOOR.regenerate).click();
    await expect(page.locator('[data-review-outcome="error"]')).toContainText("needs a note");
    expect((await gateDisposition(gate!.runId)).status).toBe("pending");

    // With words, it settles the gate as superseded and opens one successor.
    await page.getByTestId("review-rationale").fill("make the opening tighter");
    await page.locator(FLOOR.regenerate).click();
    await expect(page.locator('[data-review-outcome="changes-requested"]')).toContainText(
      "Sent back to be made again",
    );
    const after = await gateDisposition(gate!.runId);
    expect(after.status).toBe("resolved");
    expect(after.disposition).toBe("changes_requested");
    expect(await repairCount(gate!.runId)).toBe(1);
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
    const url = reviewPageUrl(gate!.runId, gate!.reviewTaskId);
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

    const after = await gateDisposition(gate!.runId);
    expect(after.disposition).toBe("changes_requested");
    expect(await repairCount(gate!.runId)).toBe(1);
    await stale.close();
  });
});

/** The review screen's route — the run, the gate, and the fixture's coordinates. */
function reviewPageUrl(runId: string, reviewTaskId: string): string {
  const { vendor, slug } = REVIEW_GATE_FIXTURE;
  return `/agents/${vendor}/${slug}/${runId}/review/${encodeURIComponent(reviewTaskId)}`;
}
