/**
 * Skills-catalog generation token — transactional fence + cross-process cache
 * (cinatra#1364, lifecycle A4).
 *
 * Loads the REAL @/lib/database + @/lib/database-metadata modules (real
 * drizzle query builders) over a captured fake postgres-sync executor, and
 * pins:
 *   1. WRITE FENCE: replaceSkillCatalogInDatabase commits the generation-token
 *      bump IN THE SAME transaction as the row writes (one
 *      runPostgresQueriesSync call, transaction: true, batch includes the
 *      metadata write for `skills_catalog_generation`).
 *   2. READ FENCE: a cache miss reads token → rows → token in ONE sequential
 *      batch and RETRIES when the tokens differ, so an interleaved commit can
 *      never hand the caller a torn {old packages, new skills} mix.
 *   3. CACHE: same token ⇒ cache hit (probe only, no row re-read); changed
 *      token (a write from ANY process) ⇒ full refetch.
 *   4. The targeted prefill writer bumps the token atomically too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Query = { text: string; values?: unknown[] };
type Call = { transaction?: boolean; queries: Query[] };

const fake = vi.hoisted(() => ({
  calls: [] as Call[],
  meta: new Map<string, string>(),
  tables: new Map<string, Array<{ id: string; payload: string }>>(),
  // Optional per-test script: each metadata-token READ shifts the next value
  // (simulates a concurrent writer landing between the two token reads).
  tokenQueue: [] as Array<string | null>,
  // Set in beforeEach to the REAL builder texts (used to classify queries).
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
        const scripted = fake.tokenQueue.length > 0 ? fake.tokenQueue.shift()! : undefined;
        const key = String(q.values?.[0]);
        const value = scripted !== undefined ? scripted : fake.meta.get(key) ?? null;
        return { rows: value === null ? [] : [{ value }], rowCount: value === null ? 0 : 1 };
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

function isGenerationBump(q: Query): boolean {
  return (
    /insert into .*metadata/i.test(q.text) &&
    Array.isArray(q.values) &&
    q.values[0] === GEN_KEY
  );
}

/** Calls whose batch contains the row-select queries (the fenced full read). */
function rowReadCalls(): Call[] {
  return fake.calls.filter((c) => c.queries.some((q) => q.text === fake.texts.selectPkgs));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.meta.clear();
  fake.tables.clear();
  fake.tokenQueue.length = 0;
  fake.texts.readMeta = buildReadMetadataQuery(SCHEMA, GEN_KEY).text;
  fake.texts.selectPkgs = buildSelectJsonRowsQuery(SCHEMA, "skill_packages").text;
  fake.texts.selectSkills = buildSelectJsonRowsQuery(SCHEMA, "skills").text;
  globalThis.__cinatraSkillCatalogCache = undefined;
  seedRows("gen-1");
});

describe("replaceSkillCatalogInDatabase — transactional generation bump (write fence)", () => {
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

describe("readSkillCatalogFromDatabase — fenced batch read + token-keyed cache", () => {
  it("reads token → rows → token in one batch, caches by token, refetches on token change", () => {
    fake.meta.set(GEN_KEY, JSON.stringify("token-1"));

    // First read: a probe call + ONE fenced batch (token, pkgs, skills, token).
    const first = readSkillCatalogFromDatabase();
    expect(first.skillPackages).toHaveLength(1);
    const batches = rowReadCalls();
    expect(batches).toHaveLength(1);
    const texts = batches[0]!.queries.map((q) => q.text);
    expect(texts).toEqual([
      fake.texts.readMeta,
      fake.texts.selectPkgs,
      fake.texts.selectSkills,
      fake.texts.readMeta,
    ]);

    // Same token: cache hit — rows are NOT re-read (only the token probe runs).
    fake.calls.length = 0;
    seedRows("gen-2"); // silently mutated rows must NOT surface under the same token
    const second = readSkillCatalogFromDatabase();
    expect(second).toBe(first);
    expect(rowReadCalls()).toHaveLength(0);

    // Changed token (another process wrote): full refetch surfaces the new rows.
    fake.meta.set(GEN_KEY, JSON.stringify("token-2"));
    fake.calls.length = 0;
    const third = readSkillCatalogFromDatabase();
    expect(third).not.toBe(first);
    expect((third.skillPackages[0] as { marker?: string }).marker).toBe("gen-2");
    expect(rowReadCalls()).toHaveLength(1);
  });

  it("RETRIES a torn read (token changed mid-batch) and never returns the torn snapshot", () => {
    // Script the token reads: probe "t1"; batch 1 sees t1 → t2 (a writer
    // committed between the row reads); batch 2 sees a stable t2.
    fake.tokenQueue.push(JSON.stringify("t1")); // probe
    fake.tokenQueue.push(JSON.stringify("t1"), JSON.stringify("t2")); // batch 1: torn
    fake.tokenQueue.push(JSON.stringify("t2"), JSON.stringify("t2")); // batch 2: stable

    const result = readSkillCatalogFromDatabase();
    expect(rowReadCalls()).toHaveLength(2); // retried exactly once
    expect(result.skillPackages).toHaveLength(1);
    // The stable read is cached under the settled token.
    expect(globalThis.__cinatraSkillCatalogCache?.token).toBe(JSON.stringify("t2"));
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
