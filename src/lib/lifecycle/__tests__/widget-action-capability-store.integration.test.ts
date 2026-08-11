/**
 * REAL-STORE integration for the ACTION-CAPABILITY LEDGER (cinatra#2575, epic
 * #2564 S8b) — the single-use, expiry and confirmation semantics of the widget
 * decision path, against a real Postgres running the real bootstrap DDL.
 *
 * WHY A MOCK PROVES NOTHING HERE. Every property this slice rests on is a
 * property of SQL, not of TypeScript:
 *
 *   • single use is `WHERE consumed_at IS NULL` losing a race, which an
 *     in-memory double cannot lose;
 *   • "confirmed exactly once" is the same shape one statement earlier, and the
 *     two together are what make a decision credential un-replayable;
 *   • "spent implies confirmed" is a DDL CHECK — the last line of defence if the
 *     confirm CAS is ever refactored out of the path, and invisible to any test
 *     that does not let the database refuse the write;
 *   • both windows are measured by the DATABASE clock (`now()`), deliberately,
 *     because two nodes minting and burning must not disagree about "expired".
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm exec vitest run src/lib/lifecycle/__tests__/widget-action-capability-store.integration
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { widgetActionCapabilitySchemaQueries } from "@/lib/widget-action-capability-schema";

const TEST_SCHEMA = "cinatra_test_action_capability_2575";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");

let client: Client;
let store: typeof import("@/lib/lifecycle/widget-action-capability-store");

const BASE_INPUT = {
  purpose: "lifecycle.decide",
  audience: "/api/lifecycle-views/broker-decide",
  orgId: "org-2575",
  userId: "user-2575",
  widgetJti: "wjti-2575",
  siteId: "site-2575",
  client: "wordpress",
  instanceId: "inst-2575",
  agentSlug: "wordpress-content-editor",
  runId: "run-2575",
  reviewTaskId: "gate-2575",
  disposition: "approve" as const,
  targetsDigest: "t".repeat(64),
  decisionDigest: "d".repeat(64),
  subjectLabel: "Autumn sale (Blog)",
  commentText: null,
};

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  // The REAL bootstrap DDL this slice ships — not a hand-written fixture table,
  // so the CHECK constraints under test are the ones that will run in prod.
  for (const q of widgetActionCapabilitySchemaQueries(TEST_SCHEMA)) {
    await client.query(q.text);
  }
  store = await import("@/lib/lifecycle/widget-action-capability-store");
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client?.end().catch(() => {});
}, 120_000);

beforeEach(async () => {
  if (!HAS_DB) return;
  await client.query(`TRUNCATE "${TEST_SCHEMA}"."widget_action_capabilities"`);
});

/** Insert a request and return its id, failing loudly rather than returning null. */
async function request(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = await store.requestActionCapability({ ...BASE_INPUT, ...overrides });
  expect(id).toBeTruthy();
  return id as string;
}

