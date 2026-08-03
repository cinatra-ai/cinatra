// ---------------------------------------------------------------------------
// The ONE extension-spec parser (cinatra#2331).
//
// The host declares its extension set as `cinatra.systemExtensions` in the root
// package.json: an array of RANGED specs, `"@scope/name@<range>"`. Before
// cinatra#2331 the same set was declared twice — bare names in
// `cinatra.systemExtensions` and ranged specs in `cinatra.extensions` — and
// SEVEN independent `lastIndexOf("@")` splits existed across the repo (the app,
// the audit gate, the lock regenerator, the prune script, the prod-boot E2E,
// the in-repo CLI helper, an integration test), each with its own tolerance for
// a malformed entry. This module replaces all of them.
//
// Plain ESM `.mjs`, NO imports, NO `server-only`, NO `@/` aliases, no I/O —
// pure string functions over already-read JSON. That is deliberate: the
// canonical reader used to live in `packages/extensions/src/required-in-prod.ts`,
// which pulls in `server-only` plus the canonical store, so no `.mjs` script
// could reuse it and every script grew its own copy. Importable from:
//   - TS in-process callers (`allowJs` is on) —
//     `import { parseExtensionSpec } from "./extension-spec.mjs"`;
//   - plain `.mjs` scripts under `scripts/` by relative path;
//   - a host-side driver for the prod-boot E2E, which extracts the raw
//     declaration out of the running image and parses it HERE rather than
//     re-implementing the split in an inline `node -e`.
//
// STRICTNESS (the contract that changes with the collapse): the ranges are
// LOAD-BEARING. A bare entry used to parse to `versionRange === null`, which
// passes the install/update pin gate unrestricted while lock verification
// requires a range — a silent hole. So this parser REJECTS a bare entry and a
// trailing-`@` (empty range) entry rather than tolerating either. Every reader
// built on it fails closed on a missing, empty, malformed or rangeless
// declaration.
// ---------------------------------------------------------------------------

/**
 * A scoped package name: `@scope/name`. The extension layout (both the
 * `extensions/<scope>/<name>` on-disk tree and the registry identity) supports
 * nothing else, so an unscoped name is a malformed spec, not an exotic one.
 * Both segments must START and END alphanumeric — npm forbids a leading `.`
 * or `_`, and a trailing one is a typo, never an identity.
 */
const SCOPED_PACKAGE_NAME_RE = /^@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** npm's hard limit on a package name (scope included). */
const MAX_PACKAGE_NAME_LENGTH = 214;

/**
 * The SHAPE of a semver range — digits plus the range grammar's own
 * punctuation. This is deliberately structural, not semantic: it rejects the
 * things that are not ranges at all (`latest` and other dist-tags, `file:`
 * and `git+https:` specifiers, a URL, an empty token) without re-implementing
 * semver. Full range VALIDATION stays with the semver-capable callers (the
 * lock regenerator and the install/update pin gate both already run semver),
 * which fail closed on a range this shape check lets through.
 */
const VERSION_RANGE_SHAPE_RE = /^[0-9xX*][0-9A-Za-z.\-+*xX\s|<>=~^]*$|^[*~^<>=][0-9A-Za-z.\-+*xX\s|<>=~^]*$/;

/**
 * @typedef {{ packageName: string, versionRange: string }} ExtensionSpec
 * A parsed declaration entry. `versionRange` is never null and never empty —
 * an entry that would produce one is rejected, not softened.
 */

/**
 * @typedef {{ ok: true, spec: ExtensionSpec } | { ok: false, reason: string }} ExtensionSpecResult
 */

/**
 * Parse ONE declaration entry, returning a result rather than throwing, so a
 * caller can report EVERY defect in a declaration instead of only the first.
 *
 * The split is on the LAST `@` at index > 0 — a scoped name starts with `@`
 * (index 0), so that `@` is part of the name, never a separator.
 *
 * @param {unknown} entry
 * @returns {ExtensionSpecResult}
 */
