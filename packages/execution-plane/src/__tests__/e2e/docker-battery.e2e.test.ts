/**
 * Docker E2E battery (exec-plane S1, cinatra#1706 — issue ACs 1/3/4/6 + the
 * epic security battery). REAL containers over the L0 image, REAL volumes,
 * REAL network enforcement through the internal network + gateway container —
 * no stubs anywhere. The battery FAILS when docker is unavailable (a green run
 * always means the real thing ran).
 *
 * Run with: pnpm test:e2e   (package: @cinatra-ai/execution-plane)
 * First run builds docker/sandbox/Dockerfile as cinatra-sandbox-l0:dev.
 * The gateway scenarios exercise real internet egress (pypi.org).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
  buildSandboxExecutionTool,
} from "@cinatra-ai/llm/execution-plane";

import { ExecutionBroker } from "../../broker";
import { createBrokerSandboxExecutor } from "../../executor";
import { LocalDevSandboxWorker } from "../../worker";
import { startLocalGateway, type LocalGateway } from "../../local-gateway";
import { DEFAULT_SANDBOX_NETWORK } from "../../egress";
import { runDocker } from "../../docker-cli";
import { workspaceVolumeName } from "../../workspace";
import { skillsVolumeName } from "../../staging";
import {
  type EgressGatewayEndpoint,
  type EgressPolicy,
  type ExecutionAuditRecord,
  type SandboxResourceLimits,
} from "../../types";

const SECRET = "e2e-battery-broker-secret";
const IMAGE = "cinatra-sandbox-l0:dev";
const ADMIN_PORT = 13129;
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const RUN_PREFIX = `e2e-${Date.now()}`;

const createdRunKeys: string[] = [];
/** Job ids whose per-job skills volumes need cleanup (S2 staging tests). */
const createdJobIds: string[] = [];
let gateway: LocalGateway | null = null;

function carrierFor(runKey: string): string {
  createdRunKeys.push(runKey);
  return sealExecutionSession(
    mintExecutionSession({
      orgId: "org-e2e",
      userId: "user-e2e",
      surface: "agent_run",
      runId: runKey,
    }),
    { secret: SECRET },
  );
}

type LiveBroker = {
  broker: ExecutionBroker;
  audits: ExecutionAuditRecord[];
  setLiveness: (v: "alive" | "archived" | "gone") => void;
};

function makeLiveBroker(opts: {
  policy: EgressPolicy;
  gatewayEndpoint?: EgressGatewayEndpoint;
  limits?: Partial<SandboxResourceLimits>;
}): LiveBroker {
  const audits: ExecutionAuditRecord[] = [];
  let liveness: "alive" | "archived" | "gone" = "alive";
  const broker = new ExecutionBroker({
    worker: new LocalDevSandboxWorker({ imageRef: IMAGE }),
    auditSink: (record) => {
      audits.push(record);
    },
    livenessProbe: async () => liveness,
    egressPolicyResolver: () => opts.policy,
    gateway: opts.gatewayEndpoint,
    sandboxNetwork: DEFAULT_SANDBOX_NETWORK,
    limits: opts.limits,
  });
  return {
    broker,
    audits,
    setLiveness: (v) => {
      liveness = v;
    },
  };
}

async function openOrThrow(broker: ExecutionBroker, runKey: string): Promise<string> {
  const opened = await broker.openJob(carrierFor(runKey));
  if (!opened.ok) throw new Error(`openJob failed: ${opened.reason}`);
  return opened.jobId;
}

beforeAll(async () => {
  process.env.EXECUTION_BROKER_SECRET = SECRET;
  // Docker must be present — the battery never skips (no stub-smoke).
  execFileSync("docker", ["info"], { stdio: "ignore" });
  // Build the L0 image from the in-repo Dockerfile.
  execFileSync("docker", ["build", "-t", IMAGE, "docker/sandbox"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 280_000,
  });
}, 300_000);

