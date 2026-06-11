/**
 * Unit tests for `countRunsForTemplates` (store.ts).
 *
 * Function under test:
 *   countRunsForTemplates(packageNames: string[]): Promise<Map<string, number>>
 *
 * Implementation summary (store.ts):
 *   - Empty-input guard: returns `new Map()` without touching the DB.
 *   - Drizzle: db.select(...).from(agentTemplates)
 *               .leftJoin(agentRuns, eq(agentRuns.templateId, agentTemplates.id))
 *               .where(inArray(agentTemplates.packageName, packageNames))
 *               .groupBy(agentTemplates.packageName)
 *   - Returns Map<packageName, runCount>; rows with null packageName are
 *     normalized to "" and null counts to 0.
 *   - PackageNames absent from result rows are absent from the Map (caller
 *     treats missing as 0 — see registry-catalog-screen).
 *
 * Strategy: mock the package-local `../db` module so the Drizzle chain
 * returns canned rows; assert the empty-input early-return guard and the
 * Map-shaping logic. Mirrors the pattern in store-external-templates.test.ts.
 *
 * This test belongs in `packages/agents/src/__tests__/` because
 * `countRunsForTemplates` lives in `packages/agents/src/store.ts` and the
 * `@cinatra-ai/agents` barrel pulls in UI/registration side-effects that fail
 * under the extensions vitest config
 * (mcp/registry → mcp-server/index.tsx → @/components/ui/button). The agents
 * vitest config is already wired for `../db` mocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const queryState = vi.hoisted(() => ({
  rows: [] as Array<{ packageName: string | null; count: number | null }>,
  selectCalls: 0,
  lastWhereCalled: false,
  lastGroupByCalled: false,
}));

const mockDb = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  chain.select = (..._args: unknown[]) => {
    queryState.selectCalls += 1;
    return chain;
  };
  chain.from = (..._args: unknown[]) => chain;
  chain.leftJoin = (..._args: unknown[]) => chain;
  chain.where = (..._args: unknown[]) => {
    queryState.lastWhereCalled = true;
    return chain;
  };
  chain.groupBy = (..._args: unknown[]) => {
    queryState.lastGroupByCalled = true;
    return Promise.resolve(queryState.rows);
  };
  return chain;
});

vi.mock("../db", () => ({
  db: mockDb,
  agentBuilderPool: {} as unknown,
}));
vi.mock("@/lib/nango-system", () => ({
  listSavedNangoConnections: vi.fn(),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  expireRunStream: vi.fn(),
}));

// Import after vi.mock so the mocks are installed first.
import { countRunsForTemplates } from "../store";

beforeEach(() => {
  queryState.rows = [];
  queryState.selectCalls = 0;
  queryState.lastWhereCalled = false;
  queryState.lastGroupByCalled = false;
});

describe("countRunsForTemplates", () => {
  it("returns an empty Map and does NOT touch the DB when input is empty", async () => {
    const result = await countRunsForTemplates([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    // Early-return guard: chain must NOT have been entered.
    expect(queryState.selectCalls).toBe(0);
    expect(queryState.lastWhereCalled).toBe(false);
    expect(queryState.lastGroupByCalled).toBe(false);
  });

  it("maps packageName → run count from LEFT JOIN result rows", async () => {
    queryState.rows = [
      { packageName: "@cinatra/foo", count: 3 },
      { packageName: "@cinatra/bar", count: 0 },
    ];
    const result = await countRunsForTemplates([
      "@cinatra/foo",
      "@cinatra/bar",
    ]);
    expect(result.size).toBe(2);
    expect(result.get("@cinatra/foo")).toBe(3);
    expect(result.get("@cinatra/bar")).toBe(0);
    // Confirm the chain was actually traversed.
    expect(queryState.selectCalls).toBe(1);
    expect(queryState.lastWhereCalled).toBe(true);
    expect(queryState.lastGroupByCalled).toBe(true);
  });

  it("packageNames absent from result rows are absent from the returned Map (caller treats missing as 0)", async () => {
    queryState.rows = [{ packageName: "@cinatra/foo", count: 5 }];
    const result = await countRunsForTemplates([
      "@cinatra/foo",
      "@cinatra/baz",
    ]);
    expect(result.get("@cinatra/foo")).toBe(5);
    expect(result.has("@cinatra/baz")).toBe(false);
    // Defensive: caller code (registry-catalog-screen) reads via
    // `result.get(name) ?? 0`, so missing-key semantics is the contract.
  });

  it("normalizes a null packageName to empty string and a null count to 0", async () => {
    // store.ts does `r.packageName ?? ""` and `r.count ?? 0`.
    queryState.rows = [
      { packageName: null, count: null },
      { packageName: "@cinatra/foo", count: null },
    ];
    const result = await countRunsForTemplates(["@cinatra/foo"]);
    expect(result.get("")).toBe(0);
    expect(result.get("@cinatra/foo")).toBe(0);
  });
});
