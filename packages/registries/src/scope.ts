// Vendor-scope helpers for the install-time dependency-confusion gate.
//
// The dependency resolver confines an install's dependency tree to an
// allowlist of npm scope prefixes. That allowlist is keyed on the ROOT
// package being installed — its own vendor scope plus the first-party
// base-layer scope — NEVER on the installing instance's namespace. The
// instance namespace is a publish-time concept (an instance publishes under
// its own scope); keying the install gate on it meant any instance whose
// namespace wasn't literally "cinatra-ai" could not install first-party
// packages at all (issue #103).
//
// NOTE: this module intentionally has no server-only guard — the package must
// load in plain Node contexts (CLI, vitest, scripts).

/**
 * The canonical first-party vendor scope. First-party packages are the shared
 * SDK/base layer that marketplace extensions of every vendor may depend on,
 * so this scope is always part of the dependency-scope allowlist.
 */
export const FIRST_PARTY_PACKAGE_SCOPE = "@cinatra-ai";

/**
 * Derive the npm vendor scope (e.g. "@cinatra-ai") from a scoped package
 * name. Returns `null` for unscoped names and for malformed inputs ("@/x",
 * "@x" with no slash) — callers decide their own fallback.
 */
export function vendorScopeOfPackage(packageName: string): string | null {
  if (!packageName.startsWith("@")) return null;
  const slash = packageName.indexOf("/");
  // Require at least one character between "@" and "/" so "@/x" is rejected.
  if (slash <= 1) return null;
  return packageName.slice(0, slash);
}

/**
 * The canonical (vendor, name) decomposition of an npm-scoped package id.
 *
 * `vendor` is `null` ONLY for an unscoped input (no leading `@`). For that
 * case `name` carries the whole input verbatim and the CALLER decides its own
 * vendor fallback — this mirrors `vendorScopeOfPackage` returning `null` for
 * unscoped names. The vendor here is WITHOUT npm's leading `@`, so it can be
 * used directly as an on-disk `<vendor>/` path segment.
 */
export interface PackageId {
  /** Vendor segment WITHOUT the leading `@` (e.g. "marcushorndt-local"). `null` for unscoped names. */
  vendor: string | null;
  /** Package name segment after the first `/` (e.g. "page-summarizer-agent"). */
  name: string;
}

/**
 * Strict POSITIVE ALLOWLIST of bare, post-parse path-segment characters
 * (cinatra#537). A safe segment:
 *   - STARTS with an ASCII alphanumeric;
 *   - if longer than one char, ENDS with an ASCII alphanumeric OR a hyphen
 *     (alnum or `-`, but NOT `.` or `_`); and
 *   - in between contains only ASCII alphanumerics plus `.`, `_`, `-`.
 * Single-char alphanumerics (`a`) are allowed.
 *
 * The trailing-`-` allowance makes this a TRUE SUPERSET of the repo's canonical
 * package/vendor shape `^[a-z0-9][a-z0-9-]*$` (materialize-agent-package
 * PACKAGE_NAME_RE / PACKAGE_DIR_RE), which itself permits a trailing `-`. We
 * still forbid a trailing `.` (a Windows/footgun char the canonical shape never
 * produces) and a trailing `_`.
 */
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/;

/**
 * Is `seg` a SINGLE, filesystem-safe path segment?
 *
 * THE shared guard for every on-disk `<vendor>/<name>`/`<slug>` segment before
 * it is fed into `path.join` (cinatra#537). Implemented as a POSITIVE ALLOWLIST
 * (not a denylist) so no edge case can slip through: a segment is safe ONLY if
 * it matches {@link SAFE_PATH_SEGMENT_RE} — a bare name component of ASCII
 * alphanumerics + interior `.`/`_`/`-`, starting alphanumeric and ending with an
 * alphanumeric OR a hyphen.
 *
 * The allowlist SUBSUMES every prior denylist rule and then some — it rejects:
 *   - empty string, and any string with whitespace anywhere (space/tab/newline)
 *   - "." and ".." (don't match the shape) — traversal tokens
 *   - any "/" or "\" (separator injection → nested dirs)
 *   - a leading "@" — on-disk segments are ALWAYS post-parse (`parsePackageId`
 *     strips the scope's "@"; legacy/unscoped names + instance vendor segments
 *     are bare), so a leading "@" means a rejected/malformed scoped value leaked
 *     and must fail closed at EVERY join site automatically
 *   - a leading "~" (home-dir / reserved-bucket marker)
 *   - leading "."/"_"/"-" (e.g. "-foo", ".foo", "_foo")
 *   - a TRAILING "." or "_" (e.g. "foo.", "foo_") — a trailing "-" IS allowed
 *     because the canonical package shape permits it (see below)
 *   - NUL / control chars, "C:"/drive forms, and any other non-allowlisted byte
 *
 * Rationale for the bound: the codebase's canonical vendor/package shape is
 * `^[a-z0-9][a-z0-9-]*$` (materialize-agent-package PACKAGE_NAME_RE /
 * PACKAGE_DIR_RE) — which permits a trailing `-`. This allowlist is a TRUE
 * SUPERSET of it (also tolerates uppercase + interior `.`/`_`, matching the
 * historical `a.b_c-d` fixture) so it never rejects a genuinely-valid segment,
 * including a real (if rare) trailing-hyphen name like "foo-". This is
 * path-safety, not npm name policy — callers still own that.
 */
