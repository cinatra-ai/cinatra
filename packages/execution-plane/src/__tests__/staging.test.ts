/**
 * Exec-plane S2 (cinatra#1707) — read-only skill staging + the broker-backed
 * SandboxExecutor binding, unit-tested against fake docker/broker seams:
 *
 *  - staging validates EVERYTHING before any side effect: digest mismatch,
 *    unsafe/traversal paths, unsafe or duplicate slugs all refuse fail-closed;
 *  - the staging volume is populated via create+cp (a copy — never a bind
 *    mount) and mounted READ-ONLY at /skills by the run profile;
 *  - a docker failure mid-staging cleans up (helper container first, then the
 *    volume) and still refuses;
 *  - openVouched(broker, carrier, {stagedSkills}) refuses `staging_failed` on a bad
 *    snapshot and threads `skillsVolume` into every worker dispatch;
 *  - createBrokerSandboxExecutor opens ONE job per carrier, resolves staged
 *    files exactly once, returns STRUCTURED refusals (never throws into the
 *    model loop), and maps worker timeouts to the timeout outcome.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";
import type { SandboxStagedSkill } from "@cinatra-ai/llm";

import { ExecutionBroker } from "../broker";
import { createBrokerSandboxExecutor } from "../executor";
import {
  SkillStagingError,
  skillsVolumeName,
  stageSkillsVolume,
} from "../staging";
import { buildHardenedRunArgs, assertNoBindMounts } from "../l0-profile";
import {
  signEnvironmentProvenance,
  type EnvironmentLayerProvenance,
} from "../environment/provenance";
import {
  computeEnvironmentRecipeKey,
  ENVIRONMENT_BUILDER_VERSION,
  type EnvironmentBuildRecipe,
} from "../environment/recipe";
import type { ResolvedEnvironmentMount } from "../environment/mount";
import type {
  ExecutionAuditRecord,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
  StagedSkillInput,
} from "../types";
import type { DockerCli } from "../docker-cli";
import {
  execVouched,
  makeVerifier,
  openVouched,
  rememberBrokerPolicy,
  testMinter,
} from "./support/voucher-fixture";

const SECRET = "unit-test-broker-secret";
const PROV_KEY = "unit-test-provenance-key";

const sha256 = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

/** A signed L1 mount projection — the app-layer service's openJob input. */
function mountFor(imageDigest = "sha256:l1layerdigest"): ResolvedEnvironmentMount {
  const recipe: EnvironmentBuildRecipe = {
    spec: { pip: ["pandas==2.2.2"] },
    l0BaseDigest: "sha256:l0base",
    builderVersion: ENVIRONMENT_BUILDER_VERSION,
    platform: { os: "linux", arch: "arm64" },
    buildPolicy: {
      networkPolicy: "registry-allowlist",
      registryAllowlist: ["pypi.org"],
    },
    resolvedArtifacts: { pip: { resolved: "sha256:pinned", integrity: "sha256:int" } },
  };
  const recipeKey = computeEnvironmentRecipeKey(recipe);
  const prov: EnvironmentLayerProvenance = {
    recipeKey,
    recipe,
    imageDigest,
    partition: "instance",
    builderIdentity: ENVIRONMENT_BUILDER_VERSION,
    builtAtMs: 1_000,
  };
  return {
    imageRef: `cinatra-sandbox-l1:${recipeKey}`,
    provenance: signEnvironmentProvenance(prov, PROV_KEY),
  };
}

function stagedSkill(over: Partial<StagedSkillInput> = {}): StagedSkillInput {
  const content = "# My skill\nbody";
  return {
    slug: "my-skill",
    files: [{ path: "SKILL.md", content, digest: sha256(content) }],
    ...over,
  };
}

