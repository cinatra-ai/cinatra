/**
 * renameTeamNameAction (cinatra#1687).
 *
 * Truths locked here:
 *  - gated on the SHARED management tiers (canManageTeamMembers): platform
 *    admin (no org lookup), org owner/admin of the TEAM's org, or team admin
 *    via the LAZY role read (only after org tiers failed AND only when the
 *    role column is provisioned — the member-actions gate pattern);
 *  - a plain org member / plain team member gets `forbidden` with NO UPDATE;
 *  - name is trimmed, required, and capped at 200 chars (`invalid-name`);
 *  - a missing team is `not-found` (no oracle beyond the shared shape);
 *  - success UPDATEs public."team".name and revalidates /teams/{id} + /teams.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const executed: Array<{ sql: unknown }> = [];
let queuedRows: unknown[][] = [];
const execute = vi.fn(async (sqlObj: unknown) => {
  executed.push({ sql: sqlObj });
  return { rows: queuedRows.shift() ?? [] };
});
const teamMemberRoleColumnExists = vi.fn(async () => false);
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { execute: (...a: unknown[]) => execute(...(a as [unknown])) },
  teamMemberRoleColumnExists: () => teamMemberRoleColumnExists(),
}));

import { renameTeamNameAction } from "../actions";

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

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

function primeSession(opts?: { platformAdmin?: boolean; orgRole?: string }) {
  requireAuthSession.mockResolvedValue({
    user: { id: "caller-1" },
    session: { activeOrganizationId: "org-of-viewer" },
  });
  isPlatformAdmin.mockReturnValue(opts?.platformAdmin ?? false);
  resolveOrgRoleForUser.mockResolvedValue(opts?.orgRole ?? "member");
}

beforeEach(() => {
  vi.clearAllMocks();
  executed.length = 0;
  queuedRows = [];
  teamMemberRoleColumnExists.mockImplementation(async () => false);
});

describe("renameTeamNameAction", () => {
  it("org owner/admin renames: UPDATE bound to team + name, revalidates detail and list", async () => {
    primeSession({ orgRole: "org_admin" });
    queuedRows = [[TEAM_ROW], []];
    const r = await renameTeamNameAction(form({ teamId: "team-1", name: "  Growth Team  " }));
    expect(r).toEqual({ ok: true, teamId: "team-1", name: "Growth Team" });
    const update = executed[1]!.sql;
    expect(sqlText(update)).toContain('UPDATE public."team"');
    expect(revalidatePath).toHaveBeenCalledWith("/teams/team-1/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/teams/team-1");
    expect(revalidatePath).toHaveBeenCalledWith("/teams");
  });

  it("resolves authority against the TEAM's org, never the viewer's active org", async () => {
    primeSession({ orgRole: "org_admin" });
    queuedRows = [[TEAM_ROW], []];
    await renameTeamNameAction(form({ teamId: "team-1", name: "N" }));
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-of-team", "caller-1");
  });

  it("platform admin passes with NO org-role lookup", async () => {
    primeSession({ platformAdmin: true });
    queuedRows = [[TEAM_ROW], []];
    const r = await renameTeamNameAction(form({ teamId: "team-1", name: "N" }));
    expect(r.ok).toBe(true);
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("a TEAM ADMIN passes via the lazy role read when the role column is provisioned", async () => {
    primeSession({ orgRole: "member" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    queuedRows = [[TEAM_ROW], [{ role: "admin" }], []];
    const r = await renameTeamNameAction(form({ teamId: "team-1", name: "N" }));
    expect(r.ok).toBe(true);
    const roleRead = executed[1]!.sql;
    expect(sqlText(roleRead)).toContain('SELECT role FROM public."teamMember"');
  });

  it("a plain team member is forbidden with NO UPDATE", async () => {
    primeSession({ orgRole: "member" });
    teamMemberRoleColumnExists.mockImplementation(async () => true);
    queuedRows = [[TEAM_ROW], [{ role: "member" }]];
    const r = await renameTeamNameAction(form({ teamId: "team-1", name: "N" }));
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(executed.map((c) => sqlText(c.sql)).some((t) => t.includes("UPDATE"))).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("with the role column NOT provisioned, a plain org member is forbidden WITHOUT a role read", async () => {
    primeSession({ orgRole: "member" });
    queuedRows = [[TEAM_ROW]];
    const r = await renameTeamNameAction(form({ teamId: "team-1", name: "N" }));
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(executed).toHaveLength(1); // team lookup only
  });

  it("rejects an empty and an over-long name before any lookup", async () => {
    primeSession({ orgRole: "org_admin" });
    expect(await renameTeamNameAction(form({ teamId: "team-1", name: "   " }))).toEqual({
      ok: false,
      error: "invalid-name",
    });
    expect(
      await renameTeamNameAction(form({ teamId: "team-1", name: "x".repeat(201) })),
    ).toEqual({ ok: false, error: "invalid-name" });
    expect(executed).toHaveLength(0);
  });

  it("returns not-found for a missing team", async () => {
    primeSession({ orgRole: "org_admin" });
    queuedRows = [[]];
    const r = await renameTeamNameAction(form({ teamId: "team-missing", name: "N" }));
    expect(r).toEqual({ ok: false, error: "not-found" });
  });
});
