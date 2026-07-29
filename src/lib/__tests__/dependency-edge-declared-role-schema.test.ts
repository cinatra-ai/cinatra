// DDL parity for the declared dependency-edge ROLE column (cinatra#2090 S3).
//
// The column has TWO homes that must agree: the fresh-install bootstrap DDL
// (`dependencyEdgeSchemaQueries`, spread into `buildCreateStoreSchemaQueries`)
// and the operator-upgrade migration (`migrations/core/core__0086`). A fresh
// install that gets the column while an upgraded instance does not — or the
// reverse — is a silent split-brain: roled edges persist on one and vanish on
// the other. This suite pins both, plus the enum the CHECK admits.
import { describe, expect, it } from "vitest";

import { dependencyEdgeSchemaQueries } from "@/lib/extension-grant-schema";
import { dependencyEdgeDeclaredRoleDdlSql } from "../../../migrations/core/core__0086_dependency-edge-declared-role.mjs";
import { DEPENDENCY_SKILL_ROLES } from "@cinatra-ai/extensions/canonical-types";

const bootstrap = dependencyEdgeSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe("extension_dependency_edge.declared_role — DDL parity", () => {
  it("the fresh-install CREATE declares the column", () => {
    expect(bootstrap).toMatch(/declared_role text/);
  });

  it("the fresh-install DDL also ALTERs an already-created table (CREATE IF NOT EXISTS is a no-op there)", () => {
    expect(bootstrap).toMatch(
      /ALTER TABLE .*extension_dependency_edge.* ADD COLUMN IF NOT EXISTS declared_role text/,
    );
  });

  it("the migration adds the same column, idempotently", () => {
    expect(dependencyEdgeDeclaredRoleDdlSql).toMatch(
      /ADD COLUMN IF NOT EXISTS declared_role text/,
    );
  });

  it("the fresh-install CHECK is NAMED, so the guarded ALTER is a no-op there (one constraint, not two)", () => {
    expect(bootstrap).toMatch(
      /CONSTRAINT extension_dependency_edge_declared_role_chk CHECK \(declared_role IS NULL/,
    );
    expect(bootstrap).toMatch(/WHERE conname = 'extension_dependency_edge_declared_role_chk'/);
  });

  it("both homes constrain the value to the declared role vocabulary", () => {
    for (const sql of [bootstrap, dependencyEdgeDeclaredRoleDdlSql]) {
      expect(sql).toMatch(/declared_role IS NULL OR declared_role IN \('matcher','authoring'\)/);
    }
  });

  it("the constrained values ARE the canonical vocabulary (no hand-copied drift)", () => {
    const listed = [...DEPENDENCY_SKILL_ROLES].sort();
    const inSql = [
      ...dependencyEdgeDeclaredRoleDdlSql.matchAll(/'(matcher|authoring)'/g),
    ].map((m) => m[1]);
    expect([...new Set(inSql)].sort()).toEqual(listed);
  });

  it("the migration is reversible in the same file", async () => {
    const mod = await import("../../../migrations/core/core__0086_dependency-edge-declared-role.mjs");
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
  });
});
