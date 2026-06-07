// Regression test — ensureDefaultOrganizationRow must be
// race-safe under concurrent callers.
//
// The original SELECT-then-INSERT pattern in auth.ts trips the
// `organization_slug_key` UNIQUE constraint (pg error 23505) when two
// concurrent layout renders on a fresh DB both miss the SELECT and race the
// INSERT. The fix uses ON CONFLICT (slug) DO NOTHING + RETURNING id, falling
// back to a re-SELECT when this caller loses the race.
//
// This test exercises a Drizzle stub (not a mock of the pg client) that
// drives a simulated race via a barrier latch — both callers reach the
// "insert" step before either is allowed to elect the winner, modelling the
// actual DB-level race the fix targets.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Drizzle chain stub
// ---------------------------------------------------------------------------

type Row = { id: string };

type Barrier = {
  remaining: number;
  release: () => void;
  promise: Promise<void>;
};

const state: {
  winnerId: string | null;
  insertCalls: Array<{ values?: unknown; onConflictTarget?: unknown }>;
  selectCalls: number;
  barrier: Barrier | null;
} = {
  winnerId: null,
  insertCalls: [],
  selectCalls: 0,
  barrier: null,
};

function resetState() {
  state.winnerId = null;
  state.insertCalls = [];
  state.selectCalls = 0;
  state.barrier = null;
}

function makeBarrier(count: number): Barrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { remaining: count, release, promise };
}

function makeInsertChain() {
  let capturedValues: unknown = undefined;
  let capturedConflictTarget: unknown = undefined;

  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  chain.values = (v: unknown) => {
    capturedValues = v;
    return chain;
  };
  chain.onConflictDoNothing = (cfg: unknown) => {
    capturedConflictTarget = (cfg as { target?: unknown } | undefined)?.target;
    return chain;
  };
  chain.returning = async () => {
    state.insertCalls.push({
      values: capturedValues,
      onConflictTarget: capturedConflictTarget,
    });

    // Barrier: when set, every concurrent caller must arrive before any can
    // proceed past this point — this models the DB-level race where two
    // INSERTs are in flight before the UNIQUE constraint arbitrates.
    if (state.barrier) {
      state.barrier.remaining -= 1;
      if (state.barrier.remaining === 0) {
        state.barrier.release();
      }
      await state.barrier.promise;
    }

    const values = capturedValues as { id: string } | undefined;
    if (state.winnerId == null && values) {
      state.winnerId = values.id;
      return [{ id: values.id }] as Row[];
    }
    return [] as Row[];
  };
  return chain;
}

function makeSelectChain() {
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => {
    state.selectCalls += 1;
    if (state.winnerId == null) {
      return Promise.resolve([] as Row[]);
    }
    return Promise.resolve([{ id: state.winnerId }] as Row[]);
  };
  return chain;
}

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    insert: () => makeInsertChain(),
    select: () => makeSelectChain(),
  },
  // Sentinel marker for the column-target — the production helper passes
  // `betterAuthOrganizations.slug` as the conflict target, so we capture the
  // identity and assert on it below.
  betterAuthOrganizations: {
    id: { _column: "betterAuthOrganizations.id" },
    slug: { _column: "betterAuthOrganizations.slug" },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => ({ _eq: args }),
}));

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

// ---------------------------------------------------------------------------
// Helper-level tests
// ---------------------------------------------------------------------------

