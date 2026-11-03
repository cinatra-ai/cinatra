// DDL parity for the publish-decision record (cinatra#4150):
// `agent_run_publish_decisions`.
//
// The table has THREE homes that must agree: the fresh-install bootstrap
// (`buildCreateStoreSchemaQueries`, through the `publishDecisionSchemaQueries`
// leaf), the operator-upgrade migration (`migrations/core/core__0119`) and the
// Drizzle table definition the store reads through. A fresh install and an
// upgraded instance that differ are a silent split-brain.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { agentRunPublishDecisions } from "@cinatra-ai/agents/schema";

type MigrationModule = {
  agentRunPublishDecisionsDdlSql: string;
  up: (pgm: { sql: (s: string) => void }) => void;
  down: (pgm: { sql: (s: string) => void }) => void;
};
const loadMigration = async () =>
  (await import("../../../migrations/core/core__0119_agent-run-publish-decisions.mjs")) as unknown as MigrationModule;

const bootstrap = buildCreateStoreSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

/** The column lines of one CREATE TABLE, whitespace normalized; constraints apart. */
function columnsOf(ddl: string): string[] {
  const match = /CREATE TABLE IF NOT EXISTS [^(]*agent_run_publish_decisions[^(]*\(([\s\S]*?)\n\s*\)/.exec(ddl);
  expect(match).not.toBeNull();
  return match![1]
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " ").replace(/,$/, ""))
    .filter((line) => line.length > 0 && !/^(CONSTRAINT|CHECK)\b/.test(line));
}

const STATUS_CHECK = /CHECK \(status IN \('parked', 'released', 'declined', 'expired', 'run_ended'\)\)/;

describe("agent_run_publish_decisions — DDL parity", () => {
  it("the bootstrap creates the table with the closed status set", () => {
    expect(bootstrap).toMatch(/CREATE TABLE IF NOT EXISTS "cinatra"\."agent_run_publish_decisions"/);
    expect(bootstrap).toMatch(STATUS_CHECK);
  });

  it("the bootstrap and the migration declare the same columns, in the same order", async () => {
    const mod = await loadMigration();
    expect(columnsOf(mod.agentRunPublishDecisionsDdlSql)).toEqual(columnsOf(bootstrap));
    expect(mod.agentRunPublishDecisionsDdlSql).toMatch(STATUS_CHECK);
  });

  it("both homes declare the unique key per stop and the partial due index", async () => {
    const mod = await loadMigration();
    for (const ddl of [bootstrap, mod.agentRunPublishDecisionsDdlSql]) {
      expect(ddl).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS agent_run_publish_decisions_park_uniq\s+ON [^(]*\(run_id, node_id, gate_task_id\)/,
      );
      expect(ddl).toMatch(
        /CREATE INDEX IF NOT EXISTS agent_run_publish_decisions_due_idx\s+ON [^(]*\(expires_at\) WHERE status = 'parked'/,
      );
    }
  });

  it("the migration is reversible in the same file, and down() drops only this table", async () => {
    const mod = await loadMigration();
    const up: string[] = [];
    const down: string[] = [];
    mod.up({ sql: (s) => up.push(s) });
    mod.down({ sql: (s) => down.push(s) });
    expect(up.join("\n")).toBe(mod.agentRunPublishDecisionsDdlSql);
    expect(down).toEqual(["DROP TABLE IF EXISTS agent_run_publish_decisions;"]);
  });

  it("the manifest fragment names the migration, its table and an additive change", () => {
    const fragment = JSON.parse(
      readFileSync(
        join(process.cwd(), "migrations/manifest.d/core__0119_agent-run-publish-decisions.json"),
        "utf8",
      ),
    ) as { seq: string; file: string; destructive: boolean; tables: string[] };
    expect(fragment).toMatchObject({
      seq: "0119",
      file: "core/core__0119_agent-run-publish-decisions.mjs",
      destructive: false,
      tables: ["agent_run_publish_decisions"],
    });
  });

  it("the Drizzle table matches the DDL's columns, nullability and indexes", async () => {
    const mod = await loadMigration();
    const config = getTableConfig(agentRunPublishDecisions);
    expect(config.name).toBe("agent_run_publish_decisions");
    const ddlColumns = columnsOf(mod.agentRunPublishDecisionsDdlSql).map((line) => ({
      name: line.split(" ")[0],
      notNull: /NOT NULL|PRIMARY KEY/.test(line),
    }));
    expect(config.columns.map((c) => ({ name: c.name, notNull: c.notNull }))).toEqual(ddlColumns);
    const indexes = config.indexes.map((i) => ({ name: i.config.name, unique: i.config.unique }));
    expect(indexes).toEqual([
      { name: "agent_run_publish_decisions_park_uniq", unique: true },
      { name: "agent_run_publish_decisions_due_idx", unique: false },
    ]);
  });
});
