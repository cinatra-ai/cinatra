// The page capture budget's table ships in the bootstrap DDL (cinatra#4223).
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  PAGE_CAPTURE_LEASES_TABLE,
  pageCaptureLeasesSchemaQueries,
} from "@/lib/artifacts/publication-operation-schema";

describe("page_capture_leases bootstrap DDL (cinatra#4223)", () => {
  it("the bootstrap runs every statement of the lease leaf exactly once", () => {
    const all = buildCreateStoreSchemaQueries("cinatra_fixture").map((row) => row.text);
    const leaf = pageCaptureLeasesSchemaQueries("cinatra_fixture").map((row) => row.text);
    expect(leaf).toHaveLength(2);
    for (const stmt of leaf) expect(all.filter((row) => row === stmt)).toHaveLength(1);
  });

  it("creates the table before its index, additively", () => {
    const [table, index] = pageCaptureLeasesSchemaQueries("cinatra_fixture").map((row) => row.text);
    expect(PAGE_CAPTURE_LEASES_TABLE).toBe("page_capture_leases");
    expect(table).toMatch(/^CREATE TABLE IF NOT EXISTS "cinatra_fixture"\."page_capture_leases" \(/);
    for (const column of [
      "id text PRIMARY KEY",
      "org_id text NOT NULL",
      "run_id text NOT NULL",
      "acquired_at timestamptz NOT NULL DEFAULT now()",
      "expires_at timestamptz NOT NULL",
      "released_at timestamptz,",
    ]) {
      expect(table).toContain(column);
    }
    expect(index).toBe(
      'CREATE INDEX IF NOT EXISTS page_capture_leases_run_idx ON "cinatra_fixture"."page_capture_leases" (org_id, run_id)',
    );
    for (const stmt of [table, index]) {
      expect(stmt).not.toMatch(/\b(?:DROP|ALTER|UPDATE|DELETE|UNIQUE|REFERENCES)\b/i);
    }
  });

  it("ships in the leaf drizzle-store.ts already imports, so no module joins a locked route graph", () => {
    const store = readFileSync("src/lib/drizzle-store.ts", "utf8");
    expect(store).toMatch(
      /import \{[^}]*\bpageCaptureLeasesSchemaQueries\b[^}]*\} from "@\/lib\/artifacts\/publication-operation-schema";/,
    );
    expect(store).not.toContain("page-capture-lease-schema");
    expect(existsSync("src/lib/artifacts/page-capture-lease-schema.ts")).toBe(false);
  });

  it("escapes the schema name", () => {
    const [table] = pageCaptureLeasesSchemaQueries('we"ird').map((row) => row.text);
    expect(table).toContain('"we""ird"."page_capture_leases"');
  });
});