describe("ensureDefaultOrganizationRow", () => {
  it("returns the inserted row id on the no-conflict path", async () => {
    const { ensureDefaultOrganizationRow } = await import(
      "@/lib/default-organization-bootstrap"
    );

    const id = await ensureDefaultOrganizationRow();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(state.insertCalls.length).toBe(1);
    // The conflict target MUST be the slug column — otherwise the ON CONFLICT
    // would match the wrong constraint and the race fix would silently regress.
    expect(state.insertCalls[0].onConflictTarget).toEqual({
      _column: "betterAuthOrganizations.slug",
    });
    // No re-SELECT needed on the winner path.
    expect(state.selectCalls).toBe(0);
  });

  it("two TRULY concurrent callers (barrier-gated) both return the SAME row id", async () => {
    // Regression guard. The barrier ensures BOTH callers reach the
    // "insert" step BEFORE either elects the winner — modelling the actual
    // DB-level race the fix targets (not a sequential fallback). Without the
    // barrier, the first call's synchronous winnerId set would short-circuit
    // the second call and we'd only be testing the loser-path lookup, not the
    // race itself.
    state.barrier = makeBarrier(2);

    const { ensureDefaultOrganizationRow } = await import(
      "@/lib/default-organization-bootstrap"
    );

    const [a, b] = await Promise.all([
      ensureDefaultOrganizationRow(),
      ensureDefaultOrganizationRow(),
    ]);

    expect(a).toBe(b);
    expect(state.insertCalls.length).toBe(2);
    // Loser falls back to a re-SELECT to recover the winner id. Winner does
    // NOT re-SELECT. Exactly one call lost the race → exactly one select.
    expect(state.selectCalls).toBe(1);
  });

  it("uses ON CONFLICT (slug) DO NOTHING — the load-bearing race primitive", async () => {
    const { ensureDefaultOrganizationRow } = await import(
      "@/lib/default-organization-bootstrap"
    );

    await ensureDefaultOrganizationRow();
    await ensureDefaultOrganizationRow();

    // Every insert call must pin the conflict target to the slug column;
    // omitting the target would no-op ANY constraint (incl. id) and the
    // re-SELECT-by-slug recovery path would diverge from the constraint
    // that actually fired.
    for (const call of state.insertCalls) {
      expect(call.onConflictTarget).toEqual({
        _column: "betterAuthOrganizations.slug",
      });
    }
  });

  it("throws fail-loud when the row disappears between INSERT and re-SELECT", async () => {
    const { ensureDefaultOrganizationRow } = await import(
      "@/lib/default-organization-bootstrap"
    );

    // Force the insertChain to return [] (simulating ON CONFLICT no-op)
    // while the selectChain also returns [] (simulating a concurrent DELETE).
    // This is the documented unreachable path; assert it fails loud not
    // silently.
    state.winnerId = "pre-claimed-by-someone-else"; // first call's insert sees winnerId set, returns []
    // But our selectChain returns [winnerId] when set. Need to force select empty too.
    // Easiest: set winnerId to non-null so insert returns [], then null it before select runs.
    // Cleaner approach: drive directly via a one-shot override.

    // Override the select chain to always return [] for this test only.
    const { betterAuthDb } = (await import("@/lib/better-auth-db")) as unknown as {
      betterAuthDb: { select: () => unknown; insert: () => unknown };
    };
    const originalSelect = betterAuthDb.select;
    betterAuthDb.select = () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([] as Row[]) }) }),
    });

    try {
      await expect(ensureDefaultOrganizationRow()).rejects.toThrow(
        /disappeared after ON CONFLICT/,
      );
    } finally {
      betterAuthDb.select = originalSelect;
    }
  });
});

// ---------------------------------------------------------------------------
// Call-site wiring assertion — guards against accidentally leaving an old
// SELECT-then-INSERT block in auth.ts, OR removing one of the two callers,
// after the refactor.
// ---------------------------------------------------------------------------

const AUTH_TS_PATH = path.join(__dirname, "..", "auth.ts");

function readAuthSource(): string {
  return fs.readFileSync(AUTH_TS_PATH, "utf8");
}

// Strip // line comments and /* ... */ block comments so prose containing
// "betterAuthOrganizations.id" cannot false-positive against the negative
// regex checks.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function extractFunctionBody(source: string, fnName: string): string {
  const decl = `export async function ${fnName}(`;
  const startIdx = source.indexOf(decl);
  if (startIdx < 0) {
    throw new Error(`extractFunctionBody: '${fnName}' not found in auth.ts`);
  }
  const openBrace = source.indexOf("{", startIdx);
  if (openBrace < 0) {
    throw new Error(`extractFunctionBody: '${fnName}' has no opening brace`);
  }
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace + 1, i);
      }
    }
  }
  throw new Error(`extractFunctionBody: '${fnName}' has unbalanced braces`);
}

describe("src/lib/auth.ts call-site wiring", () => {
  it("contains no remaining org-INSERT outside the helper", () => {
    const sourceNoComments = stripComments(readAuthSource());
    // The only legitimate writer of public."organization" must now be
    // ensureDefaultOrganizationRow() — both ensureInitialAdminBootstrap and
    // ensureDefaultOrganizationMembership must call it via the helper.
    expect(sourceNoComments).not.toMatch(
      /\binsert\s*\(\s*betterAuthOrganizations\s*\)/,
    );
    // No stray SELECT-then-INSERT on the organization table.
    expect(sourceNoComments).not.toMatch(
      /select\s*\(\s*\{\s*id:\s*betterAuthOrganizations\.id/,
    );
  });

  it("has no betterAuthOrganizations import remaining in auth.ts", () => {
    // The helper module owns the import; auth.ts must not re-introduce it.
    const sourceNoComments = stripComments(readAuthSource());
    expect(sourceNoComments).not.toMatch(/\bbetterAuthOrganizations\b/);
  });

  it("calls ensureDefaultOrganizationRow inside ensureInitialAdminBootstrap", () => {
    const source = readAuthSource();
    const body = stripComments(
      extractFunctionBody(source, "ensureInitialAdminBootstrap"),
    );
    expect(body).toMatch(/ensureDefaultOrganizationRow\s*\(\s*\)/);
  });

  it("calls ensureDefaultOrganizationRow inside ensureDefaultOrganizationMembership", () => {
    const source = readAuthSource();
    const body = stripComments(
      extractFunctionBody(source, "ensureDefaultOrganizationMembership"),
    );
    expect(body).toMatch(/ensureDefaultOrganizationRow\s*\(\s*\)/);
  });
});
