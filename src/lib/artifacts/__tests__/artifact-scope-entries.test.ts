/**
 * Behaviour tests for the /artifacts scope-filter mapping (cinatra#2449):
 * `artifactScopeEntries` lifts a library row's ownership projection
 * (ownerLevel + ownerId / organizationId / projectId) into the shared
 * `NormalizedResourceScope` vocabulary, and the end-to-end predicate
 * (`scopeSelectionMatchesAny` over the entry list) filters exactly like the
 * /connectors and /skills surfaces — including the cinatra#953 W3 fail-closed
 * doctrine for id-less rows under id-carrying selections.
 */
import { describe, expect, it } from "vitest";

import {
  artifactScopeEntries,
  type ArtifactScopeProjection,
} from "@/lib/artifacts/artifact-scope-entries";
import { scopeSelectionMatchesAny } from "@/lib/scope-filter";

function row(overrides: Partial<ArtifactScopeProjection>): ArtifactScopeProjection {
  return {
    ownerLevel: "organization",
    ownerId: null,
    organizationId: null,
    projectId: null,
    ...overrides,
  };
}

function matches(tokens: string[], projection: ArtifactScopeProjection): boolean {
  return artifactScopeEntries(projection).some((entry) =>
    scopeSelectionMatchesAny(tokens, entry),
  );
}

describe("artifactScopeEntries — locus mapping", () => {
  it("maps a user-owned row to the personal locus", () => {
    expect(artifactScopeEntries(row({ ownerLevel: "user", ownerId: "u1" }))).toEqual([
      { locus: "personal" },
    ]);
  });

  it("maps a team-owned row to its team id (ownerId IS the team id)", () => {
    expect(artifactScopeEntries(row({ ownerLevel: "team", ownerId: "team_9" }))).toEqual([
      { locus: "team", locusId: "team_9" },
    ]);
  });

  it("maps an org-owned row to its organization id", () => {
    expect(
      artifactScopeEntries(row({ ownerLevel: "organization", organizationId: "org_1" })),
    ).toEqual([{ locus: "organization", locusId: "org_1" }]);
  });

  it("maps a workspace-owned row to the bare workspace locus, never adminOnly", () => {
    const entries = artifactScopeEntries(row({ ownerLevel: "workspace" }));
    expect(entries).toEqual([{ locus: "workspace" }]);
    expect(entries.some((e) => e.adminOnly)).toBe(false);
  });

  it("adds a SECOND project entry for a project-bound row", () => {
    expect(
      artifactScopeEntries(
        row({ ownerLevel: "organization", organizationId: "org_1", projectId: "proj_7" }),
      ),
    ).toEqual([
      { locus: "organization", locusId: "org_1" },
      { locus: "project", locusId: "proj_7" },
    ]);
  });
});

describe("end-to-end predicate (the connectors/skills OR-filter lift)", () => {
  it("workspace (default) matches every row", () => {
    for (const projection of [
      row({ ownerLevel: "user", ownerId: "u1" }),
      row({ ownerLevel: "team", ownerId: "t1" }),
      row({ ownerLevel: "workspace" }),
    ]) {
      expect(matches(["workspace"], projection)).toBe(true);
    }
  });

  it("personal matches only user-owned rows", () => {
    expect(matches(["personal"], row({ ownerLevel: "user", ownerId: "u1" }))).toBe(true);
    expect(matches(["personal"], row({ ownerLevel: "team", ownerId: "t1" }))).toBe(false);
  });

  it("team:<id> matches that team's rows and nothing else", () => {
    expect(matches(["team:t1"], row({ ownerLevel: "team", ownerId: "t1" }))).toBe(true);
    expect(matches(["team:t1"], row({ ownerLevel: "team", ownerId: "t2" }))).toBe(false);
  });

  it("fail-closed (cinatra#953 W3): an id-less locus row matches NOTHING under an id-carrying selection", () => {
    expect(matches(["team:t1"], row({ ownerLevel: "team", ownerId: null }))).toBe(false);
    expect(
      matches(["org:o1"], row({ ownerLevel: "organization", organizationId: null, ownerId: null })),
    ).toBe(false);
  });

  it("project:<id> matches a project-bound row regardless of its owner locus", () => {
    expect(
      matches(["project:p1"], row({ ownerLevel: "team", ownerId: "t1", projectId: "p1" })),
    ).toBe(true);
    expect(
      matches(["project:p1"], row({ ownerLevel: "team", ownerId: "t1", projectId: "p2" })),
    ).toBe(false);
  });

  it("multi-token selections OR across tokens (cinatra#1074 W5)", () => {
    const teamRow = row({ ownerLevel: "team", ownerId: "t1" });
    expect(matches(["personal", "team:t1"], teamRow)).toBe(true);
    expect(matches(["personal", "team:t2"], teamRow)).toBe(false);
  });

  it("admin matches nothing — artifacts carry no admin-only tier", () => {
    for (const projection of [
      row({ ownerLevel: "user", ownerId: "u1" }),
      row({ ownerLevel: "workspace" }),
    ]) {
      expect(matches(["admin"], projection)).toBe(false);
    }
  });
});
