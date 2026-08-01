import { beforeEach, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import { ExecutionBroker, toAuthzAuditEventInput, verifyServiceToken } from "../broker";
import type {
  EgressPolicy,
  ExecutionAuditRecord,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
} from "../types";
import type { DockerCli } from "../docker-cli";
import { workspaceVolumeName } from "../workspace";
import {
  EnvironmentMountRefusedError,
  type ResolvedEnvironmentMount,
} from "../environment/mount";
import { signEnvironmentProvenance } from "../environment/provenance";
import {
  computeEnvironmentRecipeKey,
  ENVIRONMENT_BUILDER_VERSION,
  type EnvironmentBuildRecipe,
} from "../environment/recipe";
import {
  execVouched,
  makeVerifier,
  openVouched,
  rememberBrokerPolicy,
} from "./support/voucher-fixture";

const SECRET = "unit-test-broker-secret";

function carrierFor(over: Partial<{ orgId: string; userId: string; runId: string }> = {}): string {
  const session = mintExecutionSession({
    orgId: over.orgId ?? "org-1",
    userId: over.userId ?? "user-1",
    surface: "agent_run",
    runId: over.runId ?? "run-1",
  });
  return sealExecutionSession(session, { secret: SECRET });
}

/** A fake worker that records specs and resolves after an optional delay. */
function fakeWorker(opts?: {
  delayMs?: number;
  result?: Partial<SandboxCommandResult>;
  onRun?: (spec: SandboxCommandSpec) => void;
}): SandboxWorker & { specs: SandboxCommandSpec[]; concurrentPeak: number } {
  let inFlight = 0;
  const state = {
    specs: [] as SandboxCommandSpec[],
    concurrentPeak: 0,
    async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
      state.specs.push(spec);
      opts?.onRun?.(spec);
      inFlight += 1;
      state.concurrentPeak = Math.max(state.concurrentPeak, inFlight);
      if (opts?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      inFlight -= 1;
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
        ...opts?.result,
      };
    },
  };
  return state;
}

/** Docker seam that pretends volume ops succeed (no docker in unit tests). */
const fakeDocker: DockerCli = async (args) => ({
  exitCode: 0,
  stdout: args[0] === "volume" && args[1] === "create" ? args[args.length - 1] : "",
  stderr: "",
  stdioOverflow: false,
  timedOut: false,
});

/** Same seam, but every argv is recorded — used to observe volume removals. */
function recordingDocker(): DockerCli & { argv: string[][] } {
  const argv: string[][] = [];
  const cli = (async (args: string[]) => {
    argv.push([...args]);
    return fakeDocker(args);
  }) as DockerCli & { argv: string[][] };
  cli.argv = argv;
  return cli;
}

/** Volume names this docker seam was asked to `volume rm`. */
function removedVolumes(cli: { argv: string[][] }): string[] {
  return cli.argv
    .filter((args) => args[0] === "volume" && args[1] === "rm")
    .map((args) => args[args.length - 1]);
}

/**
 * A worker whose commands BLOCK until released — the only way to hold a
 * concurrency permit open long enough for a second command to be observably
 * PARKED in the admission queue.
 */
