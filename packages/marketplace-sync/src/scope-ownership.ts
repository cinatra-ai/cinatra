/**
 * Scope-ownership enforcement.
 *
 * Defense-in-depth: the Verdaccio ACL is the primary gate, but the sync
 * worker re-verifies that the package's `@<scope>` is owned by an approved
 * active vendor BEFORE syncing it to the catalog. Unowned-scope packages
 * are rejected at sync + an admin notice is emitted.
 *
 * Pure logic — the I/O (fetching approved scopes from the marketplace) is
 * injected by the caller so this module is straight to unit-test.
 */

export interface ScopeOwnershipCheckInput {
  packageName: string;
  /**
   * Returns true if the given scope (`@<scope>` form, e.g. `@acme`) is
   * approved + the owning vendor is in `active` or `reinstated` status.
   *
   * The cinatra-side sync worker injects an impl that calls
   * `marketplace_vendor_get` per cached scope; tests inject a Set lookup.
   */
  isScopeApproved: (scope: string) => Promise<boolean>;
}

export interface ScopeOwnershipCheckResult {
  ok: boolean;
  /** Why the sync was rejected — null when ok. */
  rejectionReason: string | null;
}

export async function checkScopeOwnership(
  input: ScopeOwnershipCheckInput,
): Promise<ScopeOwnershipCheckResult> {
  const match = /^@([a-z0-9][a-z0-9-]{1,38})\/[a-z0-9-]+$/.exec(input.packageName);
  if (!match) {
    return {
      ok: false,
      rejectionReason: `Package name "${input.packageName}" is not a valid scoped npm package (@<scope>/<name>).`,
    };
  }
  const scope = `@${match[1]}`;
  const approved = await input.isScopeApproved(scope);
  if (!approved) {
    return {
      ok: false,
      rejectionReason: `Scope "${scope}" is not owned by an approved active vendor — sync rejected.`,
    };
  }
  return { ok: true, rejectionReason: null };
}