describe.skipIf(!HAS_DB)("the action-capability ledger, against a real Postgres", () => {
  it("records a request that is neither confirmed nor consumed", async () => {
    const id = await request();
    const row = await store.readActionCapabilityRequest(id);
    expect(row).toMatchObject({
      capabilityId: id,
      orgId: BASE_INPUT.orgId,
      userId: BASE_INPUT.userId,
      widgetJti: BASE_INPUT.widgetJti,
      runId: BASE_INPUT.runId,
      reviewTaskId: BASE_INPUT.reviewTaskId,
      disposition: "approve",
      targetsDigest: BASE_INPUT.targetsDigest,
      decisionDigest: BASE_INPUT.decisionDigest,
      subjectLabel: "Autumn sale (Blog)",
      confirmed: false,
      consumed: false,
    });
  });

  it("mints an UNGUESSABLE id — a request id is not a sequence", async () => {
    const ids = await Promise.all([request(), request(), request()]);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(3);
  });

  // --- THE CONFIRMATION EDGE ---------------------------------------------

  it("confirms EXACTLY ONCE — the second attempt gets nothing", async () => {
    const id = await request();
    const first = await store.confirmActionCapability(id, BASE_INPUT.userId);
    expect(first?.capabilityId).toBe(id);
    expect(first?.confirmed).toBe(true);
    expect(await store.confirmActionCapability(id, BASE_INPUT.userId)).toBeNull();
  });

  it("refuses a confirmation by ANOTHER person, and leaves the request confirmable", async () => {
    const id = await request();
    expect(await store.confirmActionCapability(id, "someone-else")).toBeNull();
    // Untouched: the rightful person can still confirm.
    expect((await store.confirmActionCapability(id, BASE_INPUT.userId))?.confirmed).toBe(true);
  });

  it("refuses a confirmation after the REQUEST window closes", async () => {
    const id = await request();
    await client.query(
      `UPDATE "${TEST_SCHEMA}"."widget_action_capabilities" SET expires_at = now() - interval '1 second' WHERE capability_id = $1`,
      [id],
    );
    expect(await store.confirmActionCapability(id, BASE_INPUT.userId)).toBeNull();
    // ...and the page can no longer read it either — expired is indistinguishable
    // from absent, which is the one refusal the surface renders.
    expect(await store.readActionCapabilityRequest(id)).toBeNull();
  });

  it("re-bases the expiry onto the SPEND window at confirmation", async () => {
    const id = await request();
    const before = await client.query(
      `SELECT expires_at FROM "${TEST_SCHEMA}"."widget_action_capabilities" WHERE capability_id = $1`,
      [id],
    );
    await store.confirmActionCapability(id, BASE_INPUT.userId);
    const after = await client.query(
      `SELECT expires_at, confirmed_at, (expires_at - now()) AS remaining FROM "${TEST_SCHEMA}"."widget_action_capabilities" WHERE capability_id = $1`,
      [id],
    );
    expect(after.rows[0].confirmed_at).not.toBeNull();
    // The spend window is SHORTER than the request window it replaced...
    expect(new Date(after.rows[0].expires_at).getTime()).toBeLessThan(
      new Date(before.rows[0].expires_at).getTime(),
    );
    // ...and it is the codec's own TTL, measured by the database clock.
    const remainingSeconds = Number(
      (after.rows[0].remaining as { seconds?: number; minutes?: number }).minutes ?? 0,
    ) * 60 + Number((after.rows[0].remaining as { seconds?: number }).seconds ?? 0);
    expect(remainingSeconds).toBeGreaterThan(100);
    expect(remainingSeconds).toBeLessThanOrEqual(120);
  });

  // --- THE BURN ----------------------------------------------------------

  it("burns EXACTLY ONCE — the replay gets nothing", async () => {
    const id = await request();
    await store.confirmActionCapability(id, BASE_INPUT.userId);
    const burned = await store.consumeActionCapability(id);
    expect(burned?.capabilityId).toBe(id);
    expect(burned?.consumed).toBe(true);
    expect(await store.consumeActionCapability(id)).toBeNull();
  });

  it("CONCURRENT redemptions: exactly one wins", async () => {
    const id = await request();
    await store.confirmActionCapability(id, BASE_INPUT.userId);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consumeActionCapability(id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("CONCURRENT confirmations: exactly one wins", async () => {
    const id = await request();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.confirmActionCapability(id, BASE_INPUT.userId)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a burn on an UNCONFIRMED request", async () => {
    const id = await request();
    expect(await store.consumeActionCapability(id)).toBeNull();
  });

  it("refuses a burn after the SPEND window closes", async () => {
    const id = await request();
    await store.confirmActionCapability(id, BASE_INPUT.userId);
    await client.query(
      `UPDATE "${TEST_SCHEMA}"."widget_action_capabilities" SET expires_at = now() - interval '1 second' WHERE capability_id = $1`,
      [id],
    );
    expect(await store.consumeActionCapability(id)).toBeNull();
  });

  it("refuses an absent id, and answers it exactly like a spent one", async () => {
    expect(await store.consumeActionCapability(randomUUID())).toBeNull();
    expect(await store.readActionCapabilityRequest(randomUUID())).toBeNull();
  });

  // --- WHAT THE DATABASE ITSELF REFUSES ----------------------------------

  it("the DDL refuses a spend that skipped the confirmation", async () => {
    const id = await request();
    await expect(
      client.query(
        `UPDATE "${TEST_SCHEMA}"."widget_action_capabilities" SET consumed_at = now() WHERE capability_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/widget_action_capabilities_spend_needs_confirm/);
  });

  it("the DDL refuses an act outside the review floor", async () => {
    await expect(
      client.query(
        `INSERT INTO "${TEST_SCHEMA}"."widget_action_capabilities"
           (capability_id, purpose, audience, org_id, user_id, widget_jti, site_id, client,
            instance_id, agent_slug, run_id, review_task_id, disposition, targets_digest,
            decision_digest, subject_label, expires_at)
         VALUES ($1,'lifecycle.decide','/x','o','u','j','s','wordpress','i','a','r','g','escalate','t','d','subj', now() + interval '1 minute')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/disposition/);
  });

  it("the DDL refuses a request that cannot NAME what it is about", async () => {
    // codex round 0, finding 1: a confirmation window that cannot say WHICH
    // review is one whose subject can be substituted behind the same sentence.
    await expect(
      client.query(
        `INSERT INTO "${TEST_SCHEMA}"."widget_action_capabilities"
           (capability_id, purpose, audience, org_id, user_id, widget_jti, site_id, client,
            instance_id, agent_slug, run_id, review_task_id, disposition, targets_digest,
            decision_digest, expires_at)
         VALUES ($1,'lifecycle.decide','/x','o','u','j','s','wordpress','i','a','r','g','approve','t','d', now() + interval '1 minute')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/subject_label/);
  });

  it("the DDL refuses a request that cannot say what would be submitted", async () => {
    await expect(
      client.query(
        `INSERT INTO "${TEST_SCHEMA}"."widget_action_capabilities"
           (capability_id, purpose, audience, org_id, user_id, widget_jti, site_id, client,
            instance_id, agent_slug, run_id, review_task_id, disposition, targets_digest, expires_at)
         VALUES ($1,'lifecycle.decide','/x','o','u','j','s','wordpress','i','a','r','g','approve','t', now() + interval '1 minute')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/decision_digest/);
  });

  it("a burnt row SURVIVES its expiry for long enough to be an honest audit", async () => {
    const id = await request();
    await store.confirmActionCapability(id, BASE_INPUT.userId);
    await store.consumeActionCapability(id);
    await client.query(
      `UPDATE "${TEST_SCHEMA}"."widget_action_capabilities" SET expires_at = now() - interval '1 minute' WHERE capability_id = $1`,
      [id],
    );
    // The sweep on the next INSERT must not take it: a response-lost retry has
    // to meet "already consumed", not "never existed".
    await request();
    const rows = await client.query(
      `SELECT consumed_at FROM "${TEST_SCHEMA}"."widget_action_capabilities" WHERE capability_id = $1`,
      [id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].consumed_at).not.toBeNull();
  });

  it("the sweep DOES take a row that is long past its life", async () => {
    const id = await request();
    await client.query(
      `UPDATE "${TEST_SCHEMA}"."widget_action_capabilities" SET expires_at = now() - interval '2 hours' WHERE capability_id = $1`,
      [id],
    );
    await request();
    const rows = await client.query(
      `SELECT 1 FROM "${TEST_SCHEMA}"."widget_action_capabilities" WHERE capability_id = $1`,
      [id],
    );
    expect(rows.rowCount).toBe(0);
  });
});
