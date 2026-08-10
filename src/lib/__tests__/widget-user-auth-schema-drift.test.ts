import { describe, it, expect } from "vitest";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

// cinatra#407 schema-drift guard for the three hosted /widget-auth tables,
// mirroring widget-stream-tokens-schema-drift.test.ts: the SINGLE source of
// truth for these tables is buildCreateStoreSchemaQueries() (run at every
// dev-server boot via ensurePostgresSchema()). src/lib/widget-user-auth.ts does
// raw INSERT/SELECT/UPDATE/DELETE against them, so its columns + the expiry
// sweep indexes MUST exist in every DB. This locks that contract so a
// column rename/drop in the SSOT fails here, not silently at runtime.

function ddlFor(table: string): string {
  const queries = buildCreateStoreSchemaQueries("drift_test");
  const create = queries.find((q) =>
    String(q.text).includes(`CREATE TABLE IF NOT EXISTS "drift_test"."${table}"`),
  );
  return create ? String(create.text) : "";
}

function indexTexts(): string[] {
  return buildCreateStoreSchemaQueries("drift_test")
    .map((q) => String(q.text))
    .filter((t) => t.includes("CREATE INDEX") || t.includes("CREATE UNIQUE INDEX"));
}

describe("widget_auth_transactions schema-drift guard", () => {
  const ddl = ddlFor("widget_auth_transactions");

  it("is created by the boot SSOT", () => {
    expect(ddl).not.toBe("");
  });

  it("declares every column the engine reads/writes", () => {
    expect(ddl).toMatch(/txn_id\s+uuid PRIMARY KEY/);
    for (const col of [
      "site_id",
      "client",
      "org_id",
      "site_origin",
      "agent_slug",
      "instance_id",
      "code_challenge",
      "state",
      "created_at",
      "expires_at",
      "consumed_at",
    ]) {
      expect(ddl).toContain(col);
    }
    expect(ddl).toMatch(/expires_at\s+timestamptz NOT NULL/);
  });

  it("creates the expiry sweep index", () => {
    const ok = indexTexts().some(
      (t) =>
        t.includes("widget_auth_transactions_expiry_idx") &&
        t.includes('"widget_auth_transactions" (expires_at)'),
    );
    expect(ok).toBe(true);
  });
});

// cinatra#2631 — `displayed_scopes` on the TRANSACTION carries what the sign-in
// screen showed. Same rollout hazard as granted_scopes: CREATE TABLE IF NOT
// EXISTS never touches an existing table, so an installed deployment gains the
// column only through the idempotent ALTER, and the SELECT that names it would
// otherwise break every widget login after the upgrade.
describe("widget_auth_transactions displayed_scopes rollout", () => {
  it("adds displayed_scopes to an EXISTING deployment (idempotent ALTER, nullable)", () => {
    const alters = buildCreateStoreSchemaQueries("drift_test")
      .map((q) => String(q.text))
      .filter((t) => t.includes("ALTER TABLE") && t.includes("widget_auth_transactions"));
    expect(
      alters.some((t) =>
        /ADD COLUMN IF NOT EXISTS displayed_scopes text\s*$/.test(t.trim()),
      ),
    ).toBe(true);
  });

  it("orders the ALTER after the CREATE", () => {
    const texts = buildCreateStoreSchemaQueries("drift_test").map((q) => String(q.text));
    const createIdx = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "drift_test"."widget_auth_transactions"'),
    );
    const alterIdx = texts.findIndex(
      (t) =>
        t.includes("widget_auth_transactions") &&
        t.includes("ADD COLUMN IF NOT EXISTS displayed_scopes"),
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(createIdx);
  });
});

// cinatra#2631 (codex rework round 7, finding 1) — the record on the transaction
// says WHAT was displayed; this column says WHOSE arrival it was displayed to.
// The engine's write names it and its SELECT reads it, so the same rollout
// hazard applies: without the idempotent ALTER an installed deployment would
// name a column that is not there and every widget login would break.
describe("widget_auth_transactions screen_nonce_hash rollout", () => {
  const alters = buildCreateStoreSchemaQueries("drift_test")
    .map((q) => String(q.text))
    .filter((t) => t.includes("ALTER TABLE") && t.includes("widget_auth_transactions"));

  it("adds screen_nonce_hash to an EXISTING deployment (idempotent ALTER, nullable)", () => {
    // NULLABLE is the mixed-version contract, not an oversight: a node running
    // the previous build writes a displayed set and no nonce, and that record
    // must fail closed at the grant rather than being redeemable by anyone.
    expect(
      alters.some((t) =>
        /ADD COLUMN IF NOT EXISTS screen_nonce_hash text\s*$/.test(t.trim()),
      ),
    ).toBe(true);
  });

  it("orders the ALTER after the CREATE, and never rewrites the CREATE", () => {
    const texts = buildCreateStoreSchemaQueries("drift_test").map((q) => String(q.text));
    const createIdx = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "drift_test"."widget_auth_transactions"'),
    );
    const alterIdx = texts.findIndex(
      (t) =>
        t.includes("widget_auth_transactions") &&
        t.includes("ADD COLUMN IF NOT EXISTS screen_nonce_hash"),
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(createIdx);
    // Adding it to the deployed CREATE reads to the schema-migration gate as a
    // drop/retype of the whole table.
    expect(
      texts.filter((t) => t.includes("CREATE TABLE") && t.includes("screen_nonce_hash")),
    ).toEqual([]);
  });
});

