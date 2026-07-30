/**
 * The PLACEMENT GATE and the REVOCATION DRAIN (exec-plane L3).
 *
 * The lease matrix in `service/__tests__/lease.test.ts` proves what the lease
 * says. This file proves what the BROKER does about it: refuse before every
 * placement decision, and — because terminating a job is a flag flip that
 * leaves a running container running — actually cancel the containers by name.
 *
 * The container names here are produced by the REAL `containerNameFor`, not by
 * a string in a test, so a change to the naming scheme cannot leave the drain
 * quietly matching nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import { ExecutionBroker } from "../broker";
import type { DockerCli, DockerRunOutcome } from "../docker-cli";
import {
  SANDBOX_CONTAINER_JOB_LABEL,
  containerNameFor,
  isContainerNameForJob,
} from "../l0-profile";
import type {
  ExecutionAuditRecord,
  PlacementVerdict,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
} from "../types";
import { execVouched, makeVerifier, openVouched } from "./support/voucher-fixture";

const SECRET = "unit-test-placement-drain";

type Recorded = string[][];

/**
 * A docker seam that answers `volume create`, and reports the containers a
 * given job "has running" when the drain asks.
 *
 * The drain enumerates by the ownership LABEL the hardened run profile stamps,
 * so this fake keeps the same label→names mapping the daemon would.
 */
function drainableDocker(
  recorded: Recorded,
  running: Set<string>,
  labelled: Map<string, Set<string>>,
): DockerCli {
  return async (args: string[]): Promise<DockerRunOutcome> => {
    recorded.push([...args]);
    if (args[0] === "ps") {
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      const jobId = filter.replace(`label=${SANDBOX_CONTAINER_JOB_LABEL}=`, "");
      const names = [...(labelled.get(jobId) ?? [])].filter((n) => running.has(n));
      return ok(names.join("\n"));
    }
    if (args[0] === "rm") {
      running.delete(args[args.length - 1]);
      return ok("");
    }
    if (args[0] === "volume" && args[1] === "create") return ok(args[args.length - 1]);
    return ok("");
  };
}

function ok(stdout: string): DockerRunOutcome {
  return { exitCode: 0, stdout, stderr: "", stdioOverflow: false, timedOut: false };
}

/**
 * A worker that "starts" the container the real naming function would name.
 *
 * The dispatch counter is per-WORKER, not per-job — exactly as
 * `LocalDevSandboxWorker` does it — so the names are the ones a real placement
 * would produce, and `started` records them rather than the test guessing.
 */
function containerStartingWorker(
  running: Set<string>,
  labelled: Map<string, Set<string>> = new Map(),
): SandboxWorker & {
  specs: SandboxCommandSpec[];
  started: string[];
} {
  const specs: SandboxCommandSpec[] = [];
  const started: string[] = [];
  let seq = 0;
  return {
    specs,
    started,
    async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
      specs.push(spec);
      const name = containerNameFor(spec.jobId, seq++);
      started.push(name);
      running.add(name);
      // The real profile stamps `…​.job=<jobId>`; the drain selects on it.
      const forJob = labelled.get(spec.jobId) ?? new Set<string>();
      forJob.add(name);
      labelled.set(spec.jobId, forJob);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        termination: "exited",
        wallMs: 1,
        imageDigest: "sha256:test",
        workspaceKb: 0,
      };
    },
  };
}

function carrierFor(runId: string): string {
  return sealExecutionSession(
    mintExecutionSession({ orgId: "org-1", userId: "user-1", surface: "agent_run", runId }),
    { secret: SECRET },
  );
}

const REVOKED: PlacementVerdict = {
  ok: false,
  reason: "host_exclusivity_other_tenant",
  message: "The execution host is leased to a different tenant; refused (fail-closed).",
};

function makeBroker(
  guard: () => PlacementVerdict | Promise<PlacementVerdict>,
  running = new Set<string>(),
) {
  const recorded: Recorded = [];
  const audits: ExecutionAuditRecord[] = [];
  const labelled = new Map<string, Set<string>>();
  const worker = containerStartingWorker(running, labelled);
  const broker = new ExecutionBroker({
    worker,
    auditSink: (record) => { audits.push(record); },
    livenessProbe: async () => "alive",
    voucherVerifier: makeVerifier(),
    egressPolicyResolver: () => ({ mode: "none" }),
    docker: drainableDocker(recorded, running, labelled),
    placementGuard: guard,
  });
  return { broker, recorded, audits, running, worker, labelled };
}

