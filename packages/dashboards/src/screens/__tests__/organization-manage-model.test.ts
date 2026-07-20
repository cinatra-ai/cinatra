import { describe, expect, test } from "vitest";

import {
  buildOrganizationManageMembers,
  normalizePendingInvitation,
  type OrganizationMemberInput,
} from "../organization-detail-model";

describe("buildOrganizationManageMembers", () => {
  test("keys by member.id, normalizes role, and sorts owner→admin→member then name", () => {
    const rows: OrganizationMemberInput[] = [
      { id: "m_b", userId: "u_b", name: "Bob", email: null, role: "member" },
      { id: "m_a", userId: "u_a", name: "Alice", email: null, role: "owner" },
      { id: "m_c", userId: "u_c", name: "Cara", email: null, role: "admin" },
      { id: "m_d", userId: "u_d", name: "Amy", email: null, role: "member" },
    ];
    const result = buildOrganizationManageMembers(rows);
    expect(result.map((r) => [r.memberId, r.role])).toEqual([
      ["m_a", "owner"],
      ["m_c", "admin"],
      ["m_d", "member"], // Amy before Bob (name order within role)
      ["m_b", "member"],
    ]);
  });

  test("DROPS rows without a member id (no dead controls) and falls back name→email→userId", () => {
    const rows: OrganizationMemberInput[] = [
      { id: null, userId: "u_x", name: "Ghost", email: null, role: "admin" },
      { id: "  ", userId: "u_y", name: "Blank", email: null, role: "admin" },
      { id: "m_ok", userId: "u_z", name: null, email: "z@example.com", role: null },
    ];
    const result = buildOrganizationManageMembers(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      memberId: "m_ok",
      userId: "u_z",
      displayName: "z@example.com",
      role: "member", // bare/blank membership normalizes to member
    });
  });
});

describe("normalizePendingInvitation", () => {
  test("normalizes role and trims email", () => {
    expect(
      normalizePendingInvitation({ id: "inv_1", email: "  new@example.com ", role: "admin" }),
    ).toEqual({ id: "inv_1", email: "new@example.com", role: "admin" });
  });

  test("falls back to the id when email is missing; unknown role → member", () => {
    expect(normalizePendingInvitation({ id: "inv_2", email: null, role: null })).toEqual({
      id: "inv_2",
      email: "inv_2",
      role: "member",
    });
  });
});
