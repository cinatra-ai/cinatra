/**
 * Transport-level resume idempotency / replay hazard — REAL store, REAL handler
 * seam (cinatra#1947).
 *
 * The follow-up the issue prescribed: the run-scoped test-delivery send ledger's
 * exactly-once guarantee is only as strong as (a) the atomic claim fence on
 * (run_id, submission_id) and (b) the settle CAS on the `sending → terminal`
 * transition. A mock ledger MASKS exactly these windows — the ON CONFLICT DO
 * NOTHING claim and the `WHERE status = 'sending'` settle are Postgres semantics,
 * not JS. So this drives them against a REAL `agent_run_test_sends` table on a
 * lane-unique database, inside the run-bound mcpRequestContextStorage frame
 * /api/agents/passthrough establishes.
 *
 * The ONLY stub is the transport `TestDeliverySendPort` — the real Gmail/Resend
 * egress + the objects-store reconcile query (the same injectable seam the
 * primitive's own unit test and the authz-relocation integration test use). It is
 * a COUNTING port: every assertion pins how many outbound sends / reconciles
 * actually happened, so "replayed resume never re-sends" is proven by count, not
 * by inspection.
 *
 * Composition with email-connector#35: the lease-expiry reconcile confirms a
 * crashed claim by querying the persisted (submissionId, draftId) correlation on
 * the sent-email objects. #35 makes that correlation durable + type-safe on the
 * connector facade; here we simulate its "sent" verdict and prove the crashed
 * claim settles idempotently to `sent` WITHOUT a second outbound send — the read
 * side of the same guarantee #35 makes durable on the write side.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (mirrors the sibling integration
 * suites). Provisions its OWN schema so the run is fully self-contained on a fresh
 * lane database:
 *   pnpm --filter @cinatra-ai/agents test:integration \
 *     -- src/__tests__/test-delivery-resume-idempotency.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  setTestDeliverySendPort,
  type TestDeliverySendPort,
} from "../test-delivery-send-port";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

// The ORM (packages/agents/src/schema.ts) qualifies every table under the schema
// named by SUPABASE_SCHEMA (default "cinatra"). Provision that exact schema.
const SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const ORG = "org-1947-idem";
// The gate-owning agent package (binding-ID owner of the test-delivery renderer);
// the send-authz gate admits ONLY a run whose package hosts the gate (#1958).
const GATE_OWNER_PKG = "@cinatra-ai/email-test-delivery-agent";
const PLAN_DRAFT_IDS = ["draft-1", "draft-2"];

type Store = typeof import("../store");
type Ledger = typeof import("../agent-run-test-sends");
type Handlers = Record<string, (req: Record<string, unknown>) => Promise<unknown>>;

let store: Store;
let ledger: Ledger;
let handlers: Handlers;
let pg: Client;

// COUNTING transport port. reconcileOutcome is set per-test to simulate the
// objects-store verdict (email-connector#35's persisted correlation → "sent",
// or an unconfirmable send → "unknown").
const calls = { prepare: 0, perform: 0, reconcile: 0 };
let reconcileOutcome: "sent" | "unknown" = "unknown";

const countingPort: TestDeliverySendPort = {
  prepareSend: async (p) => {
    calls.prepare += 1;
    return { ok: true, recipientEmail: p.recipientEmail, selectedDraftIds: [...PLAN_DRAFT_IDS] };
  },
  performSend: async (p) => {
    calls.perform += 1;
    return {
      ok: true,
      sentTo: p.recipientEmail,
      sentCount: p.selectedDraftIds.length,
      deliveredDraftIds: [...p.selectedDraftIds],
      message: `Test email sent to ${p.recipientEmail}.`,
    };
  },
  reconcile: async () => {
    calls.reconcile += 1;
    return reconcileOutcome;
  },
};

async function provisionSchema(client: Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  // Run the authoritative bootstrap DDL (the same leaf the migrations mirror) so
  // the table shapes never drift from production. Only structural statements;
  // tolerate the handful of seed statements that reference not-yet-seeded rows on
  // a fresh empty schema (the _fixture.ts precedent).
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(q.text, q.values ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
}

beforeAll(async () => {
  if (!hasDb) return;
  pg = new Client({ connectionString: dbUrl });
  await pg.connect();
  await provisionSchema(pg);

  store = await import("../store");
  ledger = await import("../agent-run-test-sends");
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  handlers = createAgentBuilderPrimitiveHandlers() as Handlers;
  setTestDeliverySendPort(countingPort);
});

afterAll(async () => {
  if (!hasDb) return;
  setTestDeliverySendPort(null);
  await pg.end();
});

beforeEach(() => {
  calls.prepare = 0;
  calls.perform = 0;
  calls.reconcile = 0;
  reconcileOutcome = "unknown";
});

async function getOrCreateTemplate(packageName: string): Promise<string> {
  const existing = await store.readAgentTemplateByPackageName(packageName);
  if (existing) return existing.id;
  const templateId = `t_${randomUUID()}`;
  await store.createAgentTemplate({
    id: templateId,
    name: `td-idem-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName,
  });
  return templateId;
}

async function makeRun(userId: string): Promise<{ runId: string; campaignId: string }> {
  const templateId = await getOrCreateTemplate(GATE_OWNER_PKG);
  const campaignId = `camp_${randomUUID()}`;
  const run = await store.createAgentRun({
    id: `r_${randomUUID()}`,
    templateId,
    inputParams: { campaignId },
    orgId: ORG,
    runBy: userId,
  });
  return { runId: run.id, campaignId };
}

function callSend(
  runId: string,
  submissionId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  // Exactly the frame /api/agents/passthrough establishes: the VERIFIED run scope
  // + submission id (never the forgeable ambient runId). The actor is the run
  // owner, so enforceRunAccess's owner short-circuit admits read + execute.
  return mcpRequestContextStorage.run(
    {
      runId: "run-HEADER-FORGED",
      verifiedRunScopeId: runId,
      verifiedSubmissionId: submissionId,
      userId,
      orgId: ORG,
    },
    () =>
      handlers["email_test_delivery_run_send"]({
        primitiveName: "email_test_delivery_run_send",
        input: { recipientEmail: "qa@example.test", selectionMode: "random_initial" },
        actor: { userId, actorType: "model", source: "agent" },
        mode: "agentic",
      }),
  ) as Promise<Record<string, unknown>>;
}

/** Simulate a crash BETWEEN claim and settle: the outbound send already ran but
 *  the settle was lost, so the row is stuck `sending` with an EXPIRED lease. */
