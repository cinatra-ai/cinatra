import { beforeEach, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import { ExecutionBroker, toAuthzAuditEventInput, verifyServiceToken } from "../broker";
import type {
  ExecutionAuditRecord,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
} from "../types";
import type { DockerCli } from "../docker-cli";
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

function makeBroker(over: Partial<ConstructorParameters<typeof ExecutionBroker>[0]> = {}) {
  const audits: ExecutionAuditRecord[] = [];
  const worker = over.worker ?? fakeWorker();
  const broker = new ExecutionBroker({
    worker,
    auditSink: (record) => {
      audits.push(record);
    },
    livenessProbe: async () => "alive",
    egressPolicyResolver: () => ({ mode: "none" }),
    docker: fakeDocker,
    ...over,
  });
  return { broker, audits, worker: worker as ReturnType<typeof fakeWorker> };
}

beforeEach(() => {
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});

describe("openJob — carrier verification (fail-closed)", () => {
  it("opens a job for a valid carrier", async () => {
    const { broker } = makeBroker();
    const result = await broker.openJob(carrierFor());
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered carrier with carrier_bad_signature", async () => {
    const { broker } = makeBroker();
    const carrier = carrierFor();
    const [version, body] = carrier.split(".");
    const forged = `${version}.${body}.${"A".repeat(43)}`;
    const result = await broker.openJob(forged);
    expect(result).toMatchObject({ ok: false, reason: "carrier_bad_signature" });
  });

  it("rejects garbage with carrier_malformed", async () => {
    const { broker } = makeBroker();
    expect(await broker.openJob("not-a-carrier")).toMatchObject({
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
    expect(await broker.openJob(carrier)).toMatchObject({
      ok: false,
      reason: "carrier_expired",
    });
  });

  it("refuses to open a job whose run is already gone", async () => {
    const { broker } = makeBroker({ livenessProbe: async () => "gone" });
    expect(await broker.openJob(carrierFor())).toMatchObject({
      ok: false,
      reason: "run_removed",
    });
  });
});

describe("exec — per-command liveness revalidation (S1 AC6)", () => {
  it("purge mid-job fails the NEXT command closed and terminates the job", async () => {
    let live: "alive" | "gone" = "alive";
    const { broker, audits } = makeBroker({ livenessProbe: async () => live });
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");

    expect((await broker.exec(opened.jobId, "echo 1")).ok).toBe(true);
    live = "gone";
    const second = await broker.exec(opened.jobId, "echo 2");
    expect(second).toMatchObject({ ok: false, reason: "run_removed" });
    // Terminated: even after liveness recovers, the job stays dead.
    live = "alive";
    const third = await broker.exec(opened.jobId, "echo 3");
    expect(third).toMatchObject({ ok: false, reason: "job_terminated" });
    // Refusals are audited too.
    expect(audits.filter((a) => a.decision === "refused")).toHaveLength(2);
  });

  it("archive does NOT interrupt an in-flight job", async () => {
    const { broker } = makeBroker({ livenessProbe: async () => "archived" });
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect((await broker.exec(opened.jobId, "echo 1")).ok).toBe(true);
    expect((await broker.exec(opened.jobId, "echo 2")).ok).toBe(true);
  });
});

describe("exec — quotas and bounded queueing (S1 load contract)", () => {
  it("bounds concurrency per org and drains FIFO without loss", async () => {
    const worker = fakeWorker({ delayMs: 25 });
    const { broker } = makeBroker({
      worker,
      quotas: { maxConcurrentPerOrg: 2, maxGlobalConcurrent: 4, maxQueuedPerOrg: 32 },
    });
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => broker.exec(opened.jobId, `echo ${i}`)),
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const [first, second, third] = await Promise.allSettled([
      broker.exec(opened.jobId, "a"),
      broker.exec(opened.jobId, "b"),
      broker.exec(opened.jobId, "c"),
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect(await broker.exec(opened.jobId, "run forbidden thing")).toMatchObject({
      ok: false,
      reason: "command_blocked",
    });
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "command_blocked" });
  });
});

describe("audit + separated stdio retention", () => {
  it("audits EVERY executed command with policy, digest and resource fields", async () => {
    const { broker, audits } = makeBroker();
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await broker.exec(opened.jobId, "echo audited");
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await broker.exec(opened.jobId, "echo");
    expect(stdio).toHaveLength(1);
    expect(stdio[0].stdout).toBe("hello [redacted]");
    expect(stdio[0].stderr).toBe("warn");
  });

  it("maps onto the authz kernel vocabulary with actorPrincipalType model", async () => {
    const { broker, audits } = makeBroker();
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    await broker.exec(opened.jobId, "echo");
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const first = await broker.exec(opened.jobId, "dd big file");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.result.termination).toBe("disk_quota_exceeded");
    expect(await broker.exec(opened.jobId, "echo again")).toMatchObject({
      ok: false,
      reason: "job_terminated",
    });
  });

  it("terminateJobsForRun kills every job bound to the run", async () => {
    const { broker } = makeBroker();
    const a = await broker.openJob(carrierFor({ runId: "run-X" }));
    const b = await broker.openJob(carrierFor({ runId: "run-X" }));
    const c = await broker.openJob(carrierFor({ runId: "run-Y" }));
    if (!a.ok || !b.ok || !c.ok) throw new Error("open failed");
    expect(await broker.terminateJobsForRun("run-X")).toBe(2);
    expect(await broker.exec(a.jobId, "echo")).toMatchObject({ ok: false, reason: "job_terminated" });
    expect(await broker.exec(b.jobId, "echo")).toMatchObject({ ok: false, reason: "job_terminated" });
    expect((await broker.exec(c.jobId, "echo")).ok).toBe(true);
  });
});

describe("workspace keying — run-scoped persistence, job-scoped otherwise", () => {
  it("same runId shares one workspace volume; distinct runs never share", async () => {
    const worker = fakeWorker();
    const { broker } = makeBroker({ worker });
    const a = await broker.openJob(carrierFor({ runId: "run-share" }));
    const b = await broker.openJob(carrierFor({ runId: "run-share" }));
    const c = await broker.openJob(carrierFor({ runId: "run-other" }));
    if (!a.ok || !b.ok || !c.ok) throw new Error("open failed");
    await broker.exec(a.jobId, "1");
    await broker.exec(b.jobId, "2");
    await broker.exec(c.jobId, "3");
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect((await broker.exec(opened.jobId, "pip install x")).ok).toBe(true);
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await broker.exec(opened.jobId, "curl example.com");
    expect(result).toMatchObject({ ok: false, reason: "egress_unavailable" });
    // The worker was never invoked — no unattributed egress could occur.
    expect(worker.specs).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "egress_unavailable" });
  });

  it("a throwing egress policy resolver is audited + refused, not leaked", async () => {
    const worker = fakeWorker();
    const { broker, audits } = makeBroker({
      worker,
      egressPolicyResolver: () => {
        throw new Error("policy store down");
      },
    });
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await broker.exec(opened.jobId, "echo");
    expect(result).toMatchObject({ ok: false, reason: "egress_unavailable" });
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "egress_unavailable" });
    // The semaphore permit was released — a subsequent command still runs once
    // the resolver recovers is out of scope, but the broker must not be wedged:
    expect(broker.executingCount).toBe(0);
  });

  it("a gateway-mode policy with no gateway configured is refused egress_unavailable", async () => {
    const worker = fakeWorker();
    const { broker } = makeBroker({
      worker,
      egressPolicyResolver: () => ({ mode: "default_internet" }),
      // no gateway configured
    });
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    expect(await broker.exec(opened.jobId, "curl x")).toMatchObject({
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    const result = await broker.exec(opened.jobId, "echo");
    expect(result).toMatchObject({ ok: false, reason: "worker_error" });
    expect(audits.at(-1)).toMatchObject({ decision: "refused", reason: "worker_error" });
  });
});

