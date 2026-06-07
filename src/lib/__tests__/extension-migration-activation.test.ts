import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import {
  applyExtensionMigrationsFromStore,
  applyMigrationsForTrustedRecords,
} from "@/lib/extension-migration-host";
import { installExtensionFromRegistry, type InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import type { MigrationQuery, RunMigrationsResult } from "@/lib/extension-migration-runner";
import { generateExtensionSigningKeyPair, signExtension } from "@/lib/extension-signature";

// Migration-runner ACTIVATION (the install pipeline + boot pass
// call-sites). Proves the dormant host-run migration runner activates
// end-to-end from a REAL `cinatra.migrations[]` consumer fixture, idempotently,
// without a database (an injected recording query stands in for the locked
// transaction). `ctx.db` stays UNWIRED — the host runs the constrained DSL.

const STORE_ROOT = join(process.cwd(), "src/lib/__tests__/fixtures/migration-store");
const CONSUMER_DIR = join(STORE_ROOT, "notes-connector");
const NO_MIGRATIONS_DIR = join(process.cwd(), "src/lib/__tests__/fixtures/schema-config-connector");

const TABLE = "ext_cinatra_ai_notes_connector_notes";

/**
 * An in-memory recording query + a `runLocked` that just calls `run(query)` (no
 * DB, no advisory lock). Simulates the `extension_migrations` ledger so
 * idempotency + the immutable-hash gate are exercised.
 */
function makeRecorder() {
  const ledger = new Map<string, string>(); // `${pkg}|${id}` -> migration_hash
  const ddl: string[] = [];
  const query: MigrationQuery = async <T = unknown>(text: string, values?: readonly unknown[]) => {
    if (text.includes("SELECT migration_hash") && text.includes("extension_migrations")) {
      const key = `${String(values?.[0])}|${String(values?.[1])}`;
      return (ledger.has(key) ? [{ migration_hash: ledger.get(key)! }] : []) as T[];
    }
    if (text.includes("INSERT INTO") && text.includes("extension_migrations")) {
      const key = `${String(values?.[0])}|${String(values?.[1])}`;
      ledger.set(key, String(values?.[2]));
      return [] as T[];
    }
    ddl.push(text);
    return [] as T[];
  };
  const runLocked = (run: (q: MigrationQuery) => Promise<RunMigrationsResult>) => run(query);
  return { ledger, ddl, runLocked };
}

describe("extension migration activation — applyExtensionMigrationsFromStore", () => {
  it("applies a real cinatra.migrations[] consumer's DDL into the prefixed, schema-qualified table", async () => {
    const rec = makeRecorder();
    const result = await applyExtensionMigrationsFromStore(
      { storeDir: CONSUMER_DIR, schema: "cinatra" },
      { runLocked: rec.runLocked },
    );
    expect(result.applied).toEqual(["0001-create-notes"]);
    expect(result.skipped).toEqual([]);
    // The DDL targets the extension's OWN prefixed table, schema-qualified.
    const ddlBlob = rec.ddl.join("\n");
    expect(ddlBlob).toContain(`"cinatra"."${TABLE}"`);
    expect(ddlBlob).toMatch(/CREATE TABLE/i);
    expect(ddlBlob).toMatch(/org_id/);
    expect(ddlBlob).toMatch(/CREATE (UNIQUE )?INDEX/i);
    // Ledger recorded the migration.
    expect(rec.ledger.get("@cinatra-ai/notes-connector|0001-create-notes")).toBeTruthy();
  });

  it("is idempotent — a second apply skips the already-applied migration (no new DDL)", async () => {
    const rec = makeRecorder();
    await applyExtensionMigrationsFromStore({ storeDir: CONSUMER_DIR }, { runLocked: rec.runLocked });
    const ddlAfterFirst = rec.ddl.length;
    const second = await applyExtensionMigrationsFromStore({ storeDir: CONSUMER_DIR }, { runLocked: rec.runLocked });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001-create-notes"]);
    expect(rec.ddl.length).toBe(ddlAfterFirst); // no new DDL on the idempotent re-run
  });

  it("is a clean no-op for a package that declares no migrations", async () => {
    const rec = makeRecorder();
    const result = await applyExtensionMigrationsFromStore({ storeDir: NO_MIGRATIONS_DIR }, { runLocked: rec.runLocked });
    expect(result).toEqual({ applied: [], skipped: [] });
    expect(rec.ddl).toEqual([]);
  });

  it("treats a missing store manifest as no-migrations (defensive, never throws)", async () => {
    const result = await applyExtensionMigrationsFromStore({ storeDir: join(STORE_ROOT, "does-not-exist") });
    expect(result).toEqual({ applied: [], skipped: [] });
  });
});

describe("extension migration activation — install pipeline call-site", () => {
  function baseDeps(overrides: Partial<InstallPipelineDeps>): InstallPipelineDeps {
    return {
      resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: "https://registry.cinatra.ai" }),
      materialize: async () => ({ storeDir: CONSUMER_DIR, digest: "deadbeef", integrity: "sha512-abc", contentHash: "ch" }),
      readRequestedPorts: async () => [],
      recordProvenance: async () => {},
      recordRequestedGrant: async () => {},
      approveGrant: async () => {},
      ...overrides,
    };
  }

  // Host DDL (migrations) runs ONLY for a trusted-SIGNED install (the
  // capability split): a `trusted-bootstrap` install imports but never auto-runs
  // host DDL. So a migration-ACTIVATION test must install a SIGNED package — sign
  // {package,version,integrity} and register the matching public key.
  let prevKeyEnv: string | undefined;
  afterEach(() => {
    if (prevKeyEnv === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = prevKeyEnv;
    prevKeyEnv = undefined;
  });
  function signedDeps(packageName: string, version: string, overrides: Partial<InstallPipelineDeps> = {}): InstallPipelineDeps {
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension({ packageName, version, integrity: "sha512-abc" }, kp.privateKeyPkcs8DerB64);
    prevKeyEnv = process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    return baseDeps({
      resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: "https://registry.cinatra.ai", signature }),
      ...overrides,
    });
  }

  it("invokes applyMigrations with the materialized storeDir BEFORE finalize, advancing to preflighted (trusted-signed)", async () => {
    const phases: string[] = [];
    const applyMigrations = vi.fn(async () => {});
    await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", orgId: "org_1" },
      signedDeps("@cinatra-ai/notes-connector", "1.2.0", {
        applyMigrations,
        advanceInstallOpPhase: async ({ phase }) => {
          phases.push(phase);
        },
      }),
    );
    expect(applyMigrations).toHaveBeenCalledTimes(1);
    expect(applyMigrations).toHaveBeenCalledWith({
      storeDir: CONSUMER_DIR,
      packageName: "@cinatra-ai/notes-connector",
      version: "1.2.0",
      orgId: "org_1",
    });
    // preflighted lands after granted and before finalized (migration success
    // gates the finalize the anchor trusts).
    expect(phases).toEqual(["granted", "preflighted", "finalized"]);
  });

  it("a failed migration aborts the install — finalize is never reached", async () => {
    const phases: string[] = [];
    await expect(
      installExtensionFromRegistry(
        { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", orgId: null },
        signedDeps("@cinatra-ai/notes-connector", "1.2.0", {
          applyMigrations: async () => {
            throw new Error("bad migration");
          },
          advanceInstallOpPhase: async ({ phase }) => {
            phases.push(phase);
          },
        }),
      ),
    ).rejects.toThrow(/bad migration/);
    expect(phases).toContain("granted");
    expect(phases).not.toContain("finalized");
  });

  it("does NOT run migrations for an UNSIGNED (bootstrap) install — host DDL requires a verified signature (capability split)", async () => {
    const applyMigrations = vi.fn(async () => {});
    const phases: string[] = [];
    // No signature configured → the package is at most `trusted-bootstrap`, which
    // imports in-process but NEVER auto-runs host DDL (capability split).
    await installExtensionFromRegistry(
      { packageName: "@thirdparty/widget", version: "1.0.0", orgId: "org_1" },
      baseDeps({
        applyMigrations,
        advanceInstallOpPhase: async ({ phase }) => {
          phases.push(phase);
        },
      }),
    );
    expect(applyMigrations).not.toHaveBeenCalled();
    expect(phases).not.toContain("preflighted");
  });
});

