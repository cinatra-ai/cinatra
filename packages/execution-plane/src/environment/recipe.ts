/**
 * L1 environment build recipe + content-address identity (exec-plane S3,
 * cinatra#1708; epic #1705).
 *
 * Cache identity is the FULL EFFECTIVE BUILD RECIPE — never just the declared
 * spec: canonical env spec + L0 base digest + builder version + platform/arch
 * + RESOLVED lockfile/artifact digests + build policy. Any input change is a
 * different recipe key, so "invalidate on any input change" is structural
 * (there is nothing to invalidate — a changed input simply addresses a
 * different entry).
 *
 * Two keys, one doctrine:
 *  - SPEC KEY  — the PRE-resolution inputs (spec, base digest, builder
 *    version, platform, policy). The builder's fast path: an existing layer
 *    built from the same pre-resolution inputs is reused WITHOUT re-resolving
 *    (its installs are already frozen in the immutable layer); re-resolution
 *    happens on an explicit rebuild or when any pre-resolution input changes.
 *  - RECIPE KEY — the full recipe INCLUDING the resolved artifact digests.
 *    The cache's primary content address; two builds that resolved
 *    identically share one entry, a resolution drift (new lockfile) is a new
 *    entry even when the declared spec is unchanged (cinatra#1708 AC1).
 */

import { createHash } from "node:crypto";

import {
  canonicalExecutionEnvironmentJson,
  type ExecutionEnvironmentSpec,
} from "@cinatra-ai/sdk-extensions";

/**
 * Builder identity that participates in cache identity. Bump on ANY change to
 * how the builder renders/install-drives a layer (Dockerfile shape, install
 * flags, lock capture) — a silent builder change must never alias an old
 * layer.
 */
export const ENVIRONMENT_BUILDER_VERSION = "cinatra-env-builder/2";

export type EnvironmentBuildPolicy = {
  /**
   * The EFFECTIVE builder network posture — part of cache identity, so a
   * layer built one way can never alias a layer built another way (codex
   * S3-r0 finding 4):
   *  - `"registry-allowlist"` — the ONLY production posture (epic D3 trust
   *    distinction: run sandboxes may default to open internet, the TRUSTED
   *    BUILDER never does — its egress is registry-allowlisted, always via
   *    the attributing gateway on a verified-internal network);
   *  - `"insecure-open-network"` — the explicit local-dev-only escape hatch
   *    (`allowInsecureLocalDevNetwork`). Recorded truthfully in the recipe +
   *    signed provenance; a production lookup keyed on the allowlist posture
   *    can never hit a layer built open.
   */
  networkPolicy: "registry-allowlist" | "insecure-open-network";
  /** The registry hosts the build may reach (exact or dot-suffix match). */
  registryAllowlist: string[];
};

export type EnvironmentPlatform = {
  /** e.g. "linux" */
  os: string;
  /** e.g. "arm64" / "amd64" */
  arch: string;
};

/** Pre-resolution identity inputs (the SPEC KEY). */
export type EnvironmentSpecKeyInputs = {
  spec: ExecutionEnvironmentSpec;
  /** Immutable content identity of the L0 base (RepoDigest or image ID). */
  l0BaseDigest: string;
  builderVersion: string;
  platform: EnvironmentPlatform;
  buildPolicy: EnvironmentBuildPolicy;
};

/**
 * What a single manager (pip / npm / os) contributed to the recipe key: BOTH
 * layers of identity for the artifacts it froze.
 *
 * TWO DIGESTS, TWO GUARANTEES (cinatra#1708 AC1, byte-identity direction):
 *  - `resolved` — sha256 of the RESOLVED LOCK MANIFEST (pinned name==version
 *    set from pip freeze / npm ls / dpkg-query). VERSION-RESOLUTION identity:
 *    a different pinned set is a different recipe. It does NOT distinguish two
 *    byte-different artifacts that share a version string.
 *  - `integrity` — sha256 of the manager's INTEGRITY MANIFEST: the package
 *    manager's own registry-provided artifact hashes (apt `SHA256:` of each
 *    .deb, pip wheel `archive_info.hashes.sha256`, npm lockfile `integrity`
 *    SRI). CROSS-BUILD BYTE identity: a byte-differing artifact at the SAME
 *    resolved version — a re-pushed wheel, a rebuilt deb — busts the recipe
 *    key, so the cache can never serve one build's bytes under another's
 *    resolution. Missing/unavailable integrity for a package degrades to an
 *    empty token in the manifest: it never weakens the `resolved` binding,
 *    it only strengthens it when the manager surfaces a hash.
 *
 * (`imageDigest` in the signed provenance still binds the WHOLE built layer's
 * bytes; the recipe key now additionally binds the per-artifact bytes so two
 * SEPARATE builds no longer alias merely because their lock manifests matched.)
 */
