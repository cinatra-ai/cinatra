// REAL-DB proof (OWNER RULING 2026-07-22, groganz) — the platform-scope artifact
// archive/restore ENUMERATION reads org-scoped installs from the REAL canonical
// `installed_extension` store. Every other pin for the ruling seeds the reader's
// RETURN value (mock); this slice drives the SHIPPED reader
// (`readInstalledExtensionsByPackageName`) against a live Postgres so the
// DB → InstalledExtension mapping the enumeration decision consumes
// (organization_id → organizationId, status) is proven end-to-end. A mock cannot
// catch a column/name drift here; "the enumeration touches the store" is exactly
// this seam.
//
//   CINATRA_DB_INTEGRATION_TESTS=1 \
//   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/verify_1837_r1 \
//   SUPABASE_SCHEMA=cinatra \
//     pnpm exec vitest run --config vitest.config.ts \
//       src/lib/objects/__tests__/platform-artifact-enumeration-store.integration.test.ts
//
// Excluded from the fast `test:root` suite (root vitest excludes
// **/*.integration.test.ts unless CINATRA_DB_INTEGRATION_TESTS=1) and self-skips
// without a real SUPABASE_DB_URL, so the flag alone can never make it
// fail-vacuous.

import { beforeAll, describe, expect, it, vi } from "vitest";

// The full app bootstrap references Supabase-only tables absent on a plain verify
// Postgres; no-op it and build ONLY the two tables the reader touches (same
// pattern as binding-write-path.integration.test.ts).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
// The SHIPPED canonical reader (server-only; stubbed in the vitest env). Imported
// by relative path — it is not on the `@cinatra-ai/extensions` public barrel.
import { readInstalledExtensionsByPackageName } from "../../../../packages/extensions/src/canonical-store";
// The PURE enumeration decision under test — from the package's public barrel.
import { enumerateOrgScopedInstallsBlockingPlatformArchive } from "@cinatra-ai/extensions";

// PLATFORM_OWNER_SENTINEL (canonical-types) — the owner_id a NULL-org platform row
// carries; hard-coded (not imported) to keep this slice off the package internals.
const PLATFORM_OWNER = "__platform__";

const RUN =
  process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && Boolean(process.env.SUPABASE_DB_URL);

const S = () => postgresSchema.replaceAll('"', '""');
let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

function exec(text: string) {
  runPostgresQueriesSync({ connectionString: getPostgresConnectionString(), queries: [{ text }] });
}
function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Seed a canonical installed_extension row EXACTLY as the store persists one.
 *  A null org is a platform row (owner_id sentinel); a non-null org is a
 *  scope-exact org install. Each gets a distinct version so no identity collides. */
function seedInstall(input: {
  pkg: string;
  org: string | null;
  status: "active" | "locked" | "archived";
  version?: string;
}) {
  const id = nextId("iext");
  sql(
    `INSERT INTO "${S()}"."installed_extension"
       (id, package_name, owner_level, owner_id, organization_id, kind, status, source,
        version, is_default, required_in_prod)
     VALUES ($1,$2,$3,$4,$5,'artifact',$6,$7::jsonb,$8,true,false)`,
    [
      id,
      input.pkg,
      input.org == null ? "platform" : "organization",
      input.org == null ? PLATFORM_OWNER : input.org,
      input.org,
      input.status,
      JSON.stringify({ type: "verdaccio", version: input.version ?? "1.0.0" }),
      input.version ?? "1.0.0",
    ],
  );
  return id;
}

beforeAll(() => {
  if (!RUN) return;
  const s = S();
  exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  // The canonical installed_extension table — every column the shipped drizzle
  // reader (`installedExtensionTable`) selects (drizzle-store.ts + the #1040
  // version-identity leaf). No unique indexes needed for a read proof.
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."installed_extension" (
    id text PRIMARY KEY,
    package_name text NOT NULL,
    owner_level text NOT NULL,
    owner_id text NOT NULL,
    organization_id text,
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    source jsonb NOT NULL,
    version text NOT NULL DEFAULT '0.0.0',
    is_default boolean NOT NULL DEFAULT true,
    required_in_prod boolean NOT NULL DEFAULT false,
    manifest_hash text,
    access_declaration jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now() )`);
  // The dependency-edge table the reader hydrates from (empty here — no edges
  // seeded — but it must exist for the reader's hydrate query).
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."extension_dependency_edge" (
    id text PRIMARY KEY,
    dependent_install_id text NOT NULL,
    declared_package_name text NOT NULL,
    declared_kind text,
    edge_type text NOT NULL,
    requirement text NOT NULL,
    version_constraint jsonb NOT NULL,
    declared_index integer NOT NULL DEFAULT 0,
    resolved_install_id text,
    resolution_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now() )`);
});

