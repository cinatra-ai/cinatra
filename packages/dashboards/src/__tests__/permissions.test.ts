import { describe, expect, it } from "vitest";

import type { DashboardActor } from "../permissions";
import { resolveDashboardAccess } from "../permissions";
import type { DashboardRow } from "../store/schema";

// Helper: build a minimal DashboardRow stub for the resolver. Only the
// fields the resolver reads need real values; the rest can be empty
// strings / nulls because the resolver doesn't touch them.
//
// Phase-2 (cinatra#1898): the resolver no longer reads `visibility` — it is a
// demoted, write-only column pending the Phase-3 drop. The stub still carries a
// value (the column exists) but NO test below depends on it: access is scope-only.
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
    projectId: null,
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

describe("resolveDashboardAccess — Phase-2 scope-only ACL (cinatra#1898)", () => {
  // ─── Cross-org gate (unchanged) ───
  it("denies cross-org reads and writes regardless of other factors", () => {
    const r = row({ organizationId: "org-b", ownerLevel: "organization" });
    const a = actor({ organizationId: "org-a" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });

  // ─── owner_level=user ───
  it("user-owned: self gets read+write", () => {
    const r = row({ ownerLevel: "user", ownerId: "u1" });
    expect(resolveDashboardAccess(r, actor({ userId: "u1" }))).toEqual({
      canRead: true,
      canWrite: true,
    });
  });
  it("user-owned: other user gets nothing (no 'member of a user')", () => {
    const r = row({ ownerLevel: "user", ownerId: "u1" });
    expect(resolveDashboardAccess(r, actor({ userId: "u2" }))).toEqual({
      canRead: false,
      canWrite: false,
    });
  });

  // ─── owner_level=team ───
  it("team-owned: team admin gets read+write", () => {
    const r = row({ ownerLevel: "team", ownerId: "team-1" });
    const a = actor({ teamIds: ["team-1"], teamRoles: { "team-1": "admin" } });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: true });
  });
  it("WIDENED: team member (non-admin) now gets READ (was owner-only under private/owners)", () => {
    // Pre-flip: a 'private'/'owners' team dashboard was admin-only (canRead:false
    // for a non-admin member). Phase-2: everyone in the team scope may read.
    const r = row({ ownerLevel: "team", ownerId: "team-1", visibility: "private" });
    const a = actor({ teamIds: ["team-1"], teamRoles: { "team-1": "member" } });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: false });
  });
  it("team-owned: a non-member gets nothing", () => {
    const r = row({ ownerLevel: "team", ownerId: "team-1" });
    const a = actor({ teamIds: ["team-2"], teamRoles: { "team-2": "admin" } });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: false, canWrite: false });
  });

  // ─── owner_level=organization ───
  it("org-owned: org admin gets read+write", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a" });
    const a = actor({ orgRole: "admin" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: true });
  });
  it("org-owned: org owner role also gets owner access", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a" });
    const a = actor({ orgRole: "owner" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: true });
  });
  it("WIDENED: org member now gets READ (was owner-only under private/owners)", () => {
    const r = row({ ownerLevel: "organization", ownerId: "org-a", visibility: "owners" });
    const a = actor({ orgRole: "member" });
    expect(resolveDashboardAccess(r, a)).toEqual({ canRead: true, canWrite: false });
  });

  // ─── owner_level=workspace ───
  it("WIDENED: workspace member gets READ; workspace admin gets read+write", () => {
    const r = row({ ownerLevel: "workspace", ownerId: "org-a", visibility: "private" });
    expect(resolveDashboardAccess(r, actor({ orgRole: "member" }))).toEqual({
      canRead: true,
      canWrite: false,
    });
    expect(resolveDashboardAccess(r, actor({ orgRole: "admin" }))).toEqual({
      canRead: true,
      canWrite: true,
    });
  });

  // ─── project-refined rows ───
  it("project-refined: any in-org actor passes the owner tier (canRead true; grant narrows upstream)", () => {
    // The object tuple is org-owned+private+project-refined, so canRead is true
    // at the owner tier — the project GRANT applied by requireDashboardAccess /
    // filterReadableDashboards is the effective read gate. WRITE stays owner-axis.
    const r = row({
      ownerLevel: "team",
      ownerId: "team-1",
      projectId: "proj-9",
    });
    const nonOwner = actor({ userId: "u2", orgRole: "member" });
    expect(resolveDashboardAccess(r, nonOwner)).toEqual({ canRead: true, canWrite: false });
    const teamAdmin = actor({ teamIds: ["team-1"], teamRoles: { "team-1": "admin" } });
    expect(resolveDashboardAccess(r, teamAdmin)).toEqual({ canRead: true, canWrite: true });
  });
  it("project-refined: cross-org actor is still denied outright", () => {
    const r = row({ organizationId: "org-b", ownerLevel: "team", ownerId: "team-1", projectId: "proj-9" });
    expect(resolveDashboardAccess(r, actor({ organizationId: "org-a" }))).toEqual({
      canRead: false,
      canWrite: false,
    });
  });
});
