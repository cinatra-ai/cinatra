/**
 * Trusted L1 environment builder (exec-plane S3, cinatra#1708; epic #1705).
 *
 * Builds immutable, content-addressed environment layers from a declared
 * spec: a derived image `FROM` the digest-pinned L0 base, package installs
 * run as ROOT at BUILD time only (the only place OS-level deps enter besides
 * L0, epic D2), then the image drops back to the fixed non-root runtime UID —
 * preserved across every derived L1 layer (cinatra#1708).
 *
 * TRUST DISTINCTION (epic D3): run sandboxes may default to open internet;
 * the BUILDER never does. Build egress is registry-allowlisted and transits
 * the attributing egress gateway (build-args carry the proxy env; the build
 * runs on the internal no-NAT network). Without a gateway the builder REFUSES
 * to build (fail-closed) unless the caller explicitly opts into the
 * local-dev-only open network.
 *
 * LIFECYCLE-SCRIPT ISOLATION (cinatra#1708): package lifecycle scripts (npm
 * postinstall, pip build hooks) run INSIDE the build container, which is
 * handed NOTHING but the enumerated proxy variables — no provenance key, no
 * cache-write credential, no host environment. The cache write and the
 * provenance signature happen HOST-SIDE after the container exited;
 * `assertNoCredentialBuildArgs` pins the invariant on every build argv.
 *
 * Cache flow (cinatra#1708 AC1):
 *  1. canonical spec + L0 base digest + builder version + platform + policy
 *     → SPEC KEY; an existing verified layer for the spec key is reused
 *     WITHOUT re-resolving (single build across same-recipe agents).
 *  2. otherwise build once, extract the RESOLVED lock artifacts from the
 *     image, fold their digests into the FULL RECIPE KEY, tag the image
 *     content-addressed, sign provenance, insert into the cache.
 *  A change to base digest / builder version / resolved lockfile digests is a
 *  different key even when the declared spec is unchanged.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  isEmptyExecutionEnvironment,
  parseExecutionEnvironment,
  type ExecutionEnvironmentSpec,
} from "@cinatra-ai/sdk-extensions";

import { runDocker, type DockerCli } from "../docker-cli";
import { assertSafeImageRef, SANDBOX_RUNTIME_GID, SANDBOX_RUNTIME_UID } from "../l0-profile";
import { registerJobEgress } from "../egress";
import type { EgressGatewayEndpoint } from "../types";
import {
  computeEnvironmentRecipeKey,
  computeEnvironmentSpecKey,
  resolvedArtifactDigest,
  ENVIRONMENT_BUILDER_VERSION,
  type EnvironmentBuildPolicy,
  type EnvironmentBuildRecipe,
  type EnvironmentPlatform,
  type EnvironmentResolvedArtifact,
} from "./recipe";
import { signEnvironmentProvenance } from "./provenance";
import {
  EnvironmentLayerCache,
  type EnvironmentLayerCacheEntry,
  type EnvironmentLayerPartition,
} from "./cache";

/** Content-addressed L1 image tag prefix (local/dev naming; prod may re-tag). */
export const L1_IMAGE_REPO = "cinatra-sandbox-l1";

/** Where the build freezes its resolved lock artifacts inside the image. */
export const ENV_LOCK_DIR = "/opt/cinatra-env";

/**
 * Default registry allowlist for builds: the three package registries the
 * three managers resolve from (exact or dot-suffix match at the gateway).
 */
export const DEFAULT_BUILD_REGISTRY_ALLOWLIST = [
  "deb.debian.org",
  "security.debian.org",
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
];

/** The ONLY variables a build may receive (proxy plumbing; identity, no secrets). */
const ALLOWED_BUILD_ARG_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
]);

/**
 * Invariant: no credential-bearing argument enters `docker build`. Every
 * `--build-arg` key must be in the enumerated proxy set, and no `--secret` /
 * `--ssh` forwarding is ever present. A violation is a bug, not a policy
 * choice (mirrors `assertNoBindMounts`).
 */
