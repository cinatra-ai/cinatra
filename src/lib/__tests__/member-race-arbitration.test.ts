// Race + role-arbitration regression test for ensureBetterAuthMembershipRow.
//
// public."member" had no UNIQUE constraint on (organizationId, userId), so two
// concurrent ensureInitialAdminBootstrap + ensureDefaultOrganizationMembership
// callers on a fresh DB could both INSERT — and worse, a 'member' insert could
// beat the 'owner' insert, stranding the first user without org-admin rights.
//
// The fix: member_org_user_uniq serializes inserts; the loser's INSERT
// no-ops via ON CONFLICT DO NOTHING; the helper re-SELECTs and applies
// PROMOTE-ONLY arbitration (never a downgrade). This test drives the helper
// against a barrier-gated Drizzle stub so both callers
// reach the conflict-arbitration point before either claims the row — and
// asserts the surviving role regardless of which caller physically wins.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Drizzle chain stub — single (organizationId, userId) partition.
// ---------------------------------------------------------------------------

type MemberRow = { id: string; organizationId: string; userId: string; role: string | null };

type Barrier = { remaining: number; release: () => void; promise: Promise<void> };

const state: {
  rows: Map<string, MemberRow>;
  insertAttempts: Array<{ role: string | null; onConflictTarget?: unknown }>;
  claimedRole: string | null;
  winnerId: string | null;
  selectCalls: number;
  updateCalls: Array<{ role: unknown }>;
  barrier: Barrier | null;
} = {
  rows: new Map(),
  insertAttempts: [],
  claimedRole: null,
  winnerId: null,
  selectCalls: 0,
  updateCalls: [],
  barrier: null,
};

function resetState() {
  state.rows = new Map();
  state.insertAttempts = [];
  state.claimedRole = null;
  state.winnerId = null;
  state.selectCalls = 0;
  state.updateCalls = [];
  state.barrier = null;
}

function makeBarrier(count: number): Barrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { remaining: count, release, promise };
}

function key(organizationId: string, userId: string): string {
  return `${organizationId}|${userId}`;
}

function makeInsertChain() {
  let values: MemberRow | undefined;
  let onConflictTarget: unknown;
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  chain.values = (v: unknown) => {
    values = v as MemberRow;
    return chain;
  };
  chain.onConflictDoNothing = (cfg: unknown) => {
    onConflictTarget = (cfg as { target?: unknown } | undefined)?.target;
    return chain;
  };
  chain.returning = async () => {
    state.insertAttempts.push({ role: values?.role ?? null, onConflictTarget });

    // Barrier: every concurrent caller must arrive before any can arbitrate —
    // models two INSERTs in flight before the UNIQUE index picks a winner.
    if (state.barrier) {
      state.barrier.remaining -= 1;
      if (state.barrier.remaining === 0) state.barrier.release();
      await state.barrier.promise;
    }

    if (!values) return [];
    const k = key(values.organizationId, values.userId);
    if (!state.rows.has(k)) {
      state.rows.set(k, { ...values });
      state.claimedRole = values.role;
      state.winnerId = values.id;
      return [{ id: values.id }];
    }
    return [];
  };
  return chain;
}

function makeSelectChain() {
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => {
    state.selectCalls += 1;
    const row = [...state.rows.values()][0];
    return Promise.resolve(row ? [{ id: row.id, role: row.role }] : []);
  };
  return chain;
}

function makeUpdateChain() {
  let setRole: unknown;
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  chain.set = (s: unknown) => {
    setRole = (s as { role?: unknown } | undefined)?.role;
    return chain;
  };
  chain.where = () => {
    state.updateCalls.push({ role: setRole });
    const row = [...state.rows.values()][0];
    if (row) row.role = setRole as string;
    return Promise.resolve({ rowCount: 1 });
  };
  return chain;
}

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    insert: () => makeInsertChain(),
    select: () => makeSelectChain(),
    update: () => makeUpdateChain(),
  },
  betterAuthMembers: {
    id: { _column: "member.id" },
    role: { _column: "member.role" },
    organizationId: { _column: "member.organizationId" },
    userId: { _column: "member.userId" },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => ({ _eq: args }),
  and: (...args: unknown[]) => ({ _and: args }),
}));

beforeEach(resetState);
afterEach(resetState);

const ORG = "org-1";
const USER = "user-1";

async function importHelper() {
  return import("@/lib/better-auth-membership-bootstrap");
}