describe("extension migration activation — trusted-record pass (loader-gated)", () => {
  const trustedRec = {
    packageName: "@cinatra-ai/notes-connector",
    storeDir: CONSUMER_DIR,
    migrations: [{ id: "0001-create-notes", path: "cinatra/migrations/0001-create-notes.json" }],
  };

  it("applies migrations for the trusted records the loader passes in (no trust logic of its own)", async () => {
    const applyOne = vi.fn(async () => ({ applied: ["0001-create-notes"], skipped: [] }));
    const out = await applyMigrationsForTrustedRecords([trustedRec], { applyOne: applyOne as never });
    expect(applyOne).toHaveBeenCalledTimes(1);
    expect(out.applied.map((o) => o.packageName)).toContain("@cinatra-ai/notes-connector");
    expect(out.refused).toEqual([]);
  });

  it("REFUSES (does not throw) a record whose migration fails — the loader then excludes it from activation", async () => {
    const applyOne = vi.fn(async () => {
      throw new Error("ddl failed");
    });
    const out = await applyMigrationsForTrustedRecords([trustedRec], { applyOne: applyOne as never });
    expect(out.applied).toEqual([]);
    expect(out.refused).toEqual([{ packageName: "@cinatra-ai/notes-connector", error: "ddl failed" }]);
  });

  it("skips a record that declares no migrations", async () => {
    const applyOne = vi.fn(async () => ({ applied: [], skipped: [] }));
    const out = await applyMigrationsForTrustedRecords([{ packageName: "@x/none", storeDir: NO_MIGRATIONS_DIR }], {
      applyOne: applyOne as never,
    });
    expect(applyOne).not.toHaveBeenCalled();
    expect(out.applied).toEqual([]);
  });
});
