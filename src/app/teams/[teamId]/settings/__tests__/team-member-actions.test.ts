/**
 * Team member management server actions (cinatra#1567 + the #1566 role model).
 *
 * Truths locked here:
 *  - all actions are gated on `canManageTeamMembers` resolved against
 *    the TEAM's organizationId (never the viewer's active org); a plain org
 *    member gets `forbidden` and NO data/mutation;
 *  - a TEAM ADMIN of the team passes the gate via the LAZY team-role read
 *    (#1566) — resolved only after the org tiers failed AND only when the
 *    role column is provisioned; with the column absent the gate is
 *    byte-identical to the pre-#1566 behavior (the default in this file:
 *    `teamMemberRoleColumnExists` resolves false);
 *  - team-admin authority is RE-VERIFIED inside the advisory-locked
 *    transaction before any mutation: the gate's role read is pre-lock, so a
 *    concurrently demoted/removed admin whose request was queued on the lock
 *    must be refused (stale-authority TOCTOU); platform/org tiers live
 *    outside the teamMember table and are not re-read;
 *  - a missing team raises the IDENTICAL `forbidden` (no existence oracle —
 *    the assertProjectGrantAuthority precedent);
 *  - add: the target must be a member of the team's org (`user_not_in_org`),
 *    a duplicate is `already_member`, success inserts a `public."teamMember"`
 *    row that deliberately does NOT name the role column — new members get
 *    'member' via the app-owned column's DEFAULT (#1566), and the statement
 *    keeps working on un-provisioned deployments;
 *  - role change: same authority gate + the SAME per-team advisory lock;
 *    `role_unavailable` when the column is not provisioned; `not_a_member`
 *    when no row matched;
 *  - mutations serialize on the per-team `pg_advisory_xact_lock`
 *    (no (teamId,userId) unique constraint exists — codex 1567-r1);
 *  - remove: the LAST member is protected (`last_member`) inside a
 *    lock-then-count transaction; a non-member is `not_a_member`;
 *  - the candidate search is bounded by the team's organizationId, escapes
 *    ILIKE wildcards, and stays LIMIT 20.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (module factories — the grant-candidate-actions pattern)
// ---------------------------------------------------------------------------

const requireAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const resolveOrgRoleForUser = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a),
}));

// Recorded raw-SQL executor: every `betterAuthDb.execute` / `tx.execute`
// call is recorded and answered from a FIFO of queued row sets. The recorded
// drizzle `sql` objects are real SQL trees we can walk for bound params.
type ExecutedCall = { sql: unknown };
const executed: ExecutedCall[] = [];
let queuedRows: unknown[][] = [];
const execute = vi.fn(async (sqlObj: unknown) => {
  executed.push({ sql: sqlObj });
  return { rows: queuedRows.shift() ?? [] };
});
const transaction = vi.fn(async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) =>
  fn({ execute }),
);
// Default FALSE: the un-provisioned degrade — every pre-#1566 case in this
// file runs the byte-identical legacy paths (no lazy team-role read, no role
// UI). Role-model cases flip it to true explicitly.
const teamMemberRoleColumnExists = vi.fn(async () => false);
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    execute: (...a: unknown[]) => execute(...(a as [unknown])),
    transaction: (...a: unknown[]) =>
      transaction(...(a as [Parameters<typeof transaction>[0]])),
  },
  teamMemberRoleColumnExists: () => teamMemberRoleColumnExists(),
}));

import {
  addTeamMemberAction,
  removeTeamMemberAction,
  searchTeamMemberCandidates,
  updateTeamMemberRoleAction,
} from "../member-actions";

// Deep-walk an expression tree (drizzle SQL objects: cyclic, symbol-keyed)
// for an exact string value — how we assert which ids bound a query.
function containsValue(root: unknown, target: string): boolean {
  const seen = new Set<object>();
  const walk = (node: unknown): boolean => {
    if (node === target) return true;
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node as object)) return false;
    seen.add(node as object);
    for (const key of Reflect.ownKeys(node as object)) {
      let value: unknown;
      try {
        value = (node as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      if (walk(value)) return true;
    }
    return false;
  };
  return walk(root);
}

/** Concatenated static text of a recorded drizzle `sql` tree (best-effort —
 *  enough to tell INSERT/DELETE/SELECT statements apart). */
function sqlText(root: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const key of Reflect.ownKeys(node as object)) {
      let value: unknown;
      try {
        value = (node as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      walk(value);
    }
  };
  walk(root);
  return parts.join(" ");
}

