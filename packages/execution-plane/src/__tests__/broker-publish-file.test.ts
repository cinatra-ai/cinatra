/**
 * cinatra#3030 (epic #3023 W6) — THE SANDBOX PUBLISH, across the broker.
 *
 * Plan sentences:
 *
 *   item 0.21: "The folder is host-side and is never mounted into a sandbox:
 *   [...] a sandbox publishes a file from its own workspace into the folder
 *   through one tool that copies it across the broker; the execution plane's
 *   workspace, its quota and its no-host-data rule stay as they are."
 *
 *   §8.7: "The run folder is host-side and confined; a sandbox reaches it only
 *   through the broker's copy; the execution plane's rule against host bind
 *   mounts and host data stays."
 *
 * The publish rides the SAME audited command channel as every other command:
 * one voucher, one admission, one audit record — and no new mount, which is what
 * the last case here proves by reading the docker seam's own argv.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  mintExecutionSession,
  sealExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

import {
  ExecutionBroker,
  PUBLISH_FILE_MAX_BYTES,
  publishFileMaxBytes,
  validatePublishPath,
} from "../broker";
import { DEFAULT_SANDBOX_LIMITS } from "../types";
import type {
  SandboxCommandResult,
  SandboxCommandSpec,
  SandboxWorker,
} from "../types";
import type { DockerCli } from "../docker-cli";
import {
  claimsFor,
  makeVerifier,
  openVouched,
  rememberBrokerPolicy,
  signVoucher,
} from "./support/voucher-fixture";

const SECRET = "unit-test-broker-secret";

/** A worker whose one command answers with what `base64 -w 0` would print. */
function publishingWorker(stdout: string, over: Partial<SandboxCommandResult> = {}) {
  const specs: SandboxCommandSpec[] = [];
  const worker: SandboxWorker & { specs: SandboxCommandSpec[] } = {
    specs,
    async runCommand(spec: SandboxCommandSpec): Promise<SandboxCommandResult> {
      specs.push(spec);
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        termination: "exited",
        wallMs: 1,
        imageDigest: "sha256:test",
        workspaceKb: 8,
        ...over,
      };
    },
  };
  return worker;
}

const fakeDocker: DockerCli = async (args) => ({
  exitCode: 0,
  stdout: args[0] === "volume" && args[1] === "create" ? args[args.length - 1] : "",
  stderr: "",
  stdioOverflow: false,
  timedOut: false,
});

/** Every argv the docker seam saw — the no-new-mount proof reads this. */
function recordingDocker(): DockerCli & { argv: string[][] } {
  const argv: string[][] = [];
  const cli = (async (args: string[]) => {
    argv.push([...args]);
    return fakeDocker(args);
  }) as DockerCli & { argv: string[][] };
  cli.argv = argv;
  return cli;
}

async function openPublishingJob(stdout: string, over: Partial<SandboxCommandResult> = {}) {
  const docker = recordingDocker();
  const worker = publishingWorker(stdout, over);
  const broker = new ExecutionBroker({
    worker,
    auditSink: () => {},
    livenessProbe: async () => "alive",
    voucherVerifier: makeVerifier(),
    egressPolicyResolver: () => ({ mode: "none" }),
    docker,
  });
  rememberBrokerPolicy(broker, { mode: "none" });
  const carrier = sealExecutionSession(
    mintExecutionSession({
      orgId: "org-1",
      userId: "user-1",
      surface: "agent_run",
      runId: "run-1",
    }),
    { secret: SECRET },
  );
  const opened = await openVouched(broker, carrier);
  if (!opened.ok) throw new Error("the fixture job did not open");
  const jobId = opened.jobId;
  const publish = async (workspacePath: string) =>
    broker.publishFile(
      jobId,
      workspacePath,
      signVoucher(claimsFor(jobId, ExecutionBroker.publishFileCommand(workspacePath))),
    );
  return { broker, worker, docker, jobId, publish };
}

