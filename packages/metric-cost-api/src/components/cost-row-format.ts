// How a cost-breakdown row states what it knows (cinatra#2582).
//
// Pure formatters, kept out of the table component so they can be unit-tested
// without the host UI barrel. Each one exists to stop a quiet overstatement:
//
//   - an UNPRICED row (no rate card, or a producer that never reports its usage)
//     used to render "$0.0000", which reads as "this was free";
//   - a knowledge-graph row counts EPISODES, and one episode fans out to an
//     unknown number of provider requests inside the indexer's own container, so
//     a bare number under a "Calls" heading understates the request volume by an
//     unknown multiple.

/** Dollars, or the word "unknown" — never a number the ledger cannot back. */
export function formatUsd(v: number | null): string {
  if (v === null || v === undefined) return "unknown";
  return `$${v.toFixed(4)}`;
}

/** What the row's count MEANS, given which producer wrote it. */
export function describeUnit(source: string, count: number): string {
  if (source === "graphiti") return `${count} episodes`;
  return String(count);
}

/** The model column for rows that have no model to name. */
export function describeModel(source: string, model: string | null): string {
  if (model) return model;
  if (source === "graphiti") return "knowledge-graph episodes (fan-out not reported)";
  return "(unknown)";
}