export function isSafePathSegment(seg: unknown): seg is string {
  if (typeof seg !== "string") return false;
  if (seg === "." || seg === "..") return false; // explicit (regex already forbids them)
  return SAFE_PATH_SEGMENT_RE.test(seg);
}

/**
 * Assert `seg` is a single safe path segment; throw otherwise.
 * Fail-closed companion to {@link isSafePathSegment} for call sites that must
 * never join an unvalidated segment.
 */
export function assertSafePathSegment(seg: unknown, label = "path segment"): asserts seg is string {
  if (!isSafePathSegment(seg)) {
    throw new Error(
      `unsafe ${label}: ${JSON.stringify(seg)} is not a single filesystem-safe segment`,
    );
  }
}

/**
 * THE single canonical splitter for `@vendor/name` package ids → {vendor, name}.
 *
 * Every subsystem that derives a (vendor, name) pair from a package name MUST
 * route through this helper so the agent-create path, the
 * `extensions/<vendor>/<name>` writer, and the skill-store
 * `~agents/<vendor>/<name>` writer can never disagree (cinatra#537).
 *
 * Rules:
 *   - SCOPED `@vendor/name`: split on the FIRST `/` ONLY. The `@` is stripped
 *     from the returned `vendor`. A hyphen in the scope (e.g.
 *     `@marcushorndt-local/page-summarizer-agent`) is NEVER a vendor/name
 *     boundary → `{vendor: "marcushorndt-local", name: "page-summarizer-agent"}`.
 *   - Both `vendor` AND `name` MUST be a SINGLE safe path segment
 *     ({@link isSafePathSegment}). If the part after the first `/` itself
 *     contains another `/` (e.g. `@acme/foo/bar`), or either part is a
 *     traversal token / contains a backslash / is absolute-like, the input is
 *     treated as MALFORMED → returns `null`. We do NOT silently keep a
 *     multi-segment `name` (that was the separator-injection traversal gap).
 *   - UNSCOPED `name` (no leading `@`): `{vendor: null, name}` IFF `name` is a
 *     single safe segment; otherwise `null`. Caller applies its own documented
 *     vendor fallback. We deliberately do NOT guess a vendor by splitting on
 *     `-`; that hyphen-split was the exact bug #537 fixes.
 *   - MALFORMED scoped inputs ("@" alone, "@x" with no slash, "@/x" empty
 *     scope, "@x/" empty name): returns `null`. Mirrors
 *     `vendorScopeOfPackage`'s rejection set so the two helpers agree.
 *
 * Input is trimmed before parsing. Because both returned segments pass
 * {@link isSafePathSegment}, callers may join them into a path WITHOUT
 * re-validating — though defense-in-depth re-validation at the join site is
 * encouraged.
 */
export function parsePackageId(packageName: string): PackageId | null {
  if (typeof packageName !== "string") return null;
  const trimmed = packageName.trim();
  if (trimmed.length === 0) return null;

  if (!trimmed.startsWith("@")) {
    // Unscoped — no vendor. Caller decides the fallback; we never split on `-`.
    // The whole input must be a single safe segment (rejects "foo/bar", "..").
    if (!isSafePathSegment(trimmed)) return null;
    return { vendor: null, name: trimmed };
  }

  const slash = trimmed.indexOf("/");
  // Reject "@" alone, "@x" (no slash), and "@/x" (empty scope): require at
  // least one char between "@" and the FIRST "/".
  if (slash <= 1) return null;
  const vendor = trimmed.slice(1, slash); // strip leading "@"
  const name = trimmed.slice(slash + 1); // everything after the FIRST "/"
  if (name.length === 0) return null; // "@x/" — empty name
  // Both parts MUST be single safe segments. A second "/" in `name`
  // (e.g. "@acme/foo/bar") or any traversal/separator/absolute form fails here
  // → malformed. This closes the separator-injection traversal gap.
  if (!isSafePathSegment(vendor) || !isSafePathSegment(name)) return null;
  return { vendor, name };
}

/**
 * Build the dependency-scope allowlist for installing `rootPackageName`:
 * the root package's OWN vendor scope plus the first-party base-layer scope
 * (deduplicated, each as a "@scope/" prefix).
 *
 * This list is a dependency-confusion mitigation, NOT the root authorization
 * boundary — whether the root package may be installed at all is decided by
 * the marketplace/broker install grant and the caller's authz gates, before
 * dependency resolution ever runs.
 *
 * An unscoped root yields only the first-party prefix; the resolver then
 * rejects the unscoped root itself, because every allowed prefix starts
 * with "@".
 */
export function dependencyScopePrefixesFor(rootPackageName: string): string[] {
  const prefixes = new Set<string>([`${FIRST_PARTY_PACKAGE_SCOPE}/`]);
  const ownScope = vendorScopeOfPackage(rootPackageName);
  if (ownScope) prefixes.add(`${ownScope}/`);
  return [...prefixes];
}
