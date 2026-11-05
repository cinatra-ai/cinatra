// cinatra#3978 — the bootstrap DDL of `artifact_review_effect_records`, its
// migration twin core__0129 and its manifest fragment, pinned without a
// database. The two DDLs must be the same statement but for the schema
// qualification, so a fresh install and an upgraded one hold the same table.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { artifactReviewGateSchemaQueries } from "@/lib/artifacts/artifact-review-gate-schema";
import { artifactReviewEffectRecordsDdlSql } from "../../../migrations/core/core__0129_artifact-review-effect-records.mjs";

/** The one-row-per-reviewed-target constraint, inline in the CREATE TABLE. */
const TARGET_UNIQ =
  /CONSTRAINT artifact_review_effect_records_target_uniq UNIQUE \(gate_id, reviewed_artifact_id, reviewed_representation_revision_id\)\s*\)/;
/** A separate unique index on the table (the schema-migration gate reads it as one on an existing table). */
const STANDALONE_UNIQUE_INDEX = /CREATE\s+UNIQUE\s+INDEX[^;]*artifact_review_effect_records/i;

const all = artifactReviewGateSchemaQueries("cinatra").map((q) => q.text);
const effectQueries = all.filter((t) => t.includes("artifact_review_effect_records"));
const bootstrap = effectQueries.join(";\n");

/** Normalize a DDL: drop the app-schema qualification and collapse whitespace. */
function normalize(sql: string): string {
  return sql
    .replaceAll('"cinatra".', "")
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*/g, ";")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim()
    .replace(/;$/, "");
}

describe("artifact_review_effect_records — the bootstrap DDL", () => {
  it("creates the table in one statement, after the gate table it references", () => {
    expect(effectQueries).toHaveLength(1);
    const gateAt = all.findIndex((t) => /CREATE TABLE IF NOT EXISTS "cinatra"\."artifact_review_gates"/.test(t));
    const effectAt = all.findIndex((t) => /CREATE TABLE IF NOT EXISTS "cinatra"\."artifact_review_effect_records"/.test(t));
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(effectAt).toBeGreaterThan(gateAt);
  });

  it("binds every row to its gate, with cascade, and holds one per reviewed target", () => {
    expect(bootstrap).toMatch(/gate_id\s+text NOT NULL\s+REFERENCES "cinatra"\."artifact_review_gates" \(id\) ON DELETE CASCADE/);
    expect(bootstrap).toMatch(TARGET_UNIQ);
    for (const col of ["org_id", "run_id", "reviewed_artifact_id", "reviewed_representation_revision_id"]) {
      expect(bootstrap).toMatch(new RegExp(`${col}\\s+text NOT NULL`));
    }
  });

  it("holds the one-per-target rule inline, with no separate unique index on the table", () => {
    for (const text of all) expect(text).not.toMatch(STANDALONE_UNIQUE_INDEX);
    expect(artifactReviewEffectRecordsDdlSql).not.toMatch(STANDALONE_UNIQUE_INDEX);
    expect(artifactReviewEffectRecordsDdlSql).toMatch(TARGET_UNIQ);
  });

  it("checks the writer kind, the source and the record (an object of at most 8192 bytes)", () => {
    expect(bootstrap).toMatch(/writer\s+text NOT NULL CHECK \(writer IN \('cms_apply','dashboard_publish'\)\)/);
    expect(bootstrap).toMatch(/source_ref\s+text NOT NULL CHECK \(octet_length\(source_ref\) BETWEEN 1 AND 256\)/);
    expect(normalize(bootstrap)).toContain(
      "record_json text NOT NULL CHECK (octet_length(record_json) <= 8192 AND jsonb_typeof(record_json::jsonb) = 'object')",
    );
    expect(bootstrap).toMatch(/recorded_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });
});

describe("artifact_review_effect_records — the migration twin and its manifest", () => {
  it("is the same DDL as the bootstrap, but for the schema qualification", () => {
    expect(normalize(artifactReviewEffectRecordsDdlSql)).toBe(normalize(bootstrap));
  });

  it("is recorded as an additive fragment naming its table", () => {
    const fragment = JSON.parse(
      readFileSync(new URL("../../../migrations/manifest.d/core__0129_artifact-review-effect-records.json", import.meta.url), "utf8"),
    ) as { seq: string; file: string; destructive: boolean; tables: string[] };
    expect(fragment.seq).toBe("0129");
    expect(fragment.file).toBe("core/core__0129_artifact-review-effect-records.mjs");
    expect(fragment.destructive).toBe(false);
    expect(fragment.tables).toEqual(["artifact_review_effect_records"]);
  });
});