export function assertNoCredentialBuildArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--build-arg") {
      const key = (args[i + 1] ?? "").split("=")[0];
      if (!ALLOWED_BUILD_ARG_KEYS.has(key)) {
        throw new Error(
          `execution-plane invariant violated: non-proxy --build-arg "${key}" in builder argv ` +
            `(lifecycle-script isolation: a build receives proxy plumbing only, never credentials)`,
        );
      }
    }
    if (args[i] === "--secret" || args[i] === "--ssh") {
      throw new Error(
        `execution-plane invariant violated: ${args[i]} forwarding in builder argv`,
      );
    }
  }
}

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Per-manager INTEGRITY-manifest capture (cinatra#1708 AC1, byte-identity).
 *
 * Alongside the version-resolution lock, each manager freezes a deterministic
 * manifest of the ACTUALLY-INSTALLED artifact bytes (never a re-declaration or
 * a second, detachable resolution), so a byte-differing artifact at the same
 * version busts the recipe key. Each reads the manager's authoritative
 * installed-byte source:
 *  - os  → the DELTA of installed packages vs the L0 baseline (captured before
 *    apt runs), each with `apt-cache show` `SHA256:` (the published .deb byte
 *    hash). The delta covers every package apt actually ADDED or UPGRADED —
 *    including transitive deps — while excluding inherited-L0 packages (already
 *    bound by `l0BaseDigest`), so unchanged base packages cannot spuriously
 *    bust the key. Reads the real installed `name=version`, so a pinned
 *    `pkg=ver` declaration resolves correctly.
 *  - pip → `pip install --report` `download_info.archive_info.hashes.sha256`
 *    (the wheel/sdist byte hash the resolver actually downloaded). This is the
 *    report OF the same install — NOT a detached re-resolution. NOTE: the
 *    hashes live in the INSTALL report, not `pip inspect`.
 *  - npm → a content hash (`sha256sum`) of every file the global install
 *    actually wrote under `npm root -g`, sorted by path. Binds the mounted
 *    bytes directly (covers transitive; no separate resolution that could
 *    describe different bytes than were installed).
 *
 * Each is best-effort: the whole capture is wrapped `{ … || true; }` at the
 * call site (NEVER inline `|| true`, which would let an install/lock failure
 * report build success). A manager that cannot surface a hash contributes an
 * empty manifest — the integrity binding only ever STRENGTHENS the version
 * lock, never weakens it. Emitted sorted for build-to-build determinism. The
 * exact real-daemon output is validated by the slice-D E2E; THIS slice binds
 * the manifest into the cache identity. POSIX-sh only (docker RUN is dash) —
 * no process substitution / bashisms.
 */
/**
 * Snapshot the set of ACTUALLY-INSTALLED packages, `name=version`, sorted.
 * Filters `db:Status-Status == installed` so packages in `config-files` (or
 * any other non-installed) state never appear — otherwise a config-files→
 * installed transition at the same version would leave `os.baseline` and
 * `os.lock` identical and the delta would miss the now-installed bytes.
 * Uses `binary:Package` for multi-arch-safe identity.
 */
const DPKG_INSTALLED_SNAPSHOT =
  `dpkg-query -W -f='\${db:Status-Status} \${binary:Package}=\${Version}\\n' 2>/dev/null ` +
  `| sed -n 's/^installed //p' | LC_ALL=C sort`;

function osIntegrityCapture(): string {
  // os.baseline (pre-install) and os.lock (post-install) are both LC_ALL=C
  // sorted, so `comm -13` yields exactly the added/upgraded packages.
  return (
    `comm -13 ${ENV_LOCK_DIR}/os.baseline ${ENV_LOCK_DIR}/os.lock ` +
    `| while IFS= read -r pv; do ` +
    `printf '%s %s\\n' "$pv" ` +
    `"$(apt-cache show "$pv" 2>/dev/null | awk -F': ' '/^SHA256: /{print $2; exit}')"; ` +
    `done > ${ENV_LOCK_DIR}/os.integrity`
  );
}

function pipIntegrityCapture(): string {
  // Parse the install report written by `pip install --report` (same install).
  // Guarantee the manifest EXISTS first (`: >`), so a best-effort python hiccup
  // leaves an EMPTY manifest (the documented graceful degradation) rather than
  // a missing file that the mandatory extraction would hard-fail on.
  return (
    `: > ${ENV_LOCK_DIR}/pip.integrity; ` +
    `python3 -c 'import json;` +
    `d=json.load(open("${ENV_LOCK_DIR}/pip.report.json"));` +
    `rows=sorted("%s==%s %s"%(i["metadata"]["name"],i["metadata"]["version"],` +
    `i.get("download_info",{}).get("archive_info",{}).get("hashes",{}).get("sha256","")) ` +
    `for i in d.get("install",[]));` +
    `open("${ENV_LOCK_DIR}/pip.integrity","w").write("\\n".join(rows)+"\\n")'`
  );
}

function npmIntegrityCapture(): string {
  // Content hash of exactly what the global install wrote (path-sorted).
  // Guarantee the manifest EXISTS first (`: >`), so a best-effort `cd` failure
  // leaves an EMPTY manifest (the documented graceful degradation) rather than
  // a missing file that the mandatory extraction would hard-fail on.
  return (
    `: > ${ENV_LOCK_DIR}/npm.integrity; ` +
    `cd "$(npm root -g)" && find . -type f -exec sha256sum {} + ` +
    `| LC_ALL=C sort -k2 > ${ENV_LOCK_DIR}/npm.integrity`
  );
}

/**
 * Render the deterministic build Dockerfile for a CANONICAL spec. Pure —
 * unit-tested as the build contract. Root at build time only; the final
 * `USER` pins the fixed non-root runtime identity so every derived L1 layer
 * preserves it. Each manager freezes its RESOLVED state into ENV_LOCK_DIR
 * (world-readable) for post-build extraction.
 */
export function renderEnvironmentDockerfile(
  spec: ExecutionEnvironmentSpec,
  opts: { baseImageRef: string },
): string {
  const lines: string[] = [
    `# generated by ${ENVIRONMENT_BUILDER_VERSION} — do not edit`,
    `FROM ${assertSafeImageRef(opts.baseImageRef)}`,
    // Root at BUILD time only (epic D2). The base image pins a non-root USER;
    // installs need root; the tail drops back to the runtime UID.
    `USER 0:0`,
    `ARG HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy`,
    `RUN mkdir -p ${ENV_LOCK_DIR} && chmod 0755 ${ENV_LOCK_DIR}`,
  ];
  if (spec.os && spec.os.length > 0) {
    const pkgs = spec.os.map(shQuote).join(" ");
    // Snapshot the installed set BEFORE apt runs (the L0 baseline), install,
    // freeze the sorted post-install closure to os.lock, then capture
    // os.integrity for the DELTA — all before clearing the apt lists, whose
    // metadata carries the .deb SHA256s. The integrity capture is best-effort
    // ({ … || true; }); baseline / install / lock are NOT — a failure there
    // must fail the RUN.
    lines.push(
      `RUN ${DPKG_INSTALLED_SNAPSHOT} > ${ENV_LOCK_DIR}/os.baseline ` +
        `&& apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkgs} ` +
        `&& ${DPKG_INSTALLED_SNAPSHOT} > ${ENV_LOCK_DIR}/os.lock ` +
        `&& { ${osIntegrityCapture()} || true; } ` +
        `&& rm -rf /var/lib/apt/lists/*`,
    );
  }
  if (spec.pip && spec.pip.length > 0) {
    const pkgs = spec.pip.map(shQuote).join(" ");
    lines.push(
      `RUN pip install --no-cache-dir --report ${ENV_LOCK_DIR}/pip.report.json ${pkgs} ` +
        `&& pip freeze > ${ENV_LOCK_DIR}/pip.lock ` +
        `&& { ${pipIntegrityCapture()} || true; }`,
    );
  }
  if (spec.npm && spec.npm.length > 0) {
    const pkgs = spec.npm.map(shQuote).join(" ");
    lines.push(
      `RUN npm install -g --no-fund --no-audit ${pkgs} ` +
        `&& npm ls -g --all --json > ${ENV_LOCK_DIR}/npm.lock ` +
        `&& { ${npmIntegrityCapture()} || true; }`,
    );
  }
  lines.push(`RUN chmod -R a+r ${ENV_LOCK_DIR}`);
  // Preserve the fixed non-root runtime identity across derived L1 layers.
  lines.push(`USER ${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`);
  return lines.join("\n") + "\n";
}

/**
 * Build the `docker build` argv (without the leading binary). Pure. The
 * credential invariant is asserted on the RESULT, every time.
 */
/** Best-effort daemon-side build resource ceilings (hygiene, not the boundary). */
export type EnvironmentBuildResources = {
  memoryMb: number;
  cpuShares: number;
};

export const DEFAULT_BUILD_RESOURCES: EnvironmentBuildResources = {
  memoryMb: 2048,
  cpuShares: 512,
};

export function buildEnvironmentImageArgs(opts: {
  contextDir: string;
  tag: string;
  network?: string;
  proxyUrl?: string;
  platform?: EnvironmentPlatform;
  resources?: EnvironmentBuildResources;
}): string[] {
  const args = ["build", "--tag", opts.tag, "--file", join(opts.contextDir, "Dockerfile")];
  if (opts.platform) args.push("--platform", `${opts.platform.os}/${opts.platform.arch}`);
  if (opts.network) args.push("--network", opts.network);
  // Resource ceilings on the BUILD (codex S3-r0 finding 5): lifecycle scripts
  // run as root inside the build, so cap what the build can take from the
  // daemon host. Classic-builder flags; best-effort under BuildKit — the
  // hard capacity boundary remains the deployment layer's builder placement.
  const res = opts.resources ?? DEFAULT_BUILD_RESOURCES;
  args.push("--memory", `${res.memoryMb}m`, "--cpu-shares", String(res.cpuShares));
  if (opts.proxyUrl) {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      args.push("--build-arg", `${key}=${opts.proxyUrl}`);
    }
    args.push("--build-arg", "NO_PROXY=localhost,127.0.0.1", "--build-arg", "no_proxy=localhost,127.0.0.1");
  }
  args.push(opts.contextDir);
  assertNoCredentialBuildArgs(args);
  return args;
}