beforeEach(() => {
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});

describe("placement gate — openJob", () => {
  it("a held lease changes nothing", async () => {
    const { broker } = makeBroker(() => ({ ok: true }));
    expect((await openVouched(broker, carrierFor("run-ok"))).ok).toBe(true);
  });

  it("a revoked lease refuses the open BEFORE any volume is created", async () => {
    const { broker, recorded } = makeBroker(() => REVOKED);
    const result = await openVouched(broker, carrierFor("run-revoked"));
    expect(result).toMatchObject({ ok: false, reason: "placement_refused" });
    expect(recorded.some((argv) => argv[0] === "volume" && argv[1] === "create")).toBe(false);
  });

  it("a THROWING guard fails CLOSED — unlike the liveness probe", async () => {
    const { broker } = makeBroker(() => {
      throw new Error("lease read exploded");
    });
    const result = await openVouched(broker, carrierFor("run-throw"));
    expect(result).toMatchObject({ ok: false, reason: "placement_refused" });
  });

  it("a refused open does not leak an org open-job reservation", async () => {
    let held = false;
    const { broker } = makeBroker(() => (held ? { ok: true } : REVOKED));
    for (let i = 0; i < 5; i += 1) {
      expect((await openVouched(broker, carrierFor(`run-${i}`))).ok).toBe(false);
    }
    held = true;
    expect((await openVouched(broker, carrierFor("run-after"))).ok).toBe(true);
  });
});

describe("placement gate — exec", () => {
  it("refuses at ADMISSION, before the command can queue", async () => {
    let held = true;
    const { broker, audits } = makeBroker(() => (held ? { ok: true } : REVOKED));
    const opened = await openVouched(broker, carrierFor("run-admit"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    held = false;
    const result = await execVouched(broker, opened.jobId, "echo hi");
    expect(result).toMatchObject({ ok: false, reason: "placement_revoked" });
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "placement_revoked" });
  });

  it("the refusal message never names the tenant or the lease path", async () => {
    let held = true;
    const { broker } = makeBroker(() => (held ? { ok: true } : REVOKED));
    const opened = await openVouched(broker, carrierFor("run-quiet"));
    if (!opened.ok) return;
    held = false;
    const result = await execVouched(broker, opened.jobId, "echo hi");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(/\/opt\//);
      expect(result.message).toContain("fail-closed");
    }
  });
});

