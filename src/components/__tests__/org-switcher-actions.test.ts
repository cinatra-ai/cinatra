/**
 * listMemberOrganizations — the parameterless server action backing the
 * sidebar org-switcher's lazy list tier (cinatra#1502).
 *
 * Proves the security contract: the user id is derived exclusively from the
 * server session (the action takes NO parameters, so nothing client-supplied
 * can ever reach the query), and a stale session `activeOrganizationId` that
 * is no longer in the membership-filtered list is reported as null rather
 * than echoed back.
 *
 *   pnpm exec vitest run src/components/__tests__/org-switcher-actions.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAuthSession, listOrganizationsForUser } = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  listOrganizationsForUser: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({ getAuthSession }));
vi.mock("@/lib/better-auth-db", () => ({ listOrganizationsForUser }));

import { listMemberOrganizations } from "@/components/org-switcher-actions";

const ORGS = [
  { id: "org-a", name: "Alpha Works" },
  { id: "org-b", name: "Beta Labs" },
];

beforeEach(() => {
  vi.clearAllMocks();
  listOrganizationsForUser.mockResolvedValue(ORGS);
});

describe("listMemberOrganizations", () => {
  it("declares ZERO parameters — nothing client-supplied is ever accepted", () => {
    expect(listMemberOrganizations.length).toBe(0);
  });

  it("derives the user id from the server session", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-a" },
    });
    const result = await listMemberOrganizations();
    expect(listOrganizationsForUser).toHaveBeenCalledTimes(1);
    expect(listOrganizationsForUser).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({ organizations: ORGS, activeOrganizationId: "org-a" });
  });

  it("returns the empty shape without querying when there is no session", async () => {
    getAuthSession.mockResolvedValue(null);
    const result = await listMemberOrganizations();
    expect(result).toEqual({ organizations: [], activeOrganizationId: null });
    expect(listOrganizationsForUser).not.toHaveBeenCalled();
  });

  it("nulls a stale active org that is not in the membership-filtered list", async () => {
    getAuthSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-gone" },
    });
    const result = await listMemberOrganizations();
    expect(result.activeOrganizationId).toBeNull();
    expect(result.organizations).toEqual(ORGS);
  });

  it("reports a null active org when the session carries none", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    const result = await listMemberOrganizations();
    expect(result.activeOrganizationId).toBeNull();
  });
});