const TEAM_ROW = { id: "team-1", organizationId: "org-of-team" };

function primeManagerSession(opts?: { platformAdmin?: boolean; orgRole?: string }) {
  requireAuthSession.mockResolvedValue({
    user: { id: "caller-1" },
    session: { activeOrganizationId: "org-of-viewer" },
  });
  isPlatformAdmin.mockReturnValue(opts?.platformAdmin ?? false);
  resolveOrgRoleForUser.mockResolvedValue(opts?.orgRole ?? "org_admin");
}

beforeEach(() => {
  vi.clearAllMocks();
  executed.length = 0;
  queuedRows = [];
  teamMemberRoleColumnExists.mockImplementation(async () => false);
});

// ---------------------------------------------------------------------------
// Authority gate
// ---------------------------------------------------------------------------
describe("authority gate", () => {
  it("plain org members get forbidden with NO mutation (add)", async () => {
    primeManagerSession({ orgRole: "member" });
    queuedRows = [[TEAM_ROW]]; // team lookup succeeds; gate must still refuse
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    // only the team lookup ran — no org-membership probe, no INSERT
    expect(executed).toHaveLength(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a missing team raises the IDENTICAL forbidden (no existence oracle)", async () => {
    primeManagerSession({ orgRole: "org_admin" });
    queuedRows = [[]]; // team lookup: no row
    const r = await addTeamMemberAction("team-missing", "user-2");
    expect(r).toEqual({ ok: false, error: "forbidden" });
  });

  it("resolves the org role against the TEAM's org, never the viewer's active org", async () => {
    primeManagerSession({ orgRole: "org_admin" });
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [], [{ id: "tm-new" }]];
    await addTeamMemberAction("team-1", "user-2");
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-of-team", "caller-1");
    expect(resolveOrgRoleForUser).not.toHaveBeenCalledWith(
      "org-of-viewer",
      expect.anything(),
    );
  });

  it("platform admin passes without an org role lookup", async () => {
    primeManagerSession({ platformAdmin: true });
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [], [{ id: "tm-new" }]];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: true });
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("a missing session fails closed to forbidden (search)", async () => {
    requireAuthSession.mockRejectedValue(new Error("NEXT_REDIRECT"));
    const r = await searchTeamMemberCandidates("team-1", "al");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(executed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addTeamMemberAction
// ---------------------------------------------------------------------------
describe("addTeamMemberAction", () => {
  it("refuses a target outside the team's org (user_not_in_org)", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], []]; // team found; no org membership row
    const r = await addTeamMemberAction("team-1", "user-outside");
    expect(r).toEqual({ ok: false, error: "user_not_in_org" });
    // the org-membership probe is bound to the TEAM's org
    expect(containsValue(executed[1]!.sql, "org-of-team")).toBe(true);
    expect(executed).toHaveLength(2); // no INSERT attempted
  });

  it("returns already_member when the guarded insert matches an existing row", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [], []]; // lock, then insert returned nothing
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "already_member" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("serializes on the per-team advisory lock, then inserts a ROLELESS row and revalidates", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [], [{ id: "tm-new" }]];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: true });
    // the guarded insert runs inside the advisory-locked transaction
    expect(transaction).toHaveBeenCalledTimes(1);
    const lock = executed[2]!.sql;
    expect(sqlText(lock)).toContain("pg_advisory_xact_lock");
    expect(containsValue(lock, "team-1")).toBe(true);
    const insert = executed[3]!.sql;
    const text = sqlText(insert);
    expect(text).toContain('INSERT INTO public."teamMember"');
    // roleless membership — the statement must not touch a role column
    expect(text).not.toMatch(/\brole\b/i);
    expect(containsValue(insert, "team-1")).toBe(true);
    expect(containsValue(insert, "user-2")).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/teams/team-1/settings");
  });

  it("rejects a blank user id before touching the org boundary", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW]];
    const r = await addTeamMemberAction("team-1", "   ");
    expect(r).toEqual({ ok: false, error: "invalid_user" });
    expect(executed).toHaveLength(1); // team lookup only
  });
});

