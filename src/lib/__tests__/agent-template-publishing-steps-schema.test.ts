// DDL parity for the publishing-step declaration (cinatra#4150):
// `agent_templates.publishing_steps`.
//
// The column has TWO homes that must agree: the fresh-install bootstrap DDL
// (`buildCreateStoreSchemaQueries`, src/lib/drizzle-store.ts, through the
// `agentTemplateRunGateSchemaQueries` leaf) and the operator-upgrade migration
// (`migrations/core/core__0118`). A fresh install that gets the column while an
// upgraded instance does not — or the reverse — is a silent split-brain. This
// suite pins both, plus the Drizzle table definition. Model:
// agent-template-has-artifact-bindings-schema.test.ts.
import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { agentTemplates } from "@cinatra-ai/agents/schema";

const bootstrap = buildCreateStoreSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe("agent_templates.publishing_steps — DDL parity", () => {
  it("the fresh-install bootstrap ALTERs an already-created table, idempotently", () => {
    expect(bootstrap).toMatch(
      /ALTER TABLE .*agent_templates.* ADD COLUMN IF NOT EXISTS publishing_steps text/,
    );
  });

  it("the migration adds the same column, idempotently", async () => {
    const mod = (await import("../../../migrations/core/core__0118_agent-template-publishing-steps.mjs")) as unknown as { agentTemplatePublishingStepsDdlSql: string };
    expect(mod.agentTemplatePublishingStepsDdlSql).toMatch(
      /ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS publishing_steps text;/,
    );
  });

  it("the migration is reversible in the same file, and down() drops only this column", async () => {
    const mod = (await import("../../../migrations/core/core__0118_agent-template-publishing-steps.mjs")) as unknown as {
      up: (pgm: { sql: (s: string) => void }) => void;
      down: (pgm: { sql: (s: string) => void }) => void;
    };
    const up: string[] = [];
    const down: string[] = [];
    mod.up({ sql: (s) => up.push(s) });
    mod.down({ sql: (s) => down.push(s) });
    expect(up.join("\n")).toMatch(/ADD COLUMN IF NOT EXISTS publishing_steps text/);
    expect(down.join("\n")).toMatch(/ALTER TABLE agent_templates DROP COLUMN IF EXISTS publishing_steps;/);
    expect(down.join("\n")).not.toMatch(/DROP TABLE|has_artifact_bindings|gated_steps/);
  });

  it("the Drizzle table definition declares the column nullable text with no default (no backfill)", () => {
    const column = (agentTemplates as unknown as Record<string, { name: string; notNull: boolean; hasDefault: boolean; columnType: string } | undefined>).publishingSteps;
    expect(column).toBeDefined();
    expect(column!.name).toBe("publishing_steps");
    expect(column!.notNull).toBe(false);
    expect(column!.hasDefault).toBe(false);
    expect(column!.columnType).toBe("PgText");
  });
});
