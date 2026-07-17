import { describe, expect, it } from "vitest";

import type { DockerCli, DockerRunOutcome } from "../docker-cli";
import { SANDBOX_RUNTIME_GID, SANDBOX_RUNTIME_UID } from "../l0-profile";
import { EnvironmentLayerCache } from "../environment/cache";
import {
  assertNoCredentialBuildArgs,
  buildEnvironmentImageArgs,
  EnvironmentBuildRefusedError,
  renderEnvironmentDockerfile,
  TrustedEnvironmentBuilder,
} from "../environment/builder";

const ok = (stdout = ""): DockerRunOutcome => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdioOverflow: false,
  timedOut: false,
});

/**
 * Scripted fake docker CLI: records every argv; answers inspect/build/run/tag
 * from a small state machine so the full ensureEnvironmentLayer flow runs.
 */
function fakeDocker(state?: { baseDigest?: string; pipLock?: string }) {
  const calls: string[][] = [];
  const baseDigest = state?.baseDigest ?? "sha256:l0base";
  const pipLock = state?.pipLock ?? "pandas==2.2.1\n";
  const cli: DockerCli = async (args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[args.length - 1];
      return ok(ref.startsWith("cinatra-sandbox-l1:") ? "sha256:l1img" : baseDigest);
    }
    if (args[0] === "build") return ok();
    if (args[0] === "run") return ok(pipLock); // lock extraction
    if (args[0] === "tag" || args[0] === "rmi") return ok();
    return ok();
  };
  return { cli, calls };
}

const PLATFORM = { os: "linux", arch: "arm64" };

function makeBuilder(over?: {
  docker?: DockerCli;
  cache?: EnvironmentLayerCache;
  gateway?: boolean;
  allowInsecure?: boolean;
  registered?: Array<{ token: string; allowlist: string[] }>;
}) {
  const cache = over?.cache ?? new EnvironmentLayerCache({ provenanceKey: "pk" });
  const fake = fakeDocker();
  const registered = over?.registered ?? [];
  const builder = new TrustedEnvironmentBuilder({
    cache,
    provenanceKey: "pk",
    docker: over?.docker ?? fake.cli,
    l0ImageRef: "cinatra-sandbox-l0:dev",
    platform: PLATFORM,
    ...(over?.gateway
      ? {
          gateway: {
            host: "cinatra-exec-gateway",
            port: 3128,
            adminUrl: "http://127.0.0.1:3129",
            controlSecret: "cs",
          },
          registerEgress: async (_gw, token, policy) => {
            registered.push({ token, allowlist: policy.allowlist ?? [] });
          },
        }
      : {}),
    ...(over?.allowInsecure ? { allowInsecureLocalDevNetwork: true } : {}),
  });
  return { builder, cache, fake, registered };
}

describe("renderEnvironmentDockerfile (build contract)", () => {
  const spec = { os: ["pandoc"], pip: ["pandas==2.2.1"], npm: ["prettier"] };

  it("derives FROM the L0 ref, installs as root at BUILD time, and drops back to the fixed runtime UID", () => {
    const df = renderEnvironmentDockerfile(spec, { baseImageRef: "cinatra-sandbox-l0:dev" });
    const lines = df.trim().split("\n");
    expect(lines[1]).toBe("FROM cinatra-sandbox-l0:dev");
    expect(lines[2]).toBe("USER 0:0"); // root at build time ONLY (epic D2)
    // The LAST directive pins the fixed non-root runtime identity — preserved
    // across every derived L1 layer (cinatra#1708).
    expect(lines[lines.length - 1]).toBe(`USER ${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`);
    expect(df).toContain("apt-get install -y --no-install-recommends 'pandoc'");
    expect(df).toContain("pip install --no-cache-dir 'pandas==2.2.1'");
    expect(df).toContain("npm install -g --no-fund --no-audit 'prettier'");
    // Every manager freezes its RESOLVED state for recipe-key extraction.
    expect(df).toContain("/opt/cinatra-env/os.lock");
    expect(df).toContain("/opt/cinatra-env/pip.lock");
    expect(df).toContain("/opt/cinatra-env/npm.lock");
  });

  it("omits managers the spec does not declare", () => {
    const df = renderEnvironmentDockerfile({ pip: ["requests"] }, { baseImageRef: "l0:dev" });
    expect(df).not.toContain("apt-get");
    expect(df).not.toContain("npm install");
  });

  it("refuses an option-injection base ref", () => {
    expect(() =>
      renderEnvironmentDockerfile({ pip: ["x"] }, { baseImageRef: "--privileged" }),
    ).toThrow(/does not start with an alphanumeric/);
  });
});

describe("lifecycle-script isolation (no credentials enter the build)", () => {
  it("build argv carries ONLY proxy build-args; anything else is an invariant violation", () => {
    const args = buildEnvironmentImageArgs({
      contextDir: "/tmp/ctx",
      tag: "cinatra-sandbox-l1:x",
      network: "cinatra-exec-internal",
      proxyUrl: "http://token:x@gw:3128",
      platform: PLATFORM,
    });
    expect(() => assertNoCredentialBuildArgs(args)).not.toThrow();
    const keys = args
      .map((a, i) => (a === "--build-arg" ? args[i + 1].split("=")[0] : null))
      .filter((k): k is string => k !== null);
    expect(new Set(keys)).toEqual(
      new Set(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]),
    );
    expect(() =>
      assertNoCredentialBuildArgs(["build", "--build-arg", "NPM_TOKEN=secret"]),
    ).toThrow(/lifecycle-script isolation/);
    expect(() => assertNoCredentialBuildArgs(["build", "--secret", "id=x"])).toThrow(
      /--secret/,
    );
  });
});

