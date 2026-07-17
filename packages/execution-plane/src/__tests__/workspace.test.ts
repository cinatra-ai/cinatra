/**
 * L2 workspace unit tests (exec-plane S1, cinatra#1706) — label parsing and
 * retention GC against a fake DockerCli. The `{{.Labels}}` parser is
 * prefix/split based (no regex built from the label constant), so the edge
 * cases here pin the contract: digits-only createdAt values parse, anything
 * else classifies as unparseable (null) and is therefore SKIPPED by GC — the
 * fail-safe direction (never delete on a malformed timestamp).
 */
import { describe, expect, it } from "vitest";

import type { DockerCli, DockerRunOutcome } from "../docker-cli";
import {
  WORKSPACE_LABEL,
  gcExpiredWorkspaces,
  listWorkspaceVolumes,
  workspaceVolumeName,
} from "../workspace";

const ok = (stdout: string): DockerRunOutcome => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdioOverflow: false,
  timedOut: false,
});

function fakeDockerLs(lines: string[]): { docker: DockerCli; calls: string[][] } {
  const calls: string[][] = [];
  const docker: DockerCli = async (args) => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "ls") return ok(lines.join("\n") + "\n");
    return ok("");
  };
  return { docker, calls };
}

describe("workspaceVolumeName", () => {
  it("sanitizes keys to the docker-safe charset (no '|' can reach the ls format)", () => {
    expect(workspaceVolumeName("run|1/x y")).toBe("cinatra-exec-l2-run-1-x-y");
  });
});

describe("listWorkspaceVolumes label parsing", () => {
  const CREATED = `${WORKSPACE_LABEL}.createdAt`;

  it.each([
    {
      name: "plain digits parse",
      labels: `${WORKSPACE_LABEL}=l2,${CREATED}=1720000000000`,
      expected: 1720000000000,
    },
    {
      name: "surrounding entries and spaces are tolerated",
      labels: `a=b, ${CREATED}=42 ,c=d`,
      expected: 42,
    },
    {
      name: "non-digit suffix is unparseable -> null",
      labels: `${CREATED}=1720000000000x`,
      expected: null,
    },
    {
      name: "empty value -> null",
      labels: `${CREATED}=`,
      expected: null,
    },
    {
      name: "missing createdAt entry -> null",
      labels: `${WORKSPACE_LABEL}=l2`,
      expected: null,
    },
    {
      name: "lookalike key with extra prefix chars does not match",
      labels: `x${CREATED}=999`,
      expected: null,
    },
    {
      name: "no labels at all -> null",
      labels: "",
      expected: null,
    },
  ])("$name", async ({ labels, expected }) => {
    const { docker } = fakeDockerLs([`vol-a|${labels}`]);
    const volumes = await listWorkspaceVolumes(docker);
    expect(volumes).toEqual([{ name: "vol-a", createdAtMs: expected }]);
  });

  it("returns [] when docker ls fails", async () => {
    const docker: DockerCli = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      stdioOverflow: false,
      timedOut: false,
    });
    expect(await listWorkspaceVolumes(docker)).toEqual([]);
  });
});

describe("gcExpiredWorkspaces", () => {
  const CREATED = `${WORKSPACE_LABEL}.createdAt`;

  it("removes only expired volumes and SKIPS unparseable timestamps", async () => {
    const now = 100_000;
    const { docker, calls } = fakeDockerLs([
      `expired|${CREATED}=1`,
      `fresh|${CREATED}=${now - 1}`,
      `mangled|${CREATED}=not-a-number`,
    ]);
    const removed = await gcExpiredWorkspaces(50_000, docker, now);
    expect(removed).toEqual(["expired"]);
    const rmCalls = calls.filter((args) => args[0] === "volume" && args[1] === "rm");
    expect(rmCalls).toEqual([["volume", "rm", "expired"]]);
  });
});
