import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import {
  applyExtensionMigrationsFromStore,
  applyMigrationsForTrustedRecords,
  preflightExtensionMigrationsFromStore,
} from "@/lib/extension-migration-host";
import { installExtensionFromRegistry, type InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import { generateExtensionSigningKeyPair, signExtension } from "@/lib/extension-signature";

// Extension-migration ACTIVATION (#118 — the install pipeline + boot pass
// call-sites). Proves the host applies a REAL `cinatra.migrationsDir`
// consumer fixture through the SHARED node-pg-migrate runner entry point,
// without a database (an injected recording `run` stands in for the runner),
// and that the retired JSON-DSL declaration is rejected fail-closed.

const STORE_ROOT = join(process.cwd(), "src/lib/__tests__/fixtures/migration-store");
const CONSUMER_DIR = join(STORE_ROOT, "notes-connector");
const LEGACY_DIR = join(STORE_ROOT, "notes-connector-legacy");
const NO_MIGRATIONS_DIR = join(process.cwd(), "src/lib/__tests__/fixtures/schema-config-connector");

const NAMESPACE = "ext_cinatra-ai_notes-connector__";
const MODULE_NAME = "ext_cinatra-ai_notes-connector__0001_create-notes";

/** Injected runner recorder — no pg, no node-pg-migrate. */
function makeRunRecorder(ranNames: string[] = [MODULE_NAME]) {
  const calls: Array<Record<string, unknown>> = [];
  const run = vi.fn(async (input: Record<string, unknown>) => {
    calls.push(input);
    return { ranNames, direction: "up" as const, faked: false };
  });
  return { run, calls };
}

const prevDbUrl = process.env.SUPABASE_DB_URL;
afterEach(() => {
  if (prevDbUrl === undefined) delete process.env.SUPABASE_DB_URL;
  else process.env.SUPABASE_DB_URL = prevDbUrl;
});

describe("extension migration host — preflight (validate-only, fs-only)", () => {
  it("resolves the consumer fixture's dir, namespace, and module set", async () => {
    const pre = await preflightExtensionMigrationsFromStore({ storeDir: CONSUMER_DIR });
    expect(pre).not.toBeNull();
    expect(pre?.packageName).toBe("@cinatra-ai/notes-connector");
    expect(pre?.namespace).toBe(NAMESPACE);
    expect(pre?.dirAbs.endsWith(join("notes-connector", "cinatra", "migrations"))).toBe(true);
    expect(pre?.files).toEqual([`${MODULE_NAME}.mjs`]);
  });

  it("returns null for a package that declares no migrations", async () => {
    await expect(preflightExtensionMigrationsFromStore({ storeDir: NO_MIGRATIONS_DIR })).resolves.toBeNull();
  });

  it("treats a missing store manifest as no-migrations (defensive, never throws)", async () => {
    await expect(
      preflightExtensionMigrationsFromStore({ storeDir: join(STORE_ROOT, "does-not-exist") }),
    ).resolves.toBeNull();
  });

  it("REJECTS the retired legacy cinatra.migrations JSON-DSL declaration (fail closed, never a silent no-op)", async () => {
    await expect(preflightExtensionMigrationsFromStore({ storeDir: LEGACY_DIR })).rejects.toThrow(
      /cinatra\.migrations\) is retired/,
    );
  });

  it("rejects a migrationsDir that escapes the store dir (containment)", async () => {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const dir = await mkdtemp(join(os.tmpdir(), "ext-mig-escape-"));
    await mkdir(join(dir, "pkg"), { recursive: true });
    await writeFile(
      join(dir, "pkg", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/escape", cinatra: { migrationsDir: "../" } }),
    );
    await expect(preflightExtensionMigrationsFromStore({ storeDir: join(dir, "pkg") })).rejects.toThrow(
      /unsafe migrationsDir/,
    );
  });

  it("rejects an unscoped/non-kebab package name (no derivable namespace)", async () => {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const dir = await mkdtemp(join(os.tmpdir(), "ext-mig-name-"));
    await mkdir(join(dir, "m"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "unscoped_pkg", cinatra: { migrationsDir: "m" } }),
    );
    await expect(preflightExtensionMigrationsFromStore({ storeDir: dir })).rejects.toThrow(
      /cannot derive a migration namespace/,
    );
  });
});