describe("TrustedEnvironmentBuilder.ensureEnvironmentLayer", () => {
  it("fails closed on an invalid declaration and skips empty specs", async () => {
    const { builder } = makeBuilder({ allowInsecure: true });
    await expect(
      builder.ensureEnvironmentLayer({ raw: { bogus: ["x"] }, orgId: "org-a" }),
    ).rejects.toThrow(EnvironmentBuildRefusedError);
    expect(
      await builder.ensureEnvironmentLayer({ raw: {}, orgId: "org-a" }),
    ).toEqual({ kind: "no-environment" });
  });

  it("REFUSES to build without the attributing gateway unless local-dev explicitly opts in", async () => {
    const { builder } = makeBuilder({});
    await expect(
      builder.ensureEnvironmentLayer({ raw: { pip: ["pandas"] }, orgId: "org-a" }),
    ).rejects.toThrow(/without the attributing egress gateway/);
  });

  it("builds once, then same-recipe agents cache-hit with NO further docker build (AC1)", async () => {
    const { builder, fake } = makeBuilder({ allowInsecure: true });
    const first = await builder.ensureEnvironmentLayer({
      raw: { pip: ["pandas==2.2.1"] },
      orgId: "org-a",
    });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;
    expect(first.cacheHit).toBe(false);
    const buildsAfterFirst = fake.calls.filter((c) => c[0] === "build").length;
    expect(buildsAfterFirst).toBe(1);

    // A SECOND agent with the same declared set (different order): cache hit.
    const second = await builder.ensureEnvironmentLayer({
      raw: { pip: ["pandas==2.2.1"] },
      orgId: "org-b",
    });
    expect(second.kind === "ready" && second.cacheHit).toBe(true);
    expect(second.kind === "ready" && second.entry.recipeKey).toBe(first.entry.recipeKey);
    expect(fake.calls.filter((c) => c[0] === "build").length).toBe(buildsAfterFirst);
  });

  it("a changed L0 base digest busts the fast path even when the spec is unchanged", async () => {
    const cache = new EnvironmentLayerCache({ provenanceKey: "pk" });
    const fakeA = fakeDocker({ baseDigest: "sha256:l0-A" });
    const { builder: builderA } = makeBuilder({ docker: fakeA.cli, cache, allowInsecure: true });
    const a = await builderA.ensureEnvironmentLayer({ raw: { pip: ["pandas"] }, orgId: "o" });

    const fakeB = fakeDocker({ baseDigest: "sha256:l0-B" });
    const { builder: builderB } = makeBuilder({ docker: fakeB.cli, cache, allowInsecure: true });
    const b = await builderB.ensureEnvironmentLayer({ raw: { pip: ["pandas"] }, orgId: "o" });

    expect(a.kind === "ready" && b.kind === "ready").toBe(true);
    if (a.kind !== "ready" || b.kind !== "ready") return;
    expect(b.cacheHit).toBe(false); // rebuilt — not aliased onto the old base
    expect(fakeB.calls.filter((c) => c[0] === "build").length).toBe(1);
  });

  it("registers the registry allowlist at the gateway and rides proxy build-args", async () => {
    const registered: Array<{ token: string; allowlist: string[] }> = [];
    const { builder, fake } = makeBuilder({ gateway: true, registered });
    const result = await builder.ensureEnvironmentLayer({
      raw: { pip: ["pandas"] },
      orgId: "org-a",
    });
    expect(result.kind).toBe("ready");
    expect(registered.length).toBe(1);
    expect(registered[0].allowlist).toContain("pypi.org");
    const build = fake.calls.find((c) => c[0] === "build");
    expect(build).toBeDefined();
    expect(build!.join(" ")).toContain(`http://${registered[0].token}:x@cinatra-exec-gateway:3128`);
    expect(build!).toContain("--network");
    expect(() => assertNoCredentialBuildArgs(build!)).not.toThrow();
  });

  it("org-private visibility partitions the layer to the org", async () => {
    const { builder, cache } = makeBuilder({ allowInsecure: true });
    const result = await builder.ensureEnvironmentLayer({
      raw: { pip: ["secretlib"] },
      orgId: "org-a",
      visibility: "org-private",
    });
    expect(result.kind === "ready" && result.entry.partition).toBe("org:org-a");
    if (result.kind !== "ready") return;
    expect(cache.lookup(result.entry.recipeKey, { orgId: "org-b" })).toEqual({
      hit: false,
      reason: "partition_denied",
    });
  });

  it("signs provenance host-side; the cached entry verifies before mount", async () => {
    const { builder, cache } = makeBuilder({ allowInsecure: true });
    const result = await builder.ensureEnvironmentLayer({
      raw: { pip: ["pandas"] },
      orgId: "org-a",
    });
    if (result.kind !== "ready") throw new Error("expected ready");
    const hit = cache.lookup(result.entry.recipeKey, { orgId: "org-a" });
    expect(hit.hit).toBe(true);
    // Tampering with the stored recipe breaks verification (mount refused).
    result.entry.provenance.recipe.spec = { pip: ["evil"] };
    expect(cache.lookup(result.entry.recipeKey, { orgId: "org-a" })).toEqual({
      hit: false,
      reason: "provenance_invalid",
    });
  });
});
