/**
 * HOST-WIRING contract for AC9's hard-removal duties (epic #1705).
 *
 * The gap the acceptance audit found was not a missing capability — the broker
 * has carried `terminateJobsForRun` since S1 — it was a missing CALLER: nothing
 * in `src/` connected a hard removal to it, so a force-deleted package left its
 * queued sandbox work and its retained run workspaces behind.
 *
 * This proves the whole chain against a REAL `ExecutionBroker` and its real
 * volume ops (observed through a recording docker seam), never against
 * reference counts:
 *
 *   fireExtensionDataTeardown(pkg, { runIds })   ← what force_delete/purge fire
 *     → the host hook wired by extension-data-teardown-wiring
 *       → the participant registered by the execution-broker boot phase
 *         → broker.terminateJobsForRun(runId, { removeWorkspace: true })
 *
 * `@/lib/database` is mocked: the settings/secrets halves of the hook are not
 * what is under test here, and the hook's per-half isolation contract means
 * they must not be able to influence this half either way — which the last case
 * asserts directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";
import {
  ExecutionBroker,
  ExecutionVoucherVerifier,
} from "@cinatra-ai/execution-plane";
import type { DockerCli } from "@cinatra-ai/execution-plane";
import { fireExtensionDataTeardown } from "@cinatra-ai/extensions";

import { createExecutionRunTeardownParticipant } from "@/lib/execution/execution-run-teardown";
import {
  clearExecutionRunTeardown,
  registerExecutionRunTeardown,
} from "@/lib/execution/register-execution-run-teardown";

const deletedPrefixes: string[] = [];
vi.mock("@/lib/database", () => ({
  deleteConnectorConfigByPrefix: vi.fn(async (prefix: string) => {
    deletedPrefixes.push(prefix);
    return 0;
  }),
}));

const SECRET = "hard-removal-teardown-test-secret";
const PKG = "@cinatra-ai/hard-removal-test-agent";

/** Records every docker argv so volume removals are directly observable. */
function recordingDocker(): DockerCli & { argv: string[][] } {
  const argv: string[][] = [];
  const cli = (async (args: string[]) => {
    argv.push([...args]);
    return {
      exitCode: 0,
      stdout:
        args[0] === "volume" && args[1] === "create" ? args[args.length - 1] : "",
      stderr: "",
      stdioOverflow: false,
      timedOut: false,
    };
  }) as DockerCli & { argv: string[][] };
  cli.argv = argv;
  return cli;
}

function makeBroker(docker: DockerCli) {
  const { publicKey } = generateKeyPairSync("ed25519");
  return new ExecutionBroker({
    // No command ever runs in this suite — the wiring under test is the
    // teardown path, and the dispatch path has its own batteries.
    worker: {
      runCommand: async () => {
        throw new Error("no command should run in this suite");
      },
    },
    auditSink: () => {},
    livenessProbe: async () => "alive",
    voucherVerifier: new ExecutionVoucherVerifier({
      publicKey,
      aud: "urn:cinatra:execution-broker:teardown-test",
    }),
    egressPolicyResolver: () => ({ mode: "none" }),
    docker,
  });
}

function carrierFor(runId: string): string {
  return sealExecutionSession(
    mintExecutionSession({
      orgId: "org-teardown",
      userId: "user-teardown",
      surface: "agent_run",
      runId,
    }),
    { secret: SECRET },
  );
}

function removedVolumes(cli: { argv: string[][] }): string[] {
  return cli.argv
    .filter((args) => args[0] === "volume" && args[1] === "rm")
    .map((args) => args[args.length - 1]);
}

beforeEach(async () => {
  deletedPrefixes.length = 0;
  process.env.EXECUTION_BROKER_SECRET = SECRET;
  // The wiring module installs the hook as an import side effect and guards
  // itself with a module-level `wired` flag, so re-import it fresh per test.
  vi.resetModules();
  const wiring = await import("@/lib/extension-data-teardown-wiring");
  wiring.wireExtensionDataTeardownHook();
});

afterEach(() => {
  clearExecutionRunTeardown();
});

