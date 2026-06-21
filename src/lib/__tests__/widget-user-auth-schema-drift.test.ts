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
