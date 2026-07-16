import { describe, expect, test } from "vitest";

import {
  buildOrganizationAccessModel,
  buildOrganizationDetailRef,
  memberDisplayName,
  normalizeOrganizationRole,
  type OrganizationMemberInput,
  type OrganizationTeamInput,
} from "../organization-detail-model";

describe("buildOrganizationDetailRef", () => {
  test("is a per-instance, per-user organization ref", () => {
    expect(buildOrganizationDetailRef("org_1", "user_9")).toEqual({
      entityType: "organization",
      entityId: "org_1",
      ownerLevel: "user",
      ownerId: "user_9",
    });
  });
});

describe("normalizeOrganizationRole", () => {
  test("collapses to the highest-privilege role and defaults bare membership to member", () => {
    expect(normalizeOrganizationRole("owner")).toBe("owner");
    expect(normalizeOrganizationRole("admin")).toBe("admin");
    expect(normalizeOrganizationRole("member")).toBe("member");
    expect(normalizeOrganizationRole("member,admin")).toBe("admin");
    expect(normalizeOrganizationRole("admin,owner")).toBe("owner");
    expect(normalizeOrganizationRole("")).toBe("member");
    expect(normalizeOrganizationRole(null)).toBe("member");
    expect(normalizeOrganizationRole(undefined)).toBe("member");
    // Unknown role tokens degrade to plain membership, never leak through.
    expect(normalizeOrganizationRole("wizard")).toBe("member");
  });
});

describe("memberDisplayName", () => {
  test("prefers name, then email, then the raw id", () => {
    expect(
      memberDisplayName({ userId: "u1", name: "Ada Lovelace", email: "ada@x.io", role: null }),
    ).toBe("Ada Lovelace");
    expect(
      memberDisplayName({ userId: "u2", name: "  ", email: "grace@x.io", role: null }),
    ).toBe("grace@x.io");
    expect(memberDisplayName({ userId: "u3", name: null, email: null, role: null })).toBe("u3");
  });
});

describe("buildOrganizationAccessModel", () => {
  const members: OrganizationMemberInput[] = [
    { userId: "u_mem", name: "Zed Member", email: null, role: "member" },
    { userId: "u_own", name: "Ann Owner", email: null, role: "owner" },
    { userId: "u_adm2", name: "Bea Admin", email: null, role: "admin" },
    { userId: "u_adm1", name: "Al Admin", email: null, role: "admin" },
    { userId: "u_bare", name: "Cy Bare", email: null, role: null },
  ];
  const teams: OrganizationTeamInput[] = [
    { id: "t1", name: "Platform" },
    { id: "t2", name: "Research" },
  ];

  test("orders by role privilege (owner→admin→member) then display name", () => {
    const model = buildOrganizationAccessModel(members, teams);
    expect(model.members.map((m) => m.displayName)).toEqual([
      "Ann Owner", // owner
      "Al Admin", // admin (alpha within role)
      "Bea Admin", // admin
      "Cy Bare", // member (null role normalized)
      "Zed Member", // member
    ]);
    expect(model.members.map((m) => m.role)).toEqual([
      "owner",
      "admin",
      "admin",
      "member",
      "member",
    ]);
  });

  test("counts are the totals and match what the Overview count portlet renders", () => {
    const model = buildOrganizationAccessModel(members, teams);
    expect(model.memberCount).toBe(5);
    expect(model.teamCount).toBe(2);
  });

  test("passes teams through untouched and handles the empty org", () => {
    const model = buildOrganizationAccessModel([], []);
    expect(model.members).toEqual([]);
    expect(model.teams).toEqual([]);
    expect(model.memberCount).toBe(0);
    expect(model.teamCount).toBe(0);
  });
});
