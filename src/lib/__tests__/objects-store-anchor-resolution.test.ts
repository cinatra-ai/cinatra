/**
 * cinatra#2591 — deterministic graph-node -> canonical-row resolution, over the
 * REAL `resolveObjectIdsByAnchorNodeUuids`.
 *
 * WHY THIS FILE EXISTS. The recall handler's own test file
 * (`packages/objects/src/__tests__/handlers-read-path.test.ts`) MOCKS this
 * function, so until now the branch asserted that the handler calls it and
 * never that it is correct. Three properties carry real consequence and none of
 * them were pinned:
 *
 *   THE ORG CLAUSE. `search_nodes` ranks across the graph, not across a tenant.
 *   The UUIDs handed to this function are therefore untrusted input, and the
 *   `(org_id = $2 OR $2 IS NULL)` clause is the first boundary they meet. It
 *   runs in SQL, before the per-actor filter downstream, so a regression here
 *   would widen the candidate set of a cross-tenant recall.
 *
 *   THE SOFT-DELETE FILTER. A deleted row keeps its anchor UUID and its graph
 *   node outlives the delete, so without `deleted_at IS NULL` a semantic recall
 *   resurrects deleted rows into the candidate set.
 *
 *   ONE ANCHOR NAMING TWO ROWS. graphiti resolves a newly-seeded node against
 *   existing near-duplicates, so two similar rows in one lane can legitimately
 *   share an anchor. Mapping uuid -> a single id would silently drop whichever
 *   Postgres returned second and make that row permanently unrecoverable — the
 *   exact failure the deterministic anchor replaced.
 *
 * Mocked here: `postgres-sync` (so the emitted SQL and its bound values are
 * captured without a live Postgres) and the host `database` module. NOT mocked:
 * the function under test. The boundary this leaves open is honest and stated —
 * it asserts the query cinatra SENDS, not that Postgres executes it as read.
 * Executing it needs a seeded live database, which the unit harness has no
 * route to; the works-after graphiti arm covers the round trip end to end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const capturedQueries: Array<{ text: string; values: unknown[] }> = [];
let mockRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn((opts: { queries: Array<{ text: string; values?: unknown[] }> }) => {
    for (const q of opts.queries) capturedQueries.push({ text: q.text, values: q.values ?? [] });
    return opts.queries.map(() => ({ rows: mockRows }));
  }),
}));

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: vi.fn(),
  postgresSchema: "cinatra_test",
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
}));

vi.mock("@cinatra-ai/llm", () => ({ getActorContext: () => undefined }));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { mcpRequestContextStorage: new AsyncLocalStorage() };
});

import { resolveObjectIdsByAnchorNodeUuids } from "@/lib/objects-store";

const ANCHOR_A = "2591a0c4-0000-4000-8000-00000000000a";
const ANCHOR_B = "2591a0c4-0000-4000-8000-00000000000b";

/** The two columns the mapper reads. Nothing else is consulted. */
function anchorRow(id: string, uuid: string): Record<string, unknown> {
  return { id, graphiti_anchor_node_uuid: uuid };
}

beforeEach(() => {
  capturedQueries.length = 0;
  mockRows = [];
});

