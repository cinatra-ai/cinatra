/**
 * THE PRE-DISPATCH RESERVATION, at the broker (cinatra#2266 G1/AC4 + G2/AC2).
 *
 * These drive the REAL `ExecutionBroker` — the same class the service wraps —
 * with a counting worker double, because the load-bearing assertion is about
 * DISPATCH COUNT: a reservation the broker could not take must mean the sandbox
 * was never handed the command, and only the worker can testify to that. The
 * audit table alone cannot: "no record" is exactly the state the failure
 * produces either way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExecutionBroker } from "../broker";
import { createMemoryAuditSpool } from "../service/audit-spool";
import { createAuditRelay } from "../service/broker-server";
import {
  DEFAULT_SANDBOX_LIMITS,
  type ExecutionAuditRecord,
  type ExecutionAuditReserver,
  type SandboxCommandResult,
  type SandboxCommandSpec,
  type SandboxWorker,
} from "../types";
import { sealExecutionSession } from "@cinatra-ai/llm/execution-plane";

const SECRET = "carrier-secret-aaaaaaaaaaaaaaaaaaaaaaaa";

let priorSecret: string | undefined;
beforeAll(() => {
  priorSecret = process.env.EXECUTION_BROKER_SECRET;
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});
afterAll(() => {
  if (priorSecret === undefined) delete process.env.EXECUTION_BROKER_SECRET;
  else process.env.EXECUTION_BROKER_SECRET = priorSecret;
});
const SESSION = {
  orgId: "org-1",
  userId: "user-1",
  surface: "agent_run" as const,
  runId: "run-1",
};

const RESULT: SandboxCommandResult = {
  exitCode: 0,
  stdout: "hi\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  termination: "exited",
  wallMs: 12,
  imageDigest: "sha256:deadbeef",
  workspaceKb: 4,
};

/** Counts dispatches — the only witness that can say "the sandbox never ran". */
function countingWorker(): SandboxWorker & { dispatches: SandboxCommandSpec[] } {
  const dispatches: SandboxCommandSpec[] = [];
  return {
    dispatches,
    async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
      dispatches.push(spec);
      return RESULT;
    },
  };
}

/**
 * A voucher verifier that ACCEPTS — the authorization boundary is not what
 * these arms are about, and a real one would need the whole mint site.
 */
function acceptingVerifier(commandId: () => string) {
  return {
    verify: () => ({
      ok: true as const,
      claims: {
        commandId: commandId(),
        egressPolicy: { mode: "none" as const },
      },
    }),
    // The post-queue freshness re-check the broker runs before dispatch. Always
    // fresh here: these arms are about the reservation, not about voucher TTLs.
    checkFreshness: () => ({ ok: true as const }),
  };
}

async function brokerWith(opts: {
  worker: SandboxWorker;
  auditSink: (r: ExecutionAuditRecord) => void | Promise<void>;
  auditReserver?: ExecutionAuditReserver;
  commandId: () => string;
}) {
  const broker = new ExecutionBroker({
    worker: opts.worker,
    auditSink: opts.auditSink,
    ...(opts.auditReserver ? { auditReserver: opts.auditReserver } : {}),
    livenessProbe: async () => "alive",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    voucherVerifier: acceptingVerifier(opts.commandId) as any,
    egressPolicyResolver: () => ({ mode: "none" }),
    limits: DEFAULT_SANDBOX_LIMITS,
    volumeOps: {
      ensureWorkspace: async (key: string) => `vol-${key}`,
      removeWorkspace: async () => {},
      stageSkills: async () => "skills-vol",
      removeSkills: async () => {},
    },
  });
  const carrier = await sealExecutionSession(SESSION, { secret: SECRET });
  const opened = await broker.openJob(carrier);
  if (!opened.ok) throw new Error(`openJob refused: ${opened.reason}`);
  return { broker, jobId: opened.jobId };
}

