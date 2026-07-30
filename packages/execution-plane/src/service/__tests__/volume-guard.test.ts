/**
 * The VOLUME-NAME REFUSAL MATRIX (exec-plane L3).
 *
 * The worker holds the only docker socket in the topology, so every name the
 * broker hands it is a name it is about to act on with root-equivalent
 * authority. This matrix is the negative half of that contract: for each typed
 * op, what a compromised broker cannot make the worker do.
 */

import { describe, expect, it } from "vitest";

import type { DockerCli, DockerRunOutcome } from "../../docker-cli";
import { skillsVolumeName } from "../../staging";
import { WORKSPACE_LABEL, workspaceVolumeName } from "../../workspace";
import {
  ExecVolumeNameRefusedError,
  assertDrainJobId,
  assertExecVolumeName,
  assertExecVolumeOwnership,
  assertStagingJobId,
  assertWorkspaceKey,
} from "../volume-guard";

function docker(
  answer: (args: string[]) => Partial<DockerRunOutcome>,
  seen: string[][] = [],
): DockerCli & { seen: string[][] } {
  const cli = (async (args: string[]) => {
    seen.push([...args]);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdioOverflow: false,
      timedOut: false,
      ...answer(args),
    } as DockerRunOutcome;
  }) as DockerCli & { seen: string[][] };
  cli.seen = seen;
  return cli;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("assertExecVolumeName — the L2 workspace namespace", () => {
  it("accepts a name the plane's own sanitizer produced", () => {
    const name = workspaceVolumeName("run-abc.1_2");
    expect(assertExecVolumeName(name, "l2")).toBe(name);
  });

  const refused: Array<[string, unknown]> = [
    ["a bare docker volume", "postgres-data"],
    ["another service's namespace", "cinatra-nango-data"],
    ["the SKILLS namespace under the l2 tier", "cinatra-exec-skills-job-1"],
    ["the prefix alone, with no job segment", "cinatra-exec-l2-"],
    ["a host path", "/var/lib/docker"],
    ["a bind-mount spec smuggled in as a name", "/:/host"],
    ["a traversal", "cinatra-exec-l2-../../etc"],
    ["an option-looking argument", "--privileged"],
    ["a name with a shell metacharacter", "cinatra-exec-l2-a;rm -rf /"],
    ["a name with whitespace", "cinatra-exec-l2-a b"],
    ["an empty string", ""],
    ["a non-string", 42],
    ["null", null],
  ];

  for (const [label, candidate] of refused) {
    it(`refuses ${label}`, () => {
      expect(() => assertExecVolumeName(candidate, "l2")).toThrow(
        ExecVolumeNameRefusedError,
      );
    });
  }

  it("refuses a name longer than docker's own ceiling", () => {
    const overlong = workspaceVolumeName("x".repeat(260));
    expect(() => assertExecVolumeName(overlong, "l2")).toThrow(ExecVolumeNameRefusedError);
  });

  it("never echoes the rejected value back", () => {
    const secretish = "cinatra-nango-data-SHOULD-NOT-APPEAR";
    try {
      assertExecVolumeName(secretish, "l2");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecVolumeNameRefusedError);
      expect((err as Error).message).not.toContain(secretish);
    }
  });
});

describe("assertExecVolumeName — the skills namespace", () => {
  it("accepts a staged-skills name", () => {
    const name = skillsVolumeName("job-1");
    expect(assertExecVolumeName(name, "skills")).toBe(name);
  });

  it("refuses an L2 workspace name under the skills tier", () => {
    expect(() => assertExecVolumeName(workspaceVolumeName("run-1"), "skills")).toThrow(
      ExecVolumeNameRefusedError,
    );
  });

  it("the two namespaces are disjoint in both directions", () => {
    expect(workspaceVolumeName("x").startsWith("cinatra-exec-skills-")).toBe(false);
    expect(skillsVolumeName("x").startsWith("cinatra-exec-l2-")).toBe(false);
  });
});

