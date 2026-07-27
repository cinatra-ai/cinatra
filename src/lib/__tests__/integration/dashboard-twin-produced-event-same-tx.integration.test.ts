/**
 * DASHBOARD-TWIN produced-event SAME-TRANSACTION proof — REAL Postgres
 * (cinatra#2047, the row-5 durability gap; epic #2037 S0 #2038 / S1 #2039).
 *
 * S0's outbox contract is "same-transaction atomicity proven PER LOCAL WRITER",
 * and S1 enumerates the dashboard twin as one of those writers. The #2047
 * acceptance report found that property proven only for `createSemanticArtifact`:
 * the twin's emitter was admitted to the CLOSED emitter set (`dashboard_twin_writer`
 * in `PRODUCED_EVENT_EMITTERS`, asserted by `lifecycle-emit.test.ts`) but **no test
 * drove a dashboard-twin production and asserted the row landed in the twin's own
 * transaction**. This suite DRIVES it, on a real schema built from the canonical
 * DDL:
 *
 *   1. FENCE OFF (the merged default) — the twin's query list splices NOTHING, so
 *      the writer's transaction is byte-identical to `origin/main`.
 *   2. FENCE ON + COMMIT — executing the twin's query list writes the dashboard
 *      substrate AND exactly one `artifact_produced_outbox` row, keyed by the
 *      deterministic event id, with `emitter='dashboard_twin_writer'`.
 *   3. FENCE ON + ROLLBACK — the SAME execution rolled back leaves ZERO outbox
 *      rows AND zero substrate rows. This is the same-Tx property: the event can
 *      never outlive the dashboard write that produced it (nor vice versa).
 *   4. ORIGIN mapping — an extension-materialized dashboard is `agent_generated`
 *      (→ `agent_produced`, review-eligible); an operator-built one is `upload`
 *      (→ `user_provided`, which the review core default skips).
 *
 * Gated by CINATRA_DB_INTEGRATION_TESTS=1 + a live SUPABASE_DB_URL (same contract
 * as the sibling integration/** suites).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";

import { connect, createTestSchema, dropSchema } from "./_fixture";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";
import { buildProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";

const HAS_DB =
  process.env.CINATRA_DB_INTEGRATION_TESTS === "1" &&
  !!process.env.SUPABASE_DB_URL &&
  !process.env.SUPABASE_DB_URL.includes("unused:unused@localhost:5432/unused");

let client: Client;
let schema: string;
let buildDashboardTwinQueries: typeof import("@/lib/dashboards/dashboard-artifact-twin-writer").buildDashboardTwinQueries;

type TwinCtx = Parameters<typeof buildDashboardTwinQueries>[0];

function ctxFor(over: Partial<TwinCtx> = {}): TwinCtx {
  return {
    operation: "upsert",
    dashboardId: `dash-${randomUUID()}`,
    orgId: "org-2047-twin",
    ownerLevel: "organization",
    ownerId: "org-2047-twin",
    projectId: null,
    actorId: "user-2047",
    ...over,
  } as TwinCtx;
}

/** Execute the twin's ordered query list on ONE connection inside an explicit
 * transaction — exactly how the dashboards seam dispatches it (`tx.execute` on the
 * dashboards transaction). `after` decides COMMIT vs ROLLBACK. */
