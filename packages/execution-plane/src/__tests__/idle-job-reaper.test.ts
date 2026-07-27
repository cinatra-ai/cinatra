/**
 * `ExecutionBroker.closeIdleJobs` (exec-plane S1b activation, cinatra#2138 —
 * Codex convergence finding 3).
 *
 * The executor memoizes one broker job per sealed carrier and a request has no
 * "turn finished" signal to hand back, so a long-lived app-wired broker would
 * otherwise accumulate open jobs until the per-org open-job ceiling refuses all
 * further execution until the process restarts. The app wiring sweeps on a
 * timer with the carrier TTL as the idle window; these tests pin the sweep's
 * semantics.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintExecutionSession, sealExecutionSession } from "@cinatra-ai/llm/execution-plane";

import { ExecutionBroker } from "../broker";
import type { DockerCli } from "../docker-cli";
import type {
  SandboxCommandResult,
  SandboxWorker,
} from "../types";

const SECRET = "idle-reaper-secret";

// The broker opens carriers with the process-level secret (it takes no explicit
// one), so the suite pins it for the duration.
let priorSecret: string | undefined;
beforeAll(() => {
  priorSecret = process.env.EXECUTION_BROKER_SECRET;
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});
afterAll(() => {
  if (priorSecret === undefined) delete process.env.EXECUTION_BROKER_SECRET;
  else process.env.EXECUTION_BROKER_SECRET = priorSecret;
});

const worker: SandboxWorker = {
  async runCommand(): Promise<SandboxCommandResult> {
    return {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      termination: "exited",
      wallMs: 1,
      imageDigest: "sha256:test",
      workspaceKb: 8,
    };
  },
};

const removedVolumes: string[] = [];
const fakeDocker: DockerCli = async (args) => {
  if (args[0] === "volume" && args[1] === "rm") removedVolumes.push(args[args.length - 1]);
  return {
    exitCode: 0,
    stdout: args[0] === "volume" && args[1] === "create" ? args[args.length - 1] : "",
    stderr: "",
    stdioOverflow: false,
    timedOut: false,
  };
};

function carrier(runId: string, nowMs: number): string {
  return sealExecutionSession(
    mintExecutionSession({ orgId: "org-1", userId: "user-1", surface: "agent_run", runId }),
    { secret: SECRET, nowMs, ttlMs: 24 * 60 * 60 * 1000 },
  );
}

function makeBroker(clock: { now: number }) {
  return new ExecutionBroker({
    worker,
    auditSink: () => {},
    livenessProbe: async () => "alive",
    egressPolicyResolver: () => ({ mode: "none" }),
    docker: fakeDocker,
    nowMs: () => clock.now,
  });
}

describe("closeIdleJobs", () => {
  it("closes only the jobs idle beyond the window, and leaves fresh ones open", async () => {
    const clock = { now: 1_000_000 };
    const broker = makeBroker(clock);

    const stale = await broker.openJob(carrier("run-stale", clock.now));
    expect(stale.ok).toBe(true);

    clock.now += 20 * 60 * 1000; // 20 minutes later
    const fresh = await broker.openJob(carrier("run-fresh", clock.now));
    expect(fresh.ok).toBe(true);

    const closed = await broker.closeIdleJobs(15 * 60 * 1000);
    expect(closed).toBe(1);

    // The stale job is gone; a command on it is refused as unknown.
    if (stale.ok) {
      const after = await broker.exec(stale.jobId, "echo hi");
      expect(after).toMatchObject({ ok: false, reason: "unknown_job" });
    }
    // The fresh job still works.
    if (fresh.ok) {
      await expect(broker.exec(fresh.jobId, "echo hi")).resolves.toMatchObject({ ok: true });
    }
  });

  it("a dispatched command REFRESHES the job's idle clock", async () => {
    const clock = { now: 2_000_000 };
    const broker = makeBroker(clock);
    const opened = await broker.openJob(carrier("run-active", clock.now));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    clock.now += 10 * 60 * 1000;
    await broker.exec(opened.jobId, "echo still-here");
    clock.now += 10 * 60 * 1000;

    // 20 minutes since OPEN, but only 10 since the last command.
    expect(await broker.closeIdleJobs(15 * 60 * 1000)).toBe(0);
    clock.now += 10 * 60 * 1000;
    expect(await broker.closeIdleJobs(15 * 60 * 1000)).toBe(1);
  });

  it("leaves the run-keyed L2 workspace in place (the retention GC owns it)", async () => {
    removedVolumes.length = 0;
    const clock = { now: 3_000_000 };
    const broker = makeBroker(clock);
    await broker.openJob(carrier("run-keep-workspace", clock.now));
    clock.now += 60 * 60 * 1000;
    expect(await broker.closeIdleJobs(15 * 60 * 1000)).toBe(1);
    expect(removedVolumes).toEqual([]);
  });

  it("NEVER closes a job with a command in flight, however idle the clock looks", async () => {
    const clock = { now: 5_000_000 };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slowWorker: SandboxWorker = {
      async runCommand(): Promise<SandboxCommandResult> {
        await gate;
        return {
          exitCode: 0, stdout: "ok", stderr: "",
          stdoutTruncated: false, stderrTruncated: false,
          termination: "exited", wallMs: 1, imageDigest: "sha256:test", workspaceKb: 8,
        };
      },
    };
    const broker = new ExecutionBroker({
      worker: slowWorker,
      auditSink: () => {},
      livenessProbe: async () => "alive",
      egressPolicyResolver: () => ({ mode: "none" }),
      docker: fakeDocker,
      nowMs: () => clock.now,
    });
    const opened = await broker.openJob(carrier("run-slow", clock.now));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const running = broker.exec(opened.jobId, "sleep-forever");
    await new Promise((r) => setTimeout(r, 10));
    // The command is still dispatched; push the clock far past the window.
    clock.now += 60 * 60 * 1000;
    expect(await broker.closeIdleJobs(15 * 60 * 1000)).toBe(0);

    release();
    await running;
    // Once the command settles the job becomes reapable again.
    expect(await broker.closeIdleJobs(15 * 60 * 1000)).toBe(1);
  });

  it("frees room under the per-org open-job ceiling", async () => {
    const clock = { now: 4_000_000 };
    const broker = new ExecutionBroker({
      worker,
      auditSink: () => {},
      livenessProbe: async () => "alive",
      egressPolicyResolver: () => ({ mode: "none" }),
      docker: fakeDocker,
      nowMs: () => clock.now,
      quotas: { maxOpenJobsPerOrg: 2 },
    });

    expect((await broker.openJob(carrier("r1", clock.now))).ok).toBe(true);
    expect((await broker.openJob(carrier("r2", clock.now))).ok).toBe(true);
    // Ceiling reached — the merged bounded, fail-closed refusal.
    expect(await broker.openJob(carrier("r3", clock.now))).toMatchObject({
      ok: false,
      reason: "open_jobs_exhausted",
    });

    clock.now += 30 * 60 * 1000;
    expect(await broker.closeIdleJobs(15 * 60 * 1000)).toBe(2);
    expect((await broker.openJob(carrier("r3", clock.now))).ok).toBe(true);
  });
});