describe("keys and job ids", () => {
  it("accepts an ordinary run key / job id", () => {
    expect(assertWorkspaceKey("run-1", workspaceVolumeName)).toBe("run-1");
    expect(assertStagingJobId("job-1", skillsVolumeName)).toBe("job-1");
    expect(assertDrainJobId("job-1")).toBe("job-1");
  });

  it("refuses an empty or over-long key", () => {
    expect(() => assertWorkspaceKey("", workspaceVolumeName)).toThrow(
      ExecVolumeNameRefusedError,
    );
    expect(() => assertWorkspaceKey("x".repeat(201), workspaceVolumeName)).toThrow(
      ExecVolumeNameRefusedError,
    );
    expect(() => assertStagingJobId("x".repeat(201), skillsVolumeName)).toThrow(
      ExecVolumeNameRefusedError,
    );
    expect(() => assertDrainJobId("x".repeat(201))).toThrow(ExecVolumeNameRefusedError);
  });

  it("a hostile key is SANITIZED into the namespace rather than escaping it", () => {
    // The guard accepts the KEY because the sanitizer has already neutralized
    // it — every character outside [a-zA-Z0-9_.-] becomes `-`, so the derived
    // name is still in-namespace. Recorded here because it is the case where
    // the guard is deliberately NOT the line of defence.
    const key = "../../etc/passwd";
    expect(assertWorkspaceKey(key, workspaceVolumeName)).toBe(key);
    expect(workspaceVolumeName(key)).toBe("cinatra-exec-l2-..-..-etc-passwd");
  });

  it("refuses an absent job id on the drain path", () => {
    expect(() => assertDrainJobId("")).toThrow(ExecVolumeNameRefusedError);
    expect(() => assertDrainJobId(undefined)).toThrow(ExecVolumeNameRefusedError);
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe("assertRemovableExecVolume — the label check on removal", () => {
  it("accepts a volume carrying the tier label", async () => {
    const cli = docker(() => ({ stdout: JSON.stringify({ [WORKSPACE_LABEL]: "l2" }) }));
    await expect(
      assertExecVolumeOwnership("cinatra-exec-l2-run-1", "l2", cli),
    ).resolves.toBe("labelled");
  });

  it("treats an unknown volume as absent — removal is idempotent", async () => {
    const cli = docker(() => ({ exitCode: 1, stderr: "no such volume" }));
    await expect(
      assertExecVolumeOwnership("cinatra-exec-l2-run-1", "l2", cli),
    ).resolves.toBe("absent");
  });

  it("refuses an UNLABELLED volume that merely looks like ours", async () => {
    const cli = docker(() => ({ stdout: "null" }));
    await expect(
      assertExecVolumeOwnership("cinatra-exec-l2-run-1", "l2", cli),
    ).rejects.toThrow(ExecVolumeNameRefusedError);
  });

  it("refuses a volume labelled for the OTHER tier", async () => {
    const cli = docker(() => ({ stdout: JSON.stringify({ [WORKSPACE_LABEL]: "skills" }) }));
    await expect(
      assertExecVolumeOwnership("cinatra-exec-l2-run-1", "l2", cli),
    ).rejects.toThrow(ExecVolumeNameRefusedError);
  });

  it("refuses when the label output cannot be parsed (fail-closed)", async () => {
    const cli = docker(() => ({ stdout: "<no value>" }));
    await expect(
      assertExecVolumeOwnership("cinatra-exec-l2-run-1", "l2", cli),
    ).rejects.toThrow(ExecVolumeNameRefusedError);
  });

  it("reads labels as JSON, not through a nil-map-unsafe template index", async () => {
    const seen: string[][] = [];
    const cli = docker(() => ({ stdout: "null" }), seen);
    await assertExecVolumeOwnership("cinatra-exec-l2-run-1", "l2", cli).catch(() => {});
    expect(seen[0]).toEqual([
      "volume",
      "inspect",
      "--format",
      "{{json .Labels}}",
      "cinatra-exec-l2-run-1",
    ]);
  });
});
