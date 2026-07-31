// cinatra#2240 — the per-turn skill-delivery table's bootstrap DDL.
//
// The table is NET-NEW and purely ADDITIVE, so the idempotent bootstrap is the
// whole operator story on fresh installs AND upgrades (it re-runs at every
// boot) — no numbered migration, exactly like the `connector_instance_*`
// bootstrap leaves (migrations/README.md, "The idempotent bootstrap … covers
// additive evolution"). These cases therefore ARE the schema contract:
//
//   - it is created AFTER `assistant_turns`, whose id it references (a FK to a
//     table that does not exist yet aborts the whole bootstrap);
//   - the FK cascades, so deleting a thread/turn takes its delivery record with
//     it — an orphaned audit row keyed to a vanished turn is worse than none;
//   - `(turn_id, skill_id)` is the primary key: one row per resolved skill per
//     turn, which is also the no-double-write property;
//   - the outcome/vehicle CHECKs make an untruthful row unrepresentable — a
//     `delivered` row without a transport, or a non-delivered row without a
//     reason, cannot be stored at all.

import { describe, expect, it } from "vitest";

import { assistantTurnSkillDeliverySchemaQueries } from "@/lib/assistant-thread-schema";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const ddl = () =>
  assistantTurnSkillDeliverySchemaQueries("testschema")
    .map((q) => q.text)
    .join("\n");

describe("assistantTurnSkillDeliverySchemaQueries", () => {
  it("creates the table idempotently in the given schema", () => {
    expect(ddl()).toContain(
      'CREATE TABLE IF NOT EXISTS "testschema"."assistant_turn_skill_delivery"',
    );
  });

  it("keys the record to the chat turn with a CASCADING foreign key", () => {
    expect(ddl()).toContain(
      'turn_id text NOT NULL REFERENCES "testschema"."assistant_turns" (id) ON DELETE CASCADE',
    );
  });

  it("makes (turn_id, skill_id) the primary key — one row per resolved skill per turn", () => {
    expect(ddl()).toContain("PRIMARY KEY (turn_id, skill_id)");
  });

  it("pins the outcome and vehicle domains", () => {
    const text = ddl();
    expect(text).toContain("CHECK (outcome IN ('delivered', 'dropped', 'refused'))");
    // `unknown` is the fail-honest vehicle for a connector-reported delivery
    // mode this build cannot classify — the delivery happened, only its
    // transport name is unresolvable.
    expect(text).toContain(
      "CHECK (vehicle IS NULL OR vehicle IN ('container-skills', 'tool-mount', 'inline', 'unknown'))",
    );
  });

  it("makes an untruthful row unrepresentable in BOTH directions", () => {
    const text = ddl();
    // Biconditionals, not implications: a one-way rule would still admit a
    // 'dropped' row carrying a vehicle, or a 'delivered' row carrying an excuse.
    expect(text).toContain("(outcome = 'delivered') = (vehicle IS NOT NULL)");
    expect(text).toContain("(outcome = 'delivered') = (delivery_mode IS NOT NULL)");
    expect(text).toContain("(outcome = 'delivered') = (non_delivery_reason IS NULL)");
  });

  it("indexes the per-skill rollup axis the efficacy aggregate groups on", () => {
    expect(ddl()).toContain(
      'CREATE INDEX IF NOT EXISTS assistant_turn_skill_delivery_skill_idx ON "testschema"."assistant_turn_skill_delivery" (skill_id)',
    );
  });

  it("quotes a schema name containing a double quote", () => {
    expect(assistantTurnSkillDeliverySchemaQueries('we"ird')[0].text).toContain(
      '"we""ird"."assistant_turn_skill_delivery"',
    );
  });
});

describe("bootstrap ordering", () => {
  it("is spread into the store bootstrap AFTER the assistant_turns table it references", () => {
    const texts = buildCreateStoreSchemaQueries("testschema").map((q) => q.text);
    const turnsAt = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "testschema"."assistant_turns"'),
    );
    const deliveryAt = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "testschema"."assistant_turn_skill_delivery"'),
    );
    expect(turnsAt).toBeGreaterThanOrEqual(0);
    expect(deliveryAt).toBeGreaterThanOrEqual(0);
    expect(deliveryAt).toBeGreaterThan(turnsAt);
  });
});