async function runTwinTx(
  ctx: TwinCtx,
  after: "COMMIT" | "ROLLBACK",
  inTx?: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const q of buildDashboardTwinQueries(ctx)) {
      await client.query(q.text, q.values as unknown[]);
    }
    if (inTx) await inTx();
    await client.query(after);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function outboxCount(artifactId: string): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM "${schema}"."artifact_produced_outbox" WHERE artifact_id = $1`,
    [artifactId],
  );
  return r.rows[0].n as number;
}

async function representationRevisionIdFor(dashboardId: string): Promise<string | null> {
  const r = await client.query(
    `SELECT representation_revision_id FROM "${schema}"."artifact_produced_outbox"
      WHERE artifact_id = $1 LIMIT 1`,
    [dashboardId],
  );
  return (r.rows[0]?.representation_revision_id as string | undefined) ?? null;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  client = await connect();
  schema = await createTestSchema(client);
  // The twin's builders read the schema from the postgres config at import time,
  // so the env must be set BEFORE the module is imported.
  process.env.SUPABASE_SCHEMA = schema;
  ({ buildDashboardTwinQueries } = await import(
    "@/lib/dashboards/dashboard-artifact-twin-writer"
  ));
}, 120_000);

beforeEach(() => {
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
});

afterAll(async () => {
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  if (client && schema) await dropSchema(client, schema).catch(() => {});
  await client?.end().catch(() => {});
});

describe.skipIf(!HAS_DB)("cinatra#2047 — dashboard-twin produced event is SAME-TX", () => {
  it("FENCE OFF (merged default): the twin writes NO produced event at all", async () => {
    const ctx = ctxFor({ extensionId: "@cinatra-ai/web-analytics-dashboard-artifact" });
    await runTwinTx(ctx, "COMMIT");
    expect(await outboxCount(ctx.dashboardId)).toBe(0);
  });

  it("FENCE ON + COMMIT: exactly ONE produced event, emitter=dashboard_twin_writer, deterministic id", async () => {
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    const ctx = ctxFor({ extensionId: "@cinatra-ai/web-analytics-dashboard-artifact" });
    await runTwinTx(ctx, "COMMIT");

    const rows = await client.query(
      `SELECT event_id, emitter, origin_kind, destination_class, continuation_mode, status,
              org_id, representation_revision_id
         FROM "${schema}"."artifact_produced_outbox" WHERE artifact_id = $1`,
      [ctx.dashboardId],
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(row.emitter).toBe("dashboard_twin_writer");
    // Extension-MATERIALIZED ⇒ agent_generated ⇒ the lattice's agent_produced axis.
    expect(row.origin_kind).toBe("agent_produced");
    expect(row.destination_class).toBe("none");
    expect(row.continuation_mode).toBe("async_effects_gated");
    expect(row.status).toBe("pending");
    expect(row.org_id).toBe(ctx.orgId);
    // The id is the DETERMINISTIC gate key over (artifact, revision, kind) — the
    // property the replay-idempotency of the whole slice rests on.
    expect(row.event_id).toBe(
      producedEventId(ctx.dashboardId, row.representation_revision_id as string),
    );
  });

  it("FENCE ON + ROLLBACK: the produced event rolls back WITH the twin's transaction (zero partial write)", async () => {
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    const ctx = ctxFor({ extensionId: "@cinatra-ai/web-analytics-dashboard-artifact" });

    let seenInsideTx = 0;
    await runTwinTx(ctx, "ROLLBACK", async () => {
      // INSIDE the twin's own transaction the event is already there — proving it
      // is written on the same connection/transaction, not by a post-commit hook.
      const r = await client.query(
        `SELECT count(*)::int AS n FROM "${schema}"."artifact_produced_outbox" WHERE artifact_id = $1`,
        [ctx.dashboardId],
      );
      seenInsideTx = r.rows[0].n as number;
    });
    expect(seenInsideTx).toBe(1);

    // After the rollback: no event AND no dashboard substrate — neither can
    // outlive the other.
    expect(await outboxCount(ctx.dashboardId)).toBe(0);
    const objects = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}"."objects" WHERE id = $1`,
      [ctx.dashboardId],
    );
    expect(objects.rows[0].n).toBe(0);
    expect(await representationRevisionIdFor(ctx.dashboardId)).toBeNull();
  });

  it("FENCE ON: an OPERATOR-built dashboard (no extension) emits origin_kind=user_provided", async () => {
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    const ctx = ctxFor();
    await runTwinTx(ctx, "COMMIT");
    const r = await client.query(
      `SELECT origin_kind FROM "${schema}"."artifact_produced_outbox" WHERE artifact_id = $1`,
      [ctx.dashboardId],
    );
    // upload → user_provided: the review core default SKIPS it (unless an org
    // bound requires it) — the deliberate asymmetry with a materialized twin.
    expect(r.rows[0].origin_kind).toBe("user_provided");
  });

  it("FENCE ON: REPLAYING the twin's own emitted op is idempotent (no duplicate event)", async () => {
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    const ctx = ctxFor({ extensionId: "@cinatra-ai/web-analytics-dashboard-artifact" });
    await runTwinTx(ctx, "COMMIT");
    expect(await outboxCount(ctx.dashboardId)).toBe(1);

    // Re-execute the WRITER'S OWN produced-event op for the SAME (artifact,
    // revision) — the at-least-once replay the outbox contract must absorb. Built
    // by the shipped `buildProducedEventInsertOp` (the exact builder the twin
    // splices), not a hand-written INSERT, so the deterministic-id +
    // ON CONFLICT (event_id) DO NOTHING guarantee is proven on the real statement.
    // NOTE a fresh `buildDashboardTwinQueries` call would allocate a NEW
    // representation revision — a new PRODUCTION, not a replay.
    const revisionId = await representationRevisionIdFor(ctx.dashboardId);
    expect(revisionId).not.toBeNull();
    const emitOp = buildProducedEventInsertOp(schema.replaceAll('"', '""'), {
      orgId: ctx.orgId,
      artifactId: ctx.dashboardId,
      representationRevisionId: revisionId as string,
      emitter: "dashboard_twin_writer",
      originKind: "agent_generated",
    });
    await client.query(emitOp.text, emitOp.values as unknown[]);
    expect(await outboxCount(ctx.dashboardId)).toBe(1);
  });
});
