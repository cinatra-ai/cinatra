#!/usr/bin/env node
/**
 * Verdaccio publish allowlist gate.
 *
 * Parses a git tag of the form `@<scope>/<name>@<semver>` (e.g.
 * `@cinatra-ai/design@0.1.0`), validates it against the configured
 * allowlist + strict semver, prints the parsed `pkg` + `version` on
 * success, exits 1 on rejection. Designed for CI use:
 *
 *   eval "$(node scripts/audit/package-publish-allowlist.mjs "$GITHUB_REF_NAME")"
 *   # exports PUBLISH_PKG=@cinatra-ai/design PUBLISH_VERSION=0.1.0
 *
 * The allowlist is the SINGLE source of truth — any new publishable
 * workspace package must be added here AND the package's own publish
 * metadata (private: false in package.json) must agree. A workspace-
 * internal package (e.g. `@cinatra/agents`) attempting publish via tag
 * push is rejected here, before npm/pnpm ever runs.
 *
 * Exit codes:
 *   0  tag parses + passes allowlist + semver checks
 *   1  parse failure, not in allowlist, or invalid semver
 *
 * Unit tests in scripts/audit/__tests__/package-publish-allowlist.test.mjs.
 */

// The registry-publish allowlist. INTENTIONALLY EMPTY:
// the internal SDK/app packages (@cinatra-ai/sdk-*, @cinatra-ai/design, etc.)
// are NOT marketplace extensions — they stay in the monorepo and are not
// published to registry.cinatra.ai. The registry holds only marketplace-
// published extensions, which are published from their own extracted repos
// (not via this monorepo tag-push gate). With an empty allowlist this gate
// rejects every tag, so no monorepo package can be published to the cinatra
// registry. Re-populating this list is a deliberate operator decision and
// must agree with the package's own publish metadata (`private: false` +
// a publish-worthy `files`/`exports` boundary).
export const PUBLISH_ALLOWLIST = Object.freeze([]);

// Strict semver per the suggested regex on https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
// This is the official semver.org regex verbatim, anchored. Pre-release
// identifiers can be alphanumeric (no leading zero on numeric identifiers);
// build metadata after `+` is alphanumeric + hyphen. Dev-only versions
// (0.0.0-dev.*) are explicitly rejected by the dedicated check below.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Parse + validate a tag.
 *
 * @param {string} tag - e.g. "@cinatra-ai/design@0.1.0"
 * @param {readonly string[]} [allowlist=PUBLISH_ALLOWLIST]
 * @returns {{valid: true, pkg: string, version: string}
 *           | {valid: false, reason: string}}
 */
export function validatePackageTag(tag, allowlist = PUBLISH_ALLOWLIST) {
  if (typeof tag !== "string" || tag.length === 0) {
    return { valid: false, reason: "tag is empty or non-string" };
  }

  // Tag form: <pkg>@<version>. Split on the LAST `@` (not the first —
  // scoped names like `@cinatra-ai/design` contain their own `@`).
  const lastAt = tag.lastIndexOf("@");
  if (lastAt <= 0) {
    return {
      valid: false,
      reason: `tag does not contain a version-separating '@': ${tag}`,
    };
  }
  const pkg = tag.slice(0, lastAt);
  const version = tag.slice(lastAt + 1);

  if (!pkg.startsWith("@")) {
    return {
      valid: false,
      reason: `package name must be a scoped name (start with '@'): ${pkg}`,
    };
  }

  if (!allowlist.includes(pkg)) {
    return {
      valid: false,
      reason: `package not in publish allowlist: ${pkg} (allowed: ${allowlist.join(", ")})`,
    };
  }

  if (version.startsWith("0.0.0-dev.")) {
    return {
      valid: false,
      reason: `dev version not publishable: ${version}`,
    };
  }

  if (!SEMVER_RE.test(version)) {
    return {
      valid: false,
      reason: `invalid semver: ${version}`,
    };
  }

  return { valid: true, pkg, version };
}

// CLI entry — only when run directly (not when imported by tests).
//
// Stable shell-friendly output on success:
//   PUBLISH_PKG=@cinatra-ai/design
//   PUBLISH_VERSION=0.1.0
// On failure, prints `ERROR: <reason>` to stderr and exits 1.
//
// Uses fileURLToPath comparison (guarded on argv[1] presence) rather than
// a substring/endsWith check — the latter spuriously fires when imported
// under `node --eval` because endsWith("") is always true.
const { fileURLToPath } = await import("node:url");
const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const tag = process.argv[2];
  if (!tag) {
    console.error(
      "Usage: package-publish-allowlist.mjs <tag>\n" +
        "  tag form: @<scope>/<name>@<semver>",
    );
    process.exit(1);
  }
  const result = validatePackageTag(tag);
  if (!result.valid) {
    console.error(`ERROR: ${result.reason}`);
    process.exit(1);
  }
  process.stdout.write(`PUBLISH_PKG=${result.pkg}\n`);
  process.stdout.write(`PUBLISH_VERSION=${result.version}\n`);
}
