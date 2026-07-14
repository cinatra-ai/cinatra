/**
 * Team member management server actions (cinatra#1567).
 *
 * Truths locked here:
 *  - all three actions are gated on `canManageTeamMembers` resolved against
 *    the TEAM's organizationId (never the viewer's active org); a plain org
 *    member gets `forbidden` and NO data/mutation;
 *  - a missing team raises the IDENTICAL `forbidden` (no existence oracle —
 *    the assertProjectGrantAuthority precedent);
 *  - add: the target must be a member of the team's org (`user_not_in_org`),
 *    a duplicate is `already_member`, success inserts a ROLELESS
 *    `public."teamMember"` row (no role column — #1566 owns that decision);
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
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    execute: (...a: unknown[]) => execute(...(a as [unknown])),
    transaction: (...a: unknown[]) =>
      transaction(...(a as [Parameters<typeof transaction>[0]])),
  },
}));

import {
  addTeamMemberAction,
  removeTeamMemberAction,
  searchTeamMemberCandidates,
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
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [{ id: "tm-new" }]];
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
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [{ id: "tm-new" }]];
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
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], []]; // insert returned nothing
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "already_member" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("inserts a ROLELESS teamMember row and revalidates the settings page", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], [{ id: "m-1" }], [{ id: "tm-new" }]];
    const r = await addTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: true });
    const insert = executed[2]!.sql;
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
    queuedRows = [[TEAM_ROW], [{ userId: "user-2" }]]; // lock: sole member
    const r = await removeTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "last_member" });
    const texts = executed.map((c) => sqlText(c.sql));
    expect(texts.some((t) => t.includes("DELETE"))).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("locks the membership rows before counting (FOR UPDATE serializes racers)", async () => {
    primeManagerSession();
    queuedRows = [
      [TEAM_ROW],
      [{ userId: "user-2" }, { userId: "user-3" }],
      [],
    ];
    await removeTeamMemberAction("team-1", "user-2");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(sqlText(executed[1]!.sql)).toContain("FOR UPDATE");
  });

  it("returns not_a_member for a user without a membership row", async () => {
    primeManagerSession();
    queuedRows = [[TEAM_ROW], [{ userId: "user-3" }]];
    const r = await removeTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: false, error: "not_a_member" });
  });

  it("deletes a non-last member and revalidates the settings page", async () => {
    primeManagerSession();
    queuedRows = [
      [TEAM_ROW],
      [{ userId: "user-2" }, { userId: "user-3" }],
      [],
    ];
    const r = await removeTeamMemberAction("team-1", "user-2");
    expect(r).toEqual({ ok: true });
    const del = executed[2]!.sql;
    expect(sqlText(del)).toContain('DELETE FROM public."teamMember"');
    expect(containsValue(del, "team-1")).toBe(true);
    expect(containsValue(del, "user-2")).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/teams/team-1/settings");
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
