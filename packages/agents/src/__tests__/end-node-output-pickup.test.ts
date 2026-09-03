import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX,
  DOCUMENT_FLOOR_BYTES,
  defaultRoadLedgerOutputId,
  isDefaultRoadLedgerOutputId,
  selectEndNodeOutputPickupItems,
  BELOW_FLOOR_STEP_RESULT_KEY,
  belowFloorTerminalRecord,
} from "../end-node-output-pickup";

// ---------------------------------------------------------------------------
// The document floor — issue #3029 acceptance 2 ("a datum below the floor takes
// no road") and acceptance 3 ("response text takes no road"), at the point the
// decision is actually MADE: the transaction-local capture inside the terminal
// transition.
//
// Plan sentence (Agents Lifecycle (C) §3): "Below the floor an end-node value
// is a control datum — an id, a flag, a receipt, an address, a short summary —
// and takes no road unless a binding names it. [...] Response text is not an
// output."
// ---------------------------------------------------------------------------

const doc = (n: number) => "x".repeat(n);
const ABOVE = doc(DOCUMENT_FLOOR_BYTES);
const BELOW = doc(DOCUMENT_FLOOR_BYTES - 1);

describe("the document floor", () => {
  it("is one kilobyte, serialised", () => {
    expect(DOCUMENT_FLOOR_BYTES).toBe(1024);
  });

  it("takes an output AT the floor and turns away the byte below it", () => {
    const { items, belowFloor } = selectEndNodeOutputPickupItems({
      endNodeOutputs: { draft: ABOVE, receipt: BELOW },
    });
    expect(items.map((i) => i.outputName)).toEqual(["draft"]);
    expect(belowFloor).toEqual([{ outputName: "receipt", byteLength: DOCUMENT_FLOOR_BYTES - 1 }]);
  });

  it("ACCEPTANCE 2 — a datum below the floor takes no road, and is RECORDED as such", () => {
    const selection = selectEndNodeOutputPickupItems({
      endNodeOutputs: {
        publicationId: "wp_10231",
        approved: true,
        address: "https://example.invalid/post/1",
        summary: "the draft was approved and published",
      },
    });
    const { items, belowFloor } = selection;
    expect(items).toEqual([]);
    // "a rule the pickup records, not a guess" — every turned-away datum is
    // named with the length that was measured.
    expect(belowFloor.map((b) => b.outputName)).toEqual([
      "address",
      "approved",
      "publicationId",
      "summary",
    ]);
    for (const b of belowFloor) expect(b.byteLength).toBeLessThan(DOCUMENT_FLOOR_BYTES);

    // AND "RECORDED" MEANS PERSISTED (cinatra#3029, forward + fix leg 1). This
    // case used to end at the line above — on the pure selector's RETURN value,
    // which the terminal transition then discarded, so the title claimed a
    // durability that production did not have. `belowFloorTerminalRecord` is the
    // fragment `execution.ts` spreads into the run's own terminal step result,
    // so this reads what a person reading the run afterwards actually gets.
    const record = belowFloorTerminalRecord(selection);
    expect(record).toHaveProperty(BELOW_FLOOR_STEP_RESULT_KEY);
    expect(record[BELOW_FLOOR_STEP_RESULT_KEY]).toEqual(belowFloor);
  });

  it("the terminal record carries NO below-floor key when the floor turned nothing away", () => {
    // An absent key reads as "the floor had no work to do", which is true. A
    // present empty array would be a record of a decision never taken.
    const selection = selectEndNodeOutputPickupItems({ endNodeOutputs: { draft: ABOVE } });
    expect(selection.belowFloor).toEqual([]);
    expect(belowFloorTerminalRecord(selection)).toEqual({});
  });

  it("ACCEPTANCE 3 — response text is not an output: a run whose outputs are absent yields nothing", () => {
    // The response text reaches the capture as the run's final message, NEVER
    // as an end-node output. There is no input shape by which it can enter.
    expect(selectEndNodeOutputPickupItems({ endNodeOutputs: null }).items).toEqual([]);
    expect(selectEndNodeOutputPickupItems({ endNodeOutputs: undefined }).items).toEqual([]);
    expect(selectEndNodeOutputPickupItems({ endNodeOutputs: doc(50_000) }).items).toEqual([]);
    expect(selectEndNodeOutputPickupItems({ endNodeOutputs: [doc(50_000)] }).items).toEqual([]);
  });

  it("measures BYTES, not characters", () => {
    // 400 four-byte characters = 1600 bytes but only 400 code points.
    const emoji = "🙂".repeat(400);
    expect(emoji.length).toBeLessThan(DOCUMENT_FLOOR_BYTES);
    const { items } = selectEndNodeOutputPickupItems({ endNodeOutputs: { note: emoji } });
    expect(items).toHaveLength(1);
    expect(items[0].byteLength).toBe(1600);
  });

  it("serialises a structured value as JSON and measures THAT", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, title: `idea number ${i}` }));
    const { items } = selectEndNodeOutputPickupItems({ endNodeOutputs: { ideas: rows } });
    expect(items).toHaveLength(1);
    expect(items[0].contentIsJson).toBe(true);
    expect(items[0].content).toBe(JSON.stringify(rows));
    expect(items[0].byteLength).toBe(Buffer.byteLength(JSON.stringify(rows), "utf8"));
  });

  it("a bound output takes the DECLARED road, never the default one", () => {
    const { items } = selectEndNodeOutputPickupItems({
      endNodeOutputs: { draft: ABOVE, notes: ABOVE },
      boundOutputNames: ["draft"],
    });
    expect(items.map((i) => i.outputName)).toEqual(["notes"]);
  });

  it("an unserialisable value is not a document", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { items, belowFloor } = selectEndNodeOutputPickupItems({
      endNodeOutputs: { cyclic, missing: null },
    });
    expect(items).toEqual([]);
    expect(belowFloor).toEqual([]);
  });
});

describe("the reserved ledger id family", () => {
  it("cannot collide with a node id or an EndNode output name", () => {
    const id = defaultRoadLedgerOutputId("draft");
    expect(id).toBe(`${DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX}draft`);
    // A colon is illegal in an OAS node id and in an EndNode output name, which
    // is exactly what makes the 4-part ledger key collision-free.
    expect(id).toContain(":");
    expect(isDefaultRoadLedgerOutputId(id)).toBe(true);
    expect(isDefaultRoadLedgerOutputId("draft")).toBe(false);
    expect(isDefaultRoadLedgerOutputId("cinatra:run-final-output")).toBe(false);
  });

  it("is one id PER OUTPUT — a family, not the retired single sentinel", () => {
    const { items } = selectEndNodeOutputPickupItems({
      endNodeOutputs: { draft: ABOVE, linkedin: `${ABOVE}!` },
    });
    expect(new Set(items.map((i) => i.outputId)).size).toBe(2);
  });

  it("hashes the serialised content, so identical bytes in one run share a hash", () => {
    const { items } = selectEndNodeOutputPickupItems({
      endNodeOutputs: { a: ABOVE, b: ABOVE },
    });
    expect(items[0].contentHash).toBe(items[1].contentHash);
    expect(items[0].contentHash).toBe(createHash("sha256").update(ABOVE, "utf8").digest("hex"));
    expect(items[0].outputId).not.toBe(items[1].outputId);
  });
});