describe("extension migration activation — applyExtensionMigrationsFromStore (the ONE host entry point)", () => {
  it("runs the consumer fixture UP through the shared runner with the derived namespace + containment-checked dir", async () => {
    process.env.SUPABASE_DB_URL = "postgres://unused:0/fake";
    const rec = makeRunRecorder();
    const result = await applyExtensionMigrationsFromStore(
      { storeDir: CONSUMER_DIR, schema: "cinatra" },
      { run: rec.run as never },
    );
    expect(result.applied).toEqual([MODULE_NAME]);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].namespace).toBe(NAMESPACE);
    expect(rec.calls[0].direction).toBe("up");
    expect(rec.calls[0].schemaName).toBe("cinatra");
    expect(String(rec.calls[0].dirAbs).endsWith(join("cinatra", "migrations"))).toBe(true);
  });

  it("is a clean no-op for a package that declares no migrations (runner never invoked)", async () => {
    const rec = makeRunRecorder();
    const result = await applyExtensionMigrationsFromStore({ storeDir: NO_MIGRATIONS_DIR }, { run: rec.run as never });
    expect(result).toEqual({ applied: [] });
    expect(rec.run).not.toHaveBeenCalled();
  });

  it("fails closed without SUPABASE_DB_URL when migrations ARE declared", async () => {
    delete process.env.SUPABASE_DB_URL;
    const rec = makeRunRecorder();
    await expect(
      applyExtensionMigrationsFromStore({ storeDir: CONSUMER_DIR }, { run: rec.run as never }),
    ).rejects.toThrow(/SUPABASE_DB_URL is required/);
    expect(rec.run).not.toHaveBeenCalled();
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
      { packageName: "@cinatra-ai/notes-connector", version: "1.3.0", orgId: "org_1" },
      signedDeps("@cinatra-ai/notes-connector", "1.3.0", {
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
      version: "1.3.0",
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
        { packageName: "@cinatra-ai/notes-connector", version: "1.3.0", orgId: null },
        signedDeps("@cinatra-ai/notes-connector", "1.3.0", {
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

  it("REFUSES to finalize an UNSIGNED (bootstrap) install of a package that DECLARES migrations — its DDL would never run", async () => {
    const phases: string[] = [];
    const applyMigrations = vi.fn(async () => {});
    await expect(
      installExtensionFromRegistry(
        // The consumer fixture declares cinatra.migrationsDir; no signature is
        // configured, so the install is at most trusted-bootstrap.
        { packageName: "@cinatra-ai/notes-connector", version: "1.3.0", orgId: "org_1" },
        baseDeps({
          applyMigrations,
          preflightMigrations: async (i) => {
            const { preflightExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
            return (await preflightExtensionMigrationsFromStore(i)) !== null;
          },
          advanceInstallOpPhase: async ({ phase }) => {
            phases.push(phase);
          },
        }),
      ),
    ).rejects.toThrow(/declares host migrations[\s\S]*not trusted-signed/);
    expect(applyMigrations).not.toHaveBeenCalled();
    expect(phases).not.toContain("finalized");
  });

  it("REFUSES to finalize an install whose store manifest still declares the RETIRED legacy field (preflight throws for every tier)", async () => {
    const phases: string[] = [];
    await expect(
      installExtensionFromRegistry(
        { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", orgId: "org_1" },
        baseDeps({
          materialize: async () => ({ storeDir: LEGACY_DIR, digest: "deadbeef", integrity: "sha512-abc", contentHash: "ch" }),
          preflightMigrations: async (i) => {
            const { preflightExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
            return (await preflightExtensionMigrationsFromStore(i)) !== null;
          },
          advanceInstallOpPhase: async ({ phase }) => {
            phases.push(phase);
          },
        }),
      ),
    ).rejects.toThrow(/cinatra\.migrations\) is retired/);
    expect(phases).not.toContain("finalized");
  });
});

describe("extension migration activation — trusted-record pass (loader-gated)", () => {
  const trustedRec = {
    packageName: "@cinatra-ai/notes-connector",
    storeDir: CONSUMER_DIR,
    migrationsDir: "cinatra/migrations",
  };

  it("applies migrations for the trusted records the loader passes in (no trust logic of its own)", async () => {
    const applyOne = vi.fn(async () => ({ applied: [MODULE_NAME] }));
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

  it("REFUSES a record that still declares the retired legacy field (the host throws; fail closed)", async () => {
    const out = await applyMigrationsForTrustedRecords([
      { packageName: "@cinatra-ai/notes-connector", storeDir: LEGACY_DIR, legacyMigrationsDeclared: true },
    ]);
    expect(out.applied).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].error).toMatch(/retired/);
  });

  it("skips a record that declares no migrations", async () => {
    const applyOne = vi.fn(async () => ({ applied: [] }));
    const out = await applyMigrationsForTrustedRecords([{ packageName: "@x/none", storeDir: NO_MIGRATIONS_DIR }], {
      applyOne: applyOne as never,
    });
    expect(applyOne).not.toHaveBeenCalled();
    expect(out.applied).toEqual([]);
  });
});
