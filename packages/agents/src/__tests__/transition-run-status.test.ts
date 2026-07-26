/**
 * Behavioral tests for transitionRunStatus under the org-write kernel guard
 * (cinatra#1939 wave 2, Commit B). The writer now runs its CAS + delegated meta
 * write inside guardOrgMutation's org-locked transaction, requires a host-minted
 * authority (the per-writer ratchet), and fires all non-transactional
 * side-effects POST-COMMIT.
 *
 * Harness (mirrors the dashboards conversion tests): `../db` is mocked so
 * `db.transaction(fn)` hands the writer a fake drizzle tx that (a) answers the
 * kernel's own queries via `wrapTxWithOrgWriteKernel` from `state.kernelAnswers`,
 * and (b) records the writer's CAS/meta `.set()` payloads + derivation inserts.
 * `expireRunStream` (@cinatra-ai/a2a) and `dispatchRunWaitTransition`
 * (../run-wait-notifier) are spied so the POST-COMMIT side-effect contract is
 * observable. No live Postgres / Redis.
 *
 * Covers §4 (a)–(g): illegal pre-guard, stale CAS, capability proofs (archived
 * deny / lease-required / active allow), CAS org-scope fail-closed, dispatch
 * stamping, derivationOutbox on the guarded tx, POST-COMMIT firing + suppression,
 * plus the active-org RUN-authority split-safety proofs (codex #11) and the
 * cinatra#1937/#1938 dispatch + wait-marker contracts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shared = vi.hoisted(() => ({
  // Mutated per test (fields, NOT reassigned — the kernel wrap holds this ref).
  kernelAnswers: {
    organization: { archivedAt: null as string | null, archiveEpoch: 0 } as
      | { archivedAt: string | null; archiveEpoch: number }
      | null,
    leaseHeld: false,
  },
  // Queue of CAS `.returning()` results; empty → default win ([{ id }]).
  returningRows: [] as Array<Array<{ id: string }>>,
  setPayloads: [] as unknown[],
  inserted: [] as unknown[],
  updateCalls: 0,
  // 1-indexed update-call ordinal whose write should REJECT (meta-write-failure sim).
  failOnUpdateCall: null as number | null,
  expireRunStream: vi.fn(async () => undefined),
  dispatchRunWaitTransition: vi.fn(async () => undefined),
}));

vi.mock("../db", async () => {
  // Sanctioned kernel fakes: answer the guard's own queries (org locks,
  // lifecycle read, lease probe) from state.kernelAnswers; delegate everything
  // else (the writer's own drizzle statements) to the base fake below.
  const { wrapTxWithOrgWriteKernel } = await import(
    "@cinatra-ai/org-write-kernel/testing"
  );
  const update = () => {
    shared.updateCalls += 1;
    const thisCall = shared.updateCalls;
    return {
      set: (payload: unknown) => {
        shared.setPayloads.push(payload);
        return {
          // The CAS calls `.returning()`; the meta write awaits `.where()` directly.
          where: () => {
            if (shared.failOnUpdateCall === thisCall) {
              const rej = () => {
                const r = Promise.reject(new Error("simulated write failure"));
                r.catch(() => {});
                return r;
              };
              return Object.assign(rej(), { returning: rej });
            }
            const rows =
              shared.returningRows.length > 0
                ? shared.returningRows.shift()!
                : [{ id: "run-1" }];
            return Object.assign(Promise.resolve(undefined), {
              returning: async () => rows,
            });
          },
        };
      },
    };
  };
  const insert = () => ({
    values: (v: unknown) => ({
      onConflictDoNothing: async () => {
        shared.inserted.push(v);
      },
    }),
  });
  const tx = wrapTxWithOrgWriteKernel(
    { update, insert, execute: async () => ({ rows: [] }) },
    shared.kernelAnswers,
  );
  return {
    db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    agentBuilderPool: { end: vi.fn() },
  };
});

vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = await orig<typeof import("@cinatra-ai/a2a")>();
  return { ...actual, expireRunStream: shared.expireRunStream };
});
vi.mock("../run-wait-notifier", async (orig) => {
  const actual = await orig<typeof import("../run-wait-notifier")>();
  return { ...actual, dispatchRunWaitTransition: shared.dispatchRunWaitTransition };
});

import { transitionRunStatus, type AgentRunStatus } from "../store";
// Error identity is asserted by the deterministic `.name` (+ `.reason`/`.code`)
// via toMatchObject — the same shape the seam suite pins — so the error classes
// need not be imported here.

const ORG = "org-1";
const RUN = "run-1";
// Member session (grants every capability). System = the agent-run-dispatch
// grant. RUN = a VerifiedRunRef-shaped authority (self-bound; run.complete only).
const SESSION = { orgId: ORG, can: () => true };
const RUN_AUTH = {
  orgId: ORG,
  runId: RUN,
  can: (c: string) => c === "content.write" || c === "run.complete",
};

const expireRunStream = shared.expireRunStream;
const dispatchRunWaitTransition = shared.dispatchRunWaitTransition;

function derivationCapture() {
  return {
    orgId: ORG,
    templateId: "tmpl-1",
    packageVersion: null,
    createdBy: "user-1",
    content: "final output",
    contentIsJson: false,
    contentHash: "abc123",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.setPayloads.length = 0;
  shared.inserted.length = 0;
  shared.returningRows = [];
  shared.updateCalls = 0;
  shared.failOnUpdateCall = null;
  shared.kernelAnswers.organization = { archivedAt: null, archiveEpoch: 0 };
  shared.kernelAnswers.leaseHeld = false;
});

describe("transitionRunStatus — required authority + pre-guard (§1b)", () => {
  it("(a) illegal edge throws illegal_transition BEFORE the guard; no DB, no side-effects", async () => {
    await expect(
      transitionRunStatus(RUN, "completed" as AgentRunStatus, "running" as AgentRunStatus, undefined, SESSION),
    ).rejects.toMatchObject({ name: "RunTransitionError", code: "illegal_transition" });
    expect(shared.updateCalls).toBe(0);
    expect(expireRunStream).not.toHaveBeenCalled();
    expect(dispatchRunWaitTransition).not.toHaveBeenCalled();
  });

  it("fail-closed: a missing authority throws AgentRunOrgWriteAuthorityError('missing'); no DB", async () => {
    await expect(
      transitionRunStatus(RUN, "pending_input", "queued", undefined, undefined),
    ).rejects.toMatchObject({ name: "AgentRunOrgWriteAuthorityError", reason: "missing" });
    expect(shared.updateCalls).toBe(0);
  });

  it("(b) a lost CAS (0 rows) throws stale_from_status and fires NO post-commit side-effects", async () => {
    shared.returningRows = [[]];
    await expect(
      transitionRunStatus(RUN, "queued", "running", { dispatch: { attemptId: "att-1" } }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    expect(expireRunStream).not.toHaveBeenCalled();
    expect(dispatchRunWaitTransition).not.toHaveBeenCalled();
  });
});

describe("transitionRunStatus — per-transition capability proofs (§3, item c)", () => {
  it("archived org + non-terminal edge → OrgWriteRefusedError('capability-denied'); no write", async () => {
    shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 };
    await expect(
      transitionRunStatus(RUN, "pending_input", "queued", undefined, SESSION),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "capability-denied" });
    expect(shared.setPayloads).toHaveLength(0);
    expect(expireRunStream).not.toHaveBeenCalled();
  });

  it("archived org + terminal edge w/ session (no runId, no lease) → 'lease-required-but-not-held'", async () => {
    shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 };
    await expect(
      transitionRunStatus(RUN, "queued", "stopped", undefined, SESSION),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "lease-required-but-not-held" });
    expect(shared.setPayloads).toHaveLength(0);
  });

  it("active org → both a non-terminal and a terminal edge succeed", async () => {
    await transitionRunStatus(RUN, "pending_input", "queued", undefined, SESSION);
    await transitionRunStatus(RUN, "queued", "stopped", undefined, SESSION);
    expect(shared.updateCalls).toBeGreaterThanOrEqual(2);
  });
});

describe("transitionRunStatus — CAS org-scope fail-closed (§1d, item d)", () => {
  it("a wrong-org authority yields a 0-row org-scoped CAS → stale_from_status, no derivation insert", async () => {
    // The CAS is `AND org_id = authority.orgId`; a run in another org matches 0
    // rows. Simulated here as a 0-row CAS — the security-relevant outcome is
    // fail-closed (no mutation, no capture) rather than cross-org write.
    shared.returningRows = [[]];
    await expect(
      transitionRunStatus(RUN, "running", "completed", { derivationOutbox: derivationCapture() }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    expect(shared.inserted).toHaveLength(0);
    expect(expireRunStream).not.toHaveBeenCalled();
    expect(dispatchRunWaitTransition).not.toHaveBeenCalled();
  });
});

describe("transitionRunStatus — POST-COMMIT side-effects (§1b, codex #2/#13, item g)", () => {
  it("(e) dispatch stamps executionAttemptId in the guarded CAS UPDATE", async () => {
    await transitionRunStatus(RUN, "queued", "running", { dispatch: { attemptId: "att-xyz" } }, SESSION);
    const cas = shared.setPayloads[0] as Record<string, unknown>;
    expect(cas.status).toBe("running");
    expect(cas.executionAttemptId).toBe("att-xyz");
    expect(cas.executionDeadlineAt).toBeDefined();
  });

  it("success terminal (non-derivation) fires expireRunStream AND dispatchRunWaitTransition once each", async () => {
    await transitionRunStatus(RUN, "queued", "stopped", undefined, SESSION);
    expect(expireRunStream).toHaveBeenCalledTimes(1);
    expect(expireRunStream).toHaveBeenCalledWith(RUN);
    expect(dispatchRunWaitTransition).toHaveBeenCalledTimes(1);
  });

  it("success non-terminal fires dispatchRunWaitTransition but NOT expireRunStream", async () => {
    await transitionRunStatus(RUN, "pending_input", "queued", undefined, SESSION);
    expect(expireRunStream).not.toHaveBeenCalled();
    expect(dispatchRunWaitTransition).toHaveBeenCalledTimes(1);
  });

  it("(f) derivationOutbox branch writes the outbox on the guarded tx, fires expire, SKIPS dispatch", async () => {
    await transitionRunStatus(RUN, "running", "completed", { derivationOutbox: derivationCapture() }, SESSION);
    expect(shared.inserted).toHaveLength(1);
    expect(shared.inserted[0]).toMatchObject({ runId: RUN, orgId: ORG, status: "pending" });
    // Terminal ⇒ expire fires post-commit; derivationOutbox path never notifies (parity).
    expect(expireRunStream).toHaveBeenCalledTimes(1);
    expect(dispatchRunWaitTransition).not.toHaveBeenCalled();
  });

  it("a meta-write failure rolls the tx back AND suppresses the post-commit side-effects", async () => {
    // running→completed with meta ⇒ CAS (update #1, wins) then meta write
    // (update #2) — force the meta write to reject.
    shared.failOnUpdateCall = 2;
    await expect(
      transitionRunStatus(RUN, "running", "completed", { stepResults: [{ ok: true }] }, SESSION),
    ).rejects.toThrow(/simulated write failure/);
    expect(expireRunStream).not.toHaveBeenCalled();
    expect(dispatchRunWaitTransition).not.toHaveBeenCalled();
  });

  it("terminal meta (stepResults) is forwarded through the guarded meta write", async () => {
    await transitionRunStatus(RUN, "running", "completed", { stepResults: [{ ok: true, step: "final" }] }, SESSION);
    expect(shared.setPayloads).toHaveLength(2);
    expect(shared.setPayloads[1]).toMatchObject({
      status: "completed",
      stepResults: JSON.stringify([{ ok: true, step: "final" }]),
    });
  });

  it("expireRunStream fires for every terminal `to`, and never for a non-terminal `to`", async () => {
    for (const [from, to] of [["queued", "stopped"], ["running", "completed"], ["running", "failed"]] as const) {
      vi.clearAllMocks();
      await transitionRunStatus(RUN, from, to, undefined, SESSION);
      expect(expireRunStream, `terminal ${from}->${to}`).toHaveBeenCalledTimes(1);
    }
    for (const [from, to] of [["pending_input", "queued"], ["running", "pending_approval"]] as const) {
      vi.clearAllMocks();
      await transitionRunStatus(RUN, from, to, undefined, SESSION);
      expect(expireRunStream, `non-terminal ${from}->${to}`).not.toHaveBeenCalled();
    }
  });
});

describe("transitionRunStatus — active-org RUN-authority split-safety (codex #11)", () => {
  it("a RUN authority may LAND its OWN run's terminal state (run.complete, self-bound)", async () => {
    await transitionRunStatus(RUN, "running", "completed", undefined, RUN_AUTH);
    expect(shared.updateCalls).toBeGreaterThanOrEqual(1);
    expect(expireRunStream).toHaveBeenCalledTimes(1);
  });

  it("a RUN authority CANNOT drive a NON-terminal edge (lacks run.execute)", async () => {
    await expect(
      transitionRunStatus(RUN, "queued", "running", { dispatch: { attemptId: "att-1" } }, RUN_AUTH),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "authority-lacks-capability" });
    expect(shared.setPayloads).toHaveLength(0);
  });

  it("a RUN authority CANNOT terminal-transition ANOTHER same-org run (§1a run-binding)", async () => {
    await expect(
      transitionRunStatus("run-OTHER", "running", "completed", undefined, RUN_AUTH),
    ).rejects.toMatchObject({ name: "AgentRunOrgWriteAuthorityError", reason: "run-mismatch" });
    expect(shared.updateCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cinatra#1937 dispatch bookkeeping + cinatra#1938 wait-marker contracts,
// re-verified under the guarded-tx conversion.
// ---------------------------------------------------------------------------
describe("queued→running dispatch fields (cinatra#1937)", () => {
  it("queued→running WITHOUT dispatch fields throws; the CAS UPDATE never runs", async () => {
    await expect(
      transitionRunStatus(RUN, "queued", "running", undefined, SESSION),
    ).rejects.toThrow(/requires dispatch fields/);
    expect(shared.setPayloads).toHaveLength(0);
  });

  it("REFUSES dispatch fields on a non-dispatch transition (inverse guard)", async () => {
    await expect(
      transitionRunStatus(RUN, "running", "completed", { dispatch: { attemptId: "att-misuse" } }, SESSION),
    ).rejects.toThrow(/non-dispatch transition/);
  });

  it("strips control keys from the delegated meta write (dispatch/humanWaitGate never reach the DB)", async () => {
    await transitionRunStatus(
      RUN,
      "queued",
      "running",
      { startedAt: new Date("2026-07-21T00:00:00Z"), dispatch: { attemptId: "att-abc" } },
      SESSION,
    );
    expect(shared.setPayloads).toHaveLength(2);
    const delegated = shared.setPayloads[1] as Record<string, unknown>;
    expect(delegated.startedAt).toBeInstanceOf(Date);
    expect("dispatch" in delegated).toBe(false);
    expect("humanWaitGate" in delegated).toBe(false);
  });
});

describe("mid-attempt wait marker stamping (#1938)", () => {
  type CasPayload = { humanWaitAttemptId?: unknown };
  it("running→pending_approval stamps the marker from the row's own attempt id", async () => {
    await transitionRunStatus(RUN, "running", "pending_approval", undefined, SESSION);
    const cas = shared.setPayloads[0] as CasPayload;
    expect(cas.humanWaitAttemptId).not.toBeNull();
    expect(cas.humanWaitAttemptId).toBeTypeOf("object");
  });

  it("queued→pending_approval (setup interrupt) clears the marker", async () => {
    await transitionRunStatus(RUN, "queued", "pending_approval", undefined, SESSION);
    expect(shared.setPayloads[0]).toHaveProperty("humanWaitAttemptId", null);
  });

  it("pending_input edges never touch the marker column", async () => {
    await transitionRunStatus(RUN, "failed", "pending_input", undefined, SESSION);
    const cas = shared.setPayloads[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(cas, "humanWaitAttemptId")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source-scan guard (codex-adopted): every queued→running transition CALL in the
// tree supplies dispatch fields, so `running` rows never carry a stale attempt.
// ---------------------------------------------------------------------------
describe("queued→running caller discipline (source scan)", () => {
  it("EVERY queued→running caller in the tree supplies dispatch fields", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const repoRoot = resolve(__dirname, "../../../..");
    const roots = [join(repoRoot, "packages/agents/src"), join(repoRoot, "src/lib")];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(p, "utf-8");
        let idx = 0;
        while ((idx = text.indexOf('"queued", "running"', idx)) !== -1) {
          const windowText = text.slice(Math.max(0, idx - 200), idx + 300);
          const isCall = /transitionRunStatus\(|updateAgentRunStatusConditional\(/.test(windowText);
          if (isCall && !windowText.includes("dispatch")) {
            offenders.push(p.slice(repoRoot.length + 1));
          }
          idx += 1;
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