describe("ensureBetterAuthMembershipRow — race + promote-only arbitration", () => {
  it("composite ON CONFLICT target is (organizationId, userId)", async () => {
    const { ensureBetterAuthMembershipRow } = await importHelper();
    await ensureBetterAuthMembershipRow(USER, ORG, "owner", true);
    expect(state.insertAttempts[0].onConflictTarget).toEqual([
      { _column: "member.organizationId" },
      { _column: "member.userId" },
    ]);
  });

  it("scenario 1 — bootstrap wins INSERT(owner); membership loses, finds owner, NO downgrade", async () => {
    state.barrier = makeBarrier(2);
    const { ensureBetterAuthMembershipRow } = await importHelper();

    // bootstrap is first in the array → reaches the barrier await first → wins
    // the claim (FIFO microtask resume). membership is the non-platform-admin
    // first user (insertRole='member', promoteToOwner=false).
    const [boot, mem] = await Promise.all([
      ensureBetterAuthMembershipRow(USER, ORG, "owner", true),
      ensureBetterAuthMembershipRow(USER, ORG, "member", false),
    ]);

    expect(state.insertAttempts.length).toBe(2);
    expect(state.rows.size).toBe(1);
    expect(state.claimedRole).toBe("owner"); // bootstrap won
    expect([...state.rows.values()][0].role).toBe("owner");
    // No downgrade UPDATE fired (membership promoteToOwner=false, and the
    // surviving row was already owner anyway).
    expect(state.updateCalls.length).toBe(0);
    expect(boot.changed).toBe(true);
    expect(boot.role).toBe("owner");
    expect(mem.changed).toBe(false);
    expect(mem.role).toBe("owner");
  });

  it("scenario 2 — membership wins INSERT(member); bootstrap loses, finds member, promotes to owner", async () => {
    state.barrier = makeBarrier(2);
    const { ensureBetterAuthMembershipRow } = await importHelper();

    // membership first in the array → wins the claim with role='member'.
    const [mem, boot] = await Promise.all([
      ensureBetterAuthMembershipRow(USER, ORG, "member", false),
      ensureBetterAuthMembershipRow(USER, ORG, "owner", true),
    ]);

    expect(state.insertAttempts.length).toBe(2);
    expect(state.rows.size).toBe(1);
    expect(state.claimedRole).toBe("member"); // membership won
    // bootstrap lost, re-SELECTed 'member', promote-to-owner UPDATE fired.
    expect(state.updateCalls.length).toBe(1);
    expect(state.updateCalls[0].role).toBe("owner");
    expect([...state.rows.values()][0].role).toBe("owner");
    expect(mem.changed).toBe(true); // it inserted the row
    expect(boot.changed).toBe(true); // it promoted the row
    expect(boot.role).toBe("owner");
  });

  it("scenario 3 — platform admin with a pre-existing 'member' row is promoted to owner", async () => {
    state.rows.set(key(ORG, USER), { id: "seed", organizationId: ORG, userId: USER, role: "member" });
    const { ensureBetterAuthMembershipRow } = await importHelper();

    // ensureDefaultOrganizationMembership for a platform admin: insertRole
    // 'owner', promoteToOwner=true.
    const result = await ensureBetterAuthMembershipRow(USER, ORG, "owner", true);

    expect(state.insertAttempts.length).toBe(1); // attempted, no-op'd via conflict
    expect(state.rows.size).toBe(1);
    expect(state.selectCalls).toBe(1); // re-SELECT to recover the row
    expect(state.updateCalls.length).toBe(1);
    expect([...state.rows.values()][0].role).toBe("owner");
    expect(result.changed).toBe(true);
    expect(result.role).toBe("owner");
  });

  it("scenario 4 — non-platform-admin with a pre-existing 'admin' row is NOT downgraded", async () => {
    state.rows.set(key(ORG, USER), { id: "seed", organizationId: ORG, userId: USER, role: "admin" });
    const { ensureBetterAuthMembershipRow } = await importHelper();

    // ensureDefaultOrganizationMembership for a regular user: insertRole
    // 'member', promoteToOwner=false. MUST preserve the legitimate 'admin'.
    const result = await ensureBetterAuthMembershipRow(USER, ORG, "member", false);

    expect(state.rows.size).toBe(1);
    expect(state.selectCalls).toBe(1);
    expect(state.updateCalls.length).toBe(0); // no write — the downgrade guard
    expect([...state.rows.values()][0].role).toBe("admin");
    expect(result.changed).toBe(false);
    expect(result.role).toBe("admin");
  });

  it("scenario 5 — platform admin with a pre-existing 'owner,admin' row is NOT clobbered to 'owner'", async () => {
    // Comma-aware promote guard: Better Auth multi-role 'owner,admin' already
    // grants owner; overwriting it with plain 'owner' would drop the 'admin'
    // token. The helper must treat it as already-owner and skip the UPDATE.
    state.rows.set(key(ORG, USER), { id: "seed", organizationId: ORG, userId: USER, role: "owner,admin" });
    const { ensureBetterAuthMembershipRow } = await importHelper();

    const result = await ensureBetterAuthMembershipRow(USER, ORG, "owner", true);

    expect(state.rows.size).toBe(1);
    expect(state.selectCalls).toBe(1);
    expect(state.updateCalls.length).toBe(0); // no clobber
    expect([...state.rows.values()][0].role).toBe("owner,admin"); // tokens preserved
    expect(result.changed).toBe(false);
    expect(result.role).toBe("owner,admin");
  });

  it("fail-loud when the row disappears after ON CONFLICT (concurrent DELETE)", async () => {
    const { ensureBetterAuthMembershipRow } = await importHelper();
    // Pre-claim the partition so the insert no-ops, then force select to []
    // (simulating a concurrent DELETE between INSERT and re-SELECT).
    state.rows.set(key(ORG, USER), { id: "ghost", organizationId: ORG, userId: USER, role: "member" });
    const { betterAuthDb } = (await import("@/lib/better-auth-db")) as unknown as {
      betterAuthDb: { select: () => unknown };
    };
    const originalSelect = betterAuthDb.select;
    betterAuthDb.select = () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    try {
      await expect(ensureBetterAuthMembershipRow(USER, ORG, "owner", true)).rejects.toThrow(
        /disappeared after ON CONFLICT/,
      );
    } finally {
      betterAuthDb.select = originalSelect;
    }
  });
});

