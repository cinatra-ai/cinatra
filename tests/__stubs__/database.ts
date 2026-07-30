// Stub for @/lib/database in root-level vitest runs.
// The only symbols enqueueChildFlow transitively depends on are the metadata
// read/write helpers, which it does not actually call. Provide safe no-ops
// in case background-jobs.ts is imported wholesale.
export function readMetadataValueFromDatabase<T>(_key: string, fallback: T): T {
  return fallback;
}
export function writeMetadataValueToDatabase(_key: string, _value: unknown): void {
  // noop
}

// src/lib/notifications-host.ts
// STATICALLY imports these three from @/lib/database. Because
// @/lib/notifications-host is now a TOP-LEVEL side-effect import in the
// facade (src/lib/notifications.ts), the stream route, AND
// src/lib/background-jobs.ts, any vitest test that transitively loads any
// of those three entry paths would fail at module load if the stub did not
// export test-safe versions of these. ADD — never replace the metadata
// helpers above (other tests rely on them). These mirror the real
// src/lib/database exports (postgresSchema:36, getPostgresConnectionString:163,
// ensurePostgresSchema:238) with inert test-safe behavior.
export const postgresSchema = "cinatra";
export function getPostgresConnectionString(): string {
  return "postgres://stub";
}
export function ensurePostgresSchema(): void {
  // noop — schema provisioning is a no-op in unit tests
}

// cinatra#850: src/lib/instance-identity-store.ts STATICALLY imports these two
// row-level-CAS helpers from @/lib/database. The store is pulled transitively
// into root-level vitest runs (e.g. via src/mcp/handlers.ts in the
// packages/extensions invariants sandbox, which aliases @/lib/database → this
// stub), so a missing export makes the store module fail resolution/
// instantiation. ADD — never replace the helpers above. Inert test-safe
// versions: the store's DEFAULT CAS deps call these, but every unit test
// injects fakes, so the production DB path is exercised via the real
// src/lib/database in integration tests, never through this stub.
export function readRawMetadataStringFromDatabase(_key: string): string | null {
  // No row in the stub → the store's CAS engine short-circuits at "no-identity".
  return null;
}
export function compareAndSwapMetadataValueFromDatabase(
  _key: string,
  _value: unknown,
  _expectedRaw: string,
): boolean {
  // Never reached in unit tests (readRaw above returns null first); inert.
  return false;
}

// cinatra#1943 A6: the connector-config pair, backed by a module-local map so
// a test can SEED config for production code whose dynamic
// `import("@/lib/database")` resolves to THIS stub via the alias — e.g. the
// org-archive activation gate (organization-archive.ts's
// isArchiveActivationEnabled), which the A6 contention suite must read as ON.
// ADD — never replace the helpers above (this file's standing rule).
//
// Lives HERE, not in a per-file vi.mock, deliberately: a vi.mock seam proved
// NOT concurrency-safe for OVERLAPPING dynamic imports of the mocked id (in
// CI, a 5-way concurrent burst of gate reads saw the mock on exactly one
// caller and fell through to this stub — then missing the function — on the
// other four; PR #2280 rounds 1-3). A plain aliased module has no mocker in
// the loop: the module cache guarantees one namespace for every importer,
// static or dynamic, overlapping or not.
//
// An UNSEEDED key returns the caller's fallback — for consumers that never
// seed, the same effective outcome as the missing-export era (their
// fail-closed catch produced the fallback behavior), minus the masked
// TypeError. Tests that vi.mock @/lib/database themselves are unaffected
// (their mocks override this stub). Map state is per test file (vitest
// isolates module registries per file), so seeding never leaks across files.
const connectorConfigStore = new Map<string, unknown>();
export function readConnectorConfigFromDatabase<T>(connectorId: string, fallback: T): T {
  return connectorConfigStore.has(connectorId)
    ? (connectorConfigStore.get(connectorId) as T)
    : fallback;
}
export function writeConnectorConfigToDatabase(connectorId: string, value: unknown): void {
  connectorConfigStore.set(connectorId, value);
}
