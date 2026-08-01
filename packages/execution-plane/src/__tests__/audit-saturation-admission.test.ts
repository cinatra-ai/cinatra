/**
 * THE SATURATION STATE MACHINE, at the broker (cinatra#2266 G5/AC7).
 *
 * `service/__tests__/audit-spool-saturation.test.ts` proves the spool's own
 * behaviour. This file proves the property the issue actually states, which is
 * about COMMANDS: a permanently-full spool refuses new commands fail-closed,
 * costs exactly ONE bounded `audit_spool_full` episode instead of one record
 * per attempt, and reopens on a defined condition — asserted against DISPATCH
 * COUNT and against the FILE, because the audit table alone cannot tell
 * "refused" from "lost".
 *
 * Everything below drives the REAL `ExecutionBroker` through the REAL
 * `createAuditRelay` over a REAL file spool in a real directory. No double
 * stands in for the thing under test.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ExecutionBroker } from "../broker";
import {
  AUDIT_SPOOL_EPISODE_RESERVE_BYTES,
  AUDIT_SPOOL_FULL_REASON,
  AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES,
  openAuditSpool,
  type AuditSpool,
} from "../service/audit-spool";
import { createAuditRelay } from "../service/broker-server";
import {
  DEFAULT_SANDBOX_LIMITS,
  type ExecutionAuditRecord,
  type SandboxCommandResult,
  type SandboxCommandSpec,
  type SandboxWorker,
} from "../types";
import { sealExecutionSession } from "@cinatra-ai/llm/execution-plane";

/**
 * REAL FSYNCS NEED A REAL TIMEOUT, and the default 5 s one is not a statement
 * about correctness — it is a statement about how loaded the host is.
 *
 * Every arm below drives the spool's actual durability path: `fsync` on the log,
 * `fsync` on the directory, an atomic rename per watermark write. That is the
 * behaviour under test, so it cannot be stubbed out to go faster. On a busy
 * machine those syscalls are tens of milliseconds each and a single arm issues
 * dozens, which put several arms within noise of the 5 s ceiling and made them
 * flake — as TIMEOUTS, never as wrong assertions.
 *
 * The ceiling is raised rather than the fsyncs removed, because a spool that
 * does not fsync is exactly the defect cinatra#2266 exists to fix. A genuine
 * hang still fails, just later.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });


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

const dirs: string[] = [];
const spools: AuditSpool[] = [];
afterEach(async () => {
  for (const s of spools.splice(0)) await s.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cinatra-broker-saturation-"));
  dirs.push(dir);
  return dir;
}

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

function acceptingVerifier(commandId: () => string) {
  return {
    verify: () => ({
      ok: true as const,
      claims: { commandId: commandId(), egressPolicy: { mode: "none" as const } },
    }),
    checkFreshness: () => ({ ok: true as const }),
  };
}

/** Every record currently on the spool FILE, decoded from its frames. */
function recordsOnDisk(dir: string): ExecutionAuditRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, "audit-spool.log"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line.slice(17)) as { kind: string; record?: ExecutionAuditRecord })
    .filter((frame) => frame.kind === "record" && frame.record)
    .map((frame) => frame.record!);
}

/**
 * A bound with room for a handful of executed commands and no more. Derived
 * from the module's own constants so it cannot drift when either moves.
 */
const TIGHT_MAX_BYTES = AUDIT_SPOOL_EPISODE_RESERVE_BYTES + 3 * AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES;

