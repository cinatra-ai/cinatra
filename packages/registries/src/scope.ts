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
