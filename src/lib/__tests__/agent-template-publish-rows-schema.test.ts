// DDL parity for the publish card's rows (cinatra#4150):
// `agent_templates.publish_rows`.
//
// The column has TWO homes that must agree: the fresh-install bootstrap DDL
// (`buildCreateStoreSchemaQueries` through the `agentTemplateRunGateSchemaQueries`
// leaf of src/lib/extension-grant-schema.ts) and the operator-upgrade migration
// (`migrations/core/core__0130`). This suite pins both, the migration's lock
// posture (outside a transaction, lock_timeout set first and reset last), its
// down, and the Drizzle table definition. Model:
// agent-template-publishing-steps-schema.test.ts.
import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { agentTemplateRunGateSchemaQueries } from "@/lib/extension-grant-schema";
import { agentTemplates } from "@cinatra-ai/agents/schema";

type Pgm = { sql: (s: string) => void; noTransaction: () => void };
type Mod = { agentTemplatePublishRowsDdlSql: string; up: (pgm: Pgm) => void; down: (pgm: Pgm) => void };

function record(fn: (pgm: Pgm) => void): { sql: string[]; noTransaction: number } {
  const out = { sql: [] as string[], noTransaction: 0 };
  fn({ sql: (s) => out.sql.push(s), noTransaction: () => (out.noTransaction += 1) });
  return out;
}

describe("agent_templates.publish_rows — DDL parity", () => {
  it("the fresh-install bootstrap ALTERs the table, idempotently, once", () => {
    const bootstrap = buildCreateStoreSchemaQueries("cinatra").map((q) => q.text);
    expect(bootstrap.filter((text) => /ALTER TABLE .*agent_templates.* ADD COLUMN IF NOT EXISTS publish_rows text/.test(text))).toHaveLength(1);
  });

  it("the agent_templates leaf carries the ALTER after publishing_steps, with the schema name quoted", () => {
    const leaf = agentTemplateRunGateSchemaQueries('we"ird').map((q) => q.text);
    expect(leaf.at(-1)).toBe('ALTER TABLE "we""ird"."agent_templates" ADD COLUMN IF NOT EXISTS publish_rows text');
    expect(leaf.at(-2)).toBe('ALTER TABLE "we""ird"."agent_templates" ADD COLUMN IF NOT EXISTS publishing_steps text');
  });

  it("the migration adds the same column, idempotently, outside a transaction, under a bounded lock wait", async () => {
    const mod = (await import("../../../migrations/core/core__0130_agent-template-publish-rows.mjs")) as unknown as Mod;
    expect(mod.agentTemplatePublishRowsDdlSql).toBe("ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS publish_rows text");
    const up = record(mod.up);
    expect(up.noTransaction).toBe(1);
    expect(up.sql).toEqual([
      "SET lock_timeout = 5000",
      "ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS publish_rows text",
      "RESET lock_timeout",
    ]);
    expect(record(mod.up).sql).toEqual(up.sql);
  });

  it("down drops only this column, with IF EXISTS", async () => {
    const mod = (await import("../../../migrations/core/core__0130_agent-template-publish-rows.mjs")) as unknown as Mod;
    expect(record(mod.down).sql).toEqual(["ALTER TABLE agent_templates DROP COLUMN IF EXISTS publish_rows"]);
  });

  it("the Drizzle table definition declares the column nullable text with no default (no backfill)", () => {
    const column = (agentTemplates as unknown as Record<string, { name: string; notNull: boolean; hasDefault: boolean; columnType: string } | undefined>).publishRows;
    expect(column).toBeDefined();
    expect(column!.name).toBe("publish_rows");
    expect(column!.notNull).toBe(false);
    expect(column!.hasDefault).toBe(false);
    expect(column!.columnType).toBe("PgText");
  });
});
