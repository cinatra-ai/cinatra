/**
 * Lifecycle proof for the requiredExtensions shrink 33 → 16 (cinatra#7):
 * BOTH sides of the fixed invariant are TEST deliverables, not side effects.
 *
 *   1. UPGRADED EXISTING DB — the demotion migration
 *      (migrations/core/core__0004_demote-optional-extension-anchors.mjs)
 *      converts the previously-required anchor rows to optional /
 *      marketplace-managed: `required_in_prod` → false, `locked` → `active`
 *      for exactly the demoted rows; archived tombstones stay archived;
 *      NOTHING is uninstalled; every other column is preserved byte-for-byte
 *      (the fixture seeds rich activation metadata BEFORE the migration so
 *      preservation is proven, not implied). Idempotent on re-run.
 *
 *   2. FRESH PROD DB — the real anchor seeder
 *      (ensureStaticBundleLifecycleAnchors) run against an image-shaped
 *      record set (exactly the shrunk bootable set) creates required-in-prod
 *      anchors for ONLY the declared set — locked, per the prod
 *      required-in-prod coercion — and never touches or resurrects a
 *      pre-existing optional row whose package left the bundle (the seeder
 *      is records-driven: a row without a record is never consulted).
 *
 * The no-DB shape assertions always run; the DB-gated suites skip without a
 * real SUPABASE_DB_URL (same contract as the sibling integration tests).
 * CI runs this file in the extension-lifecycle-db-tests job (Postgres
 * service container); locally: point SUPABASE_DB_URL at a dev Postgres and
 * run with CINATRA_DB_INTEGRATION_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
// the migration module is plain ESM — import the real artifact, no copy
import {
  DEMOTED_PACKAGES,
  up as demoteUp,
  down as demoteDown,
} from "../../../../migrations/core/core__0004_demote-optional-extension-anchors.mjs";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const requiredNames: string[] = (rootPkg.cinatra.requiredExtensions as string[]).map((e) => {
  const at = e.lastIndexOf("@");
  return at <= 0 ? e : e.slice(0, at);
});
const systemNames: string[] = rootPkg.cinatra.systemExtensions;

/** Image-shaped record set: exactly the declared bootable set, the shape the
 * in-image regenerated maps carry after acquisition. */
function imageShapedRecords() {
  return requiredNames.map((packageName) => ({
    packageName,
    scope: "cinatra-ai",
    kind: packageName.endsWith("-connector")
      ? "connector"
      : packageName.endsWith("-agent")
        ? "agent"
        : packageName.endsWith("-skills")
          ? "skill"
          : "artifact",
    version: "0.1.0",
    sourceDir: `extensions/cinatra-ai/${packageName.split("/")[1]}`,
    serverEntry: packageName.endsWith("-connector") && packageName !== "@cinatra-ai/nango-connector" ? "./register" : null,
    requestedHostPorts: [],
    dependencies: [],
    resolution: systemNames.includes(packageName) ? "required" : "guardedOptional",
  }));
}

// The fresh-prod suite drives the REAL seeder against the mocked generated
// maps (the image presence shape). Hoisted so the factory sees it.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_RECORDS: imageShapedRecords(),
}));

type SqlCapture = (pgm: { sql: (s: string) => void }) => void;

function migrationStatements(fn: unknown): string[] {
  const stmts: string[] = [];
  // The migration's JSDoc types pgm as node-pg-migrate's MigrationBuilder;
  // these data-only migrations use ONLY pgm.sql, so a capture shim suffices.
  (fn as SqlCapture)({ sql: (s: string) => stmts.push(s) });
  return stmts;
}

async function applyStoreDdl(client: Client, schema: string): Promise<void> {
  for (const q of buildCreateStoreSchemaQueries(schema)) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (
      head !== "CREATE" &&
      head !== "ALTER " &&
      head !== "DROP T" &&
      head !== "DROP S" &&
      head !== "DELETE" &&
      head !== "UPDATE" &&
      head !== "DO $$ " &&
      !head.startsWith("DO $$")
    ) {
      continue;
    }
    await client.query(q.text);
  }
}

const ANCHOR_SOURCE = (pkg: string) =>
  JSON.stringify({ type: "local", path: `static-bundle:${pkg}`, resolvedCommitOrTreeHash: "bundled@0.1.0" });
const TWENTY_DEPS = JSON.stringify([
  {
    packageName: "@cinatra-ai/crm-connector",
    kind: "connector",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
  },
]);