/** Recording docker seam — every argv is captured; all ops succeed. */
function recordingDocker(failOn?: (args: string[]) => boolean): {
  docker: DockerCli;
  argvs: string[][];
} {
  const argvs: string[][] = [];
  const docker: DockerCli = async (args) => {
    argvs.push(args);
    if (failOn?.(args)) {
      return { exitCode: 1, stdout: "", stderr: "boom", stdioOverflow: false, timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", stdioOverflow: false, timedOut: false };
  };
  return { docker, argvs };
}

beforeEach(() => {
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});

// ---------------------------------------------------------------------------
// stageSkillsVolume — validation is fail-closed and side-effect-free
// ---------------------------------------------------------------------------

describe("stageSkillsVolume — fail-closed validation", () => {
  it("refuses a digest mismatch BEFORE any docker side effect", async () => {
    const { docker, argvs } = recordingDocker();
    const bad = stagedSkill();
    bad.files[0] = { ...bad.files[0], digest: "0".repeat(64) };
    await expect(
      stageSkillsVolume("job-1", [bad], "img:dev", docker),
    ).rejects.toThrow(SkillStagingError);
    await expect(
      stageSkillsVolume("job-1", [bad], "img:dev", docker),
    ).rejects.toThrow(/Digest mismatch/);
    expect(argvs).toHaveLength(0);
  });

  it.each([
    ["traversal", "../etc/passwd"],
    ["absolute", "/etc/passwd"],
    ["backslash", "a\\b"],
    ["dot segment", "./SKILL.md"],
    ["empty segment", "a//b"],
  ])("refuses an unsafe staged path (%s)", async (_label, path) => {
    const { docker, argvs } = recordingDocker();
    const content = "x";
    const bad = stagedSkill({
      files: [{ path, content, digest: sha256(content) }],
    });
    await expect(
      stageSkillsVolume("job-1", [bad], "img:dev", docker),
    ).rejects.toThrow(/unsafe staged file path/);
    expect(argvs).toHaveLength(0);
  });

  it("refuses an unsafe slug and a duplicate slug", async () => {
    const { docker } = recordingDocker();
    await expect(
      stageSkillsVolume("job-1", [stagedSkill({ slug: "../evil" })], "img:dev", docker),
    ).rejects.toThrow(/unsafe skill slug/);
    await expect(
      stageSkillsVolume("job-1", [stagedSkill(), stagedSkill()], "img:dev", docker),
    ).rejects.toThrow(/Duplicate staged skill slug/);
  });

  it("stages via labeled volume + create/cp copy (no bind mounts) and removes the helper", async () => {
    const { docker, argvs } = recordingDocker();
    const name = await stageSkillsVolume("job-1", [stagedSkill()], "img:dev", docker);
    expect(name).toBe(skillsVolumeName("job-1"));
    const [create, helperCreate, cp, helperRm] = argvs;
    expect(create.slice(0, 2)).toEqual(["volume", "create"]);
    expect(create).toContain("ai.cinatra.execution-plane=skills");
    expect(helperCreate[0]).toBe("create");
    expect(helperCreate).toContain(`${name}:/skills`);
    expect(helperCreate).toContain("none"); // --network none
    expect(cp[0]).toBe("cp");
    expect(String(cp[2])).toContain(":/skills");
    expect(helperRm.slice(0, 2)).toEqual(["rm", "-f"]);
    // No bind mounts anywhere in the staging argvs.
    for (const argv of argvs) assertNoBindMounts(argv);
  });

  it("cleans up helper-then-volume when cp fails, and still refuses", async () => {
    const { docker, argvs } = recordingDocker((args) => args[0] === "cp");
    await expect(
      stageSkillsVolume("job-1", [stagedSkill()], "img:dev", docker),
    ).rejects.toThrow(/Failed to populate/);
    const tail = argvs.slice(-2);
    expect(tail[0].slice(0, 2)).toEqual(["rm", "-f"]); // helper container first
    expect(tail[1].slice(0, 3)).toEqual(["volume", "rm", "-f"]); // then the volume
  });
});

// ---------------------------------------------------------------------------
// Run profile — read-only /skills mount
// ---------------------------------------------------------------------------

describe("buildHardenedRunArgs — /skills read-only mount", () => {
  const baseSpec: SandboxCommandSpec = {
    jobId: "job-1",
    command: "cat /skills/my-skill/SKILL.md",
    workspaceVolume: "cinatra-exec-l2-run-1",
    egress: { kind: "none" },
    limits: {
      timeoutMs: 1000,
      maxStdioBytes: 1024,
      workspaceQuotaKb: 1024,
      pidsLimit: 32,
      memoryMb: 128,
      cpus: 1,
    },
  };

  it("mounts the skills volume READ-ONLY at /skills when present", () => {
    const args = buildHardenedRunArgs(
      { ...baseSpec, skillsVolume: "cinatra-exec-skills-job-1" },
      { imageRef: "img:dev", containerName: "c1" },
    );
    const volumeIdx = args.indexOf("cinatra-exec-skills-job-1:/skills:ro");
    expect(volumeIdx).toBeGreaterThan(0);
    expect(args[volumeIdx - 1]).toBe("--volume");
    assertNoBindMounts(args);
  });

  it("emits NO /skills mount when absent (byte-identical S1 argv)", () => {
    const args = buildHardenedRunArgs(baseSpec, { imageRef: "img:dev", containerName: "c1" });
    // The command string itself may mention /skills — assert no MOUNT exists.
    expect(args.filter((a) => a.endsWith(":/skills:ro"))).toHaveLength(0);
    const volumeMounts = args.filter((a, i) => args[i - 1] === "--volume");
    expect(volumeMounts).toEqual(["cinatra-exec-l2-run-1:/workspace"]);
  });
});

// ---------------------------------------------------------------------------
// Broker — openJob staging + skillsVolume threading
// ---------------------------------------------------------------------------

function carrierFor(runId = "run-1"): string {
  const session = mintExecutionSession({
    orgId: "org-1",
    userId: "user-1",
    surface: "agent_run",
    runId,
  });
  return sealExecutionSession(session, { secret: SECRET });
}

function fakeWorker(result?: Partial<SandboxCommandResult>) {
  const state = {
    specs: [] as SandboxCommandSpec[],
    async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
      state.specs.push(spec);
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
        ...result,
      };
    },
  };
  return state as SandboxWorker & { specs: SandboxCommandSpec[] };
}