export function parseExtensionSpecResult(entry) {
  if (typeof entry !== "string") {
    return { ok: false, reason: `expected a string, got ${entry === null ? "null" : typeof entry}` };
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty entry" };
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) {
    return {
      ok: false,
      reason: `"${trimmed}" carries no version range — every entry must be "<@scope/name>@<range>"`,
    };
  }
  const packageName = trimmed.slice(0, at);
  const versionRange = trimmed.slice(at + 1).trim();
  if (versionRange.length === 0) {
    return {
      ok: false,
      reason: `"${trimmed}" has an empty version range (trailing "@")`,
    };
  }
  if (!SCOPED_PACKAGE_NAME_RE.test(packageName) || packageName.length > MAX_PACKAGE_NAME_LENGTH) {
    return {
      ok: false,
      reason: `"${trimmed}" does not name a scoped package (@scope/name)`,
    };
  }
  if (!VERSION_RANGE_SHAPE_RE.test(versionRange)) {
    return {
      ok: false,
      reason: `"${trimmed}" does not carry a version RANGE — a dist-tag, URL or other specifier is not a range`,
    };
  }
  return { ok: true, spec: { packageName, versionRange } };
}

/**
 * Parse ONE declaration entry, THROWING on any defect. The strict form every
 * in-repo reader uses; `parseExtensionSpecResult` is for the readers that
 * aggregate defects.
 *
 * @param {unknown} entry
 * @param {string} [context] prefix for the error message (e.g. the file read)
 * @returns {ExtensionSpec}
 */
export function parseExtensionSpec(entry, context = "extension spec") {
  const result = parseExtensionSpecResult(entry);
  if (!result.ok) throw new Error(`${context}: ${result.reason}`);
  return result.spec;
}

/**
 * Parse a WHOLE declaration array. Fails closed and reports every defect at
 * once: a non-array, an EMPTY array, any malformed/bare/rangeless entry, and a
 * duplicated package name (the specs are consumed as a name-keyed set, so a
 * duplicate would silently drop one entry's range).
 *
 * @param {unknown} declared the raw `cinatra.systemExtensions` value
 * @param {string} [context] prefix for the error message
 * @returns {ExtensionSpec[]} in declaration order
 */
export function parseExtensionSpecs(declared, context = "cinatra.systemExtensions") {
  if (!Array.isArray(declared)) {
    throw new Error(`${context}: must be an array of "<@scope/name>@<range>" specs`);
  }
  if (declared.length === 0) {
    throw new Error(`${context}: must not be empty — the host declares its extension set here`);
  }
  const specs = [];
  const defects = [];
  const seen = new Set();
  for (const [i, entry] of declared.entries()) {
    const result = parseExtensionSpecResult(entry);
    if (!result.ok) {
      defects.push(`[${i}]: ${result.reason}`);
      continue;
    }
    if (seen.has(result.spec.packageName)) {
      defects.push(`[${i}]: duplicate package ${result.spec.packageName}`);
      continue;
    }
    seen.add(result.spec.packageName);
    specs.push(result.spec);
  }
  if (defects.length > 0) {
    throw new Error(`${context}: invalid declaration:\n  - ${defects.join("\n  - ")}`);
  }
  return specs;
}

/**
 * The declared package NAMES, ranges stripped — the shape every name-keyed
 * consumer wants (system-extension inventory, the generated-manifest
 * classification, the lock bijection, the prune script). Same fail-closed
 * validation as `parseExtensionSpecs`.
 *
 * @param {unknown} declared
 * @param {string} [context]
 * @returns {string[]}
 */
export function parseExtensionSpecNames(declared, context = "cinatra.systemExtensions") {
  return parseExtensionSpecs(declared, context).map((s) => s.packageName);
}

/**
 * Strip the range off ONE entry (validating it), for the readers that key on
 * names only.
 *
 * @param {unknown} entry
 * @param {string} [context]
 * @returns {string}
 */
export function extensionSpecName(entry, context = "extension spec") {
  return parseExtensionSpec(entry, context).packageName;
}