describe("hard removal → execution-plane run teardown (AC9)", () => {
  it("terminates the run's open jobs and collects its workspace, through the real broker", async () => {
    const docker = recordingDocker();
    const broker = makeBroker(docker);
    registerExecutionRunTeardown(
      createExecutionRunTeardownParticipant({
        terminateJobsForRun: (runId, opts) => broker.terminateJobsForRun(runId, opts),
      }),
    );

    const opened = await broker.openJob(carrierFor("run-teardown-1"));
    expect(opened.ok).toBe(true);
    expect(removedVolumes(docker)).toHaveLength(0);

    // Exactly what force_delete / purge fire once the rows are gone.
    await fireExtensionDataTeardown(PKG, { runIds: ["run-teardown-1"] });

    // The job is TERMINATED: a second sweep finds nothing left to terminate.
    expect(await broker.terminateJobsForRun("run-teardown-1")).toBe(0);
    // ...and its L2 workspace was collected NOW, not left to the retention GC.
    expect(removedVolumes(docker)).toContain("cinatra-exec-l2-run-teardown-1");
    // The other halves of the hook still ran (per-half isolation, unchanged).
    expect(deletedPrefixes).toContain(`ext:${PKG}:`);
  });

  it("collects a RETAINED workspace — the run whose job was already closed", async () => {
    const docker = recordingDocker();
    const broker = makeBroker(docker);
    registerExecutionRunTeardown(
      createExecutionRunTeardownParticipant({
        terminateJobsForRun: (runId, opts) => broker.terminateJobsForRun(runId, opts),
      }),
    );

    const opened = await broker.openJob(carrierFor("run-teardown-2"));
    if (!opened.ok) throw new Error("openJob failed");
    // `closeJob` without `removeWorkspace` is the RETAINED case the AC names.
    await broker.closeJob(opened.jobId);
    expect(removedVolumes(docker)).not.toContain("cinatra-exec-l2-run-teardown-2");

    await fireExtensionDataTeardown(PKG, { runIds: ["run-teardown-2"] });

    expect(removedVolumes(docker)).toContain("cinatra-exec-l2-run-teardown-2");
  });

  it("leaves an UNRELATED run alone", async () => {
    const docker = recordingDocker();
    const broker = makeBroker(docker);
    registerExecutionRunTeardown(
      createExecutionRunTeardownParticipant({
        terminateJobsForRun: (runId, opts) => broker.terminateJobsForRun(runId, opts),
      }),
    );
    await broker.openJob(carrierFor("run-keep"));
    await broker.openJob(carrierFor("run-teardown-3"));

    await fireExtensionDataTeardown(PKG, { runIds: ["run-teardown-3"] });

    // The TARGETED run was torn down — so the participant demonstrably ran, and
    // this case is a real discrimination test rather than a no-op.
    expect(removedVolumes(docker)).toContain("cinatra-exec-l2-run-teardown-3");
    expect(await broker.terminateJobsForRun("run-teardown-3")).toBe(0);
    // The unrelated one is untouched: no volume removed, still open, still
    // terminable.
    expect(removedVolumes(docker)).not.toContain("cinatra-exec-l2-run-keep");
    expect(await broker.terminateJobsForRun("run-keep")).toBe(1);
  });

  it("does nothing when the destructive step reported no run ids", async () => {
    const calls: string[][] = [];
    registerExecutionRunTeardown(async ({ runIds }) => {
      calls.push([...runIds]);
      return { runs: runIds.length, terminatedJobs: 0 };
    });

    await fireExtensionDataTeardown(PKG);
    await fireExtensionDataTeardown(PKG, { runIds: [] });

    // Absent context is "not reported", never "there were none" — the
    // participant is not invoked with an empty set it would read as complete.
    expect(calls).toEqual([]);
    // The other halves still ran on both fires.
    expect(deletedPrefixes.filter((p) => p === `ext:${PKG}:`)).toHaveLength(2);
  });

  it("a THROWING run-teardown participant never aborts the committed removal", async () => {
    let invoked = 0;
    registerExecutionRunTeardown(async () => {
      invoked += 1;
      throw new Error("broker unreachable");
    });

    await expect(
      fireExtensionDataTeardown(PKG, { runIds: ["run-teardown-4"] }),
    ).resolves.toBeUndefined();
    // It genuinely ran and genuinely threw — the point is that the throw was
    // contained, not that nothing happened.
    expect(invoked).toBe(1);
    // Per-half isolation: the settings/secrets deletes still happened.
    expect(deletedPrefixes).toContain(`ext-secret:${PKG}:`);
  });

  // Per-RUN isolation inside the participant itself: one unreachable run must
  // not strand the others.
  it("keeps tearing down the remaining runs when one of them fails", async () => {
    const attempted: string[] = [];
    registerExecutionRunTeardown(
      createExecutionRunTeardownParticipant({
        terminateJobsForRun: async (runId) => {
          attempted.push(runId);
          if (runId === "run-bad") throw new Error("broker refused");
          return 1;
        },
        warn: () => {},
      }),
    );

    await fireExtensionDataTeardown(PKG, {
      runIds: ["run-ok-1", "run-bad", "run-ok-2"],
    });

    expect(attempted).toEqual(["run-ok-1", "run-bad", "run-ok-2"]);
  });
});
