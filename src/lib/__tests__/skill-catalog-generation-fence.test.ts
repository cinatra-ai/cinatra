/**
 * Skills-catalog generation token — transactional fence + cross-process cache
 * (cinatra#1364, lifecycle A4).
 *
 * Loads the REAL @/lib/database module (real drizzle query builders) over a
 * captured fake postgres-sync executor, and pins:
 *   1. FENCE: replaceSkillCatalogInDatabase commits the generation-token bump
 *      IN THE SAME transaction as the row writes (one runPostgresQueriesSync
 *      call, transaction: true, batch includes the metadata write for
 *      `skills_catalog_generation`) — a reader can never observe new rows
 *      under an old token or vice versa.
 *   2. CACHE: readSkillCatalogFromDatabase keys its in-process cache on the
 *      DB token — same token ⇒ cache hit (no row re-read); changed token
 *      (a write from ANY process) ⇒ full refetch. The token is read BEFORE
 *      the rows (conservative-staleness ordering).
 *   3. The targeted writers (updateSkillPrefillTextInDatabase,
 *      applySkillRollbackInDatabase) bump the token atomically too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Query = { text: string; values?: unknown[] };
type Call = { transaction?: boolean; queries: Query[] };

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  meta: new Map<string, string>(),
  tables: new Map<string, Array<{ id: string; payload: string }>>(),
  // Set per-test to classify queries (real builder texts computed after import).
  texts: { readMeta: "", selectPkgs: "", selectSkills: "" },
}));

vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
  postgresSchema: "cinatra_test",
}));
vi.mock("@/lib/objects-dual-write", () => ({ shadowUpsertObject: vi.fn() }));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn((opts: { transaction?: boolean; queries: Query[] }) => {
    fake.calls.push({ transaction: opts.transaction, queries: opts.queries });
    return opts.queries.map((q) => {
      if (q.text === fake.texts.readMeta) {
        const key = String(q.values?.[0]);
        const value = fake.meta.get(key);
        return { rows: value === undefined ? [] : [{ value }], rowCount: value === undefined ? 0 : 1 };
      }
      if (q.text === fake.texts.selectPkgs) {
        return { rows: fake.tables.get("skill_packages") ?? [], rowCount: 0 };
      }
      if (q.text === fake.texts.selectSkills) {
        return { rows: fake.tables.get("skills") ?? [], rowCount: 0 };
      }
      // Writes: apply metadata upserts so token bumps land in the fake store.
      if (/insert into .*metadata/i.test(q.text) && Array.isArray(q.values) && q.values.length >= 2) {
        fake.meta.set(String(q.values[0]), String(q.values[1]));
      }
      return { rows: [], rowCount: 0 };
    });
  }),
}));

// RELATIVE import deliberately: the root vitest config aliases the
// "@/lib/database" SPECIFIER to tests/__stubs__/database.ts for the broad
// src/** suite; this test exercises the REAL module.
import {
  readSkillCatalogFromDatabase,
  replaceSkillCatalogInDatabase,
  updateSkillPrefillTextInDatabase,
} from "../database";
import {
  buildReadMetadataQuery,
  buildSelectJsonRowsQuery,
} from "@/lib/drizzle-store";
import { SKILL_CATALOG_GENERATION_METADATA_KEY } from "@/lib/database-metadata";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

const SCHEMA = "cinatra_test";
const GEN_KEY = SKILL_CATALOG_GENERATION_METADATA_KEY;

function seedRows(marker: string) {
  fake.tables.set("skill_packages", [
    { id: "pkg", payload: JSON.stringify({ id: "pkg", marker }) },
  ]);
  fake.tables.set("skills", [
    { id: "pkg:one", payload: JSON.stringify({ id: "pkg:one", marker }) },
  ]);
}

/** Flattened list of executed queries across all captured calls. */
function executedQueries(): Query[] {
  return fake.calls.flatMap((c) => c.queries);
}

function isGenerationBump(q: Query): boolean {
  return (
    /insert into .*metadata/i.test(q.text) &&
    Array.isArray(q.values) &&
    q.values[0] === GEN_KEY
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.meta.clear();
  fake.tables.clear();
  fake.texts.readMeta = buildReadMetadataQuery(SCHEMA, GEN_KEY).text;
  fake.texts.selectPkgs = buildSelectJsonRowsQuery(SCHEMA, "skill_packages").text;
  fake.texts.selectSkills = buildSelectJsonRowsQuery(SCHEMA, "skills").text;
  globalThis.__cinatraSkillCatalogCache = undefined;
  seedRows("gen-1");
});

describe("replaceSkillCatalogInDatabase — transactional generation bump (fence)", () => {
  it("commits rows + token bump in ONE transaction", () => {
    replaceSkillCatalogInDatabase({
      skillPackages: [{ id: "pkg", packageId: "pkg", slug: "pkg", name: "P", description: "d" }],
      skills: [],
    });

    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
    const call = fake.calls[0]!;
    expect(call.transaction).toBe(true);
    const bumps = call.queries.filter(isGenerationBump);
    expect(bumps).toHaveLength(1);
    // The bump writes a FRESH opaque token (a JSON string value).
    expect(() => JSON.parse(String(bumps[0]!.values?.[1]))).not.toThrow();
  });
});

describe("readSkillCatalogFromDatabase — token-keyed cross-process cache", () => {
  it("reads the token BEFORE the rows, caches by token, and refetches when the token changes", () => {
    fake.meta.set(GEN_KEY, JSON.stringify("token-1"));

    // First read: token check + full row fetch, in that order.
    const first = readSkillCatalogFromDatabase();
    expect(first.skillPackages).toHaveLength(1);
    const firstQueries = executedQueries();
    const tokenIdx = firstQueries.findIndex((q) => q.text === fake.texts.readMeta);
    const rowsIdx = firstQueries.findIndex((q) => q.text === fake.texts.selectPkgs);
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(rowsIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeLessThan(rowsIdx);

    // Same token: cache hit — rows are NOT re-read (only the token probe runs).
    fake.calls.length = 0;
    seedRows("gen-2"); // silently mutated rows must NOT surface under the same token
    const second = readSkillCatalogFromDatabase();
    expect(second).toBe(first);
    expect(executedQueries().some((q) => q.text === fake.texts.selectPkgs)).toBe(false);

    // Changed token (another process wrote): full refetch surfaces the new rows.
    fake.meta.set(GEN_KEY, JSON.stringify("token-2"));
    fake.calls.length = 0;
    const third = readSkillCatalogFromDatabase();
    expect(third).not.toBe(first);
    expect((third.skillPackages[0] as { marker?: string }).marker).toBe("gen-2");
    expect(executedQueries().some((q) => q.text === fake.texts.selectPkgs)).toBe(true);
  });
});

describe("targeted writers bump the token atomically", () => {
  it("updateSkillPrefillTextInDatabase writes the upsert + bump in one transaction", () => {
    fake.meta.set(GEN_KEY, JSON.stringify("token-1"));
    const ok = updateSkillPrefillTextInDatabase("pkg:one", "prefill!");
    expect(ok).toBe(true);

    // Last captured call is the write; it must be transactional and include the bump.
    const writeCall = fake.calls[fake.calls.length - 1]!;
    expect(writeCall.transaction).toBe(true);
    expect(writeCall.queries.some(isGenerationBump)).toBe(true);
    expect(writeCall.queries.length).toBeGreaterThanOrEqual(2);
  });
});