/** Resolve an image ref to its immutable content identity (image ID). */
export async function resolveImageDigest(
  imageRef: string,
  docker: DockerCli = runDocker,
): Promise<string> {
  const outcome = await docker(["image", "inspect", "--format", "{{.Id}}", assertSafeImageRef(imageRef)]);
  if (outcome.exitCode !== 0) {
    throw new Error(`Failed to inspect image ${imageRef}: ${outcome.stderr.trim()}`);
  }
  const digest = outcome.stdout.trim();
  if (!digest) throw new Error(`Image ${imageRef} resolved to an empty digest`);
  return digest;
}

export class EnvironmentBuildRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentBuildRefusedError";
  }
}

export type TrustedEnvironmentBuilderOptions = {
  cache: EnvironmentLayerCache;
  /** HMAC key for provenance signing (host-held; NEVER enters a container). */
  provenanceKey: string;
  docker?: DockerCli;
  /** L0 base image reference (digest-pinned in prod; dev tag locally). */
  l0ImageRef: string;
  platform: EnvironmentPlatform;
  buildPolicy?: EnvironmentBuildPolicy;
  /**
   * Attributing egress gateway for build egress (registry-allowlisted).
   * Absent + no local-dev opt-in ⇒ every non-empty build is REFUSED
   * fail-closed.
   */
  gateway?: EgressGatewayEndpoint;
  /** Docker network for gateway builds (the internal no-NAT network). */
  buildNetwork?: string;
  /**
   * EXPLICIT local-dev escape hatch: build over the default docker network
   * with no gateway. Never the default; deployment never sets it.
   */
  allowInsecureLocalDevNetwork?: boolean;
  /** Per-build wall-clock ceiling (docker build). */
  buildTimeoutMs?: number;
  now?: () => number;
  /** Test seam: registration of the build egress policy at the gateway. */
  registerEgress?: typeof registerJobEgress;
};