describe("resolveObjectIdsByAnchorNodeUuids (real implementation)", () => {
  it("scopes the lookup to the caller's org IN SQL", () => {
    mockRows = [anchorRow("obj-1", ANCHOR_A)];
    resolveObjectIdsByAnchorNodeUuids([ANCHOR_A], "org-1");

    expect(capturedQueries).toHaveLength(1);
    const [q] = capturedQueries;
    // The clause mirrors listObjectsByFilter's own, so an org-scoped recall
    // cannot resolve a UUID onto another tenant's row even before the actor
    // filter runs.
    expect(q.text).toContain("(org_id = $2 OR $2 IS NULL)");
    // And the org actually travels as the bound value — a clause with the wrong
    // parameter would read as correct and filter on nothing.
    expect(q.values[1]).toBe("org-1");
    expect(q.values[0]).toEqual([ANCHOR_A]);
  });

  it("excludes soft-deleted rows", () => {
    mockRows = [anchorRow("obj-1", ANCHOR_A)];
    resolveObjectIdsByAnchorNodeUuids([ANCHOR_A], "org-1");
    // A deleted row keeps its anchor and its graph node survives the delete, so
    // without this the semantic path resurrects deleted rows.
    expect(capturedQueries[0].text).toContain("deleted_at IS NULL");
  });

  it("matches the anchor column, not an incidentally-extracted id", () => {
    mockRows = [anchorRow("obj-1", ANCHOR_A)];
    resolveObjectIdsByAnchorNodeUuids([ANCHOR_A], "org-1");
    // The whole point of cinatra#2591: recovery reads the DETERMINISTIC anchor
    // the projector wrote, never whatever the extraction model happened to emit.
    expect(capturedQueries[0].text).toContain("graphiti_anchor_node_uuid = ANY($1::text[])");
  });

  it("returns BOTH rows when one anchor names two", () => {
    // graphiti merges a newly-seeded node into a near-duplicate, so both rows
    // store the same anchor UUID. Dropping either makes it unrecoverable.
    mockRows = [anchorRow("obj-1", ANCHOR_A), anchorRow("obj-2", ANCHOR_A)];

    const resolved = resolveObjectIdsByAnchorNodeUuids([ANCHOR_A], "org-1");
    expect(resolved.get(ANCHOR_A)).toEqual(["obj-1", "obj-2"]);
  });

  it("keys each anchor separately so the caller can preserve RANK order", () => {
    mockRows = [anchorRow("obj-2", ANCHOR_B), anchorRow("obj-1", ANCHOR_A)];

    const resolved = resolveObjectIdsByAnchorNodeUuids([ANCHOR_A, ANCHOR_B], "org-1");
    expect(resolved.get(ANCHOR_A)).toEqual(["obj-1"]);
    expect(resolved.get(ANCHOR_B)).toEqual(["obj-2"]);
  });

  it("de-duplicates and drops blank UUIDs before querying", () => {
    mockRows = [anchorRow("obj-1", ANCHOR_A)];
    resolveObjectIdsByAnchorNodeUuids([ANCHOR_A, ANCHOR_A, ""], "org-1");
    expect(capturedQueries[0].values[0]).toEqual([ANCHOR_A]);
  });

  it("issues NO query at all when nothing usable came back from the graph", () => {
    const resolved = resolveObjectIdsByAnchorNodeUuids([""], "org-1");
    expect(resolved.size).toBe(0);
    expect(capturedQueries).toHaveLength(0);
  });

  it("passes a null org through as null — the ambient case, not a literal", () => {
    // `$2 IS NULL` is what makes an ambient (org-less) recall resolve at all.
    // Coercing null to a string here would silently return nothing forever.
    mockRows = [anchorRow("obj-1", ANCHOR_A)];
    resolveObjectIdsByAnchorNodeUuids([ANCHOR_A], null);
    expect(capturedQueries[0].values[1]).toBeNull();
  });

  it("ignores a row whose id or anchor is not a string", () => {
    // Defensive: a driver that hands back a non-string must not put `undefined`
    // into the candidate set, where it would become a bogus id lookup.
    mockRows = [
      { id: 42, graphiti_anchor_node_uuid: ANCHOR_A },
      { id: "obj-1", graphiti_anchor_node_uuid: null },
      anchorRow("obj-2", ANCHOR_B),
    ];
    const resolved = resolveObjectIdsByAnchorNodeUuids([ANCHOR_A, ANCHOR_B], "org-1");
    expect(resolved.get(ANCHOR_A)).toBeUndefined();
    expect(resolved.get(ANCHOR_B)).toEqual(["obj-2"]);
  });
});