afterAll(async () => {
  if (gateway) await gateway.stop();
  for (const runKey of createdRunKeys) {
    await runDocker(["volume", "rm", "-f", workspaceVolumeName(runKey)]);
  }
  for (const jobId of createdJobIds) {
    await runDocker(["volume", "rm", "-f", skillsVolumeName(jobId)]);
  }
  // Executor-opened jobs mint their own jobIds — sweep remaining S2 skills
  // volumes by their retention label tier.
  const strays = await runDocker([
    "volume",
    "ls",
    "-q",
    "--filter",
    "label=ai.cinatra.execution-plane=skills",
  ]);
  for (const name of strays.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    await runDocker(["volume", "rm", "-f", name]);
  }
});

describe("AC1 — command / script / persistence, all in the plane", () => {
  it("runs a command in a real hardened container and captures stdout", async () => {
    const { broker, audits } = makeLiveBroker({ policy: { mode: "none" } });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-cmd`);
    const result = await broker.exec(jobId, "echo hello-from-the-plane");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.exitCode).toBe(0);
    expect(result.result.stdout.trim()).toBe("hello-from-the-plane");
    expect(result.result.termination).toBe("exited");
    // Audit: image digest + effective policy recorded for the command.
    expect(audits[0].imageDigest).toMatch(/(sha256:|@sha256:)/);
    expect(audits[0].effectivePolicy.egressMode).toBe("none");
  });

  it("persists files across commands within a run: write a script, then run it", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-script`);
    const write = await broker.exec(
      jobId,
      `printf 'import sys\\nprint("script-ok", sys.version_info.major)\\n' > tool.py`,
    );
    expect(write.ok).toBe(true);
    const run = await broker.exec(jobId, "python3 tool.py");
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.result.stdout.trim()).toBe("script-ok 3");
  });

  it("a fresh run NEVER sees another run's workspace (L2 isolation)", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const jobA = await openOrThrow(broker, `${RUN_PREFIX}-iso-a`);
    await broker.exec(jobA, "echo private-data > secret-file.txt");
    const jobB = await openOrThrow(broker, `${RUN_PREFIX}-iso-b`);
    const listing = await broker.exec(jobB, "ls -A");
    expect(listing.ok).toBe(true);
    if (listing.ok) {
      expect(listing.result.stdout).not.toContain("secret-file.txt");
    }
  });
});

describe("security battery — hardened-container contract (epic AC6)", () => {
  it("non-root fixed UID, read-only rootfs, zero capabilities, no-new-privileges, scrubbed env", async () => {
    // Canary: if ANY host env leaked into the sandbox this test catches it.
    process.env.CANARY_HOST_SECRET_E2E = "leaked-host-value";
    try {
      const { broker } = makeLiveBroker({ policy: { mode: "none" } });
      const jobId = await openOrThrow(broker, `${RUN_PREFIX}-hardening`);
      const probe = await broker.exec(
        jobId,
        [
          `echo "uid=$(id -u)"`,
          `touch /etc/write-probe 2>/dev/null && echo rootfs=writable || echo rootfs=readonly`,
          `echo "capeff=$(grep CapEff /proc/self/status | awk '{print $2}')"`,
          `echo "nnp=$(grep NoNewPrivs /proc/self/status | awk '{print $2}')"`,
          `echo "canary=[$CANARY_HOST_SECRET_E2E]"`,
          `echo "home=$HOME"`,
        ].join(" && "),
      );
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      const out = probe.result.stdout;
      expect(out).toContain("uid=10001");
      expect(out).toContain("rootfs=readonly");
      expect(out).toContain("capeff=0000000000000000");
      expect(out).toContain("nnp=1");
      expect(out).toContain("canary=[]");
      expect(out).toContain("home=/workspace/home");
    } finally {
      delete process.env.CANARY_HOST_SECRET_E2E;
    }
  });

  it("mount table: no host bind mounts — only the L2 volume and declared tmpfs are writable", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-mounts`);
    const mounts = await broker.exec(
      jobId,
      `awk '$4 ~ /(^|,)rw(,|$)/ {print $2}' /proc/mounts`,
    );
    expect(mounts.ok).toBe(true);
    if (!mounts.ok) return;
    const writable = mounts.result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("/proc") &&
          !line.startsWith("/sys") &&
          !line.startsWith("/dev"),
      );
    // Exactly the L2 workspace and the bounded tmpfs — nothing from the host.
    expect(writable.sort()).toEqual(["/tmp", "/workspace"].sort());
  });

  it("no runtime root path: sudo/su absent or refused (D2)", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-noroot`);
    const probe = await broker.exec(
      jobId,
      `command -v sudo || echo no-sudo; su root -c 'id' 2>&1 | head -1 || true`,
    );
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.result.stdout).toContain("no-sudo");
    expect(probe.result.stdout).not.toContain("uid=0(root)");
  });
});