export type EnsureEnvironmentLayerResult =
  | { kind: "no-environment" }
  | { kind: "ready"; entry: EnvironmentLayerCacheEntry; cacheHit: boolean };

export class TrustedEnvironmentBuilder {
  private readonly opts: TrustedEnvironmentBuilderOptions;
  private readonly docker: DockerCli;
  private readonly inflight = new Map<string, Promise<EnsureEnvironmentLayerResult>>();

  constructor(opts: TrustedEnvironmentBuilderOptions) {
    this.opts = opts;
    this.docker = opts.docker ?? runDocker;
  }

  /**
   * The EFFECTIVE build policy — truthful to the actual network posture
   * (codex S3-r0 finding 4): with a gateway this is the registry-allowlist
   * posture; under the explicit local-dev escape hatch it is
   * `insecure-open-network`, a DISTINCT cache identity that can never alias
   * a gateway-built layer.
   */
  buildPolicy(): EnvironmentBuildPolicy {
    const allowlist =
      this.opts.buildPolicy?.registryAllowlist ?? DEFAULT_BUILD_REGISTRY_ALLOWLIST;
    if (!this.opts.gateway && this.opts.allowInsecureLocalDevNetwork) {
      return { networkPolicy: "insecure-open-network", registryAllowlist: allowlist };
    }
    return { networkPolicy: "registry-allowlist", registryAllowlist: allowlist };
  }

