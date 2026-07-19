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
function fakeDocker(state?: { baseDigest?: string; pipLock?: string; pipIntegrity?: string }) {
  const calls: string[][] = [];
  const baseDigest = state?.baseDigest ?? "sha256:l0base";
  const pipLock = state?.pipLock ?? "pandas==2.2.1\n";
  const pipIntegrity = state?.pipIntegrity ?? "pandas==2.2.1 sha256:deadbeef\n";
  const cli: DockerCli = async (args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[args.length - 1];
      return ok(ref.startsWith("cinatra-sandbox-l1:") ? "sha256:l1img" : baseDigest);
    }
    if (args[0] === "network" && args[1] === "inspect") return ok("true"); // internal
    if (args[0] === "build") return ok();
    if (args[0] === "run") {
      // `... cat <path>` — the LAST arg picks the version lock vs the
      // byte-integrity manifest for this manager.
      const path = args[args.length - 1];
      return ok(path.endsWith(".integrity") ? pipIntegrity : pipLock);
    }
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
    expect(df).toContain(
      "pip install --no-cache-dir --report /opt/cinatra-env/pip.report.json 'pandas==2.2.1'",
    );
    expect(df).toContain("npm install -g --no-fund --no-audit 'prettier'");
    // Every manager freezes its RESOLVED state for recipe-key extraction.
    expect(df).toContain("/opt/cinatra-env/os.lock");
    expect(df).toContain("/opt/cinatra-env/pip.lock");
    expect(df).toContain("/opt/cinatra-env/npm.lock");
    // …and its BYTE-INTEGRITY manifest (cinatra#1708 AC1 byte identity).
    expect(df).toContain("/opt/cinatra-env/os.integrity");
    expect(df).toContain("/opt/cinatra-env/pip.integrity");
    expect(df).toContain("/opt/cinatra-env/npm.integrity");
    // os.integrity must be captured BEFORE the apt lists (holding the .deb
    // SHA256s) are cleared, or the hashes are gone.
    expect(df.indexOf("os.integrity")).toBeLessThan(df.indexOf("rm -rf /var/lib/apt/lists"));
    // Integrity capture is best-effort but SCOPED: EVERY `|| true` must be
    // brace-wrapped (`… || true; }`) so an install/lock failure still fails the
    // RUN (a bare `… || true` would swallow it). And pip integrity reads the
    // INSTALL report, not `pip inspect`.
    const orTrue = (df.match(/\|\| true/g) ?? []).length;
    const bracedOrTrue = (df.match(/\|\| true; \}/g) ?? []).length;
    expect(orTrue).toBeGreaterThan(0);
    expect(bracedOrTrue).toBe(orTrue); // no unscoped best-effort clause
    expect(df).toContain("pip install --no-cache-dir --report /opt/cinatra-env/pip.report.json");
    // os integrity is the DELTA vs an L0 baseline snapshot (captured before
    // apt runs), so inherited-L0 packages don't spuriously bust while every
    // added/upgraded transitive dep IS hashed.
    expect(df).toContain("/opt/cinatra-env/os.baseline");
    expect(df).toContain("comm -13 /opt/cinatra-env/os.baseline /opt/cinatra-env/os.lock");
    expect(df.indexOf("os.baseline")).toBeLessThan(df.indexOf("apt-get install"));
    // Snapshots are filtered to INSTALLED status only (config-files-state
    // entries must not mask a config-files→installed transition in the delta).
    expect(df).toContain("sed -n 's/^installed //p'");
    // npm integrity is a content hash of exactly what was installed.
    expect(df).toContain('cd "$(npm root -g)" && find . -type f -exec sha256sum');
    // Each best-effort manifest is GUARANTEED to exist (`: >` first) so a
    // capture hiccup degrades to an EMPTY manifest (the documented graceful
    // degradation) rather than a missing file the mandatory extraction would
    // hard-fail on. (os.integrity is already guaranteed by its `done >` redirect.)
    expect(df).toContain(": > /opt/cinatra-env/pip.integrity;");
    expect(df).toContain(": > /opt/cinatra-env/npm.integrity;");
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

  it("a byte-differing artifact at the SAME resolved version busts the recipe key (AC1 byte identity)", async () => {
    // Identical declared spec, identical pip.lock (same pinned version) — only
    // the frozen pip.integrity manifest differs (a re-pushed wheel). Each build
    // resolves into its OWN cache (no spec-key fast-path reuse), so both fully
    // extract; their RECIPE keys must differ, so the primary content address
    // can never serve one build's bytes under the other's resolution.
    const fakeA = fakeDocker({ pipIntegrity: "pandas==2.2.1 sha256:AAAA\n" });
    const { builder: builderA } = makeBuilder({ docker: fakeA.cli, allowInsecure: true });
    const a = await builderA.ensureEnvironmentLayer({ raw: { pip: ["pandas==2.2.1"] }, orgId: "o" });

    const fakeB = fakeDocker({ pipIntegrity: "pandas==2.2.1 sha256:BBBB\n" });
    const { builder: builderB } = makeBuilder({ docker: fakeB.cli, allowInsecure: true });
    const b = await builderB.ensureEnvironmentLayer({ raw: { pip: ["pandas==2.2.1"] }, orgId: "o" });

    expect(a.kind === "ready" && b.kind === "ready").toBe(true);
    if (a.kind !== "ready" || b.kind !== "ready") return;
    expect(a.entry.recipeKey).not.toBe(b.entry.recipeKey); // byte drift ⇒ new key
    // The integrity digest actually landed in the signed recipe…
    expect(a.entry.provenance.recipe.resolvedArtifacts.pip.integrity).not.toBe(
      b.entry.provenance.recipe.resolvedArtifacts.pip.integrity,
    );
    // …while the resolved version lock is identical — it was the BYTES that
    // differed, not the resolution.
    expect(a.entry.provenance.recipe.resolvedArtifacts.pip.resolved).toBe(
      b.entry.provenance.recipe.resolvedArtifacts.pip.resolved,
    );
  });

  it("same resolved version AND same bytes ⇒ the SAME content address (deterministic, no spurious bust)", async () => {
    const fakeA = fakeDocker({ pipIntegrity: "pandas==2.2.1 sha256:SAME\n" });
    const { builder: builderA } = makeBuilder({ docker: fakeA.cli, allowInsecure: true });
    const a = await builderA.ensureEnvironmentLayer({ raw: { pip: ["pandas==2.2.1"] }, orgId: "o" });

    const fakeB = fakeDocker({ pipIntegrity: "pandas==2.2.1 sha256:SAME\n" });
    const { builder: builderB } = makeBuilder({ docker: fakeB.cli, allowInsecure: true });
    const b = await builderB.ensureEnvironmentLayer({ raw: { pip: ["pandas==2.2.1"] }, orgId: "o" });

    expect(a.kind === "ready" && b.kind === "ready").toBe(true);
    if (a.kind !== "ready" || b.kind !== "ready") return;
    // Two independent resolutions that froze identical bytes address the SAME
    // recipe key (a shared cache would dedup them to one entry).
    expect(a.entry.recipeKey).toBe(b.entry.recipeKey);
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
    // The build network's internal (no-NAT) property was VERIFIED.
    expect(fake.calls.some((c) => c[0] === "network" && c[1] === "inspect")).toBe(true);
  });

  it("refuses a gateway build on a NON-internal network (fail-closed)", async () => {
    const fake = fakeDocker();
    const routed: DockerCli = async (args) => {
      if (args[0] === "network" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "false\n", stderr: "", stdioOverflow: false, timedOut: false };
      }
      return fake.cli(args);
    };
    const { builder } = makeBuilder({ gateway: true, docker: routed });
    await expect(
      builder.ensureEnvironmentLayer({ raw: { pip: ["pandas"] }, orgId: "org-a" }),
    ).rejects.toThrow(/not a verified internal/);
  });

  it("records the TRUTHFUL insecure-open-network policy under the local-dev escape hatch", async () => {
    const { builder } = makeBuilder({ allowInsecure: true });
    expect(builder.buildPolicy().networkPolicy).toBe("insecure-open-network");
    const result = await builder.ensureEnvironmentLayer({
      raw: { pip: ["pandas"] },
      orgId: "org-a",
    });
    if (result.kind !== "ready") throw new Error("expected ready");
    expect(result.entry.provenance.recipe.buildPolicy.networkPolicy).toBe(
      "insecure-open-network",
    );
    // A gateway builder's identity is the allowlist posture — the two can
    // never alias under one recipe key.
    const { builder: gw } = makeBuilder({ gateway: true });
    expect(gw.buildPolicy().networkPolicy).toBe("registry-allowlist");
  });

  it("applies build resource ceilings and a UNIQUE temp tag per build", async () => {
    const { builder, fake } = makeBuilder({ allowInsecure: true });
    await builder.ensureEnvironmentLayer({ raw: { pip: ["pandas"] }, orgId: "org-a" });
    const build = fake.calls.find((c) => c[0] === "build")!;
    expect(build).toContain("--memory");
    expect(build).toContain("--cpu-shares");
    const tempTag = build[build.indexOf("--tag") + 1];
    expect(tempTag).toMatch(/^cinatra-sandbox-l1:build-[0-9a-f]{24}$/);
  });

  it("resolves the signed digest from the UNIQUE temp tag, never the shared final alias", async () => {
    // codex S3-r1 finding 2: a concurrent same-recipe build (other partition /
    // other process) can retarget the mutable final alias between tagging and
    // inspection — so the digest that gets SIGNED must be read through the
    // unique temp tag, before the final alias exists.
    const { builder, fake } = makeBuilder({ allowInsecure: true });
    // Concurrent same-spec builds in DIFFERENT partitions (not single-flighted).
    const [shared, priv] = await Promise.all([
      builder.ensureEnvironmentLayer({ raw: { pip: ["pandas"] }, orgId: "org-a" }),
      builder.ensureEnvironmentLayer({
        raw: { pip: ["pandas"] },
        orgId: "org-a",
        visibility: "org-private",
      }),
    ]);
    expect(shared.kind).toBe("ready");
    expect(priv.kind).toBe("ready");
    const digestInspects = fake.calls.filter(
      (c) => c[0] === "image" && c[1] === "inspect" && c[c.length - 1].startsWith("cinatra-sandbox-l1:"),
    );
    expect(digestInspects.length).toBeGreaterThan(0);
    for (const call of digestInspects) {
      // EVERY digest resolution over an L1 ref targets a unique build-… temp
      // tag — never the shared cinatra-sandbox-l1:<recipeKey> final alias.
      expect(call[call.length - 1]).toMatch(/^cinatra-sandbox-l1:build-[0-9a-f]{24}$/);
    }
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
