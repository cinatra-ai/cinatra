import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// The document floor and the pickup's item family (Agents Lifecycle (C)
// section 3, "The default road, in one paragraph", and item 0.17).
//
//   "An output is a file the agent emits into the `outputs` folder of its run
//    folder (item 0.21), or an end-node output of the run that is a document
//    rather than a datum: a text or structured value of at least one kilobyte
//    when serialised — the document floor, a rule the pickup RECORDS, not a
//    guess. Below the floor an end-node value is a control datum — an id, a
//    flag, a receipt, an address, a short summary — and takes no road unless a
//    binding names it. [...] Response text is not an output."
//
// This module is the transaction-local half: PURE, no registry read, no DB. It
// runs inside the terminal transition's guarded transaction, exactly where the
// single final-text capture used to sit, and turns the run's end-node outputs
// into the family of items the post-terminal pickup drains.
//
// The FILE half of item 0.17 ("once per emitted file") is #3030's (W6): this
// slice deliberately stops short of files, so the item shape carries a `source`
// discriminator that W6 extends rather than replaces.
// ---------------------------------------------------------------------------

/** One kilobyte, serialised. The floor decides — never the meaning. */
export const DOCUMENT_FLOOR_BYTES = 1024;

/**
 * The reserved ledger `output_id` prefix for the default road. Item 0.17 asks
 * for "one ledger row per item under a reserved id that cannot collide with a
 * node id"; item 8.2 makes it a FAMILY, "one per output or file". The colon
 * makes every member illegal as an OAS node id or an EndNode output name — the
 * same guarantee the single retired `cinatra:run-final-output` sentinel gave,
 * now per item.
 */
export const DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX = "cinatra:run-output:";

/** The reserved ledger output id for one end-node output. */
export function defaultRoadLedgerOutputId(outputName: string): string {
  return `${DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX}${outputName}`;
}

/** Whether a ledger output id belongs to the default road's reserved family. */
export function isDefaultRoadLedgerOutputId(outputId: string): boolean {
  return outputId.startsWith(DEFAULT_ROAD_LEDGER_OUTPUT_ID_PREFIX);
}

/** One item the pickup will drain: an end-node output at or above the floor. */
export type EndNodeOutputPickupItem = {
  /** The reserved ledger identity. */
  outputId: string;
  /** The end-node output's declared name — the item's title seed. */
  outputName: string;
  /** W6 extends this with `"file"`; W5 only ever emits `"end_node_output"`. */
  source: "end_node_output";
  /** The serialised value the ladder types and the write path stores. */
  content: string;
  /** Whether the value was serialised AS JSON (a non-string end-node value). */
  contentIsJson: boolean;
  /** sha256 of `content` — the ledger dedupe component AND the ladder's cache
   *  key, so identical bytes in one run cost one detection and one artifact. */
  contentHash: string;
  /** The serialised byte length that was measured against the floor. */
  byteLength: number;
};

/** An end-node output the floor turned away — recorded, so "took no road" is a
 *  readable fact rather than an absence. */
export type BelowFloorOutput = {
  outputName: string;
  byteLength: number;
};

export type EndNodeOutputSelection = {
  items: EndNodeOutputPickupItem[];
  belowFloor: BelowFloorOutput[];
};

/** Serialise one end-node value the way the write path will store it. */
function serialize(value: unknown): { content: string; contentIsJson: boolean } | null {
  if (typeof value === "string") return { content: value, contentIsJson: false };
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    // A scalar is a datum by construction and can never reach the floor; it is
    // serialised anyway so the floor — not this function — is what turns it
    // away, and the reason on the record stays "below the floor".
    return { content: String(value), contentIsJson: false };
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") return null;
    return { content: json, contentIsJson: true };
  } catch {
    // A cyclic or unserialisable value is not a document.
    return null;
  }
}

/**
 * Select the run's end-node outputs that are DOCUMENTS.
 *
 * `endNodeOutputs` is the structured EndNode output object the run already
 * carries (`output_data` on the terminal stepResults). Anything that is not an
 * object of named outputs yields nothing: response text is not an output, and
 * neither is a bare scalar the run happened to end on.
 *
 * `boundOutputNames` are the outputs a DECLARED binding already named — the
 * first rung of the per-output ladder. The default road never writes them a
 * second time; the materializer owns them.
 */
export function selectEndNodeOutputPickupItems(input: {
  endNodeOutputs: unknown;
  boundOutputNames?: readonly string[];
}): EndNodeOutputSelection {
  const outputs = input.endNodeOutputs;
  if (typeof outputs !== "object" || outputs === null || Array.isArray(outputs)) {
    return { items: [], belowFloor: [] };
  }
  const bound = new Set(input.boundOutputNames ?? []);
  const items: EndNodeOutputPickupItem[] = [];
  const belowFloor: BelowFloorOutput[] = [];
  for (const [outputName, value] of Object.entries(outputs as Record<string, unknown>)) {
    if (bound.has(outputName)) continue;
    const serialised = serialize(value);
    if (!serialised) continue;
    const byteLength = Buffer.byteLength(serialised.content, "utf8");
    if (byteLength < DOCUMENT_FLOOR_BYTES) {
      belowFloor.push({ outputName, byteLength });
      continue;
    }
    items.push({
      outputId: defaultRoadLedgerOutputId(outputName),
      outputName,
      source: "end_node_output",
      content: serialised.content,
      contentIsJson: serialised.contentIsJson,
      contentHash: createHash("sha256").update(serialised.content, "utf8").digest("hex"),
      byteLength,
    });
  }
  // A stable order so a re-drive claims the ledger family in the same sequence.
  items.sort((a, b) => (a.outputName < b.outputName ? -1 : a.outputName > b.outputName ? 1 : 0));
  belowFloor.sort((a, b) => (a.outputName < b.outputName ? -1 : a.outputName > b.outputName ? 1 : 0));
  return { items, belowFloor };
}