async function forceSendingExpired(runId: string, submissionId: string): Promise<void> {
  await pg.query(
    `UPDATE "${SCHEMA}".agent_run_test_sends
       SET status = 'sending', result_json = NULL, lease_expires_at = now() - interval '5 minutes'
     WHERE run_id = $1 AND submission_id = $2`,
    [runId, submissionId],
  );
}

const sub = (): string => `sub_${randomUUID()}`;

describe.skipIf(!hasDb)("test-delivery resume idempotency — real ledger, counting transport (#1947)", () => {
  it("a transport retry of the SAME submission never drives a second outbound send", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    const r1 = await callSend(runId, submissionId, userId);
    expect(r1).toMatchObject({ ok: true, sentTo: "qa@example.test" });
    expect(calls.perform).toBe(1);

    // Replay the EXACT same resume (same submission id) — the terminal row is
    // returned verbatim; performSend is NOT called again.
    const r2 = await callSend(runId, submissionId, userId);
    expect(r2).toMatchObject({ ok: true, sentTo: "qa@example.test" });
    expect(calls.perform).toBe(1);

    const rows = await ledger.readTestSendsForRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
  });

  it("a replay while the claim lease is LIVE returns send_in_progress — no send", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    // Claimed-then-crashed-before-settle, but within the lease window.
    const claim = await ledger.claimTestSend({
      runId,
      submissionId,
      selectedDraftIds: PLAN_DRAFT_IDS,
      recipientEmail: "qa@example.test",
      leaseSeconds: 120,
    });
    expect(claim.kind).toBe("claimed");

    const r = await callSend(runId, submissionId, userId);
    expect(r).toMatchObject({ reason: "send_in_progress" });
    expect(calls.perform).toBe(0);
    expect(calls.reconcile).toBe(0);

    const rows = await ledger.readTestSendsForRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sending");
  });

  it("crash between claim and settle → replay reconciles to SENT (email-connector#35 correlation) — exactly one outbound send, one terminal row", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    // The original send: one outbound send, row settled `sent`.
    const r1 = await callSend(runId, submissionId, userId);
    expect(r1).toMatchObject({ ok: true });
    expect(calls.perform).toBe(1);

    // The crash: the outbound already happened, but the settle was lost — the row
    // reverts to `sending` past its lease. This is precisely the window #1947
    // targets.
    await forceSendingExpired(runId, submissionId);

    // The replay: the persisted (submissionId, draftId) correlation that #35 keeps
    // durable lets the reconcile confirm delivery.
    reconcileOutcome = "sent";
    const r2 = await callSend(runId, submissionId, userId);

    expect(r2).toMatchObject({ ok: true });
    // Reconciled, NOT re-sent — the total outbound send count stays exactly one.
    expect(calls.perform).toBe(1);
    expect(calls.reconcile).toBe(1);

    const rows = await ledger.readTestSendsForRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
  });

  it("crash + replay when reconcile CANNOT confirm → previous_send_unknown, never a blind resend", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    // Claimed with an already-expired lease (crash), and the correlation store
    // cannot confirm delivery for this submission.
    const claim = await ledger.claimTestSend({
      runId,
      submissionId,
      selectedDraftIds: PLAN_DRAFT_IDS,
      recipientEmail: "qa@example.test",
      leaseSeconds: -1,
    });
    expect(claim.kind).toBe("claimed");
    reconcileOutcome = "unknown";

    const r = await callSend(runId, submissionId, userId);
    expect(r).toMatchObject({ reason: "previous_send_unknown" });
    // The unknowable outcome must NEVER auto-resend.
    expect(calls.perform).toBe(0);
    expect(calls.reconcile).toBe(1);

    const rows = await ledger.readTestSendsForRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sending");
  });

  it("settle CAS: a terminal row is authoritative — a late racing settle is rejected, not a clobber (#1947)", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    const claim = await ledger.claimTestSend({
      runId,
      submissionId,
      selectedDraftIds: ["d1"],
      recipientEmail: "qa@example.test",
      leaseSeconds: 120,
    });
    expect(claim.kind).toBe("claimed");

    // A reconcile confirms delivery and settles `sent` first.
    const first = await ledger.settleTestSend({
      id: claim.row.id,
      status: "sent",
      result: { ok: true, deliveredDraftIds: ["d1"], message: "sent" },
    });
    expect(first?.status).toBe("sent");

    // The original claimer's late performSend returns and reports `failed`
    // (delivered-but-reported-failed). WITHOUT the CAS this would overwrite the
    // reconcile-confirmed `sent` and DROP deliveredDraftIds → a later gate re-entry
    // would double-deliver. The CAS rejects it.
    const second = await ledger.settleTestSend({
      id: claim.row.id,
      status: "failed",
      result: { ok: false, deliveredDraftIds: [], message: "failed" },
    });
    expect(second).toBeNull();

    const row = await ledger.readTestSendBySubmission(runId, submissionId);
    expect(row?.status).toBe("sent");
    // The delivered set survived — no clobber.
    expect((row?.resultJson as { deliveredDraftIds?: unknown } | null)?.deliveredDraftIds).toEqual([
      "d1",
    ]);
  });

  it("priority CAS: a reconcile-confirmed `sent` UPGRADES a transport-reported `failed` even when the failure settled FIRST (#1947)", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    const claim = await ledger.claimTestSend({
      runId,
      submissionId,
      selectedDraftIds: ["d1", "d2"],
      recipientEmail: "qa@example.test",
      leaseSeconds: 120,
    });
    expect(claim.kind).toBe("claimed");

    // The original claimer's slow performSend reports `failed` FIRST — a
    // delivered-but-reported-failed send (nothing in deliveredDraftIds). A
    // symmetric first-writer-wins CAS would freeze this `failed` and, on the next
    // fresh gate re-entry, double-deliver the drafts that actually landed.
    const failedFirst = await ledger.settleTestSend({
      id: claim.row.id,
      status: "failed",
      result: { ok: false, deliveredDraftIds: [], message: "failed" },
    });
    expect(failedFirst?.status).toBe("failed");

    // Then the lease-expiry reconcile confirms delivery from the persisted
    // (submissionId, draftId) correlation and settles `sent`. Priority ordering
    // makes it WIN — the delivery-confirmed terminal is authoritative.
    const sentUpgrade = await ledger.settleTestSend({
      id: claim.row.id,
      status: "sent",
      result: { ok: true, deliveredDraftIds: ["d1", "d2"], message: "sent" },
    });
    expect(sentUpgrade?.status).toBe("sent");

    const row = await ledger.readTestSendBySubmission(runId, submissionId);
    expect(row?.status).toBe("sent");
    // The confirmed delivered set is recorded, so a later gate re-entry suppresses
    // those drafts instead of double-delivering.
    expect((row?.resultJson as { deliveredDraftIds?: unknown } | null)?.deliveredDraftIds).toEqual([
      "d1",
      "d2",
    ]);
  });

  it("concurrent claims for the SAME submission → exactly one claimed, one existing, one row (real ON CONFLICT fence)", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    // Two resumes race the atomic claim at the same instant. ON CONFLICT DO
    // NOTHING fences them: exactly one INSERT wins ("claimed"), the other reads the
    // winning row ("existing"). A mock cannot reproduce Postgres unique-index
    // arbitration on a genuinely concurrent INSERT — this is the fence itself.
    const [a, b] = await Promise.all([
      ledger.claimTestSend({
        runId,
        submissionId,
        selectedDraftIds: PLAN_DRAFT_IDS,
        recipientEmail: "qa@example.test",
        leaseSeconds: 120,
      }),
      ledger.claimTestSend({
        runId,
        submissionId,
        selectedDraftIds: PLAN_DRAFT_IDS,
        recipientEmail: "qa@example.test",
        leaseSeconds: 120,
      }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["claimed", "existing"]);
    // Both observe the SAME winning row, and there is exactly one row.
    expect(a.row.id).toBe(b.row.id);
    const rows = await ledger.readTestSendsForRun(runId);
    expect(rows).toHaveLength(1);
  });

  it("two concurrent resumes of the SAME fresh submission drive exactly one outbound send (claim fence, full handler)", async () => {
    const userId = `u_${randomUUID()}`;
    const { runId } = await makeRun(userId);
    const submissionId = sub();

    // Both resumes run the whole prepare → claim → perform path at once.
    // prepareSend has no side effects (it may run for both); the atomic claim
    // admits exactly ONE to performSend — the loser reads the existing row and
    // returns without sending.
    const [r1, r2] = await Promise.all([
      callSend(runId, submissionId, userId),
      callSend(runId, submissionId, userId),
    ]);

    // Exactly one outbound send across both concurrent resumes; one terminal row.
    expect(calls.perform).toBe(1);
    const rows = await ledger.readTestSendsForRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    // Neither resume faulted — the loser got a coherent non-sending result (the
    // terminal verbatim or an in-progress banner), never an error, never a resend.
    for (const r of [r1, r2]) expect(r).not.toHaveProperty("error");
  });
});
