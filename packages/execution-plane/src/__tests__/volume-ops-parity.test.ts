/**
 * The BYTE-IDENTICAL pin for the typed volume-ops seam (exec-plane L3).
 *
 * `broker.ts` used to call `ensureWorkspaceVolume` / `stageSkillsVolume` /
 * `removeWorkspaceVolume` / `removeSkillsVolume` with `this.opts.docker` at six
 * sites. Those six calls are now ONE seam that defaults to the same helpers
 * over the same `DockerCli`. A refactor like that is only safe if the argv a
 * default-constructed broker emits is unchanged — and "unchanged" is a claim a
 * test has to make, not a comment.
 *
 * The reference is never a hand-copied expectation: each case records what the
 * REAL helper emits and asserts the seam emits the same sequence, element for
 * element.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import { ExecutionBroker } from "../broker";
import type { DockerCli, DockerRunOutcome } from "../docker-cli";
import { SANDBOX_CONTAINER_JOB_LABEL } from "../l0-profile";
import { removeSkillsVolume, stageSkillsVolume } from "../staging";
import type { SandboxCommandResult, SandboxWorker } from "../types";
import {
  createLocalDockerContainerOps,
  createLocalDockerVolumeOps,
} from "../volume-ops";
import { ensureWorkspaceVolume, removeWorkspaceVolume } from "../workspace";
import { makeVerifier, openVouched } from "./support/voucher-fixture";

const SECRET = "unit-test-volume-ops-parity";

type Recorded = string[][];

/** Records argv and answers success — the same posture as broker.test.ts. */
function recordingDocker(recorded: Recorded): DockerCli {
  return async (args: string[]): Promise<DockerRunOutcome> => {
    recorded.push([...args]);
    return {
      exitCode: 0,
      stdout: args[0] === "volume" && args[1] === "create" ? args[args.length - 1] : "",
      stderr: "",
      stdioOverflow: false,
      timedOut: false,
    };
  };
}

const idleWorker: SandboxWorker = {
  runCommand: async (): Promise<SandboxCommandResult> => {
    throw new Error("no command is dispatched in the parity suite");
  },
};

function carrierFor(runId: string): string {
  return sealExecutionSession(
    mintExecutionSession({
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      runId,
    }),
    { secret: SECRET },
  );
}

beforeEach(() => {
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});

