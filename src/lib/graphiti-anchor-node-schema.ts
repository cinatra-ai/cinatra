// Bootstrap DDL for `objects.graphiti_anchor_node_uuid` (cinatra#2591) — a pure
// string builder with ZERO imports, so `drizzle-store.ts` can compose it
// synchronously (the same leaf shape as `agent-run-lifecycle-moment-schema.ts`
// and `graphiti-projection-policy-schema.ts`).
//
// WHY A LEAF AND NOT TWO INLINE LINES. `src/lib/drizzle-store.ts` sits AT its
// file-size ceiling, which may only ever shrink. The leaf carries the two
// statements and the reasoning; the composing module pays one spread that
// rides an existing line.
//
// WHAT THE COLUMN IS. The DETERMINISTIC entity node this row is seeded as in
// the graph. Recall gets ranked node UUIDs back from `search_nodes`; this
// column is the inverse map that turns them into canonical row ids WITHOUT
// depending on the extraction model incidentally emitting the row UUID as an
// entity name (three of the four historical recovery probes were already
// measured inert). It stores the uuid the SERVER resolved, not the one we
// proposed: graphiti normally keeps the caller's uuid (measured), but it may
// merge a new node onto an existing near-duplicate, and then the resolved
// uuid is the truth.
//
// ADDITIVE AND NULLABLE, rides this idempotent bootstrap path like its other
// `graphiti_*` siblings, NOT the destructive numbered migration ledger. The
// index is partial (non-null only): the column is null for every row
// projected before this change and for every row whose class never projects,
// and the recall lookup (`WHERE graphiti_anchor_node_uuid = ANY($uuids)`) runs
// on every semantic query.

export function graphitiAnchorNodeSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `ALTER TABLE "${s}"."objects" ADD COLUMN IF NOT EXISTS graphiti_anchor_node_uuid TEXT` },
    { text: `CREATE INDEX IF NOT EXISTS objects_graphiti_anchor_node_uuid_idx ON "${s}"."objects" (graphiti_anchor_node_uuid) WHERE graphiti_anchor_node_uuid IS NOT NULL` },
  ];
}