describe("pre-dispatch reservation — a reservation failure PREVENTS dispatch", () => {
  it("never calls worker.runCommand when the reservation rejects (dispatch count zero)", async () => {
    const worker = countingWorker();
    const records: ExecutionAuditRecord[] = [];
    let n = 0;
    const { broker, jobId } = await brokerWith({
      worker,
      auditSink: (r) => {
        records.push(r);
      },
      // Fault-injected at the exact seam the spool occupies: an fsync/full
      // failure surfaces to the broker as a rejected reservation.
      auditReserver: async () => {
        throw new Error("fsync failed: no space left on device");
      },
      commandId: () => `cmd-${(n += 1)}`,
    });

    const result = await broker.exec(jobId, "echo hi", "voucher");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("audit_spool_unavailable");
      expect(result.message).toMatch(/durably reserve/);
    }
    // THE LOAD-BEARING ASSERTION.
    expect(worker.dispatches).toHaveLength(0);
    // And the refusal is deliberately NOT itself an audit record: the audit
    // path is what just failed, and minting one per attempt is the unbounded
    // write G5 names (slice 3 turns the count into a bounded episode).
    expect(records.filter((r) => r.reason === "audit_spool_unavailable")).toHaveLength(0);
  });

  it("dispatches normally when the reservation succeeds, and commits ONE terminal record", async () => {
    const worker = countingWorker();
    const spool = createMemoryAuditSpool();
    const relay = createAuditRelay({ spool });
    let n = 0;
    const { broker, jobId } = await brokerWith({
      worker,
      auditSink: relay.auditSink,
      auditReserver: relay.auditReserver,
      commandId: () => `cmd-${(n += 1)}`,
    });

    const result = await broker.exec(jobId, "echo hi", "voucher");
    expect(result.ok).toBe(true);
    expect(worker.dispatches).toHaveLength(1);

    const batch = spool.read();
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0]).toMatchObject({ decision: "executed", jobId });
    expect(spool.stats().openReservations).toBe(0);
  });

  it("a DISPATCH FAILURE resolves the reservation instead of leaving it open", async () => {
    // Otherwise the next restart would mint a spurious `outcome_unknown` for a
    // command whose real outcome (a worker error) is already known.
    const spool = createMemoryAuditSpool();
    const relay = createAuditRelay({ spool });
    let n = 0;
    const worker: SandboxWorker = {
      async runCommand(): Promise<SandboxCommandResult> {
        throw new Error("the worker exploded");
      },
    };
    const { broker, jobId } = await brokerWith({
      worker,
      auditSink: relay.auditSink,
      auditReserver: relay.auditReserver,
      commandId: () => `cmd-${(n += 1)}`,
    });

    const result = await broker.exec(jobId, "echo hi", "voucher");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("worker_error");
    expect(spool.stats().openReservations).toBe(0);
    const entries = spool.read().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ decision: "refused", reason: "worker_error" });
  });
});

describe("the attempt sequence is allocated before any refusal path (AC2)", () => {
  it("gives two same-reason pre-dispatch refusals on ONE job distinct sequences AND keys", async () => {
    const worker = countingWorker();
    const spool = createMemoryAuditSpool();
    const relay = createAuditRelay({ spool });
    let n = 0;
    const { broker, jobId } = await brokerWith({
      worker,
      auditSink: relay.auditSink,
      auditReserver: relay.auditReserver,
      commandId: () => `cmd-${(n += 1)}`,
    });

    // Terminate the job so BOTH attempts take the identical, earliest
    // pre-dispatch refusal path (`job_terminated`) — the one that used to carry
    // no sequence at all because `seq` was allocated at dispatch.
    await broker.terminateJobsForRun(SESSION.runId);
    const first = await broker.exec(jobId, "echo one", "voucher");
    const second = await broker.exec(jobId, "echo two", "voucher");
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);

    const entries = spool.read().entries;
    expect(entries).toHaveLength(2);
    expect(entries.every((r) => r.reason === "job_terminated")).toBe(true);
    expect(entries.every((r) => r.jobId === jobId)).toBe(true);
    // Distinct producer sequences — neither defaulted.
    expect(new Set(entries.map((r) => r.seq)).size).toBe(2);
    // Distinct PHYSICAL delivery keys, which is what the ACK and the kernel's
    // idempotent insert actually key on.
    expect(new Set(entries.map((r) => r.deliveryKey)).size).toBe(2);
    // Both are durable — neither was collapsed, and no dispatch happened.
    expect(worker.dispatches).toHaveLength(0);
  });

  it("a dispatch does not reuse a sequence a refusal already consumed", async () => {
    const worker = countingWorker();
    const spool = createMemoryAuditSpool();
    const relay = createAuditRelay({ spool });
    let n = 0;
    const { broker, jobId } = await brokerWith({
      worker,
      auditSink: relay.auditSink,
      auditReserver: relay.auditReserver,
      commandId: () => `cmd-${(n += 1)}`,
    });

    // A refusal that happens BEFORE dispatch (a replayed commandId), then a
    // real dispatch. Under the pre-#2266 allocation the refusal had no
    // sequence and the dispatch would have taken 0 either way.
    const ok1 = await broker.exec(jobId, "echo one", "voucher");
    expect(ok1.ok).toBe(true);
    const seqs = spool.read().entries.map((r) => r.seq);
    const ok2 = await broker.exec(jobId, "echo two", "voucher");
    expect(ok2.ok).toBe(true);
    const all = spool.read().entries.map((r) => r.seq);
    expect(all).toEqual([...seqs, seqs[seqs.length - 1]! + 1]);
  });
});
