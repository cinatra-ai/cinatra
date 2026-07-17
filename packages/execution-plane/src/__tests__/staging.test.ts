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
 *  - broker.openJob(carrier, {stagedSkills}) refuses `staging_failed` on a bad
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
import type {
  ExecutionAuditRecord,
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
  StagedSkillInput,
} from "../types";
import type { DockerCli } from "../docker-cli";

const SECRET = "unit-test-broker-secret";

const sha256 = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

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

function makeBroker(worker: SandboxWorker, docker: DockerCli) {
  const audits: ExecutionAuditRecord[] = [];
  const broker = new ExecutionBroker({
    worker,
    auditSink: (record) => {
      audits.push(record);
    },
    livenessProbe: async () => "alive",
    egressPolicyResolver: () => ({ mode: "none" }),
    docker,
  });
  return { broker, audits };
}

describe("ExecutionBroker — staged skills", () => {
  it("openJob refuses staging_failed on a digest-mismatched snapshot (fail-closed)", async () => {
    const { docker } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const bad = stagedSkill();
    bad.files[0] = { ...bad.files[0], digest: "0".repeat(64) };
    const opened = await broker.openJob(carrierFor(), { stagedSkills: [bad] });
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
    const withSkills = await broker.openJob(carrierFor("run-a"), {
      stagedSkills: [stagedSkill()],
    });
    expect(withSkills.ok).toBe(true);
    if (!withSkills.ok) return;
    await broker.exec(withSkills.jobId, "cat /skills/my-skill/SKILL.md");
    await broker.exec(withSkills.jobId, "echo again");
    expect(worker.specs[0].skillsVolume).toBe(skillsVolumeName(withSkills.jobId));
    expect(worker.specs[1].skillsVolume).toBe(skillsVolumeName(withSkills.jobId));

    const withoutSkills = await broker.openJob(carrierFor("run-b"));
    expect(withoutSkills.ok).toBe(true);
    if (!withoutSkills.ok) return;
    await broker.exec(withoutSkills.jobId, "echo hi");
    expect(worker.specs[2].skillsVolume).toBeUndefined();
  });

  it("closeJob removes the per-job skills volume", async () => {
    const { docker, argvs } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const opened = await broker.openJob(carrierFor("run-c"), {
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
    const executor = createBrokerSandboxExecutor(broker);
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

  it("returns a STRUCTURED refusal (never throws) when the carrier is rejected", async () => {
    const { docker } = recordingDocker();
    const { broker } = makeBroker(fakeWorker(), docker);
    const executor = createBrokerSandboxExecutor(broker);
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
    const executor = createBrokerSandboxExecutor(broker);
    const outputs = await executor({
      sessionCarrier: carrierFor("run-t"),
      commands: ["sleep 999"],
    });
    expect(outputs[0].outcome).toEqual({ type: "timeout" });
  });
});