function blockingWorker(): SandboxWorker & {
  specs: SandboxCommandSpec[];
  release: () => void;
  started: () => Promise<void>;
} {
  let releaseAll: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  let announceStart: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  const specs: SandboxCommandSpec[] = [];
  return {
    specs,
    release: () => releaseAll(),
    started: () => firstStarted,
    async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
      specs.push(spec);
      announceStart();
      await gate;
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
}

function makeBroker(over: Partial<ConstructorParameters<typeof ExecutionBroker>[0]> = {}) {
  const audits: ExecutionAuditRecord[] = [];
  const worker = over.worker ?? fakeWorker();
  const broker = new ExecutionBroker({
    worker,
    auditSink: (record) => {
      audits.push(record);
    },
    livenessProbe: async () => "alive",
    voucherVerifier: makeVerifier(),
    egressPolicyResolver: () => ({ mode: "none" }),
    docker: fakeDocker,
    ...over,
  });
  // The signed voucher — not the resolver — now carries the egress policy the
  // command runs under. Mint this suite's vouchers with the tier the fixture was
  // configured with, so every existing assertion keeps testing the same tier
  // through the new (signed) path. A resolver that THROWS is only reachable on the
  // pre-voucher audit fallback now, so `none` is the right voucher tier there.
  let voucherPolicy: EgressPolicy = { mode: "none" };
  try {
    voucherPolicy = (over.egressPolicyResolver ?? (() => ({ mode: "none" }) as EgressPolicy))(
      { orgId: "org-1", userId: "user-1", surface: "agent_run" },
    );
  } catch {
    voucherPolicy = { mode: "none" };
  }
  rememberBrokerPolicy(broker, voucherPolicy);
  return { broker, audits, worker: worker as ReturnType<typeof fakeWorker> };
}

beforeEach(() => {
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});

describe("openJob — carrier verification (fail-closed)", () => {
  it("opens a job for a valid carrier", async () => {
    const { broker } = makeBroker();
    const result = await openVouched(broker, carrierFor());
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered carrier with carrier_bad_signature", async () => {
    const { broker } = makeBroker();
    const carrier = carrierFor();
    const [version, body] = carrier.split(".");
    const forged = `${version}.${body}.${"A".repeat(43)}`;
    const result = await openVouched(broker, forged);
    expect(result).toMatchObject({ ok: false, reason: "carrier_bad_signature" });
  });

  it("rejects garbage with carrier_malformed", async () => {
    const { broker } = makeBroker();
    expect(await openVouched(broker, "not-a-carrier")).toMatchObject({
      ok: false,
      reason: "carrier_malformed",
    });
  });

  it("rejects an expired carrier with carrier_expired", async () => {
    const session = mintExecutionSession({
      orgId: "org-1",
      userId: "user-1",
      surface: "chat",
    });
    const carrier = sealExecutionSession(session, {
      secret: SECRET,
      nowMs: 1_000,
      ttlMs: 10,
    });
    const { broker } = makeBroker({ nowMs: () => 10_000 });
    expect(await openVouched(broker, carrier)).toMatchObject({
      ok: false,
      reason: "carrier_expired",
    });
  });

  it("refuses to open a job whose run is already gone", async () => {
    const { broker } = makeBroker({ livenessProbe: async () => "gone" });
    expect(await openVouched(broker, carrierFor())).toMatchObject({
      ok: false,
      reason: "run_removed",
    });
  });
});

describe("exec — per-command liveness revalidation (S1 AC6)", () => {
  it("purge mid-job fails the NEXT command closed and terminates the job", async () => {
    let live: "alive" | "gone" = "alive";
    const { broker, audits } = makeBroker({ livenessProbe: async () => live });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");

    expect((await execVouched(broker, opened.jobId, "echo 1")).ok).toBe(true);
    live = "gone";
    const second = await execVouched(broker, opened.jobId, "echo 2");
    expect(second).toMatchObject({ ok: false, reason: "run_removed" });
    // Terminated: even after liveness recovers, the job stays dead.
    live = "alive";
    const third = await execVouched(broker, opened.jobId, "echo 3");
    expect(third).toMatchObject({ ok: false, reason: "job_terminated" });
    // Refusals are audited too.
    expect(audits.filter((a) => a.decision === "refused")).toHaveLength(2);
  });

  it("archive does NOT interrupt an in-flight job", async () => {
    const { broker } = makeBroker({ livenessProbe: async () => "archived" });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect((await execVouched(broker, opened.jobId, "echo 1")).ok).toBe(true);
    expect((await execVouched(broker, opened.jobId, "echo 2")).ok).toBe(true);
  });
});

describe("exec — quotas and bounded queueing (S1 load contract)", () => {
  it("bounds concurrency per org and drains FIFO without loss", async () => {
    const worker = fakeWorker({ delayMs: 25 });
    const { broker } = makeBroker({
      worker,
      quotas: { maxConcurrentPerOrg: 2, maxGlobalConcurrent: 4, maxQueuedPerOrg: 32 },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => execVouched(broker, opened.jobId, `echo ${i}`)),
    );
    expect(burst.every((r) => r.ok)).toBe(true);
    expect(worker.concurrentPeak).toBeLessThanOrEqual(2);
    expect(worker.specs).toHaveLength(10);
  });

  it("rejects beyond the per-org queue ceiling with queue_saturated", async () => {
    const worker = fakeWorker({ delayMs: 50 });
    const { broker } = makeBroker({
      worker,
      quotas: { maxConcurrentPerOrg: 1, maxGlobalConcurrent: 4, maxQueuedPerOrg: 1 },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const [first, second, third] = await Promise.allSettled([
      execVouched(broker, opened.jobId, "a"),
      execVouched(broker, opened.jobId, "b"),
      execVouched(broker, opened.jobId, "c"),
    ]).then((settled) =>
      settled.map((s) => (s.status === "fulfilled" ? s.value : null)),
    );
    const okCount = [first, second, third].filter((r) => r?.ok).length;
    const saturated = [first, second, third].filter(
      (r) => r && !r.ok && r.reason === "queue_saturated",
    );
    expect(okCount).toBe(2);
    expect(saturated).toHaveLength(1);
  });
});

describe("exec — command hygiene hook (never the boundary)", () => {
  it("refuses a blocked command with command_blocked", async () => {
    const { broker, audits } = makeBroker({
      commandPolicy: (_session, command) =>
        command.includes("forbidden")
          ? { allowed: false, reason: "blocked by hygiene list" }
          : { allowed: true },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect(await execVouched(broker, opened.jobId, "run forbidden thing")).toMatchObject({
      ok: false,
      reason: "command_blocked",
    });
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "command_blocked" });
  });
});

describe("audit + separated stdio retention", () => {
  it("audits EVERY executed command with policy, digest and resource fields", async () => {
    const { broker, audits } = makeBroker();
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await execVouched(broker, opened.jobId, "echo audited");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      runId: "run-1",
      command: "echo audited",
      cwd: "/workspace",
      decision: "executed",
      exitCode: 0,
      imageDigest: "sha256:test",
      effectivePolicy: { egressMode: "none" },
    });
    // stdout/stderr are NOT in the audit record.
    expect(JSON.stringify(audits[0])).not.toContain('"stdout"');
  });

  it("routes stdout/stderr through the redactor to the separate stdio sink", async () => {
    const stdio: Array<{ jobId: string; seq: number; stdout: string; stderr: string }> = [];
    const { broker } = makeBroker({
      worker: fakeWorker({ result: { stdout: "hello token-xyz", stderr: "warn" } }),
      stdioSink: (entry) => {
        stdio.push(entry);
      },
      stdioRedactor: (text) => text.replace("token-xyz", "[redacted]"),
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await execVouched(broker, opened.jobId, "echo");
    expect(stdio).toHaveLength(1);
    expect(stdio[0].stdout).toBe("hello [redacted]");
    expect(stdio[0].stderr).toBe("warn");
  });

  it("maps onto the authz kernel vocabulary with actorPrincipalType model", async () => {
    const { broker, audits } = makeBroker();
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await execVouched(broker, opened.jobId, "echo");
    const mapped = toAuthzAuditEventInput(audits[0]);
    expect(mapped).toMatchObject({
      organizationId: "org-1",
      actorPrincipalType: "model",
      authSource: "agent",
      resourceType: "execution_sandbox",
      operation: "sandbox_execute",
      decision: "allowed",
      runId: "run-1",
    });
  });
});

describe("disk-quota termination + teardown hook", () => {
  it("a disk_quota_exceeded result terminates the job (no further commands)", async () => {
    const { broker } = makeBroker({
      worker: fakeWorker({ result: { termination: "disk_quota_exceeded", workspaceKb: 999_999 } }),
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const first = await execVouched(broker, opened.jobId, "dd big file");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.result.termination).toBe("disk_quota_exceeded");
    expect(await execVouched(broker, opened.jobId, "echo again")).toMatchObject({
      ok: false,
      reason: "job_terminated",
    });
  });

  it("terminateJobsForRun kills every job bound to the run", async () => {
    const { broker } = makeBroker();
    const a = await openVouched(broker, carrierFor({ runId: "run-X" }));
    const b = await openVouched(broker, carrierFor({ runId: "run-X" }));
    const c = await openVouched(broker, carrierFor({ runId: "run-Y" }));
    if (!a.ok || !b.ok || !c.ok) throw new Error("open failed");
    expect(await broker.terminateJobsForRun("run-X")).toBe(2);
    expect(await execVouched(broker, a.jobId, "echo")).toMatchObject({ ok: false, reason: "job_terminated" });
    expect(await execVouched(broker, b.jobId, "echo")).toMatchObject({ ok: false, reason: "job_terminated" });
    expect((await execVouched(broker, c.jobId, "echo")).ok).toBe(true);
  });
});

/**
 * Hard-removal lifecycle battery (epic #1705 AC9).
 *
 * The AC asks for three observable duties, and the two that were MISSING are
 * asserted here against the broker's own dispatch counts and volume ops — never
 * against reference counts:
 *   - a QUEUED-NOT-STARTED command is CANCELLED (it resolves without the
 *     blocking command ever being released, and never reaches the worker);
 *   - a RETAINED workspace — one whose jobs are all closed, which `closeJob`
 *     deliberately leaves for the retention GC — is collected NOW.
 */
describe("hard-removal teardown — cancel queued work + GC retained workspaces (AC9)", () => {
  /** Fail loudly instead of hanging when a cancellation regresses. */
  async function withDeadline<T>(p: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} did not settle — it was never cancelled`)),
            2_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it("cancels a command parked in the admission queue — it never dispatches", async () => {
    const worker = blockingWorker();
    const { broker } = makeBroker({
      worker,
      quotas: { maxConcurrentPerOrg: 1, maxGlobalConcurrent: 4, maxQueuedPerOrg: 8 },
    });
    const holder = await openVouched(broker, carrierFor({ runId: "run-cancel" }));
    const parked = await openVouched(broker, carrierFor({ runId: "run-cancel" }));
    if (!holder.ok || !parked.ok) throw new Error("open failed");

    // Occupy the org's only concurrency permit with a command that never returns.
    const holding = execVouched(broker, holder.jobId, "hold the permit");
    await worker.started();
    // This one cannot be admitted: it parks in the org admission queue.
    const queued = execVouched(broker, parked.jobId, "must never run");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worker.specs).toHaveLength(1);

    // Hard removal. The blocking command is NEVER released — so the queued
    // command can only settle by being cancelled, not by winning a permit.
    expect(await broker.terminateJobsForRun("run-cancel", { removeWorkspace: true })).toBe(2);
    expect(await withDeadline(queued, "the queued command")).toMatchObject({
      ok: false,
      reason: "job_terminated",
    });
    // Dispatch count is the proof it never ran: still just the holder's command.
    expect(worker.specs).toHaveLength(1);
    expect(worker.specs[0].command).toBe("hold the permit");

    worker.release();
    await holding;
  });

  it("releases the org permit when the GLOBAL wait is cancelled (no leak)", async () => {
    const worker = blockingWorker();
    const { broker } = makeBroker({
      worker,
      quotas: { maxConcurrentPerOrg: 1, maxGlobalConcurrent: 1, maxQueuedPerOrg: 8 },
    });
    const other = await openVouched(
      broker,
      carrierFor({ orgId: "org-holder", runId: "run-holder" }),
    );
    const victim = await openVouched(
      broker,
      carrierFor({ orgId: "org-victim", runId: "run-victim" }),
    );
    if (!other.ok || !victim.ok) throw new Error("open failed");

    const holding = execVouched(broker, other.jobId, "hold the global permit");
    await worker.started();
    // org-victim's own permit is FREE, so this acquires it and then parks on the
    // GLOBAL semaphore — the arm where a cancellation must hand the org permit
    // back explicitly (the `finally` cannot: `permitsHeld` is still false).
    const queued = execVouched(broker, victim.jobId, "must never run");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await broker.terminateJobsForRun("run-victim")).toBe(1);
    expect(await withDeadline(queued, "the globally-queued command")).toMatchObject({
      ok: false,
      reason: "job_terminated",
    });
    expect(worker.specs).toHaveLength(1);

    worker.release();
    await holding;
    // org-victim's single permit must be usable again: a leaked one would park
    // this command forever and trip the deadline.
    const fresh = await openVouched(
      broker,
      carrierFor({ orgId: "org-victim", runId: "run-victim-2" }),
    );
    if (!fresh.ok) throw new Error("open failed");
    expect(
      await withDeadline(execVouched(broker, fresh.jobId, "echo"), "the follow-up command"),
    ).toMatchObject({ ok: true });
  });

  it("collects a RETAINED run workspace even when no job is open any more", async () => {
    const docker = recordingDocker();
    const { broker } = makeBroker({ docker });
    const opened = await openVouched(broker, carrierFor({ runId: "run-retained" }));
    if (!opened.ok) throw new Error("open failed");
    // `closeJob` without `removeWorkspace` is the RETAINED case: the run-keyed
    // L2 volume is deliberately left behind for the retention GC.
    await broker.closeJob(opened.jobId);
    expect(removedVolumes(docker)).not.toContain(workspaceVolumeName("run-retained"));

    // No job matches any more — the pre-existing loop would sweep nothing.
    expect(await broker.terminateJobsForRun("run-retained", { removeWorkspace: true })).toBe(0);
    expect(removedVolumes(docker)).toContain(workspaceVolumeName("run-retained"));
  });

  it("removes the run workspace exactly once per fire and RETRIES on a re-fire", async () => {
    const docker = recordingDocker();
    const { broker } = makeBroker({ docker });
    const a = await openVouched(broker, carrierFor({ runId: "run-once" }));
    const b = await openVouched(broker, carrierFor({ runId: "run-once" }));
    if (!a.ok || !b.ok) throw new Error("open failed");

    // Two jobs, ONE shared run-keyed volume ⇒ one removal, not two.
    expect(await broker.terminateJobsForRun("run-once", { removeWorkspace: true })).toBe(2);
    const volume = workspaceVolumeName("run-once");
    expect(removedVolumes(docker).filter((name) => name === volume)).toHaveLength(1);

    // A re-fire terminates nothing new (idempotent) but RE-ATTEMPTS the removal:
    // the first attempt may have failed while a container still held the volume.
    expect(await broker.terminateJobsForRun("run-once", { removeWorkspace: true })).toBe(0);
    expect(removedVolumes(docker).filter((name) => name === volume)).toHaveLength(2);
  });
});

describe("workspace keying — run-scoped persistence, job-scoped otherwise", () => {
  it("same runId shares one workspace volume; distinct runs never share", async () => {
    const worker = fakeWorker();
    const { broker } = makeBroker({ worker });
    const a = await openVouched(broker, carrierFor({ runId: "run-share" }));
    const b = await openVouched(broker, carrierFor({ runId: "run-share" }));
    const c = await openVouched(broker, carrierFor({ runId: "run-other" }));
    if (!a.ok || !b.ok || !c.ok) throw new Error("open failed");
    await execVouched(broker, a.jobId, "1");
    await execVouched(broker, b.jobId, "2");
    await execVouched(broker, c.jobId, "3");
    const volumes = worker.specs.map((s) => s.workspaceVolume);
    expect(volumes[0]).toBe(volumes[1]);
    expect(volumes[2]).not.toBe(volumes[0]);
  });
});

describe("gateway egress registration (fail-closed, unforgeable attribution)", () => {
  const gatewayEndpoint = {
    host: "cinatra-exec-gateway",
    port: 3128,
    adminUrl: "http://127.0.0.1:19129",
    controlSecret: "ctrl",
  };

  it("registers the per-job token + policy at the gateway BEFORE dispatch", async () => {
    const registrations: Array<{ url: string; body: unknown; header: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      registrations.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        header: (init?.headers as Record<string, string>)["x-egress-control"],
      });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch;
    const worker = fakeWorker();
    const { broker } = makeBroker({
      worker,
      egressPolicyResolver: () => ({ mode: "allowlist", allowlist: ["pypi.org"] }),
      gateway: gatewayEndpoint,
      fetchImpl,
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect((await execVouched(broker, opened.jobId, "pip install x")).ok).toBe(true);
    expect(registrations).toHaveLength(1);
    expect(registrations[0].url).toContain("/__register");
    expect(registrations[0].header).toBe("ctrl");
    expect(registrations[0].body).toMatchObject({ mode: "allowlist", allowlist: ["pypi.org"] });
    // The registered token equals the token the worker was handed.
    if (worker.specs[0].egress.kind === "gateway") {
      expect((registrations[0].body as { token: string }).token).toBe(
        worker.specs[0].egress.jobToken,
      );
    }
  });

  it("refuses the command when gateway registration fails (never dispatches)", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch;
    const worker = fakeWorker();
    const { broker, audits } = makeBroker({
      worker,
      egressPolicyResolver: () => ({ mode: "default_internet" }),
      gateway: gatewayEndpoint,
      fetchImpl,
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await execVouched(broker, opened.jobId, "curl example.com");
    expect(result).toMatchObject({ ok: false, reason: "egress_unavailable" });
    // The worker was never invoked — no unattributed egress could occur.
    expect(worker.specs).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "egress_unavailable" });
  });

  it("a throwing egress policy resolver can no longer decide a command's egress", async () => {
    // The dispatch policy is the SIGNED one (clamped). The resolver survives only
    // as the audit-row fallback for refusals that happen before any voucher is
    // verified — so a throwing resolver must neither refuse a properly authorized
    // command nor leak out of the pre-voucher audit path.
    const worker = fakeWorker();
    const { broker, audits } = makeBroker({
      worker,
      egressPolicyResolver: () => {
        throw new Error("policy store down");
      },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await execVouched(broker, opened.jobId, "echo");
    expect(result.ok).toBe(true);
    expect(audits.at(-1)).toMatchObject({ decision: "executed" });
    expect(broker.executingCount).toBe(0);

    // ...and a PRE-voucher refusal (no signed policy to report) still returns its
    // structured refusal instead of throwing out of the audit fallback.
    const missing = await broker.exec(opened.jobId, "echo", "");
    expect(missing).toMatchObject({ ok: false, reason: "voucher_missing" });
    expect(audits.at(-1)).toMatchObject({
      decision: "refused",
      reason: "voucher_missing",
      effectivePolicy: { egressMode: "none" },
    });
  });

  it("a gateway-mode policy with no gateway configured is refused egress_unavailable", async () => {
    const worker = fakeWorker();
    const { broker } = makeBroker({
      worker,
      egressPolicyResolver: () => ({ mode: "default_internet" }),
      // no gateway configured
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect(await execVouched(broker, opened.jobId, "curl x")).toMatchObject({
      ok: false,
      reason: "egress_unavailable",
    });
    expect(worker.specs).toHaveLength(0);
  });

  it("a worker dispatch failure is audited + refused, never thrown into the caller", async () => {
    const throwingWorker = {
      specs: [],
      concurrentPeak: 0,
      runCommand: async () => {
        throw new Error("docker daemon unreachable");
      },
    };
    const { broker, audits } = makeBroker({
      worker: throwingWorker as unknown as ReturnType<typeof fakeWorker>,
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await execVouched(broker, opened.jobId, "echo");
    expect(result).toMatchObject({ ok: false, reason: "worker_error" });
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "worker_error" });
  });
});

describe("open-job ceiling (carrier-replay volume bound)", () => {
  it("refuses opening beyond the per-org open-job ceiling", async () => {
    const { broker } = makeBroker({ quotas: { maxOpenJobsPerOrg: 2 } });
    const a = await openVouched(broker, carrierFor({ runId: "r1" }));
    const b = await openVouched(broker, carrierFor({ runId: "r2" }));
    const c = await openVouched(broker, carrierFor({ runId: "r3" }));
    expect(a.ok && b.ok).toBe(true);
    expect(c).toMatchObject({ ok: false, reason: "open_jobs_exhausted" });
    // Closing one frees a slot.
    if (a.ok) await broker.closeJob(a.jobId);
    expect((await openVouched(broker, carrierFor({ runId: "r4" }))).ok).toBe(true);
  });

  it("the ceiling holds under a concurrent openJob burst (no race past it)", async () => {
    // A docker seam that yields the event loop before resolving, so all the
    // openJob() calls interleave across the async volume-create await.
    const slowDocker = (async (args: string[]) => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        exitCode: 0,
        stdout: args[0] === "volume" && args[1] === "create" ? args[args.length - 1] : "",
        stderr: "",
        stdioOverflow: false,
        timedOut: false,
      };
    }) as typeof fakeDocker;
    const { broker } = makeBroker({ quotas: { maxOpenJobsPerOrg: 3 }, docker: slowDocker });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => openVouched(broker, carrierFor({ runId: `burst-${i}` }))),
    );
    const opened = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok && r.reason === "open_jobs_exhausted");
    expect(opened).toHaveLength(3);
    expect(refused).toHaveLength(7);
  });
});

describe("post-queue re-authorization", () => {
  it("a job purged while queued does not execute", async () => {
    let live: "alive" | "gone" = "alive";
    const worker = fakeWorker({ delayMs: 40 });
    const { broker } = makeBroker({
      worker,
      livenessProbe: async () => live,
      quotas: { maxConcurrentPerOrg: 1, maxGlobalConcurrent: 1, maxQueuedPerOrg: 8 },
    });
    const opened = await openVouched(broker, carrierFor());
    if (!opened.ok) throw new Error("open failed");
    // First occupies the single concurrency slot; second queues behind it.
    const first = execVouched(broker, opened.jobId, "one");
    const second = execVouched(broker, opened.jobId, "two");
    // Purge while the second is queued.
    live = "gone";
    const [r1, r2] = await Promise.all([first, second]);
    // One of them ran before the purge; the other is refused run_removed.
    const reasons = [r1, r2].map((r) => (r.ok ? "ok" : r.reason));
    expect(reasons).toContain("run_removed");
  });
});

describe("verifyServiceToken (broker service boundary seam)", () => {
  it("accepts only the exact configured token, timing-safe", () => {
    expect(verifyServiceToken("tok", "tok")).toBe(true);
    expect(verifyServiceToken("tok", "other")).toBe(false);
    expect(verifyServiceToken("", "")).toBe(false);
    expect(verifyServiceToken(undefined, "tok")).toBe(false);
    expect(verifyServiceToken("tok", undefined)).toBe(false);
  });
});

function environmentMount(key = "prov-key"): ResolvedEnvironmentMount {
  const recipe: EnvironmentBuildRecipe = {
    spec: { pip: ["pandas"] },
    l0BaseDigest: "sha256:l0base",
    builderVersion: ENVIRONMENT_BUILDER_VERSION,
    platform: { os: "linux", arch: "arm64" },
    buildPolicy: { networkPolicy: "registry-allowlist", registryAllowlist: ["pypi.org"] },
    resolvedArtifacts: { pip: { resolved: "sha256:pinned", integrity: "sha256:pinned-int" } },
  };
  const recipeKey = computeEnvironmentRecipeKey(recipe);
  return {
    imageRef: `cinatra-sandbox-l1:${recipeKey}`,
    provenance: signEnvironmentProvenance(
      {
        recipeKey,
        recipe,
        imageDigest: "sha256:l1digest",
        partition: "instance",
        builderIdentity: ENVIRONMENT_BUILDER_VERSION,
        builtAtMs: 1,
      },
      key,
    ),
  };
}

describe("openJob — L1 environment mount (exec-plane S3)", () => {
  it("threads the resolved environment onto EVERY command spec", async () => {
    const { broker, worker } = makeBroker();
    const env = environmentMount();
    const opened = await openVouched(broker, carrierFor(), { environment: env });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await execVouched(broker, opened.jobId, "echo one");
    await execVouched(broker, opened.jobId, "echo two");
    expect(worker.specs).toHaveLength(2);
    expect(worker.specs[0].environment).toEqual(env);
    expect(worker.specs[1].environment).toEqual(env);
  });

  it("omits environment when the job declares none (byte-identical S1/S2 spec)", async () => {
    const { broker, worker } = makeBroker();
    const opened = await openVouched(broker, carrierFor());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await execVouched(broker, opened.jobId, "echo hi");
    expect(worker.specs[0].environment).toBeUndefined();
  });

  it("maps a worker EnvironmentMountRefusedError to an audited environment_untrusted refusal", async () => {
    const throwingWorker: SandboxWorker = {
      async runCommand() {
        throw new EnvironmentMountRefusedError("unverifiable_provenance");
      },
    };
    const { broker, audits } = makeBroker({ worker: throwingWorker });
    const opened = await openVouched(broker, carrierFor(), { environment: environmentMount() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await execVouched(broker, opened.jobId, "echo hi");
    expect(result).toMatchObject({ ok: false, reason: "environment_untrusted" });
    const refusal = audits.find(
      (a) => a.decision === "refused" && a.reason === "environment_untrusted",
    );
    expect(refusal).toBeTruthy();
  });
});
