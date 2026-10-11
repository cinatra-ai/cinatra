import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeArgs = ["--conditions=react-server", "--import", "tsx"];

function runCommand(script, { env = {}, args = [], input = "" } = {}) {
  return spawnSync(process.execPath, [...runtimeArgs, script, ...args], {
    cwd: root,
    env: { ...process.env, APP_RUNTIME_MODE: "", ...env },
    input,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

for (const mode of ["", "production", "staging"]) {
  test(`database preparation refuses ${mode || "undeclared"} runtime before connecting`, () => {
    const secret = "synthetic-database-secret-must-not-be-printed";
    const result = runCommand("scripts/prepare-dev-database.mjs", {
      env: {
        CINATRA_RUNTIME_MODE: mode,
        SUPABASE_DB_URL: `postgres://operator:${secret}@127.0.0.1:1/unused`,
        BETTER_AUTH_SECRET: secret,
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /development/);
    assert.doesNotMatch(output, /auth migration complete|base schema complete|ECONNREFUSED/);
    assert.ok(!output.includes(secret));
  });
}

test("database preparation reports missing configuration without connecting", () => {
  const result = runCommand("scripts/prepare-dev-database.mjs", {
    env: {
      CINATRA_RUNTIME_MODE: "development",
      SUPABASE_DB_URL: "",
      BETTER_AUTH_SECRET: "",
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SUPABASE_DB_URL/);
  assert.doesNotMatch(result.stdout, /complete/);
});

test("a failed authentication migration stops before the baseline and hides connection credentials", () => {
  const secret = "synthetic-connection-secret-never-print";
  const result = runCommand("scripts/prepare-dev-database.mjs", {
    env: {
      CINATRA_RUNTIME_MODE: "development",
      SUPABASE_DB_URL: `postgres://operator:${secret}@127.0.0.1:1/unused`,
      BETTER_AUTH_SECRET: "fresh-provisioning-placeholder-not-a-credential",
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /auth migration failed; preparation stopped/);
  assert.doesNotMatch(output, /base schema complete|db:migrate complete|Database ready/);
  assert.ok(!output.includes(secret));
});

// This is an explicit disposable-database lane, not the generic SUPABASE_DB_URL.
// It refuses a non-empty database and never drops tables or resets operator data.
test("prepares an empty database, provisions before boot, and preserves rows on rerun", {
  skip: !process.env.CINATRA_PROVISION_FRESH_DB_URL,
  timeout: 900_000,
}, async () => {
  const { Client } = await import("pg");
  const connectionString = process.env.CINATRA_PROVISION_FRESH_DB_URL;
  const schema = "cinatra_fresh_provisioning";
  const env = {
    CINATRA_RUNTIME_MODE: "development",
    SUPABASE_DB_URL: connectionString,
    SUPABASE_SCHEMA: schema,
    BETTER_AUTH_SECRET: "fresh-provisioning-placeholder-not-a-credential",
    BETTER_AUTH_URL: "http://localhost:3000",
    CINATRA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CINATRA_AGENT_REGISTRY_URL: "http://127.0.0.1:1",
    // Existing operator override suppresses auto-attachment; this test owns no
    // marketplace account and must not mint one as a side effect of namespace setup.
    MARKETPLACE_INSTANCE_TOKEN: "fresh-provisioning-offline-placeholder",
  };
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    );
    assert.equal(existing.rowCount, 0, "CINATRA_PROVISION_FRESH_DB_URL must name an empty disposable database");

    const prepared = runCommand("scripts/prepare-dev-database.mjs", { env });
    assert.equal(prepared.error, undefined);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.match(prepared.stdout, /auth migration complete[\s\S]*base schema complete[\s\S]*db:migrate complete/);

    const auth = await client.query("SELECT count(*)::int AS count FROM public.\"user\"");
    assert.equal(auth.rows[0].count, 0, "preparation must not create an administrator");
    const before = await client.query(`SELECT name FROM "${schema}".pgmigrations ORDER BY name`);
    assert.ok(before.rows.length > 0, "the real migration ledger must be populated");

    const origin = "https://fresh-provisioning.example.test";
    const email = "fresh-operator@example.test";
    const password = "synthetic-fresh-admin-password-3766";
    const provisioned = runCommand("scripts/provision-dev-instance.mjs", {
      env,
      args: ["--admin-email", email, "--namespace", "fresh-provisioning", "--public-origin", origin],
      input: JSON.stringify({ adminPassword: password }),
    });
    assert.equal(provisioned.error, undefined);
    assert.equal(provisioned.status, 0, provisioned.stdout + provisioned.stderr);
    assert.ok(!(provisioned.stdout + provisioned.stderr).includes(password));
    const administrator = await client.query('SELECT id, role FROM public."user" WHERE email = $1', [email]);
    assert.equal(administrator.rows[0]?.role, "admin");
    const sessions = await client.query('SELECT count(*)::int AS count FROM public.session WHERE "userId" = $1', [administrator.rows[0].id]);
    assert.equal(sessions.rows[0].count, 0, "the command must end the sign-up session");
    const identity = await client.query(`SELECT value FROM "${schema}".metadata WHERE key = 'instance_identity'`);
    assert.equal(JSON.parse(identity.rows[0].value).instanceNamespace, "fresh-provisioning");
    const rows = await client.query(`SELECT key, value FROM "${schema}".metadata WHERE value LIKE $1`, [`%${origin}%`]);
    assert.ok(rows.rowCount > 0, "the real provisioning command must persist its public origin before app boot");

    const rerun = runCommand("scripts/prepare-dev-database.mjs", { env });
    assert.equal(rerun.error, undefined);
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    const after = await client.query(`SELECT name FROM "${schema}".pgmigrations ORDER BY name`);
    assert.deepEqual(after.rows, before.rows, "rerunning must not duplicate the migration ledger");
    for (const row of rows.rows) {
      const stored = await client.query(`SELECT value FROM "${schema}".metadata WHERE key = $1`, [row.key]);
      assert.equal(stored.rows[0]?.value, row.value, "preparation must preserve provisioned settings");
    }
  } finally {
    await client.end();
  }
});
