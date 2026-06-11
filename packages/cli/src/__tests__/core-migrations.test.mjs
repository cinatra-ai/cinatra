import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { describe, expect, it, afterAll } from "vitest";

import {
  CORE_MIGRATIONS_DIR,
  CORE_MIGRATIONS_TABLE,
  CORE_MIGRATION_NAMESPACE,
  CORE_MIGRATION_FILE_RE,
  CORE_MIGRATION_LOCK_KEY,
  validateCoreMigrationsDir,
  assertDownTargetsAreCore,
  isFreshCoreSchema,
} from "../core-migrations.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const tempDirs = [];
function tempMigrationsDir(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "core-migrations-test-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(path.join(dir, name), "export function up() {}\n");
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("contract constants", () => {
  it("pin the shared-ledger design from cinatra#115/#116", () => {
    expect(CORE_MIGRATIONS_DIR).toBe("migrations/core");
    expect(CORE_MIGRATIONS_TABLE).toBe("pgmigrations");
    expect(CORE_MIGRATION_NAMESPACE).toBe("core__");
    // The SAME advisory-lock key ensurePostgresSchema (src/lib/postgres-schema-init.ts)
    // and the extension migration host (src/lib/extension-migration-host.ts) use.
    expect(CORE_MIGRATION_LOCK_KEY).toBe("cinatra-schema-init");
  });

  it("filename regex mirrors the gate's MIGRATION_MODULE_RE basename", async () => {
    expect(CORE_MIGRATION_FILE_RE.test("core__0003_narrow-usage-events-cost-usd.mjs")).toBe(true);
    expect(CORE_MIGRATION_FILE_RE.test("core__0003_Bad-Case.mjs")).toBe(false);
    expect(CORE_MIGRATION_FILE_RE.test("0003_no-namespace.mjs")).toBe(false);
    expect(CORE_MIGRATION_FILE_RE.test("core__003_short-seq.mjs")).toBe(false);
    expect(CORE_MIGRATION_FILE_RE.test("core__0003_wrong-ext.sql")).toBe(false);

    // Parity with the CI gate: what the runner accepts at runtime and what
    // the gate demands in a PR must be the SAME contract.
    const { MIGRATION_MODULE_RE } = await import(
      path.join(REPO_ROOT, "scripts", "audit", "schema-migration-gate.mjs")
    );
    for (const basename of [
      "core__0003_narrow-usage-events-cost-usd.mjs",
      "core__0003_Bad-Case.mjs",
      "0003_no-namespace.mjs",
      "core__003_short-seq.mjs",
      "core__0003_wrong-ext.sql",
    ]) {
      expect(MIGRATION_MODULE_RE.test(`migrations/core/${basename}`)).toBe(
        CORE_MIGRATION_FILE_RE.test(basename),
      );
    }
  });
});

describe("validateCoreMigrationsDir", () => {
  it("accepts the repo's real migrations/core directory", async () => {
    const files = await validateCoreMigrationsDir(path.join(REPO_ROOT, CORE_MIGRATIONS_DIR));
    expect(files).toContain("core__0001_notifications-dedupe-key.mjs");
    expect(files).toContain("core__0002_drop-agent-templates-durable.mjs");
  });

  it("rejects filenames outside the contract (this replaces node-pg-migrate's checkOrder)", async () => {
    const dir = tempMigrationsDir(["core__0001_ok.mjs", "0002_no-namespace.mjs"]);
    await expect(validateCoreMigrationsDir(dir)).rejects.toThrow(/filename contract/);
  });

  it("rejects duplicate sequence numbers", async () => {
    const dir = tempMigrationsDir(["core__0001_ok.mjs", "core__0001_dupe.mjs"]);
    await expect(validateCoreMigrationsDir(dir)).rejects.toThrow(/duplicate core migration sequence/);
  });

  it("ignores dotfiles and fails actionably on a missing directory", async () => {
    const dir = tempMigrationsDir(["core__0001_ok.mjs", ".gitkeep"]);
    await expect(validateCoreMigrationsDir(dir)).resolves.toEqual(["core__0001_ok.mjs"]);
    await expect(validateCoreMigrationsDir(path.join(dir, "missing"))).rejects.toThrow(/must ship with the app/);
  });
});

describe("assertDownTargetsAreCore (shared-ledger down fence)", () => {
  it("passes when every targeted ledger row is a core migration", () => {
    expect(() => assertDownTargetsAreCore(["core__0002_b", "core__0001_a"])).not.toThrow();
  });

  it("refuses when the newest rows belong to another source (post-#118 extension rows)", () => {
    expect(() => assertDownTargetsAreCore(["ext_cinatra-ai_crm__0004_x", "core__0002_b"])).toThrow(
      /refusing to migrate down/,
    );
  });
});

describe("isFreshCoreSchema", () => {
  it("treats a missing metadata table as fresh (setup must ledger-fake the chain)", async () => {
    const fake = { query: async () => ({ rows: [{ t: null }] }) };
    await expect(isFreshCoreSchema(fake, "cinatra")).resolves.toBe(true);
  });

  it("treats an existing metadata table as deployed (setup must execute migrations)", async () => {
    const queries = [];
    const fake = {
      query: async (text, values) => {
        queries.push({ text, values });
        return { rows: [{ t: "metadata" }] };
      },
    };
    await expect(isFreshCoreSchema(fake, "cinatra_branch")).resolves.toBe(false);
    // The probe must target the WORKTREE schema, quoted.
    expect(queries[0].values).toEqual(['"cinatra_branch".metadata']);
  });
});