// ---------------------------------------------------------------------------
// removeTeamMemberAction — last-member guard
// ---------------------------------------------------------------------------
describe("removeTeamMemberAction", () => {
  it("refuses to remove the LAST member (last_member) without deleting", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], [], [{ userId: "user-2" }]]; // lock, then: sole member
    const r = await removeTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "last_member" });
    const texts = executed.map((c) => sqlText(c.sql));
    expect(texts.some((t) => t.includes("DELETE"))).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("takes the per-team advisory lock before counting (racers serialize)", async () => {
    primeManagerSession();
    queuedRows = [
      [TEAM_ROW],
      [],
      [{ userId: "user-2" }, { userId: "user-3" }],
      [],
    ];
    await removeTeamMemberAction("team-1", "user-2");
    expect(transaction).toHaveBeenCalledTimes(1);
    const lock = executed[1]!.sql;
    expect(sqlText(lock)).toContain("pg_advisory_xact_lock");
    expect(containsValue(lock, "team-1")).toBe(true);
  });

  it("returns not_a_member for a user without a membership row", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], [], [{ userId: "user-3" }]];
    const r = await removeTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "not_a_member" });
  });

  it("deletes a non-last member and revalidates the settings page", async () => {
    primeManagerSession();
    queuedRows = [
      [TEAM_ROW],
      [],
      [{ userId: "user-2" }, { userId: "user-3" }],
      [],
    ];
    const r = await removeTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: true });
    const del = executed[3]!.sql;
    expect(sqlText(del)).toContain('DELETE FROM public."teamMember"');
    expect(containsValue(del, "team-1")).toBe(true);
    expect(containsValue(del, "user-2")).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/teams/team-1/settings");
  });
});