describe("revocation drain", () => {
  it("a MID-JOB reclaim cancels the job's running container BY NAME", async () => {
    let held = true;
    const running = new Set<string>();
    const { broker, recorded } = makeBroker(() => (held ? { ok: true } : REVOKED), running);
    const opened = await openVouched(broker, carrierFor("run-drain"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // One command runs, so the job now HAS a container on the host.
    expect((await execVouched(broker, opened.jobId, "sleep 300")).ok).toBe(true);
    const containerName = containerNameFor(opened.jobId, 0);
    expect(running.has(containerName)).toBe(true);

    // The provisioning side reclaims the host underneath the live job.
    held = false;
    const refused = await execVouched(broker, opened.jobId, "echo again");
    expect(refused).toMatchObject({ ok: false, reason: "placement_revoked" });

    // Terminating the job is not enough — the container has to be gone.
    expect(running.has(containerName)).toBe(false);
    expect(recorded).toContainEqual(["rm", "--force", containerName]);

    // The enumeration selected on the OWNERSHIP LABEL, not on a name pattern:
    // a name is not proof that this worker started the container.
    const ps = recorded.find((argv) => argv[0] === "ps");
    expect(ps).toBeDefined();
    const filter = ps?.[ps.indexOf("--filter") + 1] ?? "";
    expect(filter).toBe(`label=${SANDBOX_CONTAINER_JOB_LABEL}=${opened.jobId}`);
    // …and the name still had to match the anchored shape for this job.
    expect(isContainerNameForJob(containerName, opened.jobId)).toBe(true);
  });

  it("drains EVERY open job, not just the one that noticed", async () => {
    let held = true;
    const running = new Set<string>();
    const { broker, recorded, worker } = makeBroker(
      () => (held ? { ok: true } : REVOKED),
      running,
    );
    const first = await openVouched(broker, carrierFor("run-a"));
    const second = await openVouched(broker, carrierFor("run-b"));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    await execVouched(broker, first.jobId, "sleep 300");
    await execVouched(broker, second.jobId, "sleep 300");
    expect(running.size).toBe(2);
    const [firstContainer, secondContainer] = worker.started;

    held = false;
    await execVouched(broker, first.jobId, "echo x");

    expect(running.size).toBe(0);
    expect(recorded).toContainEqual(["rm", "--force", firstContainer]);
    expect(recorded).toContainEqual(["rm", "--force", secondContainer]);
    // The second job is closed to further commands too.
    const after = await execVouched(broker, second.jobId, "echo y");
    expect(after).toMatchObject({ ok: false, reason: "job_terminated" });
  });

  it("removes NO volume — a refusal must not become data loss", async () => {
    let held = true;
    const running = new Set<string>();
    const { broker, recorded } = makeBroker(() => (held ? { ok: true } : REVOKED), running);
    const opened = await openVouched(broker, carrierFor("run-keep"));
    if (!opened.ok) return;
    await execVouched(broker, opened.jobId, "sleep 300");
    held = false;
    await execVouched(broker, opened.jobId, "echo x");
    expect(recorded.some((argv) => argv[0] === "volume" && argv[1] === "rm")).toBe(false);
  });

  it("RETRIES a job whose earlier cancellation failed — terminated is not drained", async () => {
    // Codex round 2, finding D1. The first drain marks the job terminated and
    // its cancellation fails; a drain that skipped terminated jobs would never
    // try again, and the container would outlive the host handover.
    let held = true;
    let failNextCancel = true;
    const attempts: string[] = [];
    const broker = new ExecutionBroker({
      worker: containerStartingWorker(new Set()),
      auditSink: () => {},
      livenessProbe: async () => "alive",
      voucherVerifier: makeVerifier(),
      egressPolicyResolver: () => ({ mode: "none" }),
      docker: async () => ok(""),
      containerOps: {
        cancelJobContainers: async (jobId) => {
          attempts.push(jobId);
          if (failNextCancel) {
            failNextCancel = false;
            throw new Error("docker unreachable");
          }
          return [`cinatra-exec-${jobId}-0`];
        },
      },
      placementGuard: () => (held ? { ok: true } : REVOKED),
    });
    const opened = await openVouched(broker, carrierFor("run-retry"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await execVouched(broker, opened.jobId, "sleep 300");

    held = false;
    await execVouched(broker, opened.jobId, "echo x"); // drain 1 — cancel fails
    expect(attempts).toEqual([opened.jobId]);

    // Any later refusal drains again, and the still-retained job is retried.
    await openVouched(broker, carrierFor("run-retry-2"));
    expect(attempts).toEqual([opened.jobId, opened.jobId]);
  });

  it("a job opened DURING a drain is never inserted active", async () => {
    // Codex round 2, findings C1/D2: the drain walks the `jobs` map, and an
    // openJob still in flight is not in it yet.
    let held = true;
    const running = new Set<string>();
    const { broker } = makeBroker(() => (held ? { ok: true } : REVOKED), running);
    const opened = await openVouched(broker, carrierFor("run-inflight"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // Revoke, then open again: the final pre-insert check must catch it even
    // though the earlier checks in the same call passed.
    held = false;
    const second = await openVouched(broker, carrierFor("run-inflight-2"));
    expect(second).toMatchObject({ ok: false, reason: "placement_refused" });
    // And the first job did not survive the drain.
    expect(await execVouched(broker, opened.jobId, "echo x")).toMatchObject({
      ok: false,
    });
  });

  it("a failing container-cancel does not mask the refusal", async () => {
    let held = true;
    const broker = new ExecutionBroker({
      worker: containerStartingWorker(new Set()),
      auditSink: () => {},
      livenessProbe: async () => "alive",
      voucherVerifier: makeVerifier(),
      egressPolicyResolver: () => ({ mode: "none" }),
      docker: async () => ok(""),
      containerOps: {
        cancelJobContainers: async () => {
          throw new Error("docker unreachable");
        },
      },
      placementGuard: () => (held ? { ok: true } : REVOKED),
    });
    const opened = await openVouched(broker, carrierFor("run-cancelfail"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    held = false;
    await expect(execVouched(broker, opened.jobId, "echo x")).resolves.toMatchObject({
      ok: false,
      reason: "placement_revoked",
    });
  });
});
