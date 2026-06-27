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
 * THE single canonical splitter for `@vendor/name` package ids → `{vendor, name}`.
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
 *     Any further `/` in the name part is preserved verbatim in `name`.
 *   - UNSCOPED `name` (no leading `@`): `{vendor: null, name}` — caller applies
 *     its own documented fallback. We deliberately do NOT guess a vendor by
 *     splitting on `-`; that hyphen-split was the exact bug #537 fixes.
 *   - MALFORMED scoped inputs ("@" alone, "@x" with no slash, "@/x" empty
 *     scope, "@x/" empty name): returns `null`. Mirrors
 *     `vendorScopeOfPackage`'s rejection set so the two helpers agree.
 *
 * Input is trimmed before parsing.
 */
export function parsePackageId(packageName: string): PackageId | null {
  if (typeof packageName !== "string") return null;
  const trimmed = packageName.trim();
  if (trimmed.length === 0) return null;

  if (!trimmed.startsWith("@")) {
    // Unscoped — no vendor. Caller decides the fallback; we never split on `-`.
    return { vendor: null, name: trimmed };
  }

  const slash = trimmed.indexOf("/");
  // Reject "@" alone, "@x" (no slash), and "@/x" (empty scope): require at
  // least one char between "@" and the FIRST "/".
  if (slash <= 1) return null;
  const vendor = trimmed.slice(1, slash); // strip leading "@"
  const name = trimmed.slice(slash + 1); // everything after the FIRST "/"
  if (name.length === 0) return null; // "@x/" — empty name
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
