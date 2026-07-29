// Sandbox stub for the host reader behind the declaration-driven protection
// gate (cinatra#1927). The real `@/lib/extension-protection-host` walks the
// materialized extension store (node:fs + the data-root config + the
// sdk-extensions barrel), none of which is reachable from this package's vitest
// sandbox. The gate is only ever *consulted* by the pre-existing dispatcher
// tests, so the stub answers the fleet-wide truth — nothing declares protection
// — and the tests that EXERCISE the refusal `vi.mock` this specifier to true.
export async function resolveDeclaredProtectionForPackage(): Promise<boolean> {
  return false;
}
export async function readDeclaredProtectionFromStore(): Promise<boolean> {
  return false;
}