  /**
   * Ensure a mountable L1 layer for a DECLARED environment. `raw` is the
   * UNVALIDATED declaration (manifest pass-through or project-agent config);
   * it goes through the fail-closed parser HERE — the builder never consumes
   * unparsed bytes. `visibility: "org-private"` partitions the layer to the
   * org (private-package recipes); default is instance-shared.
   *
   * Same-spec calls are single-flighted, so two same-recipe agents get ONE
   * build (AC1).
   */
  async ensureEnvironmentLayer(input: {
    raw: unknown;
    orgId: string;
    visibility?: "shared" | "org-private";
  }): Promise<EnsureEnvironmentLayerResult> {
    const parsed = parseExecutionEnvironment(input.raw);
    if (!parsed.ok) {
      throw new EnvironmentBuildRefusedError(
        `Refusing to build from an invalid environment declaration:\n- ${parsed.errors.join("\n- ")}`,
      );
    }
    if (isEmptyExecutionEnvironment(parsed.spec)) return { kind: "no-environment" };

    const l0BaseDigest = await resolveImageDigest(this.opts.l0ImageRef, this.docker);
    const specKey = computeEnvironmentSpecKey({
      spec: parsed.spec,
      l0BaseDigest,
      builderVersion: ENVIRONMENT_BUILDER_VERSION,
      platform: this.opts.platform,
      buildPolicy: this.buildPolicy(),
    });

    const partition: EnvironmentLayerPartition =
      input.visibility === "org-private" ? `org:${input.orgId}` : "instance";
    const flightKey = `${specKey}|${partition}`;
    const existing = this.inflight.get(flightKey);
    if (existing) return existing;
    const flight = this.ensureForSpecKey({
      spec: parsed.spec,
      specKey,
      l0BaseDigest,
      orgId: input.orgId,
      partition,
    }).finally(() => {
      this.inflight.delete(flightKey);
    });
    this.inflight.set(flightKey, flight);
    return flight;
  }

