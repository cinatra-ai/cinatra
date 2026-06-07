import { describe, it, expect } from "vitest";
import {
  extTablePrefix,
  validateMigrationSpec,
  compileMigrationSpec,
  migrationSpecHash,
  type ExtensionMigrationSpec,
} from "@/lib/extension-migration-dsl";
import { runExtensionMigrations, loadExtensionMigrationSpecs } from "@/lib/extension-migration-runner";
import type { PackageStoreRecord } from "@cinatra-ai/sdk-extensions";

const PKG = "@cinatra-ai/foo-connector";
const prefix = extTablePrefix(PKG); // ext_cinatra_ai_foo_connector_

function validSpec(id = "0001-init"): ExtensionMigrationSpec {
  return {
    id,
    ops: [
      {
        op: "createTable",
        table: `${prefix}items`,
        columns: [
          { name: "id", type: "uuid", notNull: true },
          { name: "org_id", type: "text", notNull: true },
          { name: "label", type: "text" },
        ],
        primaryKey: ["id"],
      },
      { op: "addIndex", table: `${prefix}items`, name: `${prefix}items_org_idx`, columns: ["org_id"] },
    ],
  };
}

describe("extTablePrefix", () => {
  it("derives ext_<scope>_<pkg>_ from a scoped name", () => {
    expect(extTablePrefix("@cinatra-ai/foo-connector")).toBe("ext_cinatra_ai_foo_connector_");
  });
  it("bounds long names with a hash suffix", () => {
    const p = extTablePrefix("@cinatra-ai/an-extremely-long-connector-name-that-exceeds-limits");
    expect(p.length).toBeLessThanOrEqual(41);
    expect(p.startsWith("ext_")).toBe(true);
  });
});

describe("validateMigrationSpec (prefix + tenancy + allowlist)", () => {
  it("accepts a well-formed owned-table migration", () => {
    expect(validateMigrationSpec(validSpec(), PKG)).toEqual({ ok: true });
  });
  it("rejects a table outside the extension prefix (cross-table write)", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [{ op: "createTable", table: "cinatra.installed_extension", columns: [{ name: "org_id", type: "text" }] }],
    };
    const v = validateMigrationSpec(spec, PKG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/outside this extension's prefix|invalid table/);
  });
  it("requires an org_id column (tenancy)", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [{ op: "createTable", table: `${prefix}t`, columns: [{ name: "id", type: "uuid" }] }],
    };
    const v = validateMigrationSpec(spec, PKG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/org_id/);
  });
  it("requires org_id to be text NOT NULL, not merely present", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [{ op: "createTable", table: `${prefix}t`, columns: [{ name: "org_id", type: "text" }] }], // missing notNull
    };
    const v = validateMigrationSpec(spec, PKG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/text NOT NULL/);
  });
  it("rejects a FK referencesTable with unsafe identifier chars (injection guard)", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [{
        op: "createTable",
        table: `${prefix}t`,
        columns: [{ name: "org_id", type: "text", notNull: true }, { name: "ref", type: "text" }],
        foreignKeys: [{ column: "ref", referencesTable: `${prefix}other"; DROP TABLE x; --`, referencesColumn: "id" }],
      }],
    };
    const v = validateMigrationSpec(spec, PKG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/invalid FK ref table/);
  });
  it("rejects a FK onDelete outside the allowlist (injection guard)", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [
        { op: "createTable", table: `${prefix}parent`, columns: [{ name: "id", type: "uuid", notNull: true }, { name: "org_id", type: "text", notNull: true }], primaryKey: ["id"] },
        {
          op: "createTable",
          table: `${prefix}child`,
          columns: [{ name: "org_id", type: "text", notNull: true }, { name: "pid", type: "uuid" }],
          foreignKeys: [{ column: "pid", referencesTable: `${prefix}parent`, referencesColumn: "id", onDelete: "DROP TABLE x" as never }],
        },
      ],
    };
    const v = validateMigrationSpec(spec, PKG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/invalid FK onDelete/);
  });
  it("rejects a disallowed column type", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [{ op: "createTable", table: `${prefix}t`, columns: [{ name: "org_id", type: "text" }, { name: "blob", type: "money" as never }] }],
    };
    const v = validateMigrationSpec(spec, PKG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/disallowed type/);
  });
  it("rejects an FK to a non-owned table", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [{
        op: "createTable",
        table: `${prefix}t`,
        columns: [{ name: "org_id", type: "text" }, { name: "uid", type: "text" }],
        foreignKeys: [{ column: "uid", referencesTable: "user", referencesColumn: "id" }],
      }],
    };
    const v = validateMigrationSpec(spec, PKG);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/own tables/);
  });
});