export type EnvironmentResolvedArtifact = {
  /** sha256 hex of the resolved lock/manifest content (version resolution). */
  resolved: string;
  /** sha256 hex of the manager integrity manifest (registry artifact bytes). */
  integrity: string;
};

/**
 * The FULL effective build recipe (the RECIPE KEY inputs): spec-key inputs
 * plus, per manager, the digests of every RESOLVED artifact the build actually
 * froze (pip lock, npm lock, os package manifest) AND the byte-integrity of
 * those artifacts.
 */
export type EnvironmentBuildRecipe = EnvironmentSpecKeyInputs & {
  /** manager → resolved-lock digest + byte-integrity digest. */
  resolvedArtifacts: Record<string, EnvironmentResolvedArtifact>;
};

function canonicalPolicyJson(policy: EnvironmentBuildPolicy): string {
  return JSON.stringify({
    networkPolicy: policy.networkPolicy,
    registryAllowlist: [...new Set(policy.registryAllowlist.map((h) => h.trim().toLowerCase()))].sort(),
  });
}

/**
 * Deterministic JSON of the per-manager resolved artifacts: outer manager keys
 * sorted, and each entry's fields emitted in a FIXED order so that object
 * key-insertion order (build code / test order) can never change the recipe
 * key. Both `integrity` and `resolved` are bound.
 */
function sortedResolvedArtifactsJson(
  record: Record<string, EnvironmentResolvedArtifact>,
): string {
  const out: Record<string, { integrity: string; resolved: string }> = {};
  for (const key of Object.keys(record).sort()) {
    const artifact = record[key];
    out[key] = { integrity: artifact.integrity, resolved: artifact.resolved };
  }
  return JSON.stringify(out);
}

/** Deterministic JSON of the pre-resolution inputs. */
export function canonicalSpecKeyJson(inputs: EnvironmentSpecKeyInputs): string {
  return JSON.stringify({
    builderVersion: inputs.builderVersion,
    l0BaseDigest: inputs.l0BaseDigest,
    platform: { arch: inputs.platform.arch, os: inputs.platform.os },
    policy: JSON.parse(canonicalPolicyJson(inputs.buildPolicy)) as unknown,
    spec: JSON.parse(canonicalExecutionEnvironmentJson(inputs.spec)) as unknown,
  });
}

/** Deterministic JSON of the FULL recipe. */
export function canonicalRecipeJson(recipe: EnvironmentBuildRecipe): string {
  return JSON.stringify({
    ...(JSON.parse(canonicalSpecKeyJson(recipe)) as Record<string, unknown>),
    resolvedArtifacts: JSON.parse(
      sortedResolvedArtifactsJson(recipe.resolvedArtifacts),
    ) as unknown,
  });
}

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** Content address of the PRE-resolution inputs (builder fast path index). */
export function computeEnvironmentSpecKey(inputs: EnvironmentSpecKeyInputs): string {
  return sha256Hex(canonicalSpecKeyJson(inputs));
}

/** Content address of the FULL effective build recipe (cache identity). */
export function computeEnvironmentRecipeKey(recipe: EnvironmentBuildRecipe): string {
  return sha256Hex(canonicalRecipeJson(recipe));
}

/**
 * sha256 hex of a frozen manifest's content — used for BOTH the resolved lock
 * manifest (version resolution) and the manager integrity manifest (artifact
 * bytes). Same content ⇒ same digest; any byte difference ⇒ a new digest.
 */
export function resolvedArtifactDigest(content: string): string {
  return sha256Hex(content);
}