describe("core__0004 demotion artifact shape (no DB needed)", () => {
  it("freezes exactly the 17 packages the shrink removed — disjoint from the live declaration", () => {
    expect(DEMOTED_PACKAGES).toHaveLength(17);
    for (const pkg of DEMOTED_PACKAGES) {
      expect(pkg).toMatch(/^@cinatra-ai\/[a-z0-9-]+$/);
      expect(requiredNames).not.toContain(pkg);
    }
    // no demoted system package, ever
    for (const sys of systemNames) expect(DEMOTED_PACKAGES).not.toContain(sys);
  });

  it("up() demotes flag+lock only for required rows of the frozen list; down() re-promotes and re-locks live rows", () => {
    const [upSql] = migrationStatements(demoteUp);
    expect(upSql).toContain("required_in_prod = false");
    expect(upSql).toContain("WHEN status = 'locked' THEN 'active'");
    expect(upSql).toContain("WHERE required_in_prod = true");
    for (const pkg of DEMOTED_PACKAGES) expect(upSql).toContain(`'${pkg}'`);
    const [downSql] = migrationStatements(demoteDown);
    expect(downSql).toContain("required_in_prod = true");
    expect(downSql).toContain("WHEN status = 'active' THEN 'locked'"); // symmetric re-lock
  });

  it("ships its append-only ledger entry (migrations/manifest.json seq 0004)", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "migrations/manifest.json"), "utf8"));
    const entry = manifest.migrations.find((m: { seq: string }) => m.seq === "0004");
    expect(entry).toBeDefined();
    expect(entry.file).toBe("core/core__0004_demote-optional-extension-anchors.mjs");
    expect(entry.destructive).toBe(true);
    expect(entry.tables).toEqual(["installed_extension"]);
  });
});