  private async ensureForSpecKey(input: {
    spec: ExecutionEnvironmentSpec;
    specKey: string;
    l0BaseDigest: string;
    orgId: string;
    partition: EnvironmentLayerPartition;
  }): Promise<EnsureEnvironmentLayerResult> {
    // An org-private request enforces its EXACT partition (codex S3-r0
    // finding 8): it never resolves to a differently-placed layer.
    const requiredPartition =
      input.partition === "instance" ? undefined : input.partition;
    const cached = this.opts.cache.lookupBySpecKey(input.specKey, {
      orgId: input.orgId,
      ...(requiredPartition ? { requiredPartition } : {}),
    });
    if (cached.hit) return { kind: "ready", entry: cached.entry, cacheHit: true };

    // ---- egress posture (fail-closed) -------------------------------------
    const policy = this.buildPolicy();
    let network: string | undefined;
    let proxyUrl: string | undefined;
    if (this.opts.gateway) {
      const buildToken = `envbuild-${randomBytes(12).toString("hex")}`;
      const register = this.opts.registerEgress ?? registerJobEgress;
      await register(this.opts.gateway, buildToken, {
        mode: "allowlist",
        allowlist: policy.registryAllowlist,
      });
      network = this.opts.buildNetwork ?? "cinatra-exec-internal";
      // The gateway posture is only real if the build network is actually a
      // no-NAT internal network (codex S3-r0 finding 4) — verify, fail-closed.
      await this.assertInternalNetwork(network);
      proxyUrl = `http://${buildToken}:x@${this.opts.gateway.host}:${this.opts.gateway.port}`;
    } else if (!this.opts.allowInsecureLocalDevNetwork) {
      throw new EnvironmentBuildRefusedError(
        "Refusing to build an environment layer without the attributing egress " +
          "gateway (builder egress is registry-allowlisted, epic D3). Configure " +
          "the gateway, or — local dev ONLY — set allowInsecureLocalDevNetwork.",
      );
    }

    // ---- build once -------------------------------------------------------
    const contextDir = await mkdtemp(join(tmpdir(), "cinatra-env-build-"));
    // UNIQUE per build (codex S3-r0 finding 6): concurrent builds of the same
    // spec (other partitions / other processes) must never share or remove
    // each other's temp tag.
    const tempTag = `${L1_IMAGE_REPO}:build-${randomBytes(12).toString("hex")}`;
    try {
      const dockerfile = renderEnvironmentDockerfile(input.spec, {
        baseImageRef: this.opts.l0ImageRef,
      });
      await writeFile(join(contextDir, "Dockerfile"), dockerfile, "utf8");
      const args = buildEnvironmentImageArgs({
        contextDir,
        tag: tempTag,
        network,
        proxyUrl,
        platform: this.opts.platform,
      });
      const outcome = await this.docker(args, {
        timeoutMs: this.opts.buildTimeoutMs ?? 15 * 60_000,
      });
      if (outcome.exitCode !== 0) {
        throw new Error(
          `Environment layer build failed (exit ${outcome.exitCode}): ${outcome.stderr.slice(-2000)}`,
        );
      }
    } finally {
      await rm(contextDir, { recursive: true, force: true });
    }

    // ---- extract resolved artifacts → FULL recipe key ---------------------
    // Per manager, freeze BOTH manifests: the version-resolution lock and the
    // byte-integrity manifest. The recipe key binds both (cinatra#1708 AC1) so
    // a byte-differing artifact at the same resolved version busts the key.
    const resolvedArtifacts: Record<string, EnvironmentResolvedArtifact> = {};
    const managers: Array<[string, string]> = [];
    if (input.spec.os?.length) managers.push(["os", "os"]);
    if (input.spec.pip?.length) managers.push(["pip", "pip"]);
    if (input.spec.npm?.length) managers.push(["npm", "npm"]);
    for (const [manager, stem] of managers) {
      const resolved = resolvedArtifactDigest(
        await this.extractLockFile(tempTag, manager, `${ENV_LOCK_DIR}/${stem}.lock`),
      );
      const integrity = resolvedArtifactDigest(
        await this.extractLockFile(tempTag, manager, `${ENV_LOCK_DIR}/${stem}.integrity`),
      );
      resolvedArtifacts[manager] = { resolved, integrity };
    }

    const recipe: EnvironmentBuildRecipe = {
      spec: input.spec,
      l0BaseDigest: input.l0BaseDigest,
      builderVersion: ENVIRONMENT_BUILDER_VERSION,
      platform: this.opts.platform,
      buildPolicy: policy,
      resolvedArtifacts,
    };
    const recipeKey = computeEnvironmentRecipeKey(recipe);

    // Another resolution may have produced this exact recipe already.
    const raced = this.opts.cache.lookup(recipeKey, {
      orgId: input.orgId,
      ...(requiredPartition ? { requiredPartition } : {}),
    });
    if (raced.hit) {
      await this.docker(["rmi", tempTag]);
      return { kind: "ready", entry: raced.entry, cacheHit: true };
    }

    // ---- content-addressed tag + host-side provenance + cache write -------
    // Digest is resolved from the UNIQUE temp tag BEFORE the shared final
    // alias exists (codex S3-r1 finding 2): a concurrent same-recipe build in
    // another partition can retarget the mutable final alias between tagging
    // and inspection, so the signed identity must never be read through it.
    const imageDigest = await resolveImageDigest(tempTag, this.docker);
    // FULL recipe key in the tag (codex S3-r0 finding 6): 64 hex chars fits
    // docker's 128-char tag limit; no truncation-collision surface.
    const finalTag = `${L1_IMAGE_REPO}:${recipeKey}`;
    const tag = await this.docker(["tag", tempTag, finalTag]);
    if (tag.exitCode !== 0) {
      throw new Error(`Failed to tag environment layer: ${tag.stderr.trim()}`);
    }
    await this.docker(["rmi", tempTag]);
    const now = (this.opts.now ?? Date.now)();
    const provenance = signEnvironmentProvenance(
      {
        recipeKey,
        recipe,
        imageDigest,
        partition: input.partition,
        builderIdentity: ENVIRONMENT_BUILDER_VERSION,
        builtAtMs: now,
      },
      this.opts.provenanceKey,
    );
    const entry: EnvironmentLayerCacheEntry = {
      recipeKey,
      specKey: input.specKey,
      imageRef: finalTag,
      imageDigest,
      partition: input.partition,
      provenance,
      builtAtMs: now,
      lastUsedAtMs: now,
    };
    this.opts.cache.put(entry);
    return { kind: "ready", entry, cacheHit: false };
  }