async function brokerOnSpool(dir: string, maxBytes = TIGHT_MAX_BYTES) {
  const spool = openAuditSpool({ dir, maxBytes });
  spools.push(spool);
  const relay = createAuditRelay({ spool });
  const worker = countingWorker();
  let n = 0;
  const broker = new ExecutionBroker({
    worker,
    auditSink: relay.auditSink,
    auditReserver: relay.auditReserver,
    // THE GATE UNDER TEST.
    auditAdmission: relay.auditAdmission,
    livenessProbe: async () => "alive",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    voucherVerifier: acceptingVerifier(() => `cmd-${(n += 1)}`) as any,
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
  return { broker, jobId: opened.jobId, worker, spool, relay };
}

describe("saturation at the BROKER — a full spool refuses commands, fail-closed", () => {
  it("refuses with a named reason, dispatches nothing, and mints NO record per attempt", async () => {
    const dir = tempDir();
    const { broker, jobId, worker, spool } = await brokerOnSpool(dir);

    // Run until the plane stops admitting. Each success is a real dispatch and
    // a real terminal record on the volume.
    let executed = 0;
    let firstRefusal: Awaited<ReturnType<typeof broker.exec>> | undefined;
    for (let i = 0; i < 200; i += 1) {
      const result = await broker.exec(jobId, `printf ${i}`, "voucher");
      if (result.ok) {
        executed += 1;
        continue;
      }
      firstRefusal = result;
      break;
    }
    // NONZERO MINIMUM. A run in which nothing ever executed would be asserting
    // against a plane that refused its first command for some other reason.
    expect(executed).toBeGreaterThanOrEqual(1);
    expect(worker.dispatches).toHaveLength(executed);
    expect(firstRefusal).toMatchObject({ ok: false, reason: "audit_spool_unavailable" });

    expect(spool.stats().saturation.state).toBe("saturated");
    const episodeId = spool.stats().saturation.episode?.id;
    expect(episodeId).toBeTruthy();

    const dispatchesAtSaturation = worker.dispatches.length;
    const recordsAtSaturation = recordsOnDisk(dir).length;

    // PAST THE RESERVE — the AC's own instruction. Hundreds of further
    // commands, none of which may run and none of which may mint a record.
    for (let i = 0; i < 300; i += 1) {
      const result = await broker.exec(jobId, `printf late-${i}`, "voucher");
      expect(result).toMatchObject({ ok: false, reason: "audit_spool_unavailable" });
    }
    // NOTHING RAN...
    expect(worker.dispatches).toHaveLength(dispatchesAtSaturation);
    // ...and NOTHING was written. This is the whole of G5: the refusals are
    // bounded by one episode record, not by one record each.
    expect(recordsOnDisk(dir).length).toBe(recordsAtSaturation);
    const episodes = recordsOnDisk(dir).filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.spoolEpisode?.id).toBe(episodeId);
    expect(episodes[0]?.decision).toBe("refused");
    // The count of what was refused is kept even though the records are not.
    expect(spool.stats().saturation.episode?.refused).toBeGreaterThanOrEqual(300);

    // THE NEGATIVE CONTROL the issue asks for, stated as an equality rather
    // than an inequality: every command that RAN has a durable record, and no
    // command ran without one. Terminal records are `executed`; the reserved
    // prepared frames of the same commands share their delivery keys.
    const executedRecords = recordsOnDisk(dir).filter((r) => r.decision === "executed");
    expect(executedRecords).toHaveLength(worker.dispatches.length);
  });

  it("no sequence is burned on a refused admission — the recorded stream has no holes", async () => {
    const dir = tempDir();
    const { broker, jobId, spool } = await brokerOnSpool(dir);
    while ((await broker.exec(jobId, "printf x", "voucher")).ok) {
      /* fill */
    }
    expect(spool.stats().saturation.state).toBe("saturated");
    for (let i = 0; i < 50; i += 1) await broker.exec(jobId, "printf y", "voucher");

    // Every RECORDED attempt has a sequence, and the recorded sequences are a
    // dense range from zero: a gate that allocated a seq per refused attempt
    // would have left 50 unexplained holes in it.
    const seqs = recordsOnDisk(dir)
      .filter((r) => r.decision === "executed")
      .map((r) => r.seq)
      .sort((a, b) => a - b);
    expect(seqs.length).toBeGreaterThanOrEqual(1);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i));
  });
});

describe("saturation at the BROKER — recovery on the defined condition", () => {
  it("admits commands again once the app has ACKed enough of the trail", async () => {
    const dir = tempDir();
    const { broker, jobId, worker, spool, relay } = await brokerOnSpool(dir);
    while ((await broker.exec(jobId, "printf x", "voucher")).ok) {
      /* fill */
    }
    expect(spool.stats().saturation.state).toBe("saturated");
    const dispatchesWhileSaturated = worker.dispatches.length;
    expect(await broker.exec(jobId, "printf blocked", "voucher")).toMatchObject({
      ok: false,
      reason: "audit_spool_unavailable",
    });
    expect(worker.dispatches).toHaveLength(dispatchesWhileSaturated);

    // THE APP DRAINS AND ACKNOWLEDGES — the defined reopen condition, driven
    // through the real relay rather than by poking the spool.
    const batch = relay.read();
    expect(batch.audit.length).toBeGreaterThan(0);
    expect(batch.saturation?.state).toBe("saturated");
    const acked = await relay.ack({ spoolId: batch.spoolId, head: batch.head });
    expect(acked.ok).toBe(true);

    expect(spool.stats().saturation.state).toBe("open");
    // ...and the plane genuinely works again, proven by a real dispatch.
    const revived = await broker.exec(jobId, "printf revived", "voucher");
    expect(revived.ok).toBe(true);
    expect(worker.dispatches.length).toBe(dispatchesWhileSaturated + 1);

    // The RECOVERY is stated on the wire, not inferred from refusals stopping.
    const after = relay.read();
    expect(after.saturation?.state).toBe("open");
    expect(after.saturation?.lastEpisode?.closedAtMs).toBeGreaterThan(0);
    expect(after.saturation?.lastEpisode?.refused).toBeGreaterThanOrEqual(1);
    // Still exactly one episode record for the whole episode.
    expect(spool.stats().saturation.episodes).toBe(1);
  });

  it("reports the open episode and its refusal count on every drain response", async () => {
    const dir = tempDir();
    const { broker, jobId, relay } = await brokerOnSpool(dir);
    while ((await broker.exec(jobId, "printf x", "voucher")).ok) {
      /* fill */
    }
    for (let i = 0; i < 20; i += 1) await broker.exec(jobId, "printf y", "voucher");
    const batch = relay.read();
    expect(batch.saturation?.state).toBe("saturated");
    expect(batch.saturation?.episodes).toBe(1);
    expect(batch.saturation?.episode?.refused).toBeGreaterThanOrEqual(20);
    // The wire carries the count precisely because the records do not exist:
    // this is the only place an operator learns how much was refused.
    expect(batch.audit.filter((r) => r.reason === AUDIT_SPOOL_FULL_REASON)).toHaveLength(1);
  });
});