describe("disk-quota enforcement (S1 AC4 — the write cap is ENFORCED)", () => {
  it("a single file is capped by the in-sandbox ulimit", async () => {
    const { broker } = makeLiveBroker({
      policy: { mode: "none" },
      limits: { workspaceQuotaKb: 2048 },
    });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-ulimit`);
    const result = await broker.exec(
      jobId,
      "dd if=/dev/zero of=big-file bs=1024 count=4096 2>&1; ls -la big-file",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The file was truncated at the 2048 KiB cap, not written to 4 MiB.
    const size = /\s(\d+)\s+\S+\s+\d+\s+[\d:]+\s+big-file/.exec(result.result.stdout);
    expect(size).not.toBeNull();
    expect(Number(size![1])).toBeLessThanOrEqual(2048 * 1024);
  });

  it("total-workspace exhaustion terminates the job; further commands are refused closed", async () => {
    const { broker } = makeLiveBroker({
      policy: { mode: "none" },
      limits: { workspaceQuotaKb: 2048 },
    });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-quota`);
    const fill = await broker.exec(
      jobId,
      "for i in $(seq 1 40); do dd if=/dev/zero of=chunk-$i bs=1024 count=100 2>/dev/null; done; du -sk .",
    );
    expect(fill.ok).toBe(true);
    if (!fill.ok) return;
    expect(fill.result.termination).toBe("disk_quota_exceeded");
    expect(fill.result.workspaceKb).toBeGreaterThan(2048);
    const next = await broker.exec(jobId, "echo should-not-run");
    expect(next).toMatchObject({ ok: false, reason: "job_terminated" });
  });
});

describe("resource ceilings — timeout and output caps", () => {
  it("a runaway command is killed at the wall-clock ceiling and the container is removed", async () => {
    const { broker } = makeLiveBroker({
      policy: { mode: "none" },
      limits: { timeoutMs: 4_000 },
    });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-timeout`);
    const result = await broker.exec(jobId, "sleep 60");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.termination).toBe("timeout");
    // Fresh-container-per-command: nothing keeps running afterwards.
    const ps = await runDocker(["ps", "--filter", "name=cinatra-exec-", "--format", "{{.Names}}"]);
    expect(ps.stdout.trim()).toBe("");
  }, 60_000);

  it("unbounded output is truncated and terminated as output_cap_exceeded", async () => {
    const { broker } = makeLiveBroker({
      policy: { mode: "none" },
      limits: { maxStdioBytes: 65_536 },
    });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-outcap`);
    const result = await broker.exec(jobId, "yes overflow | head -c 10000000");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.termination).toBe("output_cap_exceeded");
    expect(Buffer.byteLength(result.result.stdout)).toBeLessThanOrEqual(65_536);
  }, 60_000);
});