beforeEach(() => {
  process.env.EXECUTION_BROKER_SECRET = SECRET;
});

describe("the published path", () => {
  it("accepts a plain workspace-relative path", () => {
    expect(validatePublishPath("out/hero.png")).toBeNull();
    expect(validatePublishPath("draft.md")).toBeNull();
  });

  it("refuses an absolute path — a sandbox has no host path to publish from", () => {
    expect(validatePublishPath("/data/artifacts/x.bin")).toContain("workspace-relative");
  });

  it("refuses a parent segment", () => {
    expect(validatePublishPath("../escape.png")).toContain("leave the workspace");
  });

  it("refuses a shell metacharacter", () => {
    expect(validatePublishPath("a.png; rm -rf /")).toContain("only letters");
    expect(validatePublishPath("$(whoami).png")).toContain("only letters");
  });

  it("names ONE command, so the voucher is minted for what actually runs", () => {
    expect(ExecutionBroker.publishFileCommand("out/hero.png")).toBe(
      "base64 -w 0 -- out/hero.png",
    );
  });

  it("caps a publish at a size the command channel can actually carry", () => {
    // The convergence round's finding: the channel is stdout, retained to
    // `maxStdioBytes` and base64-expanded 4:3, so a cap of 50 MiB would be a
    // number no publish could reach — every file between the real bound and the
    // advertised one would be refused by a cap nobody was told about.
    expect(PUBLISH_FILE_MAX_BYTES).toBe(
      Math.floor((DEFAULT_SANDBOX_LIMITS.maxStdioBytes * 3) / 4),
    );
    expect(PUBLISH_FILE_MAX_BYTES).toBeLessThan(50 * 1024 * 1024);
    expect(publishFileMaxBytes(4_000_000)).toBe(3_000_000);
  });
});

describe("the publish itself", () => {
  it("carries the file's bytes across the broker, with their hash", async () => {
    const bytes = Buffer.from("# a draft an agent wrote\n", "utf8");
    const { publish, worker } = await openPublishingJob(bytes.toString("base64"));

    const result = await publish("out/draft.md");

    expect(result).toMatchObject({
      ok: true,
      path: "out/draft.md",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (result.ok) {
      expect(Buffer.from(result.bytesBase64, "base64").toString("utf8")).toBe(
        "# a draft an agent wrote\n",
      );
    }
    // It ran the ONE command the voucher authorized, inside the sandbox.
    expect(worker.specs).toHaveLength(1);
    expect(worker.specs[0]?.command).toBe("base64 -w 0 -- out/draft.md");
  });

  it("NEVER mounts a host path to do it", async () => {
    const { publish, docker } = await openPublishingJob(
      Buffer.from("bytes", "utf8").toString("base64"),
    );
    await publish("out/draft.md");
    const mountArgs = docker.argv
      .flat()
      .filter((arg) => arg === "-v" || arg === "--volume" || arg.startsWith("--mount"));
    expect(mountArgs).toEqual([]);
  });

  it("refuses a path the sandbox could not read", async () => {
    const { publish } = await openPublishingJob("", {
      exitCode: 1,
      stderr: "base64: out/missing.png: No such file or directory",
    });
    const result = await publish("out/missing.png");
    expect(result).toMatchObject({ ok: false, reason: "not_readable" });
  });

  it("refuses a path before it ever reaches the sandbox", async () => {
    const { publish, worker } = await openPublishingJob("");
    const result = await publish("../../etc/passwd");
    expect(result).toMatchObject({ ok: false, reason: "invalid_path" });
    expect(worker.specs).toHaveLength(0);
  });

  it("refuses a truncated answer rather than storing half a file", async () => {
    const { publish } = await openPublishingJob(
      Buffer.from("half", "utf8").toString("base64"),
      { stdoutTruncated: true },
    );
    const result = await publish("out/big.bin");
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });
});