// ---------------------------------------------------------------------------
// Team-admin authority tier (#1566) — the lazy team-role read in the gate
// ---------------------------------------------------------------------------
describe("team-admin authority tier", () => {
  it("a plain org member who is TEAM ADMIN passes the gate via the lazy role read AND the in-lock re-check", async () => {
    primeManagerSession({ orgRole: "member" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    // team lookup → caller team-role read (gate) → org-boundary probe →
    // lock → in-lock re-read (still admin) → insert
    queuedRows = [
      [TEAM_ROW],
      [{ role: "admin" }],
      [{ id: "m-1" }],
      [],
      [{ role: "admin" }],
      [{ id: "tm-new" }],
    ];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: true });
    // The lazy gate read is bound to the team AND the caller.
    const roleRead = executed[1]!.sql;
    expect(sqlText(roleRead)).toContain('SELECT role FROM public."teamMember"');
    expect(containsValue(roleRead, "team-1")).toBe(true);
    expect(containsValue(roleRead, "caller-1")).toBe(true);
    // The re-check runs INSIDE the locked transaction (after the lock).
    expect(sqlText(executed[3]!.sql)).toContain("pg_advisory_xact_lock");
    const recheck = executed[4]!.sql;
    expect(sqlText(recheck)).toContain('SELECT role FROM public."teamMember"');
    expect(containsValue(recheck, "caller-1")).toBe(true);
  });

  it("a plain TEAM MEMBER still gets forbidden (role read ran, tier not met)", async () => {
    primeManagerSession({ orgRole: "member" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    queuedRows = [[TEAM_ROW], [{ role: "member" }]];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(executed).toHaveLength(2); // team lookup + role read only
  });

  it("with the role column NOT provisioned, the gate never issues the role read (pre-#1566 behavior)", async () => {
    primeManagerSession({ orgRole: "member" });
    queuedRows = [[TEAM_ROW]];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(executed).toHaveLength(1); // team lookup only — no role SELECT
  });

  it("CONCURRENT DEMOTION (add): a team admin demoted after the gate but before the lock is refused with NO mutation", async () => {
    primeManagerSession({ orgRole: "member" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    // The gate read (pre-lock) still sees 'admin' — the demotion commits
    // while this request is queued on the advisory lock — then the in-lock
    // re-read sees 'member'.
    queuedRows = [
      [TEAM_ROW],
      [{ role: "admin" }],
      [{ id: "m-1" }],
      [],
      [{ role: "member" }],
    ];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    const texts = executed.map((c) => sqlText(c.sql));
    expect(texts.some((t) => t.includes("INSERT"))).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("CONCURRENT REMOVAL (remove): a team admin removed from the team mid-queue is refused with NO deletion", async () => {
    primeManagerSession({ orgRole: "member" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    // Gate read 'admin' → lock → in-lock re-read finds NO row (removed).
    queuedRows = [[TEAM_ROW], [{ role: "admin" }], [], []];
    const r = await removeTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    const texts = executed.map((c) => sqlText(c.sql));
    expect(texts.some((t) => t.includes("DELETE"))).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("CONCURRENT DEMOTION (role change): a demoted admin cannot re-promote themselves from a queued request", async () => {
    primeManagerSession({ orgRole: "member" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    // Gate read 'admin' → lock → in-lock re-read 'member' → forbidden.
    queuedRows = [[TEAM_ROW], [{ role: "admin" }], [], [{ role: "member" }]];
    const r = await updateTeamMemberRoleAction("team-1", "caller-1", "admin");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    const texts = executed.map((c) => sqlText(c.sql));
    expect(texts.some((t) => t.includes("UPDATE"))).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("platform/org tiers do NOT re-read team roles inside the lock (authority lives outside teamMember)", async () => {
    primeManagerSession({ orgRole: "org_admin" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [], [{ id: "tm-new" }]];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: true });
    // team lookup → org probe → lock → insert; no role SELECT anywhere.
    const texts = executed.map((c) => sqlText(c.sql));
    expect(
      texts.filter((t) => t.includes('SELECT role FROM public."teamMember"')),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateTeamMemberRoleAction (#1566)
// ---------------------------------------------------------------------------
describe("updateTeamMemberRoleAction", () => {
  it("takes the per-team advisory lock, updates the role, and revalidates", async () => {
    primeManagerSession({ orgRole: "org_admin" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    queuedRows = [[TEAM_ROW], [], [{ id: "tm-1" }]];
    const r = await updateTeamMemberRoleAction("team-1", "user-2", "admin");
    expect(r).toEqual({ ok: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    const lock = executed[1]!.sql;
    expect(sqlText(lock)).toContain("pg_advisory_xact_lock");
    expect(containsValue(lock, "team-1")).toBe(true);
    const update = executed[2]!.sql;
    expect(sqlText(update)).toContain('UPDATE public."teamMember"');
    expect(containsValue(update, "admin")).toBe(true);
    expect(containsValue(update, "team-1")).toBe(true);
    expect(containsValue(update, "user-2")).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/teams/team-1/settings");
  });

  it("returns role_unavailable (no mutation) when the column is not provisioned", async () => {
    primeManagerSession({ orgRole: "org_admin" });
    queuedRows = [[TEAM_ROW]];
    const r = await updateTeamMemberRoleAction("team-1", "user-2", "admin");
    expect(r).toEqual({ ok: false, error: "role_unavailable" });
    expect(transaction).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns not_a_member when no membership row matched", async () => {
    primeManagerSession({ orgRole: "org_admin" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    queuedRows = [[TEAM_ROW], [], []];
    const r = await updateTeamMemberRoleAction("team-1", "user-9", "member");
    expect(r).toEqual({ ok: false, error: "not_a_member" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an out-of-vocabulary role before any mutation", async () => {
    primeManagerSession({ orgRole: "org_admin" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    queuedRows = [[TEAM_ROW]];
    const r = await updateTeamMemberRoleAction(
      "team-1",
      "user-2",
      "owner" as unknown as "admin",
    );
    expect(r).toEqual({ ok: false, error: "invalid_role" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("plain org members get forbidden with NO mutation", async () => {
    primeManagerSession({ orgRole: "member" });
    queuedRows = [[TEAM_ROW]];
    const r = await updateTeamMemberRoleAction("team-1", "user-2", "admin");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchTeamMemberCandidates
// ---------------------------------------------------------------------------
describe("searchTeamMemberCandidates", () => {
  it("bounds candidates by the TEAM's organizationId and caps at LIMIT 20", async () => {
    primeManagerSession();
    queuedRows = [
      [TEAM_ROW],
      [{ id: "u-9", name: "Ada", email: "ada@x.io", image: null }],
    ];
    const r = await searchTeamMemberCandidates("team-1", "ad");
    expect(r).toEqual({
      ok: true,
      results: [{ id: "u-9", name: "Ada", email: "ada@x.io", image: null }],
    });
    const search = executed[1]!.sql;
    expect(containsValue(search, "org-of-team")).toBe(true);
    expect(sqlText(search)).toContain("LIMIT 20");
  });

  it("escapes ILIKE wildcards in the user-supplied query", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], []];
    await searchTeamMemberCandidates("team-1", "50%_a\\b");
    expect(containsValue(executed[1]!.sql, "%50\\%\\_a\\\\b%")).toBe(true);
  });

  it("denies non-managers with no candidate data", async () => {
    primeManagerSession({ orgRole: "member" });
    queuedRows = [[TEAM_ROW]];
    const r = await searchTeamMemberCandidates("team-1", "ad");
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(executed).toHaveLength(1); // team lookup only — no user query
  });
});