describe("volume-ops seam — local-dev parity", () => {
  it("ensureWorkspace emits what the direct helper emits", async () => {
    const direct: Recorded = [];
    const viaSeam: Recorded = [];
    await ensureWorkspaceVolume("run-abc", recordingDocker(direct));
    await createLocalDockerVolumeOps(recordingDocker(viaSeam)).ensureWorkspace("run-abc");
    expect(normalize(viaSeam)).toEqual(normalize(direct));
  });

  it("stageSkills emits what the direct helper emits", async () => {
    const direct: Recorded = [];
    const viaSeam: Recorded = [];
    await stageSkillsVolume("job-1", [], "l0:dev", recordingDocker(direct));
    await createLocalDockerVolumeOps(recordingDocker(viaSeam)).stageSkills(
      "job-1",
      [],
      "l0:dev",
    );
    expect(normalizeStaging(viaSeam)).toEqual(normalizeStaging(direct));
  });

  it("removeWorkspace / removeSkills emit what the direct helpers emit", async () => {
    const direct: Recorded = [];
    const viaSeam: Recorded = [];
    await removeWorkspaceVolume("cinatra-exec-l2-run-abc", recordingDocker(direct));
    await removeSkillsVolume("cinatra-exec-skills-job-1", recordingDocker(direct));
    const ops = createLocalDockerVolumeOps(recordingDocker(viaSeam));
    await ops.removeWorkspace("cinatra-exec-l2-run-abc");
    await ops.removeSkills("cinatra-exec-skills-job-1");
    expect(viaSeam).toEqual(direct);
  });

  it("an UNCONFIGURED broker drives its docker seam exactly as before", async () => {
    const recorded: Recorded = [];
    const broker = new ExecutionBroker({
      worker: idleWorker,
      auditSink: () => {},
      livenessProbe: async () => "alive",
      voucherVerifier: makeVerifier(),
      egressPolicyResolver: () => ({ mode: "none" }),
      docker: recordingDocker(recorded),
    });

    const opened = await openVouched(broker, carrierFor("run-parity"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await broker.closeJob(opened.jobId, { removeWorkspace: true });

    // The pre-seam sequence exactly: one run-keyed `volume create` on open (no
    // skills staged ⇒ no staging calls), one `volume rm -f` on close.
    const expected: Recorded = [];
    await ensureWorkspaceVolume("run-parity", recordingDocker(expected));
    await removeWorkspaceVolume("cinatra-exec-l2-run-parity", recordingDocker(expected));
    expect(normalize(recorded)).toEqual(normalize(expected));
  });

  it("without a placement guard the broker never reaches the drain path", async () => {
    const recorded: Recorded = [];
    const broker = new ExecutionBroker({
      worker: idleWorker,
      auditSink: () => {},
      livenessProbe: async () => "alive",
      voucherVerifier: makeVerifier(),
      egressPolicyResolver: () => ({ mode: "none" }),
      docker: recordingDocker(recorded),
    });
    const opened = await openVouched(broker, carrierFor("run-noguard"));
    expect(opened.ok).toBe(true);
    // `docker ps` / `docker rm` belong to the host-exclusivity drain, which is
    // reachable only through a REFUSING guard. An unconfigured broker adds no
    // docker call it did not make before this slice.
    expect(recorded.some((argv) => argv[0] === "ps")).toBe(false);
    expect(recorded.some((argv) => argv[0] === "rm")).toBe(false);
  });
});

describe("container ops — ownership and failure reporting", () => {
  it("selects on the ownership LABEL and re-checks the anchored name shape", async () => {
    const recorded: Recorded = [];
    const cli: DockerCli = async (args) => {
      recorded.push([...args]);
      if (args[0] === "ps") {
        // A daemon that (or an attacker who) returns more than it should: a
        // different job's container, and one that is not even name-shaped.
        return okOut(
          [
            "cinatra-exec-job1-0",
            "cinatra-exec-job1-bar-7", // the DIFFERENT job `job1-bar`
            "cinatra-exec-job1-notanumber",
            "postgres",
          ].join("\n"),
        );
      }
      return okOut("");
    };
    const removed = await createLocalDockerContainerOps(cli).cancelJobContainers("job1");
    expect(removed).toEqual(["cinatra-exec-job1-0"]);
    expect(recorded.filter((argv) => argv[0] === "rm")).toEqual([
      ["rm", "--force", "cinatra-exec-job1-0"],
    ]);
    expect(recorded[0]).toContain(`label=${SANDBOX_CONTAINER_JOB_LABEL}=job1`);
  });

  it("THROWS when enumeration fails — an undrained host is not a drained one", async () => {
    const cli: DockerCli = async (args) =>
      args[0] === "ps" ? { ...okOut(""), exitCode: 1 } : okOut("");
    await expect(
      createLocalDockerContainerOps(cli).cancelJobContainers("job1"),
    ).rejects.toThrow(/NOT drained/);
  });

  it("attempts EVERY removal, then throws naming the incomplete drain", async () => {
    const attempted: string[] = [];
    const cli: DockerCli = async (args) => {
      if (args[0] === "ps") {
        return okOut(["cinatra-exec-job1-0", "cinatra-exec-job1-1"].join("\n"));
      }
      if (args[0] === "rm") {
        attempted.push(args[args.length - 1]);
        // The FIRST removal fails; the second must still be attempted.
        return { ...okOut(""), exitCode: attempted.length === 1 ? 1 : 0 };
      }
      return okOut("");
    };
    await expect(
      createLocalDockerContainerOps(cli).cancelJobContainers("job1"),
    ).rejects.toThrow(/NOT fully drained/);
    expect(attempted).toEqual(["cinatra-exec-job1-0", "cinatra-exec-job1-1"]);
  });
});

function okOut(stdout: string): DockerRunOutcome {
  return { exitCode: 0, stdout, stderr: "", stdioOverflow: false, timedOut: false };
}

/** Neutralize the wall-clock `createdAt` label; keep every other element. */
function normalize(recorded: Recorded): Recorded {
  return recorded.map((argv) =>
    argv.map((arg) =>
      arg.startsWith("ai.cinatra.execution-plane.createdAt=")
        ? "ai.cinatra.execution-plane.createdAt=<ms>"
        : arg,
    ),
  );
}

/**
 * Staging additionally mints a random helper-container name and a temp dir, so
 * those two are normalized too — everything else (op order, flags, mount spec,
 * the `--` before the image ref) still has to match exactly.
 */
function normalizeStaging(recorded: Recorded): Recorded {
  return normalize(recorded).map((argv) =>
    argv.map((arg) =>
      arg
        .replace(/cinatra-exec-stage-[0-9a-f-]{36}/g, "cinatra-exec-stage-<uuid>")
        .replace(/cinatra-skill-stage-[^/]+/g, "cinatra-skill-stage-<tmp>"),
    ),
  );
}