function makeBroker(
  worker: SandboxWorker,
  docker: DockerCli,
  quotas?: ConstructorParameters<typeof ExecutionBroker>[0]["quotas"],
) {
  const audits: ExecutionAuditRecord[] = [];
  const broker = new ExecutionBroker({
    worker,
    auditSink: (record) => {
      audits.push(record);
    },
    livenessProbe: async () => "alive",
    voucherVerifier: makeVerifier(),
    egressPolicyResolver: () => ({ mode: "none" }),
    docker,
    ...(quotas ? { quotas } : {}),
  });
  rememberBrokerPolicy(broker, { mode: "none" });
  return { broker, audits };
}

describe("ExecutionBroker — staged skills", () => {
  it("openJob refuses staging_failed on a digest-mismatched snapshot (fail-closed)", async () => {
    const { docker } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const bad = stagedSkill();
    bad.files[0] = { ...bad.files[0], digest: "0".repeat(64) };
    const opened = await openVouched(broker, carrierFor(), { stagedSkills: [bad] });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe("staging_failed");
      expect(opened.message).toContain("Digest mismatch");
    }
  });

  it("threads skillsVolume into EVERY worker dispatch; absent without staging", async () => {
    const { docker } = recordingDocker();
    const worker = fakeWorker();
    const { broker } = makeBroker(worker, docker);
    const withSkills = await openVouched(broker, carrierFor("run-a"), {
      stagedSkills: [stagedSkill()],
    });
    expect(withSkills.ok).toBe(true);
    if (!withSkills.ok) return;
    await execVouched(broker, withSkills.jobId, "cat /skills/my-skill/SKILL.md");
    await execVouched(broker, withSkills.jobId, "echo again");
    expect(worker.specs[0].skillsVolume).toBe(skillsVolumeName(withSkills.jobId));
    expect(worker.specs[1].skillsVolume).toBe(skillsVolumeName(withSkills.jobId));

    const withoutSkills = await openVouched(broker, carrierFor("run-b"));
    expect(withoutSkills.ok).toBe(true);
    if (!withoutSkills.ok) return;
    await execVouched(broker, withoutSkills.jobId, "echo hi");
    expect(worker.specs[2].skillsVolume).toBeUndefined();
  });

  it("closeJob removes the per-job skills volume", async () => {
    const { docker, argvs } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const opened = await openVouched(broker, carrierFor("run-c"), {
      stagedSkills: [stagedSkill()],
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await broker.closeJob(opened.jobId);
    const volumeRms = argvs.filter(
      (a) => a[0] === "volume" && a[1] === "rm" && a.includes(skillsVolumeName(opened.jobId)),
    );
    expect(volumeRms.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createBrokerSandboxExecutor — the llm executor binding
// ---------------------------------------------------------------------------

describe("createBrokerSandboxExecutor", () => {
  function llmStagedSkill(): SandboxStagedSkill {
    const content = "# body";
    return {
      skillId: "skill-1",
      slug: "my-skill",
      description: "does things",
      resolveFiles: async () => [
        { path: "SKILL.md", content, digest: sha256(content) },
      ],
    };
  }

  it("opens ONE job per carrier and executes commands sequentially", async () => {
    const { docker } = recordingDocker();
    const worker = fakeWorker();
    const { broker } = makeBroker(worker, docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const carrier = carrierFor("run-x");

    const first = await executor({
      sessionCarrier: carrier,
      commands: ["echo one", "echo two"],
      stagedSkills: [llmStagedSkill()],
    });
    expect(first).toHaveLength(2);
    expect(first[0].outcome).toEqual({ type: "exit", exitCode: 0 });
    const second = await executor({ sessionCarrier: carrier, commands: ["echo three"] });
    expect(second).toHaveLength(1);
    // Same job across both batches (workspace persistence within the request).
    const jobIds = new Set(worker.specs.map((s) => s.jobId));
    expect(jobIds.size).toBe(1);
    // Staged skills rode the single open.
    expect(worker.specs[0].skillsVolume).toBeDefined();
  });

  it("threads the resolved L1 environment mount into openJob → every worker dispatch (exec-plane S3, cinatra#1708)", async () => {
    const { docker } = recordingDocker();
    const worker = fakeWorker();
    const { broker } = makeBroker(worker, docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const mount = mountFor("sha256:declared-env");

    const outputs = await executor({
      sessionCarrier: carrierFor("run-env"),
      commands: ["python -c 'import pandas'", "echo again"],
      environment: mount,
    });
    expect(outputs).toHaveLength(2);
    // The job mounts the SAME resolved layer on every command of the request.
    expect(worker.specs[0].environment).toEqual(mount);
    expect(worker.specs[1].environment).toEqual(mount);
  });

  it("omits the environment when no declared env is supplied — byte-identical L0 dispatch", async () => {
    const { docker } = recordingDocker();
    const worker = fakeWorker();
    const { broker } = makeBroker(worker, docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });

    await executor({ sessionCarrier: carrierFor("run-noenv"), commands: ["echo hi"] });
    expect(worker.specs[0].environment).toBeUndefined();
  });

  it("returns a STRUCTURED refusal (never throws) when the carrier is rejected", async () => {
    const { docker } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const outputs = await executor({
      sessionCarrier: "v1.not-a-real-carrier",
      commands: ["echo hi"],
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0].outcome).toEqual({ type: "exit", exitCode: 126 });
    expect(outputs[0].stderr).toContain("refused to open a job");
  });

  it("maps a worker timeout to the timeout outcome", async () => {
    const { docker } = recordingDocker();
    const worker = fakeWorker({ termination: "timeout", exitCode: null });
    const { broker } = makeBroker(worker, docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const outputs = await executor({
      sessionCarrier: carrierFor("run-t"),
      commands: ["sleep 999"],
    });
    expect(outputs[0].outcome).toEqual({ type: "timeout" });
  });

  it("eviction past the carrier cap forgets the MAPPING only — an in-flight job keeps working and a re-presented carrier re-opens", async () => {
    const { docker } = recordingDocker();
    const worker = fakeWorker();
    // The broker's own per-org open-job ceiling (default 32) would refuse the
    // flood long before the executor's 256-carrier tracking cap — raise it so
    // this test exercises the EXECUTOR's eviction, not the broker quota.
    const { broker } = makeBroker(worker, docker, { maxOpenJobsPerOrg: 1000 });
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const first = carrierFor("run-evict-0");
    await executor({ sessionCarrier: first, commands: ["echo first"] });
    const firstJobId = worker.specs[0].jobId;
    // Flood past the cap with distinct carriers so `first` is evicted.
    for (let i = 1; i <= 257; i++) {
      await executor({ sessionCarrier: carrierFor(`run-evict-${i}`), commands: ["echo n"] });
    }
    // The evicted carrier's JOB was never closed: presenting the carrier again
    // opens a NEW job (fresh mapping) and both commands succeed structurally.
    const again = await executor({ sessionCarrier: first, commands: ["echo again"] });
    expect(again[0].outcome).toEqual({ type: "exit", exitCode: 0 });
    const reopenedJobId = worker.specs[worker.specs.length - 1].jobId;
    expect(reopenedJobId).not.toBe(firstJobId);
    // And the ORIGINAL job is still alive at the broker (not terminated). The job
    // was opened THROUGH the executor, so the voucher's session must be spelled
    // out here — it is bound to that job's own carrier identity (`run-evict-0`),
    // and a voucher carrying any other run would be refused `session_mismatch`.
    const direct = await execVouched(broker, firstJobId, "echo direct", {
      runId: "run-evict-0",
    });
    expect(direct.ok).toBe(true);
  });

  it("a non-Error throwable (throw null) from resolveFiles still becomes a structured refusal", async () => {
    const { docker } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const outputs = await executor({
      sessionCarrier: carrierFor("run-null-throw"),
      commands: ["echo hi"],
      stagedSkills: [
        {
          skillId: "skill-n",
          slug: "my-skill",
          description: "boom",
          resolveFiles: async () => {
            // eslint-disable-next-line no-throw-literal
            throw null;
          },
        },
      ],
    });
    expect(outputs[0].outcome).toEqual({ type: "exit", exitCode: 126 });
    expect(outputs[0].stderr).toContain("staging_failed");
  });

  it("a HOSTILE throwable (throwing instanceof/message traps) still yields a structured refusal", async () => {
    const { docker } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
        get() {
          throw new Error("trap");
        },
      },
    );
    const outputs = await executor({
      sessionCarrier: carrierFor("run-hostile-throw"),
      commands: ["echo hi"],
      stagedSkills: [
        {
          skillId: "skill-h",
          slug: "my-skill",
          description: "boom",
          resolveFiles: async () => {
            throw hostile;
          },
        },
      ],
    });
    expect(outputs[0].outcome).toEqual({ type: "exit", exitCode: 126 });
    expect(outputs[0].stderr).toContain("staging_failed: unknown error");
  });

  it("a THROWING resolveFiles becomes a structured refusal, never an escaping rejection", async () => {
    const { docker } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const executor = createBrokerSandboxExecutor(broker, { mintVoucher: testMinter() });
    const carrier = carrierFor("run-throw");
    const throwing: SandboxStagedSkill = {
      skillId: "skill-x",
      slug: "my-skill",
      description: "boom",
      resolveFiles: async () => {
        throw new Error("catalog read exploded");
      },
    };
    const outputs = await executor({
      sessionCarrier: carrier,
      commands: ["echo hi"],
      stagedSkills: [throwing],
    });
    expect(outputs[0].outcome).toEqual({ type: "exit", exitCode: 126 });
    expect(outputs[0].stderr).toContain("catalog read exploded");
    // The failed open is NOT cached: a later, healthy call opens fine.
    const retry = await executor({ sessionCarrier: carrier, commands: ["echo hi"] });
    expect(retry[0].outcome).toEqual({ type: "exit", exitCode: 0 });
  });
});

describe("retention GC covers the skills tier", () => {
  it("gcExpiredWorkspaces sweeps BOTH the l2 and skills label tiers", async () => {
    const listed: string[] = [];
    const removed: string[] = [];
    const docker: DockerCli = async (args) => {
      if (args[0] === "volume" && args[1] === "ls") {
        const filter = args[args.indexOf("--filter") + 1];
        listed.push(filter);
        const tier = filter.endsWith("=skills") ? "skills" : "l2";
        return {
          exitCode: 0,
          stdout: `cinatra-exec-${tier}-old|ai.cinatra.execution-plane=${tier},ai.cinatra.execution-plane.createdAt=1000\n`,
          stderr: "",
          stdioOverflow: false,
          timedOut: false,
        };
      }
      if (args[0] === "volume" && args[1] === "rm") removed.push(args[2]);
      return { exitCode: 0, stdout: "", stderr: "", stdioOverflow: false, timedOut: false };
    };
    const { gcExpiredWorkspaces } = await import("../workspace");
    const swept = await gcExpiredWorkspaces(60_000, docker, 1_000_000);
    expect(listed).toEqual([
      "label=ai.cinatra.execution-plane=l2",
      "label=ai.cinatra.execution-plane=skills",
    ]);
    expect(swept.sort()).toEqual(["cinatra-exec-l2-old", "cinatra-exec-skills-old"]);
    expect(removed.sort()).toEqual(["cinatra-exec-l2-old", "cinatra-exec-skills-old"]);
  });
});
