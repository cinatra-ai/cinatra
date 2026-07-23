// cinatra#1983 — @/lib/database shim for the REAL-STORE integration test.
//
// The root vitest config aliases `@/lib/database` to a fully-inert stub
// (getPostgresConnectionString → "postgres://stub"), which makes it impossible
// to drive the REAL objects-store against a real Postgres. This shim instead
// resolves the connection + schema from the REAL, env-driven `postgres-config`
// leaf (so `SUPABASE_DB_URL` / `SUPABASE_SCHEMA` — set by the test runner —
// point the store at the lane-unique schema on the shared verify pg), while
// keeping the heavier `@/lib/database` graph (settings/connector-config DB
// reads, notifications host) out of the sandbox with light, deterministic
// stand-ins for the few read helpers the objects_save graph touches.
//
// It exports EXACTLY the `@/lib/database` surface reachable from the sent-email
// writer → objects_save → objects-store graph:
//   - getPostgresConnectionString / postgresSchema — REAL (env-driven);
//   - ensurePostgresSchema — no-op (the test pre-creates + clones the schema);
//   - readObjectsClassificationModelFromDatabase — a static default (the
//     classifier fast-path never reaches the model anyway once the sent-email
//     type is registered);
//   - readConnectorConfigFromDatabase — fallback passthrough (the dev-override
//     reader in register-email-providers; dev mode stays off);
//   - the metadata / CAS helpers other transitively-loaded modules import.
export {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";

export function ensurePostgresSchema(): void {
  // The integration test provisions + clones the lane schema itself; schema
  // provisioning here would be redundant (and could run host migrations).
}

export function readObjectsClassificationModelFromDatabase(): string {
  return "gpt-4o-mini";
}

export function readConnectorConfigFromDatabase<T>(_key: string, fallback: T): T {
  return fallback;
}

export function readMetadataValueFromDatabase<T>(_key: string, fallback: T): T {
  return fallback;
}
export function writeMetadataValueToDatabase(_key: string, _value: unknown): void {
  // noop
}
export function readRawMetadataStringFromDatabase(_key: string): string | null {
  return null;
}
export function compareAndSwapMetadataValueFromDatabase(
  _key: string,
  _value: unknown,
  _expectedRaw: string,
): boolean {
  return false;
}