describe("egress policy — network-LAYER enforcement (S1 AC3, epic D3)", () => {
  it("mode none: the sandbox has no network at all", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-egress-none`);
    const result = await broker.exec(
      jobId,
      "curl -sS --max-time 5 https://example.com/ >/dev/null 2>&1; echo curl-exit=$?",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.stdout.trim()).not.toBe("curl-exit=0");
  }, 60_000);

  it("default-internet transits ONLY the gateway, fully attributed (pypi.org reachable; audit carries destinations)", async () => {
    gateway = await startLocalGateway(
      { mode: "default_internet" },
      { internalNetwork: DEFAULT_SANDBOX_NETWORK, adminHostPort: ADMIN_PORT, imageRef: IMAGE },
    );
    const { broker, audits } = makeLiveBroker({
      policy: { mode: "default_internet" },
      gatewayEndpoint: gateway.endpoint,
    });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-egress-gw`);
    const result = await broker.exec(
      jobId,
      `curl -s -o /dev/null -w "%{http_code}" https://pypi.org/simple/`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.stdout.trim()).toBe("200");
    // Gateway-attributed egress lands in the broker audit record.
    const audited = audits.find((a) => a.decision === "executed");
    expect(audited?.egressDestinations?.some((d) => d.host === "pypi.org" && d.allowed)).toBe(true);
    expect(audited?.egressTotalBytes ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it("pip install through the gateway, then USE the package in a later command (AC1)", async () => {
    if (!gateway) throw new Error("gateway not started");
    const { broker } = makeLiveBroker({
      policy: { mode: "default_internet" },
      gatewayEndpoint: gateway.endpoint,
    });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-pip`);
    const install = await broker.exec(
      jobId,
      "pip install --user --quiet --no-input cowsay >/dev/null 2>&1; echo pip-exit=$?",
    );
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    expect(install.result.stdout.trim()).toBe("pip-exit=0");
    const use = await broker.exec(
      jobId,
      `python3 -c "import cowsay; print('cowsay-imported-ok')"`,
    );
    expect(use.ok).toBe(true);
    if (use.ok) expect(use.result.stdout.trim()).toBe("cowsay-imported-ok");
  }, 240_000);

  it("allowlist mode: non-listed hosts are denied AND the gateway cannot be bypassed", async () => {
    if (gateway) await gateway.stop();
    gateway = await startLocalGateway(
      { mode: "allowlist", allowlist: ["pypi.org", "pythonhosted.org"] },
      { internalNetwork: DEFAULT_SANDBOX_NETWORK, adminHostPort: ADMIN_PORT, imageRef: IMAGE },
    );
    const { broker } = makeLiveBroker({
      policy: { mode: "allowlist", allowlist: ["pypi.org", "pythonhosted.org"] },
      gatewayEndpoint: gateway.endpoint,
    });
    const jobId = await openOrThrow(broker, `${RUN_PREFIX}-allowlist`);
    const denied = await broker.exec(
      jobId,
      `curl -s -o /dev/null -w "%{http_code}" --max-time 15 https://example.com/ 2>/dev/null; echo " curl-exit=$?"`,
    );
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    // Either the proxy answered 403 or curl failed the CONNECT — never a 2xx.
    expect(denied.result.stdout).not.toMatch(/^2\d\d /);
    const allowed = await broker.exec(
      jobId,
      `curl -s -o /dev/null -w "%{http_code}" --max-time 30 https://pypi.org/simple/`,
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.result.stdout.trim()).toBe("200");
    // Bypass attempt: ignore the proxy → the internal network has no route.
    const bypass = await broker.exec(
      jobId,
      `curl -sS --noproxy '*' --max-time 5 https://example.com/ >/dev/null 2>&1; echo bypass-exit=$?`,
    );
    expect(bypass.ok).toBe(true);
    if (bypass.ok) expect(bypass.result.stdout.trim()).not.toBe("bypass-exit=0");
  }, 180_000);
});

