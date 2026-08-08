// DDL parity for the locally-persisted binding-presence authority
// (cinatra#2498): `agent_templates.has_artifact_bindings`.
//
// The column has TWO homes that must agree: the fresh-install bootstrap DDL
// (`buildCreateStoreSchemaQueries`, src/lib/drizzle-store.ts) and the
// operator-upgrade migration (`migrations/core/core__0091`). A fresh install
// that gets the column while an upgraded instance does not — or the reverse —
// is a silent split-brain: the run-completion materializer's registry
// short-circuit would work on one and silently keep hitting the registry on
// the other. This suite pins both, plus the Drizzle table definition.
import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { agentTemplateHasArtifactBindingsDdlSql } from "../../../migrations/core/core__0091_agent-template-has-artifact-bindings.mjs";
import { agentTemplates } from "@cinatra-ai/agents/schema";

const bootstrap = buildCreateStoreSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe("agent_templates.has_artifact_bindings — DDL parity", () => {
  it("the fresh-install bootstrap ALTERs an already-created table (CREATE IF NOT EXISTS is a no-op there)", () => {
    expect(bootstrap).toMatch(
      /ALTER TABLE .*agent_templates.* ADD COLUMN IF NOT EXISTS has_artifact_bindings boolean/,
    );
  });

  it("the migration adds the same column, idempotently", () => {
    expect(agentTemplateHasArtifactBindingsDdlSql).toMatch(
      /ADD COLUMN IF NOT EXISTS has_artifact_bindings boolean/,
    );
  });

  it("the migration is reversible in the same file", async () => {
    const mod = await import(
      "../../../migrations/core/core__0091_agent-template-has-artifact-bindings.mjs"
    );
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
  });

  it("the Drizzle table definition declares the column nullable (no default — no backfill, cinatra#2498)", () => {
    const column = agentTemplates.hasArtifactBindings;
    expect(column.name).toBe("has_artifact_bindings");
    expect(column.notNull).toBe(false);
    expect(column.hasDefault).toBe(false);
  });
});
