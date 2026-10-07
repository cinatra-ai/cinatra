// cinatra#1738 D2 — one canonical URL per dashboard. canonicalDashboardPath is
// THE derivation (routes, flat-route redirect, and B4's listings all consume
// it); these tests pin the mapping including the NULL/unknown fallbacks.

import { describe, it, expect } from "vitest";
import { canonicalDashboardPath } from "../canonical-path";

describe("canonicalDashboardPath (#1738)", () => {
  it("nests a team-anchored row under its team", () => {
    expect(
      canonicalDashboardPath({ id: "d1", entityType: "team", entityId: "t1" }),
    ).toBe("/teams/t1/dashboards/d1");
  });

  it("nests an organization-anchored row under its org", () => {
    expect(
      canonicalDashboardPath({ id: "d1", entityType: "organization", entityId: "o1" }),
    ).toBe("/organizations/o1/dashboards/d1");
  });

  it("falls back to the flat route for NULL anchors (personal/workspace/legacy)", () => {
    expect(
      canonicalDashboardPath({ id: "d1", entityType: null, entityId: null }),
    ).toBe("/dashboards/d1");
  });

  it("falls back to flat for an unknown entityType and for a NULL entityId", () => {
    expect(
      canonicalDashboardPath({ id: "d1", entityType: "galaxy", entityId: "g1" }),
    ).toBe("/dashboards/d1");
    expect(
      canonicalDashboardPath({ id: "d1", entityType: "team", entityId: null }),
    ).toBe("/dashboards/d1");
  });

  it("nests a WORKSPACE dashboard under the workspace page (cinatra#2811)", () => {
    expect(
      canonicalDashboardPath({ id: "dash:workspace:__workspace__:user:u1:overview", entityType: "workspace", entityId: "__workspace__" }),
    ).toBe("/workspace/dashboards/dash%3Aworkspace%3A__workspace__%3Auser%3Au1%3Aoverview");
    // Only the exact workspace entity: any other id under the type stays flat.
    expect(
      canonicalDashboardPath({ id: "d1", entityType: "workspace", entityId: "org-1" }),
    ).toBe("/dashboards/d1");
  });

  it("URL-encodes both path pieces", () => {
    expect(
      canonicalDashboardPath({ id: "a b", entityType: "team", entityId: "t/x" }),
    ).toBe("/teams/t%2Fx/dashboards/a%20b");
  });
});