describe("S2 (#1707) — staged skill snapshots: /skills reads, immutability, executor binding", () => {
  const SKILL_BODY = "# Scrape data\nUse requests.get and parse the table.\n";
  const sha256 = (content: string) =>
    createHash("sha256").update(content, "utf8").digest("hex");
  const stagedInput = () => ({
    slug: "scrape-data",
    files: [
      { path: "SKILL.md", content: SKILL_BODY, digest: sha256(SKILL_BODY) },
      { path: "scripts/fetch.py", content: "print('fetch')\n", digest: sha256("print('fetch')\n") },
    ],
  });

  it("skill reads work via /skills/<slug> staging; the snapshot is READ-ONLY", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const opened = await broker.openJob(carrierFor(`${RUN_PREFIX}-skills`), {
      stagedSkills: [stagedInput()],
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    createdJobIds.push(opened.jobId);

    // AC3: the skill shell step runs IN the core sandbox, reads via staging.
    const read = await broker.exec(opened.jobId, "cat /skills/scrape-data/SKILL.md");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result.stdout).toBe(SKILL_BODY);
    const nested = await broker.exec(opened.jobId, "cat /skills/scrape-data/scripts/fetch.py");
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.result.stdout).toContain("print('fetch')");

    // Immutable snapshot: writes into /skills are refused (ro mount).
    const write = await broker.exec(
      opened.jobId,
      `echo tamper > /skills/scrape-data/SKILL.md 2>&1; echo write-exit=$?`,
    );
    expect(write.ok).toBe(true);
    if (write.ok) expect(write.result.stdout.trim()).not.toBe("write-exit=0");
    // And the content is intact.
    const reread = await broker.exec(opened.jobId, "cat /skills/scrape-data/SKILL.md");
    if (reread.ok) expect(reread.result.stdout).toBe(SKILL_BODY);
  }, 120_000);

  it("the llm sandbox tool bound via createBrokerSandboxExecutor runs reads + persistence on the plane", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const executor = createBrokerSandboxExecutor(broker);
    const reads: string[] = [];
    const tool = buildSandboxExecutionTool({
      sessionCarrier: carrierFor(`${RUN_PREFIX}-tool`),
      executor,
      stagedSkills: [
        {
          skillId: "skill-e2e",
          slug: "scrape-data",
          description: "scrape tables",
          resolveFiles: async () => stagedInput().files,
          onRead: (id) => reads.push(id),
        },
      ],
    });

    // Skill read through the FULL llm-tool → executor → broker → docker chain.
    const readOut = await tool.execute({ commands: ["cat /skills/scrape-data/SKILL.md"] });
    expect(readOut[0].outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(readOut[0].stdout).toBe(SKILL_BODY);
    // Attributable sandbox-side read signal fired (S10 efficacy loop).
    expect(reads).toEqual(["skill-e2e"]);

    // L2 persistence across separate tool.execute batches (same carrier/job).
    const write = await tool.execute({ commands: ["echo persisted > note.txt"] });
    expect(write[0].outcome).toEqual({ type: "exit", exitCode: 0 });
    const readBack = await tool.execute({ commands: ["cat note.txt"] });
    expect(readBack[0].stdout.trim()).toBe("persisted");
  }, 120_000);

  it("openJob refuses a tampered snapshot against the real staging path (fail-closed)", async () => {
    const { broker } = makeLiveBroker({ policy: { mode: "none" } });
    const tampered = stagedInput();
    tampered.files[0] = { ...tampered.files[0], digest: sha256("something else") };
    const opened = await broker.openJob(carrierFor(`${RUN_PREFIX}-tamper`), {
      stagedSkills: [tampered],
    });
    expect(opened).toMatchObject({ ok: false, reason: "staging_failed" });
  }, 60_000);
});

describe("session liveness against real containers (S1 AC6)", () => {
  it("purge mid-job fails the next command closed and terminates; archive does not", async () => {
    const live = makeLiveBroker({ policy: { mode: "none" } });
    const jobId = await openOrThrow(live.broker, `${RUN_PREFIX}-liveness`);
    expect((await live.broker.exec(jobId, "echo one")).ok).toBe(true);
    live.setLiveness("archived");
    expect((await live.broker.exec(jobId, "echo two")).ok).toBe(true);
    live.setLiveness("gone");
    expect(await live.broker.exec(jobId, "echo three")).toMatchObject({
      ok: false,
      reason: "run_removed",
    });
    live.setLiveness("alive");
    expect(await live.broker.exec(jobId, "echo four")).toMatchObject({
      ok: false,
      reason: "job_terminated",
    });
  });
});