describe("compileMigrationSpec", () => {
  it("emits idempotent, schema-qualified, quoted DDL", () => {
    const sql = compileMigrationSpec(validSpec(), PKG, "cinatra").map((q) => q.text);
    expect(sql[0]).toContain(`CREATE TABLE IF NOT EXISTS "cinatra"."${prefix}items"`);
    expect(sql[0]).toContain(`"org_id" text NOT NULL`);
    expect(sql[1]).toContain(`CREATE INDEX IF NOT EXISTS "${prefix}items_org_idx"`);
  });
  it("refuses to compile an invalid spec (defense in depth)", () => {
    const bad: ExtensionMigrationSpec = { id: "x", ops: [{ op: "createTable", table: "evil", columns: [] }] };
    expect(() => compileMigrationSpec(bad, PKG, "cinatra")).toThrow(/refusing to compile/);
  });
  it("escapes literal defaults safely", () => {
    const spec: ExtensionMigrationSpec = {
      id: "x",
      ops: [{ op: "createTable", table: `${prefix}t`, columns: [{ name: "org_id", type: "text", notNull: true }, { name: "note", type: "text", default: "o'brien" }] }],
    };
    const sql = compileMigrationSpec(spec, PKG, "cinatra").map((q) => q.text).join("\n");
    expect(sql).toContain("'o''brien'");
  });
});

describe("runExtensionMigrations (ledger idempotency + immutability)", () => {
  function fakeDb() {
    const applied = new Map<string, { hash: string }>();
    const ddl: string[] = [];
    const query = async <T,>(text: string, values?: readonly unknown[]): Promise<T[]> => {
      if (text.startsWith("SELECT migration_hash")) {
        const key = `${values?.[0]}::${values?.[1]}`;
        const row = applied.get(key);
        return (row ? [{ migration_hash: row.hash }] : []) as T[];
      }
      if (text.startsWith("INSERT INTO")) {
        applied.set(`${values?.[0]}::${values?.[1]}`, { hash: String(values?.[2]) });
        return [] as T[];
      }
      ddl.push(text);
      return [] as T[];
    };
    return { query, ddl, applied };
  }

  it("applies once, then skips on a second run (idempotent)", async () => {
    const db = fakeDb();
    const r1 = await runExtensionMigrations({ packageName: PKG, packageVersion: "1.0.0", specs: [validSpec()] }, { query: db.query });
    expect(r1.applied).toEqual(["0001-init"]);
    expect(db.ddl.some((s) => s.includes("CREATE TABLE"))).toBe(true);
    const r2 = await runExtensionMigrations({ packageName: PKG, packageVersion: "1.0.0", specs: [validSpec()] }, { query: db.query });
    expect(r2.applied).toEqual([]);
    expect(r2.skipped).toEqual(["0001-init"]);
  });

  it("rejects a re-declared id with a DIFFERENT spec (immutable)", async () => {
    const db = fakeDb();
    await runExtensionMigrations({ packageName: PKG, packageVersion: "1.0.0", specs: [validSpec("0001")] }, { query: db.query });
    const mutated: ExtensionMigrationSpec = { id: "0001", ops: [...validSpec("0001").ops, { op: "addColumn", table: `${prefix}items`, column: { name: "extra", type: "text" } }] };
    await expect(
      runExtensionMigrations({ packageName: PKG, packageVersion: "1.1.0", specs: [mutated] }, { query: db.query }),
    ).rejects.toThrow(/immutable/);
  });

  it("validates the whole batch before any DDL (fail closed)", async () => {
    const db = fakeDb();
    const bad: ExtensionMigrationSpec = { id: "bad", ops: [{ op: "createTable", table: "public.user", columns: [{ name: "org_id", type: "text" }] }] };
    await expect(
      runExtensionMigrations({ packageName: PKG, packageVersion: "1.0.0", specs: [validSpec(), bad] }, { query: db.query }),
    ).rejects.toThrow(/invalid/);
    expect(db.ddl.length).toBe(0); // nothing ran
  });
});

describe("loadExtensionMigrationSpecs", () => {
  const record: PackageStoreRecord = {
    packageName: PKG,
    serverEntry: null,
    requestedHostPorts: [],
    storeDir: "/store/foo/digest",
    migrations: [{ id: "0001", path: "./migrations/0001.json" }],
  };
  it("loads + shapes specs from the store", async () => {
    const specs = await loadExtensionMigrationSpecs(record, {
      readFile: async (p) => {
        expect(p).toBe("/store/foo/digest/migrations/0001.json");
        return JSON.stringify({ ops: validSpec().ops });
      },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].id).toBe("0001");
  });
  it("rejects a path-traversal migration path", async () => {
    await expect(
      loadExtensionMigrationSpecs(
        { ...record, migrations: [{ id: "x", path: "../../etc/passwd" }] },
        { readFile: async () => "{}" },
      ),
    ).rejects.toThrow(/unsafe migration path/);
  });
  it("returns [] when the record declares none (dormant)", async () => {
    expect(await loadExtensionMigrationSpecs({ ...record, migrations: undefined }, { readFile: async () => "" })).toEqual([]);
  });
});

describe("migrationSpecHash", () => {
  it("is stable + key-order independent, changes on content change", () => {
    const a = migrationSpecHash(validSpec("x"));
    const b = migrationSpecHash(validSpec("x"));
    expect(a).toBe(b);
    const changed: ExtensionMigrationSpec = { id: "x", ops: [...validSpec("x").ops, { op: "addColumn", table: `${prefix}items`, column: { name: "z", type: "text" } }] };
    expect(migrationSpecHash(changed)).not.toBe(a);
  });
});
