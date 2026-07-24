import { describe, it, expect } from "vitest";
import { CONNECTOR_ACCESS_SCOPES } from "@cinatra-ai/sdk-extensions";

import {
  assistantRegistrySchemaQueries,
  ASSISTANT_AUDIENCE_SUBJECT_KINDS,
  ASSISTANT_TAG_ALIAS_SOURCES,
  BUILTIN_ASSISTANT_ALIAS,
} from "@/lib/assistant-registry-schema";
import { assistantHandleSchemaQueries } from "@/lib/assistant-thread-schema";

describe("assistant audience vocabulary", () => {
  it("is exactly CONNECTOR_ACCESS_SCOPES minus 'user'", () => {
    const expected = CONNECTOR_ACCESS_SCOPES.filter((s) => s !== "user");
    // order-insensitive set equality
    expect(new Set(ASSISTANT_AUDIENCE_SUBJECT_KINDS)).toEqual(new Set(expected));
    expect(ASSISTANT_AUDIENCE_SUBJECT_KINDS).not.toContain("user");
    expect(ASSISTANT_AUDIENCE_SUBJECT_KINDS.length).toBe(expected.length);
  });
});

describe("assistantRegistrySchemaQueries — bootstrap DDL", () => {
  const q = assistantRegistrySchemaQueries("app").map((x) => x.text).join("\n;;\n");

  it("creates both NET-NEW tables schema-qualified", () => {
    expect(q).toMatch(/CREATE TABLE IF NOT EXISTS "app"\."assistant_audience"/);
    expect(q).toMatch(/CREATE TABLE IF NOT EXISTS "app"\."assistant_tag_alias"/);
  });

  it("constrains subject_kind to the audience vocabulary", () => {
    for (const k of ASSISTANT_AUDIENCE_SUBJECT_KINDS) expect(q).toMatch(new RegExp(`'${k}'`));
    expect(q).toMatch(/assistant_audience_subject_kind_check/);
  });

  it("constrains alias source and creates the unique grant index (COALESCE null id)", () => {
    for (const s of ASSISTANT_TAG_ALIAS_SOURCES) expect(q).toMatch(new RegExp(`'${s}'`));
    expect(q).toMatch(/assistant_audience_grant_uniq[\s\S]*COALESCE\(subject_id, ''\)/);
  });

  it("does NOT seed a builtin alias — the built-in's one tag is its handle (owner ruling 2026-07-23 (groganz))", () => {
    // The bootstrap DDL creates the alias table + its source constraint but seeds
    // NO alias row: the built-in Cinatra assistant's ONE tag is its resolving
    // HANDLE `cinatra` (minted by the boot backfill; the operator-upgrade twin
    // core__0077 frees the legacy builtin alias). Seeding `cinatra` here would
    // re-occupy the token in the shared handle+alias namespace and force the
    // built-in's handle to suffix to cinatra-2.
    expect(q).not.toMatch(/INSERT\s+INTO\s+"app"\."assistant_tag_alias"/i);
    expect(q).not.toMatch(new RegExp(`'${BUILTIN_ASSISTANT_ALIAS.alias}'[^\\n]*'builtin'`));
  });
});

describe("assistantHandleSchemaQueries — origin/package_name (bootstrap parity)", () => {
  const q = assistantHandleSchemaQueries("app").map((x) => x.text).join("\n;;\n");

  it("adds origin (NOT NULL DEFAULT standalone) + package_name idempotently", () => {
    expect(q).toMatch(/ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'standalone'/);
    expect(q).toMatch(/ADD COLUMN IF NOT EXISTS package_name text/);
    expect(q).toMatch(/assistant_handles_origin_check[\s\S]*CHECK \(origin IN \('extension', 'standalone'\)\)/);
  });

  it("also carries the columns on the fresh CREATE (born with final shape)", () => {
    expect(q).toMatch(/CREATE TABLE IF NOT EXISTS "app"\."assistant_handles"[\s\S]*origin text NOT NULL DEFAULT 'standalone'[\s\S]*package_name text/);
  });
});