// ---------------------------------------------------------------------------
// auth.ts call-site wiring — guards against leaving an old SELECT-then-INSERT
// member block, or one call site not routed through the helper.
// ---------------------------------------------------------------------------

const AUTH_TS_PATH = path.join(__dirname, "..", "auth.ts");

function readAuthSource(): string {
  return fs.readFileSync(AUTH_TS_PATH, "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function extractFunctionBody(source: string, fnName: string): string {
  const decl = `export async function ${fnName}(`;
  const startIdx = source.indexOf(decl);
  if (startIdx < 0) throw new Error(`extractFunctionBody: '${fnName}' not found in auth.ts`);
  const openBrace = source.indexOf("{", startIdx);
  if (openBrace < 0) throw new Error(`extractFunctionBody: '${fnName}' has no opening brace`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  throw new Error(`extractFunctionBody: '${fnName}' has unbalanced braces`);
}

describe("src/lib/auth.ts member call-site wiring", () => {
  it("has no remaining direct member INSERT/UPDATE or betterAuthMembers import", () => {
    const src = stripComments(readAuthSource());
    expect(src).not.toMatch(/\binsert\s*\(\s*betterAuthMembers\s*\)/);
    expect(src).not.toMatch(/\bupdate\s*\(\s*betterAuthMembers\s*\)/);
    // The helper module owns the betterAuthMembers import now.
    expect(src).not.toMatch(/\bbetterAuthMembers\b/);
  });

  it("routes ensureInitialAdminBootstrap through the helper with insertRole='owner', promoteToOwner=true", () => {
    const body = stripComments(extractFunctionBody(readAuthSource(), "ensureInitialAdminBootstrap"));
    // Pin the ARGUMENTS, not just that the helper is called: the first user
    // must always become 'owner', so this caller must promote.
    expect(body).toMatch(
      /ensureBetterAuthMembershipRow\(\s*userId,\s*organizationId,\s*"owner",\s*true\s*,?\s*\)/,
    );
  });

  it("routes ensureDefaultOrganizationMembership through the helper with (targetMembershipRole, isPlatformAdmin)", () => {
    const body = stripComments(extractFunctionBody(readAuthSource(), "ensureDefaultOrganizationMembership"));
    // Args span multiple lines; \s matches newlines. promoteToOwner must be
    // isPlatformAdmin (NOT a literal true) so a non-admin never promotes.
    expect(body).toMatch(
      /ensureBetterAuthMembershipRow\(\s*userId,\s*organizationId,\s*targetMembershipRole,\s*isPlatformAdmin\s*,?\s*\)/,
    );
    // targetMembershipRole is owner only for platform admins.
    expect(body).toMatch(/targetMembershipRole\s*=\s*isPlatformAdmin\s*\?\s*"owner"\s*:\s*"member"/);
    // Platform-admin detection MUST be comma-aware (Better Auth stores
    // multi-role as comma-joined text) — split on ',' then includes('admin'),
    // never a raw string compare.
    expect(body).toMatch(/\.split\(","\)[\s\S]*\.includes\("admin"\)/);
  });
});