describe.skipIf(!hasDb)("upgraded existing DB — demotion preserves installed state (DB-gated)", () => {
  let client: Client;
  let schema: string;

  type Row = Record<string, unknown>;
  const rowsByName = async (): Promise<Map<string, Row>> => {
    const res = await client.query(
      `SELECT * FROM "${schema}".installed_extension ORDER BY package_name, owner_level`,
    );
    return new Map(res.rows.map((r: Row) => [`${r.package_name}::${r.owner_level}`, r]));
  };

  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    schema = `cinatra_demote_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await applyStoreDdl(client, schema);

    // THE FIXTURE SEEDS ACTIVATION METADATA BEFORE THE MIGRATION (the
    // preservation proof): provenance source, dependency edges, manifest
    // hash, owner/org scoping — the pre-upgrade prod reality of the
    // 33-package interim set.
    const insert = `INSERT INTO "${schema}".installed_extension
      (id, package_name, owner_level, owner_id, organization_id, kind, status, source, required_in_prod, dependencies, manifest_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)`;
    // demoted, prod-locked platform anchor with rich metadata
    await client.query(insert, [
      "iext_demoted_twenty",
      "@cinatra-ai/twenty-connector",
      "platform",
      "__platform__",
      null,
      "connector",
      "locked",
      ANCHOR_SOURCE("@cinatra-ai/twenty-connector"),
      true,
      TWENTY_DEPS,
      "mh_twenty_1",
    ]);
    // demoted, archived tombstone (operator uninstalled pre-upgrade)
    await client.query(insert, [
      "iext_demoted_media",
      "@cinatra-ai/media-feeds-connector",
      "platform",
      "__platform__",
      null,
      "connector",
      "archived",
      ANCHOR_SOURCE("@cinatra-ai/media-feeds-connector"),
      true,
      "[]",
      null,
    ]);
    // demoted, org-scoped ACTIVE row (dev-installed) — flag flips, status stays
    await client.query(insert, [
      "iext_demoted_github_org",
      "@cinatra-ai/github-connector",
      "organization",
      "user_1",
      "org_1",
      "connector",
      "active",
      ANCHOR_SOURCE("@cinatra-ai/github-connector"),
      true,
      "[]",
      "mh_github_1",
    ]);
    // KEPT required package — must be completely untouched
    await client.query(insert, [
      "iext_kept_nango",
      "@cinatra-ai/nango-connector",
      "platform",
      "__platform__",
      null,
      "connector",
      "locked",
      ANCHOR_SOURCE("@cinatra-ai/nango-connector"),
      true,
      "[]",
      "mh_nango_1",
    ]);
  });

  afterAll(async () => {
    if (schema) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  async function runMigration(fn: unknown): Promise<void> {
    await client.query(`SET search_path TO "${schema}"`);
    try {
      for (const s of migrationStatements(fn)) await client.query(s);
    } finally {
      await client.query(`SET search_path TO public`);
    }
  }

  it("demotes, preserves, never deletes — then re-runs as a no-op (idempotent)", async () => {
    const before = await rowsByName();
    await runMigration(demoteUp);
    const after = await rowsByName();

    // nothing force-uninstalled: row set identical
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    // demoted prod-locked anchor: unlocked + optional, EVERYTHING else preserved
    const twentyBefore = before.get("@cinatra-ai/twenty-connector::platform")!;
    const twenty = after.get("@cinatra-ai/twenty-connector::platform")!;
    expect(twenty.required_in_prod).toBe(false);
    expect(twenty.status).toBe("active");
    for (const col of Object.keys(twentyBefore)) {
      if (col === "required_in_prod" || col === "status" || col === "updated_at") continue;
      expect({ col, v: twenty[col] }).toEqual({ col, v: twentyBefore[col] });
    }
    // the seeded activation metadata survived byte-for-byte
    expect(twenty.source).toEqual(JSON.parse(ANCHOR_SOURCE("@cinatra-ai/twenty-connector")));
    expect(twenty.dependencies).toEqual(JSON.parse(TWENTY_DEPS));
    expect(twenty.manifest_hash).toBe("mh_twenty_1");

    // archived tombstone: stays archived (an operator decision is never resurrected)
    const media = after.get("@cinatra-ai/media-feeds-connector::platform")!;
    expect(media.required_in_prod).toBe(false);
    expect(media.status).toBe("archived");

    // org-scoped active row: flag flips, status untouched
    const github = after.get("@cinatra-ai/github-connector::organization")!;
    expect(github.required_in_prod).toBe(false);
    expect(github.status).toBe("active");
    expect(github.organization_id).toBe("org_1");

    // kept required package: completely untouched (incl. updated_at)
    const nango = after.get("@cinatra-ai/nango-connector::platform")!;
    expect(nango).toEqual(before.get("@cinatra-ai/nango-connector::platform")!);

    // idempotency: a second run matches zero rows — updated_at frozen
    await runMigration(demoteUp);
    const again = await rowsByName();
    for (const [key, row] of again) expect(row).toEqual(after.get(key)!);
  });

  it("down() is the symmetric inverse: re-promotes AND re-locks live rows; tombstones stay archived", async () => {
    await runMigration(demoteDown);
    const after = await rowsByName();
    const twenty = after.get("@cinatra-ai/twenty-connector::platform")!;
    expect(twenty.required_in_prod).toBe(true);
    // required-implies-locked restored by the rollback itself (there is no
    // boot-time re-lock pass for pre-existing rows — INSERT-time coercion only)
    expect(twenty.status).toBe("locked");
    const media = after.get("@cinatra-ai/media-feeds-connector::platform")!;
    expect(media.required_in_prod).toBe(true);
    expect(media.status).toBe("archived"); // operator decision never resurrected
  });
});

describe.skipIf(!hasDb)("fresh prod DB — seeding creates ONLY the shrunk required set (DB-gated)", () => {
  let client: Client;
  let schema: string;
  const prevSchemaEnv = process.env.SUPABASE_SCHEMA;
  const prevModeEnv = process.env.CINATRA_RUNTIME_MODE;

  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    schema = `cinatra_fresh_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await applyStoreDdl(client, schema);
    // The canonical store reads SUPABASE_SCHEMA at module load; the seeder
    // imports it lazily at call time, so setting the env here (before the
    // first call) pins all canonical writes to the per-test schema.
    process.env.SUPABASE_SCHEMA = schema;
    // prod semantics: required-in-prod anchors must seed LOCKED
    process.env.CINATRA_RUNTIME_MODE = "production";

    // Pre-existing OPTIONAL row whose package left the bundle (post-shrink
    // image): the records-driven seeder must never consult, touch, or
    // resurrect it.
    await client.query(
      `INSERT INTO "${schema}".installed_extension
       (id, package_name, owner_level, owner_id, organization_id, kind, status, source, required_in_prod, dependencies, manifest_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)`,
      [
        "iext_optional_blog",
        "@cinatra-ai/blog-connector",
        "platform",
        "__platform__",
        null,
        "connector",
        "active",
        ANCHOR_SOURCE("@cinatra-ai/blog-connector"),
        false,
        "[]",
        "mh_blog_1",
      ],
    );
  });

  afterAll(async () => {
    if (prevSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = prevSchemaEnv;
    if (prevModeEnv === undefined) delete process.env.CINATRA_RUNTIME_MODE;
    else process.env.CINATRA_RUNTIME_MODE = prevModeEnv;
    if (schema) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("anchors exactly the declared required set, locked; the stale optional row is untouched", async () => {
    const blogBefore = (
      await client.query(`SELECT * FROM "${schema}".installed_extension WHERE id = 'iext_optional_blog'`)
    ).rows[0];

    // the REAL seeder over the image-shaped (mocked) generated records
    const { ensureStaticBundleLifecycleAnchors } = await import("@/lib/static-bundle-lifecycle");
    const result = await ensureStaticBundleLifecycleAnchors();
    expect(result.failed).toEqual([]);
    expect(result.seededLive.sort()).toEqual([...requiredNames].sort());

    const res = await client.query(
      `SELECT package_name, status, required_in_prod, source FROM "${schema}".installed_extension`,
    );
    const requiredRows = res.rows.filter((r) => r.required_in_prod === true);
    expect(requiredRows.map((r) => r.package_name).sort()).toEqual([...requiredNames].sort());
    for (const r of requiredRows) {
      // prod coercion: required-in-prod can never start unlocked
      expect({ pkg: r.package_name, status: r.status }).toEqual({ pkg: r.package_name, status: "locked" });
      expect((r.source as { path?: string }).path).toBe(`static-bundle:${r.package_name}`);
    }
    // nothing beyond the declared set + the pre-existing optional row
    expect(res.rows).toHaveLength(requiredNames.length + 1);

    // the optional row was never consulted (records-driven seeder)
    const blogAfter = (
      await client.query(`SELECT * FROM "${schema}".installed_extension WHERE id = 'iext_optional_blog'`)
    ).rows[0];
    expect(blogAfter).toEqual(blogBefore);
  });
});
