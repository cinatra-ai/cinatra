import { describe, it, expect } from "vitest";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

// Schema-drift guard for widget_stream_tokens (cinatra#220), mirroring the
// cli-rich-schema-drift.test.ts pattern: the SINGLE source of truth for the
// table is buildCreateStoreSchemaQueries() (run at every dev-server boot via
// ensurePostgresSchema()). The short-lived token broker
// (src/lib/widget-token-broker.ts) does raw INSERT/SELECT/DELETE against this
// table, so its columns + the expires_at sweep index MUST exist in every DB.
// This locks that contract so a column rename/drop in the SSOT fails here, not
// silently at runtime.

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

describe("widget_stream_tokens schema-drift guard", () => {
  const ddl = ddlFor("widget_stream_tokens");

  it("the table is created by the boot SSOT", () => {
    expect(ddl).not.toBe("");
  });

  it("declares every column the token broker reads/writes", () => {
    // token_hash is the PK (SHA-256(rawToken) hex) — the raw token is never stored.
    expect(ddl).toMatch(/token_hash text PRIMARY KEY/);
    for (const col of [
      "jti",
      "agent_slug",
      "aud",
      "iss",
      "origin",
      "scope",
      "sub",
      "token_config_key",
      "token_key_fingerprint",
      "expires_at",
      "created_at",
    ]) {
      expect(ddl).toContain(col);
    }
    // expiry + audit timestamps are timestamptz.
    expect(ddl).toMatch(/expires_at timestamptz NOT NULL/);
    expect(ddl).toMatch(/created_at timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("creates the expires_at index that drives the on-mint/on-consume sweep", () => {
    const hasExpiresIdx = indexTexts().some(
      (t) =>
        t.includes("widget_stream_tokens_expires_at_idx") &&
        t.includes('"widget_stream_tokens" (expires_at)'),
    );
    expect(hasExpiresIdx).toBe(true);
  });
});
