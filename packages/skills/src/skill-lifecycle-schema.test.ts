import { describe, it, expect } from "vitest";

// The lifecycle DDL leaf is a pure, zero-import string builder (safe to import
// here via the @/* alias). This suite is the fail-closed proof that the
// immutability + constraint shape ships in the schema.
import { skillLifecycleSchemaQueries } from "@/lib/skill-lifecycle-schema";

import { REVISION_SOURCES } from "./skill-source";

const SCHEMA = "cinatra_test";
const ddl = () => skillLifecycleSchemaQueries(SCHEMA).map((q) => q.text).join("\n;;\n");

describe("skillLifecycleSchemaQueries — skill_revisions immutability", () => {
  it("creates skill_revisions with a distinct id PK, source CHECK, and composite-FK unique key", () => {
    const sql = ddl();
    expect(sql).toContain(`"${SCHEMA}"."skill_revisions"`);
    expect(sql).toMatch(/id text PRIMARY KEY DEFAULT gen_random_uuid\(\)::text/);
    // content_digest is NULLABLE (no NOT NULL) — a legacy backfill row may lack it.
    expect(sql).toMatch(/content_digest text\b(?!\s+NOT NULL)/);
    expect(sql).toContain("CONSTRAINT skill_revisions_id_skill_uk UNIQUE (id, skill_id)");
  });

  it("declares NO foreign key on skill_revisions.skill_id (durable/tombstoned)", () => {
    const sql = ddl();
    // skill_id is a bare column — a REFERENCES here would re-introduce the
    // cascade-abort hazard the design deliberately removed.
    expect(sql).toMatch(/skill_id text NOT NULL,/);
    expect(sql).not.toMatch(/skill_id text NOT NULL REFERENCES/);
  });

  it("installs a BEFORE UPDATE OR DELETE trigger that RAISES — revisions are append-only", () => {
    const sql = ddl();
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION "${SCHEMA}"."fn_skill_revisions_append_only"()`);
    expect(sql).toMatch(/RAISE EXCEPTION 'skill_revisions is append-only/);
    expect(sql).toContain(`DROP TRIGGER IF EXISTS trg_skill_revisions_append_only ON "${SCHEMA}"."skill_revisions"`);
    expect(sql).toMatch(/CREATE TRIGGER trg_skill_revisions_append_only BEFORE UPDATE OR DELETE ON/);
  });

  it("the source CHECK enumerates EXACTLY the policy's REVISION_SOURCES (drift guard)", () => {
    const sql = ddl();
    const m = sql.match(/source IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const inSql = (m![1].match(/'([^']+)'/g) ?? []).map((x) => x.replaceAll("'", ""));
    expect(inSql.sort()).toEqual([...REVISION_SOURCES].sort());
  });
});

describe("skillLifecycleSchemaQueries — skill_lifecycle_audit", () => {
  it("creates the audit table with a required to_state, nullable from_state, and no FK", () => {
    const sql = ddl();
    expect(sql).toContain(`"${SCHEMA}"."skill_lifecycle_audit"`);
    expect(sql).toMatch(/to_state text NOT NULL/);
    expect(sql).toMatch(/from_state text,/); // nullable (forward-compat); audited transitions carry a real prior state
    expect(sql).toMatch(/skill_id text NOT NULL,/);
    expect(sql).not.toMatch(/skill_lifecycle_audit[\s\S]*REFERENCES/);
  });

  it("indexes both new tables by (skill_id, created_at DESC)", () => {
    const sql = ddl();
    expect(sql).toContain("skill_revisions_skill_created_idx");
    expect(sql).toContain("skill_lifecycle_audit_skill_created_idx");
  });
});

describe("skillLifecycleSchemaQueries — content authority + rollback (cinatra#1362)", () => {
  it("the source CHECK enumerates EXACTLY REVISION_SOURCES incl. 'rollback' (drift guard)", () => {
    const sql = ddl();
    const m = sql.match(/source IN \(([^)]*)\)/);
    const inSql = (m![1].match(/'([^']+)'/g) ?? []).map((x) => x.replaceAll("'", ""));
    expect(inSql.sort()).toEqual([...REVISION_SOURCES].sort());
    expect(inSql).toContain("rollback");
  });

  it("skill_revisions carries restores_revision_id, its same-skill self-FK, and the rollback biconditional", () => {
    const sql = ddl();
    expect(sql).toMatch(/restores_revision_id text/);
    // biconditional: restores_revision_id set IFF source='rollback'
    expect(sql).toContain("CONSTRAINT skill_revisions_rollback_provenance_check CHECK ((source = 'rollback') = (restores_revision_id IS NOT NULL))");
    // self-FK binds a rollback's restored revision to the SAME skill's revisions
    expect(sql).toMatch(/CONSTRAINT skill_revisions_restores_fk FOREIGN KEY \(restores_revision_id, skill_id\) REFERENCES "[^"]+"\."skill_revisions" \(id, skill_id\)/);
  });

  it("skill_revision_contents is content-addressable with DB-enforced blob integrity + append-only", () => {
    const sql = ddl();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "[^"]+"\."skill_revision_contents"/);
    expect(sql).toMatch(/content_digest text PRIMARY KEY/);
    // a wrong blob is IMPOSSIBLE: the digest must equal sha256(content) and the length must match
    expect(sql).toContain("CHECK (content_digest = encode(sha256(convert_to(content, 'UTF8')), 'hex'))");
    expect(sql).toContain("CHECK (byte_length = octet_length(content))");
    // immutable: BEFORE UPDATE OR DELETE raises
    expect(sql).toMatch(/CREATE TRIGGER trg_skill_revision_contents_append_only BEFORE UPDATE OR DELETE ON/);
    expect(sql).toMatch(/RAISE EXCEPTION 'skill_revision_contents is append-only/);
  });
});
