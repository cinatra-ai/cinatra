/**
 * cinatra#1940 P3 (Decision 2, Decision 8 acceptance map) — the creation-
 * perimeter conversion. `createAgentRun` / `createAgentRunPendingInput` now
 * run their INSERT inside `guardedRunWrite` (capability `run.execute`), so
 * every dispatch path is guarded at the one true creation chokepoint.
 *
 * Harness (mirrors transition-run-status.test.ts, the sibling guarded
 * writer): `../db` is mocked so `db.transaction(fn)` hands the writer a fake
 * drizzle tx wrapped by `wrapTxWithOrgWriteKernel` (answers the kernel's own
 * queries — org locks, lifecycle read — from `shared.kernelAnswers`); a
 * top-level `select`/`insert` fake (used both outside the guard, by
 * `deriveRunOboCeilingJson`/`readLatestAgentVersionIdForTemplate`/
 * `readAgentRunById`, and inside it, via the wrapped tx) answers by table
 * identity. No live Postgres.
 *
 * Covers: missing/org-mismatch/run-mismatch fail BEFORE any DB write
 * (`AgentRunOrgWriteAuthorityError`); archived org refuses
 * `capability-denied` (`OrgWriteRefusedError`) — the free structural win
 * that a run-bound authority can never create a DIFFERENT run; active org
 * succeeds for both functions; the archived idempotent-retry polarity
 * (design review, Decision 2): a retry under archive gets the archived refusal INSTEAD of
 * the idempotent existing-row return, and creates no new row either way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shared = vi.hoisted(() => ({
  kernelAnswers: {
    organization: { archivedAt: null as string | null, archiveEpoch: 0 } as
      | { archivedAt: string | null; archiveEpoch: number }
      | null,
    leaseHeld: false,
  },
  // Rows a select-by-agentRuns query answers with (post-insert re-reads,
  // idempotency-key lookups, readAgentRunById).
  runRows: [] as Array<Record<string, unknown>>,
  insertedValues: [] as Array<Record<string, unknown>>,
  insertCalls: 0,
  // When set, the NEXT insert throws a 23505-shaped unique-violation.
  failInsertWith23505: false,
}));

function fakeRunRowDefaults(): Record<string, unknown> {
  return {
    id: "unset",
    templateId: "tmpl-1",
    versionId: null,
    runBy: null,
    status: "queued",
    inputParams: "{}",
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: true,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-1",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    executionAttemptId: null,
    humanPresent: null,
  };
}

vi.mock("../db", async () => {
  const { wrapTxWithOrgWriteKernel } = await import(
    "@cinatra-ai/org-write-kernel/testing"
  );
  const { agentRuns, agentTemplates } = await import("../schema");

  function rowsFor(table: unknown): Array<Record<string, unknown>> {
    if (table === agentRuns) return shared.runRows;
    if (table === agentTemplates) return []; // no template row → null owner anchor (benign)
    return []; // agentVersions (readLatestAgentVersionIdForTemplate) → null pin (benign)
  }

  function select() {
    return {
      from(table: unknown) {
        const rows = rowsFor(table);
        const terminal = Object.assign(Promise.resolve(rows), {
          limit: async () => rows,
          orderBy: () => ({ limit: async () => rows }),
        });
        return {
          where: () => terminal,
        };
      },
    };
  }

  function insert() {
    return {
      values: (v: Record<string, unknown>) => {
        shared.insertCalls += 1;
        if (shared.failInsertWith23505) {
          shared.failInsertWith23505 = false; // one-shot, mirrors a real unique index (retry would re-check)
          const err = Object.assign(
            new Error('duplicate key value violates unique constraint "agent_runs_idempotency_key_uniq"'),
            { code: "23505" },
          );
          const rejected = Promise.reject(err);
          rejected.catch(() => {});
          return Object.assign(rejected, { returning: () => Promise.reject(err) });
        }
        shared.insertedValues.push(v);
        const row = { ...fakeRunRowDefaults(), ...v };
        shared.runRows = [row];
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => [row],
        });
      },
    };
  }

  const tx = wrapTxWithOrgWriteKernel(
    { update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }), insert, execute: async () => ({ rows: [] }) },
    shared.kernelAnswers,
  );
  return {
    db: {
      select,
      insert,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
    agentBuilderPool: { end: vi.fn() },
  };
});

import { createAgentRun, createAgentRunPendingInput } from "../store";

const ORG = "org-1";

// Member session (grants every capability). RUN_AUTH_OTHER = a
// VerifiedRunRef-shaped authority bound to a DIFFERENT run than the one
// being created — RUN_CAPABILITIES never grants run.execute to a run
// authority, but even if it did, guardedRunWrite's own runId-binding check
// refuses it first (the free structural win: a run can never create
// another run by forwarding its own authority).
const SESSION = { orgId: ORG, can: () => true };
const RUN_AUTH_OTHER = {
  orgId: ORG,
  runId: "run-OTHER",
  can: (c: string) => c === "content.write" || c === "run.complete",
};

beforeEach(() => {
  vi.clearAllMocks();
  shared.runRows = [];
  shared.insertedValues = [];
  shared.insertCalls = 0;
  shared.failInsertWith23505 = false;
  shared.kernelAnswers.organization = { archivedAt: null, archiveEpoch: 0 };
  shared.kernelAnswers.leaseHeld = false;
});

describe("createAgentRun — the guarded creation perimeter", () => {
  it("fail-closed: a missing authority throws AgentRunOrgWriteAuthorityError('missing'); no insert", async () => {
    await expect(
      createAgentRun(
        { id: "run-new", templateId: "tmpl-1", inputParams: {}, orgId: ORG },
        undefined,
      ),
    ).rejects.toMatchObject({ name: "AgentRunOrgWriteAuthorityError", reason: "missing" });
    expect(shared.insertCalls).toBe(0);
  });

  it("a run-bound authority for a DIFFERENT run refuses run-mismatch; no insert (a run can never create another run)", async () => {
    await expect(
      createAgentRun(
        { id: "run-new", templateId: "tmpl-1", inputParams: {}, orgId: ORG },
        RUN_AUTH_OTHER,
      ),
    ).rejects.toMatchObject({ name: "AgentRunOrgWriteAuthorityError", reason: "run-mismatch" });
    expect(shared.insertCalls).toBe(0);
  });

  it("archived org refuses capability-denied; no insert", async () => {
    shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 };
    await expect(
      createAgentRun(
        { id: "run-new", templateId: "tmpl-1", inputParams: {}, orgId: ORG },
        SESSION,
      ),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "capability-denied" });
    expect(shared.insertCalls).toBe(0);
  });

  it("active org + session authority succeeds and returns the created record", async () => {
    const run = await createAgentRun(
      { id: "run-new", templateId: "tmpl-1", inputParams: { a: 1 }, orgId: ORG },
      SESSION,
    );
    expect(run.id).toBe("run-new");
    expect(run.orgId).toBe(ORG);
    expect(shared.insertCalls).toBe(1);
  });

  it("idempotent retry — active org, mismatched-key collision re-reads the winning row and returns it (unchanged contract)", async () => {
    shared.runRows = [
      { ...fakeRunRowDefaults(), id: "run-winner", templateId: "tmpl-1", orgId: ORG, idempotencyKey: "key-1" },
    ];
    shared.failInsertWith23505 = true;
    const run = await createAgentRun(
      { id: "run-loser", templateId: "tmpl-1", inputParams: {}, orgId: ORG, idempotencyKey: "key-1" },
      SESSION,
    );
    expect(run.id).toBe("run-winner");
  });

  it("idempotent retry under an ARCHIVED org gets the archived refusal INSTEAD of the existing-row return — no new row either way (Decision 2)", async () => {
    shared.runRows = [
      { ...fakeRunRowDefaults(), id: "run-winner", templateId: "tmpl-1", orgId: ORG, idempotencyKey: "key-1" },
    ];
    shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 };
    await expect(
      createAgentRun(
        { id: "run-loser", templateId: "tmpl-1", inputParams: {}, orgId: ORG, idempotencyKey: "key-1" },
        SESSION,
      ),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "capability-denied" });
    // The guard refuses before the insert is ever attempted — the 23505 path
    // (and its existing-row return) is unreachable, so runRows is untouched.
    expect(shared.runRows).toHaveLength(1);
    expect(shared.runRows[0]?.id).toBe("run-winner");
  });
});

describe("createAgentRunPendingInput — the guarded creation perimeter", () => {
  it("fail-closed: a missing authority throws AgentRunOrgWriteAuthorityError('missing'); no insert", async () => {
    await expect(
      createAgentRunPendingInput(
        { templateId: "tmpl-1", runBy: null, orgId: ORG },
        undefined,
      ),
    ).rejects.toMatchObject({ name: "AgentRunOrgWriteAuthorityError", reason: "missing" });
    expect(shared.insertCalls).toBe(0);
  });

  it("a run-bound authority refuses run-mismatch against the freshly generated id; no insert", async () => {
    // createAgentRunPendingInput mints its OWN id internally — a run-bound
    // authority scoped to any other run can never match it.
    await expect(
      createAgentRunPendingInput(
        { templateId: "tmpl-1", runBy: null, orgId: ORG },
        RUN_AUTH_OTHER,
      ),
    ).rejects.toMatchObject({ name: "AgentRunOrgWriteAuthorityError", reason: "run-mismatch" });
    expect(shared.insertCalls).toBe(0);
  });

  it("archived org refuses capability-denied; no insert", async () => {
    shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 };
    await expect(
      createAgentRunPendingInput(
        { templateId: "tmpl-1", runBy: null, orgId: ORG },
        SESSION,
      ),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "capability-denied" });
    expect(shared.insertCalls).toBe(0);
  });

  it("active org + session authority succeeds — the post-insert re-read stays OUTSIDE the guard", async () => {
    const run = await createAgentRunPendingInput(
      { templateId: "tmpl-1", runBy: "user-1", orgId: ORG },
      SESSION,
    );
    expect(run.orgId).toBe(ORG);
    expect(run.status).toBe("pending_input");
    expect(shared.insertCalls).toBe(1);
  });
});
