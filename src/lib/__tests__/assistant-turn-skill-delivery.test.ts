// cinatra#2240 — the durable per-turn skill-delivery store.
//
// Pins the persistence contract the acceptance rests on, through the store's
// INJECTED query seam (no database needed):
//   - one statement per turn carrying every row, so a turn's record is written
//     atomically rather than row-by-row;
//   - `ON CONFLICT (turn_id, skill_id) DO NOTHING` — the NO-DOUBLE-WRITE
//     property. A delivery fact is an audit fact: a repeat write must never
//     REWRITE the first one (that would launder an accidental second execution);
//   - the column order the runtime's rows are bound to, so a future column
//     insertion cannot silently shift `vehicle` into `delivery_mode`.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => {
    throw new Error("the pooled DB must not be touched — these cases inject a query fn");
  },
}));

import {
  recordTurnSkillDelivery,
  listTurnSkillDelivery,
  listTurnSkillDeliveryByRunId,
  type TurnSkillDeliveryRow,
} from "@/lib/assistant-turn-skill-delivery";

const DELIVERED: TurnSkillDeliveryRow = {
  skillId: "@cinatra-ai/a",
  outcome: "delivered",
  provider: "anthropic",
  vehicle: "container-skills",
  deliveryMode: "anthropic_container",
  invocationAttributable: false,
  providerSkillId: "skill_ant_a",
  skillVersion: "3",
  nonDeliveryReason: null,
};

const REFUSED: TurnSkillDeliveryRow = {
  skillId: "@cinatra-ai/b",
  outcome: "refused",
  provider: "openai",
  vehicle: null,
  deliveryMode: null,
  invocationAttributable: null,
  providerSkillId: null,
  skillVersion: null,
  nonDeliveryReason: "no vehicle",
};

function recorder(returns: unknown[][] = [[]]) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let i = 0;
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    calls.push({ text, values });
    return (returns[Math.min(i++, returns.length - 1)] ?? []) as never[];
  });
  return { calls, query };
}

describe("recordTurnSkillDelivery", () => {
  it("writes ONE statement carrying every row, in the declared column order", async () => {
    const { calls, query } = recorder([[{ turn_id: "t1" }, { turn_id: "t1" }]]);
    const inserted = await recordTurnSkillDelivery(
      { turnId: "t1", rows: [DELIVERED, REFUSED] },
      { query, schema: "testschema" },
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(inserted).toBe(2);
    const { text, values } = calls[0];
    expect(text).toContain('"testschema"."assistant_turn_skill_delivery"');
    expect(text).toContain(
      "(turn_id, skill_id, outcome, provider, vehicle, delivery_mode,\n" +
        "        invocation_attributable, provider_skill_id, skill_version, non_delivery_reason)",
    );
    expect(values).toEqual([
      "t1", "@cinatra-ai/a", "delivered", "anthropic", "container-skills",
      "anthropic_container", false, "skill_ant_a", "3", null,
      "t1", "@cinatra-ai/b", "refused", "openai", null,
      null, null, null, null, "no vehicle",
    ]);
    // Two rows x ten columns = twenty distinct placeholders, none reused.
    expect(text).toContain("($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)");
    expect(text).toContain("($11, $12, $13, $14, $15, $16, $17, $18, $19, $20)");
  });

  it("is an idempotent INSERT — a conflicting key is left ALONE, never overwritten", async () => {
    const { calls, query } = recorder();
    await recordTurnSkillDelivery({ turnId: "t1", rows: [DELIVERED] }, { query });
    expect(calls[0].text).toContain("ON CONFLICT (turn_id, skill_id) DO NOTHING");
    // An UPDATE here would rewrite a delivery fact — the exact thing an audit
    // record must never do.
    expect(calls[0].text).not.toMatch(/DO\s+UPDATE/i);
  });

  it("NO DOUBLE WRITE: a repeat of the same turn inserts nothing", async () => {
    // Postgres reports the DO-NOTHING outcome by RETURNING no rows; the store
    // surfaces that as the inserted count so a caller can assert the property.
    const { query } = recorder([[{ turn_id: "t1" }], []]);
    const first = await recordTurnSkillDelivery({ turnId: "t1", rows: [DELIVERED] }, { query });
    const second = await recordTurnSkillDelivery({ turnId: "t1", rows: [DELIVERED] }, { query });
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("is a no-op on an empty row set (a turn that resolved no skills writes nothing)", async () => {
    const { query } = recorder();
    expect(await recordTurnSkillDelivery({ turnId: "t1", rows: [] }, { query })).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("read paths", () => {
  it("listTurnSkillDelivery reads the turn's record, delivered rows first", async () => {
    const { calls, query } = recorder([
      [
        {
          turn_id: "t1",
          skill_id: "@cinatra-ai/a",
          outcome: "delivered",
          provider: "anthropic",
          vehicle: "container-skills",
          delivery_mode: "anthropic_container",
          invocation_attributable: false,
          provider_skill_id: "skill_ant_a",
          skill_version: "3",
          non_delivery_reason: null,
          created_at: new Date("2026-07-30T10:00:00.000Z"),
        },
      ],
    ]);
    const rows = await listTurnSkillDelivery("t1", { query });
    expect(calls[0].values).toEqual(["t1"]);
    expect(calls[0].text).toContain("ORDER BY (outcome <> 'delivered'), skill_id ASC");
    expect(rows).toEqual([
      { ...DELIVERED, turnId: "t1", createdAt: "2026-07-30T10:00:00.000Z" },
    ]);
  });

  it("listTurnSkillDeliveryByRunId JOINS the parent turn rather than denormalising run_id", async () => {
    const { calls, query } = recorder();
    await listTurnSkillDeliveryByRunId("run-1", { query, schema: "testschema" });
    const { text, values } = calls[0];
    expect(values).toEqual(["run-1"]);
    expect(text).toContain('JOIN "testschema"."assistant_turns" t ON t.id = d.turn_id');
    expect(text).toContain("WHERE t.run_id = $1");
  });
});
