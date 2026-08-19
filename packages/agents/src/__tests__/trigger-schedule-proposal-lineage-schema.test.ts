// DDL parity for `trigger_schedule_proposal_lineage` (cinatra#2837).
//
// The lineage-latest ratchet has TWO homes that must agree: the fresh-install
// bootstrap DDL (`triggerScheduleProposalSchemaQueries`, spread into
// `buildCreateStoreSchemaQueries`) and the Drizzle table the store actually
// queries through (`packages/agents/src/schema.ts`). A column present in one and
// not the other does not fail at compile time — it throws on the first query, in
// production, on the path a reader reaches by pressing Adjust.
//
// A NEW TABLE is additive under `migrations/README.md`, so there is no numbered
// artifact to be a third home: the fresh-install shape is born in the leaf and
// the idempotent bootstrap carries it onto existing deployments at the next
// boot. That is the same route the two S5 tables beside it took.
//
// The BEHAVIOUR the shape is for — one live replacement per lineage, Adjust
// idempotent while it lives — is pinned at the seam in
// `trigger-schedule-proposal-expired.test.ts`.
import { describe, expect, it } from "vitest";

import { triggerScheduleProposalSchemaQueries } from "@/lib/trigger-schedule-proposal-schema";

import { triggerScheduleProposalLineage } from "../schema";

const TABLE = "trigger_schedule_proposal_lineage";
const EXPIRES_INDEX = "trigger_schedule_proposal_lineage_expires_idx";

const bootstrap = triggerScheduleProposalSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe(`${TABLE} — the bootstrap DDL`, () => {
  it("creates the table idempotently, in the app schema", () => {
    expect(bootstrap).toMatch(
      new RegExp(`CREATE TABLE IF NOT EXISTS "cinatra"\\."${TABLE}"`),
    );
  });

  it("keys the row on the CONSUME KEY — one live replacement per lineage", () => {
    // The PK is the ratchet: it is what makes "two live replacements" a state
    // the table cannot hold, rather than a race the service has to notice.
    expect(bootstrap).toMatch(/consume_key text PRIMARY KEY/);
  });

  it("carries the replacement and the expiry the ratchet turns on", () => {
    expect(bootstrap).toMatch(/latest_token text NOT NULL/);
    expect(bootstrap).toMatch(/expires_at timestamptz NOT NULL/);
  });

  it("records who re-proposed what, for the same reasons the consume row does", () => {
    expect(bootstrap).toMatch(/org_id text NOT NULL/);
    expect(bootstrap).toMatch(/template_id text NOT NULL/);
    expect(bootstrap).toMatch(/reproposed_by text NOT NULL/);
  });

  it("hangs off NO run — the row exists before one does", () => {
    const create = triggerScheduleProposalSchemaQueries("cinatra").find((q) =>
      q.text.includes(`"${TABLE}"`),
    )!.text;
    // A cascade from `agent_runs` is exactly what the other two tables have and
    // this one cannot: a lineage that is re-proposed and never confirmed has no
    // run to be collected with. Its bound is being upserted, not appended.
    expect(create).not.toMatch(/REFERENCES/);
  });

  it("indexes the expiry a retention pass sweeps on, NON-uniquely", () => {
    expect(bootstrap).toMatch(
      new RegExp(`CREATE INDEX IF NOT EXISTS ${EXPIRES_INDEX}[\\s\\S]*\\(expires_at\\)`),
    );
    expect(bootstrap).not.toMatch(
      new RegExp(`CREATE UNIQUE INDEX[^\\n]*${EXPIRES_INDEX}`),
    );
  });

  it("escapes a quote in the schema identifier", () => {
    expect(triggerScheduleProposalSchemaQueries('we"ird')[0]!.text).toContain('"we""ird"');
  });
});

describe(`${TABLE} — the Drizzle mirror agrees with it`, () => {
  it("declares EXACTLY the bootstrap's columns, and no others", async () => {
    // `getTableColumns` is drizzle-orm's public introspection surface; the
    // internal `Symbol(drizzle:Columns)` shape moves between versions.
    const { getTableColumns } = await import("drizzle-orm");
    const columns = getTableColumns(triggerScheduleProposalLineage);
    const dbNames = Object.values(columns)
      .map((c) => c.name)
      .sort();
    expect(dbNames).toEqual([
      "consume_key",
      "created_at",
      "expires_at",
      "latest_token",
      "org_id",
      "reproposed_by",
      "template_id",
      "updated_at",
    ]);
  });

  it("mirrors the primary key and the not-nulls the DDL states", async () => {
    const { getTableColumns } = await import("drizzle-orm");
    const columns = getTableColumns(triggerScheduleProposalLineage);
    expect(columns.consumeKey.primary).toBe(true);
    for (const key of [
      "consumeKey",
      "latestToken",
      "expiresAt",
      "orgId",
      "templateId",
      "reproposedBy",
      "createdAt",
      "updatedAt",
    ] as const) {
      expect(columns[key].notNull).toBe(true);
    }
  });

  it("gives `expires_at` no default — it is the replacement's own clock", async () => {
    // A default here would be a second opinion about when a token dies. The
    // only authority is the token's `exp`, which the service reads back out of
    // it; the row merely records what that said.
    const { getTableColumns } = await import("drizzle-orm");
    const columns = getTableColumns(triggerScheduleProposalLineage);
    expect(columns.expiresAt.hasDefault).toBe(false);
    expect(columns.createdAt.hasDefault).toBe(true);
    expect(columns.updatedAt.hasDefault).toBe(true);
  });
});
