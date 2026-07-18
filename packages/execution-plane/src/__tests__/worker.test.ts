import { describe, expect, it } from "vitest";

import { LocalDevSandboxWorker } from "../worker";
import { DEFAULT_L0_IMAGE_LOCAL_DEV } from "../l0-profile";
import { EnvironmentMountRefusedError } from "../environment/mount";
import type { ResolvedEnvironmentMount } from "../environment/mount";
import { DEFAULT_SANDBOX_LIMITS, type SandboxCommandSpec } from "../types";
import type { DockerCli, DockerRunOutcome } from "../docker-cli";
import {
  signEnvironmentProvenance,
  type EnvironmentLayerProvenance,
} from "../environment/provenance";
import {
  computeEnvironmentRecipeKey,
  ENVIRONMENT_BUILDER_VERSION,
  type EnvironmentBuildRecipe,
} from "../environment/recipe";

const KEY = "unit-test-provenance-key";
const L1_DIGEST = "sha256:l1digestabc123";
const L0_RESOLVED = "sha256:l0resolveddigest";

function ok(stdout = ""): DockerRunOutcome {
  return { exitCode: 0, stdout, stderr: "", stdioOverflow: false, timedOut: false };
}

/** Records every docker argv; answers image-inspect, the command run, and du. */
function recordingDocker(): DockerCli & { calls: string[][] } {
  const calls: string[][] = [];
  const docker = (async (args: string[]) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") return ok(L0_RESOLVED);
    if (args.includes("du")) return ok("16\t/workspace");
    return ok("done");
  }) as DockerCli & { calls: string[][] };
  docker.calls = calls;
  return docker;
}

function mountFor(digest = L1_DIGEST, key = KEY): ResolvedEnvironmentMount {
  const recipe: EnvironmentBuildRecipe = {
    spec: { pip: ["pandas"] },
    l0BaseDigest: "sha256:l0base",
    builderVersion: ENVIRONMENT_BUILDER_VERSION,
    platform: { os: "linux", arch: "arm64" },
    buildPolicy: { networkPolicy: "registry-allowlist", registryAllowlist: ["pypi.org"] },
    resolvedArtifacts: { pip: { resolved: "sha256:pinned", integrity: "sha256:pinned-int" } },
  };
  const recipeKey = computeEnvironmentRecipeKey(recipe);
  const prov: EnvironmentLayerProvenance = {
    recipeKey,
    recipe,
    imageDigest: digest,
    partition: "instance",
    builderIdentity: ENVIRONMENT_BUILDER_VERSION,
    builtAtMs: 1,
  };
  return {
    imageRef: `cinatra-sandbox-l1:${recipeKey}`,
    provenance: signEnvironmentProvenance(prov, key),
  };
}

function specFor(over: Partial<SandboxCommandSpec> = {}): SandboxCommandSpec {
  return {
    jobId: "job-1",
    command: "echo hi",
    workspaceVolume: "cinatra-ws-1",
    egress: { kind: "none" },
    limits: DEFAULT_SANDBOX_LIMITS,
    ...over,
  };
}

/** The image positional of a hardened `docker run` argv (right after `--`). */
function runImageOf(args: string[]): string | undefined {
  if (args[0] !== "run") return undefined;
  const sep = args.indexOf("--");
  return sep >= 0 ? args[sep + 1] : undefined;
}

describe("LocalDevSandboxWorker — L1 environment mount", () => {
  it("runs over the L0 base when no environment is declared", async () => {
    const docker = recordingDocker();
    const worker = new LocalDevSandboxWorker({ docker, provenanceKey: KEY });
    const result = await worker.runCommand(specFor());

    const commandRun = docker.calls.find((a) => a[0] === "run" && a.includes("bash"));
    expect(commandRun && runImageOf(commandRun)).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
    // Digest recorded for the audit record is the resolved L0 identity.
    expect(result.imageDigest).toBe(L0_RESOLVED);
    // The L0 path resolves the digest via `image inspect`.
    expect(docker.calls.some((a) => a[0] === "image" && a[1] === "inspect")).toBe(true);
  });

  it("runs the command over the SIGNED L1 digest when an environment is declared", async () => {
    const docker = recordingDocker();
    const worker = new LocalDevSandboxWorker({ docker, provenanceKey: KEY });
    const result = await worker.runCommand(specFor({ environment: mountFor() }));

    const commandRun = docker.calls.find((a) => a[0] === "run" && a.includes("bash"));
    expect(commandRun && runImageOf(commandRun)).toBe(L1_DIGEST);
    expect(result.imageDigest).toBe(L1_DIGEST);
    // The signed digest is trusted directly — no L0 `image inspect` on this path.
    expect(docker.calls.some((a) => a[0] === "image" && a[1] === "inspect")).toBe(false);
    // Workspace measurement ALWAYS runs over the TRUSTED L0 base, never the
    // agent-derived L1 layer (whose root-built lifecycle scripts could replace
    // `du` and under-report size to bypass the disk quota).
    const measure = docker.calls.find((a) => a[0] === "run" && a.includes("du"));
    expect(measure?.includes(DEFAULT_L0_IMAGE_LOCAL_DEV)).toBe(true);
    expect(measure?.includes(L1_DIGEST)).toBe(false);
    expect(result.termination).toBe("exited");
  });

  it("refuses (throws) an environment whose provenance does not verify", async () => {
    const docker = recordingDocker();
    const worker = new LocalDevSandboxWorker({ docker, provenanceKey: "wrong-key" });
    await expect(
      worker.runCommand(specFor({ environment: mountFor() })),
    ).rejects.toBeInstanceOf(EnvironmentMountRefusedError);
    // Fail-closed BEFORE dispatch: no container was ever run.
    expect(docker.calls.some((a) => a[0] === "run")).toBe(false);
  });

  it("refuses (throws, no fallback) a declared environment when no key is configured", async () => {
    const docker = recordingDocker();
    const worker = new LocalDevSandboxWorker({ docker }); // no provenanceKey
    await expect(
      worker.runCommand(specFor({ environment: mountFor() })),
    ).rejects.toMatchObject({ reason: "no_provenance_key" });
    // Never falls back to the L0 base — nothing ran.
    expect(docker.calls.some((a) => a[0] === "run")).toBe(false);
  });
});
