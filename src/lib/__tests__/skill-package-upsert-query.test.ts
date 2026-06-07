// Unit tests for `buildUpsertSkillPackageQuery`.
//
// Locks the 10-column UPSERT shape so any future change to the column
// tuple has to either (a) update this test, (b) update the mirror writer
// in packages/skills/src/cli.mjs:compileAndRegisterAgentSkillsViaPg, and
// (c) update the parallel `deriveSkillPackageIdentity` mapping in
// src/lib/database.ts.

import { describe, expect, it } from "vitest";

import {
  buildUpsertSkillPackageQuery,
  type SkillPackageIdentity,
} from "../drizzle-store";

const SAMPLE_IDENTITY: SkillPackageIdentity = {
  owner_scope: "workspace",
  owner_id: null,
  binding_scope: "owner",
  source_kind: "installed",
  vendor: "anthropic",
  package: "claude-skills",
  agent_template_id: null,
  skill_slug: "summarize-page",
};

describe("buildUpsertSkillPackageQuery catalog UPSERT shape", () => {
  it("emits an INSERT ... ON CONFLICT ... DO UPDATE statement", () => {
    const q = buildUpsertSkillPackageQuery("cinatra", { id: "pkg-1", payload: "{}" }, SAMPLE_IDENTITY);
    expect(q.text).toMatch(/INSERT INTO "cinatra"\."skill_packages"/);
    expect(q.text).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
  });

  it("writes all 10 columns in a fixed order (id, payload, then 8 identity columns)", () => {
    const q = buildUpsertSkillPackageQuery("cinatra", { id: "pkg-1", payload: "{}" }, SAMPLE_IDENTITY);
    expect(q.text).toMatch(
      /\(id,\s*payload,\s*owner_scope,\s*owner_id,\s*binding_scope,\s*source_kind,\s*vendor,\s*package,\s*agent_template_id,\s*skill_slug\)/,
    );
  });

  it("parameterizes all 10 values via $1..$10", () => {
    const q = buildUpsertSkillPackageQuery("cinatra", { id: "pkg-1", payload: "{}" }, SAMPLE_IDENTITY);
    expect(q.text).toMatch(/VALUES \(\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6,\s*\$7,\s*\$8,\s*\$9,\s*\$10\)/);
    expect(q.values).toHaveLength(10);
    expect(q.values?.[0]).toBe("pkg-1");
    expect(q.values?.[1]).toBe("{}");
    expect(q.values?.[2]).toBe(SAMPLE_IDENTITY.owner_scope);
    expect(q.values?.[3]).toBe(SAMPLE_IDENTITY.owner_id);
    expect(q.values?.[4]).toBe(SAMPLE_IDENTITY.binding_scope);
    expect(q.values?.[5]).toBe(SAMPLE_IDENTITY.source_kind);
    expect(q.values?.[6]).toBe(SAMPLE_IDENTITY.vendor);
    expect(q.values?.[7]).toBe(SAMPLE_IDENTITY.package);
    expect(q.values?.[8]).toBe(SAMPLE_IDENTITY.agent_template_id);
    expect(q.values?.[9]).toBe(SAMPLE_IDENTITY.skill_slug);
  });

  it("quote-escapes schema identifiers containing double-quotes", () => {
    // Reasonable schema names should never contain quotes, but defensive
    // escaping is the security property we promise.
    const q = buildUpsertSkillPackageQuery('weird"schema', { id: "pkg-1", payload: "{}" }, SAMPLE_IDENTITY);
    expect(q.text).toContain('"weird""schema"."skill_packages"');
  });

  it("UPDATE branch refreshes payload + all identity columns from EXCLUDED", () => {
    const q = buildUpsertSkillPackageQuery("cinatra", { id: "pkg-1", payload: "{}" }, SAMPLE_IDENTITY);
    for (const col of [
      "payload",
      "owner_scope",
      "owner_id",
      "binding_scope",
      "source_kind",
      "vendor",
      "package",
      "agent_template_id",
      "skill_slug",
    ]) {
      expect(q.text).toMatch(new RegExp(`${col}\\s*=\\s*EXCLUDED\\.${col}`));
    }
  });

  it("preserves null identity values (owner_id, vendor, package, agent_template_id)", () => {
    const identity: SkillPackageIdentity = {
      owner_scope: "personal",
      owner_id: "user-1",
      binding_scope: "owner",
      source_kind: "user-authored",
      vendor: null,
      package: null,
      agent_template_id: null,
      skill_slug: "my-skill",
    };
    const q = buildUpsertSkillPackageQuery("cinatra", { id: "pkg-1", payload: "{}" }, identity);
    expect(q.values?.[3]).toBe("user-1");
    expect(q.values?.[6]).toBeNull();
    expect(q.values?.[7]).toBeNull();
    expect(q.values?.[8]).toBeNull();
  });
});