describe.skipIf(!RUN)("platform artifact enumeration — REAL installed_extension store", () => {
  it("the shipped reader maps organization_id + status faithfully; the enumeration blocks exactly the live org installs", async () => {
    const pkg = `${nextId("@v/pkg")}-artifact`;
    // A realistic install graph for ONE artifact package:
    //   platform (null-org) active — the row being platform-archived, never a blocker
    //   org-a active                — a live org install → BLOCKS
    //   org-b locked                — a live (locked) org install → BLOCKS
    //   org-b active (v2)           — the SAME org, second version → dedups to one
    //   org-c archived              — migrated off → never blocks
    seedInstall({ pkg, org: null, status: "active" });
    seedInstall({ pkg, org: "org-a", status: "active" });
    seedInstall({ pkg, org: "org-b", status: "locked", version: "1.0.0" });
    seedInstall({ pkg, org: "org-b", status: "active", version: "2.0.0" });
    seedInstall({ pkg, org: "org-c", status: "archived" });

    // The REAL reader — over the wire from the live DB.
    const rows = await readInstalledExtensionsByPackageName(pkg);
    expect(rows.length).toBe(5);

    // The DB → InstalledExtension mapping the enumeration consumes is faithful:
    // organization_id (incl. NULL for the platform row) and status round-trip.
    const byOrgStatus = rows
      .map((r) => `${r.organizationId ?? "<null>"}:${r.status}`)
      .sort();
    expect(byOrgStatus).toEqual(
      ["<null>:active", "org-a:active", "org-b:active", "org-b:locked", "org-c:archived"].sort(),
    );

    // The enumeration decision over the REAL rows: exactly the live org installs,
    // deduped + sorted; platform + archived excluded.
    expect(enumerateOrgScopedInstallsBlockingPlatformArchive(rows)).toEqual(["org-a", "org-b"]);
  });

  it("a package with ONLY a platform row (no org installs) has an empty blocking set — the platform archive would PROCEED", async () => {
    const pkg = `${nextId("@v/pkg")}-artifact`;
    seedInstall({ pkg, org: null, status: "active" });
    const rows = await readInstalledExtensionsByPackageName(pkg);
    expect(rows.length).toBe(1);
    expect(rows[0].organizationId).toBeNull();
    expect(enumerateOrgScopedInstallsBlockingPlatformArchive(rows)).toEqual([]);
  });

  it("a package whose only org installs are ARCHIVED (all migrated off) has an empty blocking set", async () => {
    const pkg = `${nextId("@v/pkg")}-artifact`;
    seedInstall({ pkg, org: null, status: "archived" }); // the archived platform row (a restore target)
    seedInstall({ pkg, org: "org-x", status: "archived" });
    seedInstall({ pkg, org: "org-y", status: "archived" });
    const rows = await readInstalledExtensionsByPackageName(pkg);
    expect(rows.length).toBe(3);
    expect(enumerateOrgScopedInstallsBlockingPlatformArchive(rows)).toEqual([]);
  });

  it("the reader distinguishes an EMPTY-STRING org_id from NULL — the contract the malformed-sibling fail-closed guard depends on", async () => {
    // Postgres stores '' in a nullable text column as '' (not NULL). The dispatcher's
    // fail-closed sibling guard refuses a platform op when a live '' row exists; that
    // is only correct if the reader round-trips '' distinctly from NULL (a NULL row is
    // the genuine platform install). Prove the mapping here on the real store.
    const pkg = `${nextId("@v/pkg")}-artifact`;
    seedInstall({ pkg, org: null, status: "active" }); // genuine platform row
    seedInstall({ pkg, org: "", status: "active" }); // MALFORMED live sibling
    const rows = await readInstalledExtensionsByPackageName(pkg);
    const platform = rows.find((r) => r.organizationId === null);
    const malformed = rows.find((r) => r.organizationId === "");
    expect(platform).toBeDefined();
    expect(malformed).toBeDefined(); // '' did NOT collapse to null
    // The pure enumeration SKIPS the '' row (it is not a valid org id) — which is
    // exactly why the async dispatcher needs the SEPARATE malformed-row fail-closed
    // guard over the full set (proven in the unit ruling suite).
    expect(enumerateOrgScopedInstallsBlockingPlatformArchive(rows)).toEqual([]);
  });
});
