import { describe, expect, it } from "vitest";

import type { DashboardActor } from "../permissions";
import { resolveDashboardAccess } from "../permissions";
import type { DashboardRow } from "../store/schema";

// Helper: build a minimal DashboardRow stub for the resolver. Only the
// fields the resolver reads need real values; the rest can be empty
// strings / nulls because the resolver doesn't touch them.
function row(overrides: Partial<DashboardRow>): DashboardRow {
  return {
    id: "d1",
    name: "test",
    description: null,
    configJson: {},
    configVersion: "1.0.0",
    dashboardVersion: 1,
    publishedRevisionNumber: null,
    ownerLevel: "user",
    ownerId: "u1",
    organizationId: "org-a",
    visibility: "private",
    status: "draft",
    createdBy: "u1",
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    archivedAt: null,
    ...overrides,
  } as DashboardRow;
}

function actor(overrides: Partial<DashboardActor> = {}): DashboardActor {
  return {
    userId: "u1",
    organizationId: "org-a",
    teamIds: [],
    orgRole: "member",
    teamRoles: {},
    ...overrides,
  };
}

describe("resolveDashboardAccess", () => {
  // ─── Cross-org gate ───
  it("denies cross-org reads and writes regardless of other factors", () => {
    const r = row({ organizationId: "org-b", ownerLevel: "organization", visibility: "members" });
    const a = actor({ organizationId: "org-a" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });

  // ─── owner_level=user ───
  it("user-owned: self gets read+write, visibility ignored", () => {
    const r = row({ ownerLevel: "user", ownerId: "u1", visibility: "private" });
    expect(resolveDashboardAccess(r, actor({ userId: "u1" }))).toEqual({
      canRead: true,
      canWrite: true,
    });
  });
  it("user-owned: other user gets nothing", () => {
    const r = row({ ownerLevel: "user", ownerId: "u1" });
    expect(resolveDashboardAccess(r, actor({ userId: "u2" }))).toEqual({
      canRead: false,
      canWrite: false,
    });
  });

  // ─── owner_level=team ───
  it("team-owned private: team admin gets read+write", () => {
    const r = row({ ownerLevel: "team", ownerId: "team-1", visibility: "private" });
    const a = actor({ teamIds: ["team-1"], teamRoles: { "team-1": "admin" } });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: true });
  });
  it("team-owned private: team member (non-admin) gets nothing", () => {
    const r = row({ ownerLevel: "team", ownerId: "team-1", visibility: "private" });
    const a = actor({ teamIds: ["team-1"], teamRoles: { "team-1": "member" } });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });
  it("team-owned members: team member gets read-only", () => {
    const r = row({ ownerLevel: "team", ownerId: "team-1", visibility: "members" });
    const a = actor({ teamIds: ["team-1"], teamRoles: { "team-1": "member" } });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: false });
  });
  it("team-owned owners: non-admin member gets nothing", () => {
    const r = row({ ownerLevel: "team", ownerId: "team-1", visibility: "owners" });
    const a = actor({ teamIds: ["team-1"], teamRoles: { "team-1": "member" } });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });

  // ─── owner_level=organization ───
  it("org-owned private: org admin gets read+write", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a", visibility: "private" });
    const a = actor({ orgRole: "admin" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: true });
  });
  it("org-owned private: regular member gets nothing", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a", visibility: "private" });
    const a = actor({ orgRole: "member" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });
  it("org-owned members: regular member gets read-only", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a", visibility: "members" });
    const a = actor({ orgRole: "member" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: false });
  });
  it("org-owned owners: regular member gets nothing", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a", visibility: "owners" });
    const a = actor({ orgRole: "member" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });
  it("org-owned: org owner role also gets owner access (alongside admin)", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a", visibility: "private" });
    const a = actor({ orgRole: "owner" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: true });
  });

  // ─── owner_level=workspace ───
  it("workspace-owned members: workspace member gets read-only", () => {
    const r = row({ ownerLevel: "workspace", ownerId: "org-a", visibility: "members" });
    const a = actor({ orgRole: "member" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: false });
  });
  it("workspace-owned private: workspace admin gets read+write", () => {
    const r = row({ ownerLevel: "workspace", ownerId: "org-a", visibility: "private" });
    const a = actor({ orgRole: "admin" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: true });
  });

  // ─── Unknown visibility (fail closed) ───
  it("unknown visibility values fail closed", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a", visibility: "public" as never });
    const a = actor({ orgRole: "admin" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });
});