  /**
   * Read one frozen manifest (lock or integrity) out of the built layer, in a
   * throwaway network-none container running as the fixed runtime UID. The
   * exact bytes are what feed the recipe-key digest.
   */
  private async extractLockFile(
    tempTag: string,
    manager: string,
    path: string,
  ): Promise<string> {
    const read = await this.docker([
      "run", "--rm", "--network", "none",
      "--user", `${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`,
      "--", tempTag, "cat", path,
    ]);
    if (read.exitCode !== 0) {
      throw new Error(
        `Failed to extract ${manager} ${path.endsWith(".integrity") ? "integrity manifest" : "lock"} ` +
          `from the built layer: ${read.stderr.trim()}`,
      );
    }
    return read.stdout;
  }

  /**
   * Verify the build network is a docker `--internal` (no-NAT) network —
   * the gateway posture is only enforceable on a network with no direct
   * route out. Fail-closed on inspect failure or `Internal != true`.
   */
  private async assertInternalNetwork(network: string): Promise<void> {
    const outcome = await this.docker([
      "network",
      "inspect",
      "--format",
      "{{.Internal}}",
      network,
    ]);
    if (outcome.exitCode !== 0 || outcome.stdout.trim() !== "true") {
      throw new EnvironmentBuildRefusedError(
        `Build network "${network}" is not a verified internal (no-NAT) docker network ` +
          `(inspect ${outcome.exitCode !== 0 ? "failed" : `reported Internal=${outcome.stdout.trim()}`}); ` +
          `refusing the build — the registry-allowlist posture would be fictional on a routed network.`,
      );
    }
  }
}