// cinatra#2631 (codex rework rounds 4 + 6) — the hosted login proves "no sign-in
// screen rendered" by showing that a session row was already in the database
// when the transaction row was inserted. Both sides of that comparison must be
// stamped by the DATABASE at INSERT, so the app owns one column on Better Auth's
// session table (the `teamMember`.`role` precedent) and provisions it here.
describe("the session-row insert stamp the ordering proof reads", () => {
  const alters = buildCreateStoreSchemaQueries("drift_test")
    .map((q) => String(q.text))
    .filter((t) => t.includes("ALTER TABLE") && t.includes('"session"'));

  it("adds cinatra_db_created_at to Better Auth's session table, defaulted by the DATABASE", () => {
    // The DEFAULT is the whole point: a node running the PREVIOUS build inserts
    // session rows without naming this column, so Postgres fills it — with its
    // own clock, not the minting node's. A value the app wrote would be a node
    // clock again, which is the hole this replaced.
    expect(
      alters.some((t) =>
        /ADD COLUMN IF NOT EXISTS cinatra_db_created_at timestamptz NOT NULL DEFAULT now\(\)\s*$/.test(
          t.trim(),
        ),
      ),
    ).toBe(true);
  });

  it("names the auth schema explicitly and tolerates the table not existing yet", () => {
    // On a FRESH install this runs before Better Auth's own migration creates
    // the table; without IF EXISTS the whole schema init would abort there.
    const alter = alters.find((t) => t.includes("cinatra_db_created_at")) ?? "";
    expect(alter).toContain('ALTER TABLE IF EXISTS "public"."session"');
    // ...and it is an ALTER, never part of a CREATE: rewriting a deployed
    // table's column list is what the schema-migration gate reads as a
    // drop/retype.
    const creates = buildCreateStoreSchemaQueries("drift_test")
      .map((q) => String(q.text))
      .filter((t) => t.includes("CREATE TABLE") && t.includes("cinatra_db_created_at"));
    expect(creates).toEqual([]);
  });
});

describe("widget_auth_codes schema-drift guard", () => {
  const ddl = ddlFor("widget_auth_codes");

  it("is created by the boot SSOT", () => {
    expect(ddl).not.toBe("");
  });

  it("is keyed by the code HASH and declares the full user binding", () => {
    expect(ddl).toMatch(/code_hash\s+text PRIMARY KEY/);
    for (const col of [
      "user_id",
      "site_id",
      "client",
      "org_id",
      "site_origin",
      "agent_slug",
      "instance_id",
      "code_challenge",
      "granted_scopes",
      "created_at",
      "expires_at",
    ]) {
      expect(ddl).toContain(col);
    }
  });

  it("creates the expiry sweep index", () => {
    const ok = indexTexts().some(
      (t) =>
        t.includes("widget_auth_codes_expiry_idx") &&
        t.includes('"widget_auth_codes" (expires_at)'),
    );
    expect(ok).toBe(true);
  });

  // cinatra#2574 — `granted_scopes` records the consented grant on the code.
  // CREATE TABLE IF NOT EXISTS never touches an EXISTING table, so an installed
  // deployment only gains the column through the idempotent ALTER. Without it
  // the redeem's RETURNING clause names a column that is not there and EVERY
  // widget login breaks after the upgrade — a boot-order failure the drift guard
  // is exactly the right place to catch.
  it("adds granted_scopes to an EXISTING deployment (idempotent ALTER, nullable)", () => {
    const alters = buildCreateStoreSchemaQueries("drift_test")
      .map((q) => String(q.text))
      .filter((t) => t.includes("ALTER TABLE") && t.includes("widget_auth_codes"));
    expect(
      alters.some((t) => /ADD COLUMN IF NOT EXISTS granted_scopes text\s*$/.test(t.trim())),
    ).toBe(true);
  });

  it("orders the ALTER after the CREATE (a column added to a table that does not exist yet throws)", () => {
    const texts = buildCreateStoreSchemaQueries("drift_test").map((q) => String(q.text));
    const createIdx = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "drift_test"."widget_auth_codes"'),
    );
    const alterIdx = texts.findIndex(
      (t) => t.includes("widget_auth_codes") && t.includes("ADD COLUMN IF NOT EXISTS granted_scopes"),
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(createIdx);
  });
});

describe("widget_user_tokens schema-drift guard", () => {
  const ddl = ddlFor("widget_user_tokens");

  it("is created by the boot SSOT", () => {
    expect(ddl).not.toBe("");
  });

  it("is keyed by the token HASH (raw token never stored) and declares the bound claims", () => {
    expect(ddl).toMatch(/token_hash\s+text PRIMARY KEY/);
    for (const col of [
      "jti",
      "user_id",
      "site_id",
      "client",
      "org_id",
      "site_origin",
      "agent_slug",
      "instance_id",
      "credential_version",
      "aud",
      "iss",
      "scope",
      "expires_at",
      "created_at",
    ]) {
      expect(ddl).toContain(col);
    }
  });

  it("creates the expiry sweep index that drives the on-mint/on-consume sweep", () => {
    const ok = indexTexts().some(
      (t) =>
        t.includes("widget_user_tokens_expiry_idx") &&
        t.includes('"widget_user_tokens" (expires_at)'),
    );
    expect(ok).toBe(true);
  });
});