describe("open-job ceiling (carrier-replay volume bound)", () => {
  it("refuses opening beyond the per-org open-job ceiling", async () => {
    const { broker } = makeBroker({ quotas: { maxOpenJobsPerOrg: 2 } });
    const a = await broker.openJob(carrierFor({ runId: "r1" }));
    const b = await broker.openJob(carrierFor({ runId: "r2" }));
    const c = await broker.openJob(carrierFor({ runId: "r3" }));
    expect(a.ok && b.ok).toBe(true);
    expect(c).toMatchObject({ ok: false, reason: "open_jobs_exhausted" });
    // Closing one frees a slot.
    if (a.ok) await broker.closeJob(a.jobId);
    expect((await broker.openJob(carrierFor({ runId: "r4" }))).ok).toBe(true);
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
      Array.from({ length: 10 }, (_, i) => broker.openJob(carrierFor({ runId: `burst-${i}` }))),
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
    const opened = await broker.openJob(carrierFor());
    if (!opened.ok) throw new Error("open failed");
    // First occupies the single concurrency slot; second queues behind it.
    const first = broker.exec(opened.jobId, "one");
    const second = broker.exec(opened.jobId, "two");
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
    const opened = await broker.openJob(carrierFor(), { environment: env });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await broker.exec(opened.jobId, "echo one");
    await broker.exec(opened.jobId, "echo two");
    expect(worker.specs).toHaveLength(2);
    expect(worker.specs[0].environment).toEqual(env);
    expect(worker.specs[1].environment).toEqual(env);
  });

  it("omits environment when the job declares none (byte-identical S1/S2 spec)", async () => {
    const { broker, worker } = makeBroker();
    const opened = await broker.openJob(carrierFor());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await broker.exec(opened.jobId, "echo hi");
    expect(worker.specs[0].environment).toBeUndefined();
  });

  it("maps a worker EnvironmentMountRefusedError to an audited environment_untrusted refusal", async () => {
    const throwingWorker: SandboxWorker = {
      async runCommand() {
        throw new EnvironmentMountRefusedError("unverifiable_provenance");
      },
    };
    const { broker, audits } = makeBroker({ worker: throwingWorker });
    const opened = await broker.openJob(carrierFor(), { environment: environmentMount() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await broker.exec(opened.jobId, "echo hi");
    expect(result).toMatchObject({ ok: false, reason: "environment_untrusted" });
    const refusal = audits.find(
      (a) => a.decision === "refused" && a.reason === "environment_untrusted",
    );
    expect(refusal).toBeTruthy();
  });
});
