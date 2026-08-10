import { describe, it, expect } from "vitest";

import {
  compareCatalogRows,
  destinationIsActorOwned,
  destinationRefForSurface,
  isAddableWithoutNameCollision,
  prospectiveCopyName,
  templateScopeAdmitsSurface,
  vantageForSurface,
} from "@/lib/dashboards/installed-catalog-eligibility";
import type { CatalogSurface } from "@/lib/dashboards/installed-catalog-contract";
import { OVERVIEW_DASHBOARD_NAME } from "@cinatra-ai/dashboards/entity-identity";
import { buildOrganizationDetailRef } from "../../../../packages/dashboards/src/screens/organization-detail-model";

// ---------------------------------------------------------------------------
// The PURE eligibility core for concept B's installed-catalog read
// (cinatra#2474 PR4). Every rule here is a narrowing; none may widen.
// ---------------------------------------------------------------------------

const USER = "u-1";
const ORG = "org-1";

const personal: CatalogSurface = { kind: "personal", orgId: ORG, userId: USER };
const team: CatalogSurface = {
  kind: "team",
  orgId: ORG,
  scopeId: "team-a",
  userId: USER,
};
const organization: CatalogSurface = {
  kind: "organization",
  orgId: ORG,
  scopeId: ORG,
  userId: USER,
};
const project: CatalogSurface = {
  kind: "project",
  orgId: ORG,
  scopeId: "proj-a",
  userId: USER,
};

const ALL: CatalogSurface[] = [personal, team, organization, project];

describe("vantageForSurface", () => {
  it("projects each surface onto its access vantage, carrying only its own axis", () => {
    expect(vantageForSurface(personal)).toEqual({ kind: "personal", orgId: ORG });
    expect(vantageForSurface(team)).toEqual({
      kind: "team",
      orgId: ORG,
      scopeId: "team-a",
    });
    expect(vantageForSurface(organization)).toEqual({
      kind: "organization",
      orgId: ORG,
      scopeId: ORG,
    });
    expect(vantageForSurface(project)).toEqual({
      kind: "project",
      orgId: ORG,
      scopeId: "proj-a",
    });
  });
});

describe("destinationRefForSurface — the copy's landing collection", () => {
  it("is ALWAYS the acting user's own per-user collection, on every surface", () => {
    // The invariant the whole eligibility model leans on — most sharply the
    // permissive personal vantage. No other reader ever receives a catalog copy.
    for (const surface of ALL) {
      const ref = destinationRefForSurface(surface, USER);
      expect(ref).not.toBeNull();
      expect(ref!.ownerLevel).toBe("user");
      expect(ref!.ownerId).toBe(USER);
    }
  });

  it("maps each surface onto the ref its landing actually binds", () => {
    expect(destinationRefForSurface(personal, USER)).toEqual({
      entityType: "personal",
      entityId: ORG,
      ownerLevel: "user",
      ownerId: USER,
    });
    expect(destinationRefForSurface(team, USER)).toEqual({
      entityType: "team",
      entityId: "team-a",
      ownerLevel: "user",
      ownerId: USER,
    });
    expect(destinationRefForSurface(project, USER)).toEqual({
      entityType: "project",
      entityId: "proj-a",
      ownerLevel: "user",
      ownerId: USER,
    });
  });

  it("the organization arm reproduces buildOrganizationDetailRef EXACTLY", () => {
    // Derived, never supplied — and pinned against the org landing's own builder
    // so the per-instance "organization" spelling (not the migratable
    // "organizations" index surface) cannot drift apart from it.
    expect(destinationRefForSurface(organization, USER)).toEqual(
      buildOrganizationDetailRef(ORG, USER),
    );
  });

  it("REFUSES a descriptor naming a user other than the actor", () => {
    // The round-1 defect: the descriptor's userId used to be trusted as "the
    // acting user", which made the invariant only as strong as the caller.
    for (const surface of ALL) {
      expect(destinationRefForSurface(surface, "someone-else")).toBeNull();
    }
  });

  it("REFUSES an empty actor id, and a surface with no org", () => {
    expect(destinationRefForSurface(team, "")).toBeNull();
    expect(
      destinationRefForSurface(
        { kind: "team", orgId: "", scopeId: "t", userId: USER },
        USER,
      ),
    ).toBeNull();
  });

  it("REFUSES a shared surface with no scope id", () => {
    for (const kind of ["team", "project", "organization"] as const) {
      expect(
        destinationRefForSurface(
          { kind, orgId: ORG, scopeId: "", userId: USER },
          USER,
        ),
      ).toBeNull();
    }
  });

  it("REFUSES an organization surface whose scope is not its own tenant", () => {
    // The org-scope invariant (scopeId === orgId), the same pin the scope-write
    // predicate's organization arm applies.
    expect(
      destinationRefForSurface(
        { kind: "organization", orgId: ORG, scopeId: "org-2", userId: USER },
        USER,
      ),
    ).toBeNull();
  });
});

describe("destinationIsActorOwned — the asserted invariant", () => {
  it("holds only for a user-owned ref belonging to the acting user", () => {
    expect(
      destinationIsActorOwned(
        { entityType: "team", entityId: "t", ownerLevel: "user", ownerId: USER },
        USER,
      ),
    ).toBe(true);
    expect(
      destinationIsActorOwned(
        { entityType: "team", entityId: "t", ownerLevel: "user", ownerId: "other" },
        USER,
      ),
    ).toBe(false);
    expect(
      destinationIsActorOwned(
        { entityType: "team", entityId: "t", ownerLevel: "team", ownerId: USER },
        USER,
      ),
    ).toBe(false);
    expect(
      destinationIsActorOwned(
        { entityType: "team", entityId: "t", ownerLevel: "user", ownerId: "" },
        "",
      ),
    ).toBe(false);
  });
});

describe("templateScopeAdmitsSurface", () => {
  it("offers a project-scope template NOWHERE — the extension owns that mechanism", () => {
    for (const surface of ALL) {
      expect(templateScopeAdmitsSurface("project", surface)).toBe(false);
    }
  });

  it("offers every other DECLARED scope level on every surface", () => {
    for (const surface of ALL) {
      for (const level of ["user", "team", "organization", "workspace"]) {
        expect(templateScopeAdmitsSurface(level, surface)).toBe(true);
      }
    }
  });

  it("is an ALLOWLIST — null, unknown and mis-cased values are DENIED", () => {
    // Fail-open here would defeat the rule on exactly the corrupted metadata it
    // exists to catch: a project template whose stamped scope stopped reading
    // "project" would be offered.
    for (const surface of ALL) {
      for (const bad of [null, "", "Project", "PROJECT", "nonsense", "user "]) {
        expect(templateScopeAdmitsSurface(bad, surface)).toBe(false);
      }
    }
  });
});

describe("the NAME-COLLISION filter (not an 'already instantiated' check)", () => {
  it("withholds a template whose name is already taken in the destination", () => {
    expect(isAddableWithoutNameCollision("Revenue", new Set(["Revenue"]))).toBe(
      false,
    );
    expect(isAddableWithoutNameCollision("Revenue", new Set(["Other"]))).toBe(
      true,
    );
  });

  it("compares the WRITER'S prospective name — trimmed, exactly as a create persists", () => {
    expect(prospectiveCopyName("  Revenue  ")).toBe("Revenue");
    // A collision is detected through the trim, because that is what would be
    // written and what the unique index is over.
    expect(
      isAddableWithoutNameCollision("  Revenue  ", new Set(["Revenue"])),
    ).toBe(false);
  });

  it("is case-SENSITIVE, matching the unique index over the raw column", () => {
    expect(isAddableWithoutNameCollision("revenue", new Set(["Revenue"]))).toBe(
      true,
    );
  });

  it("drops a template whose name could never be created at all", () => {
    // The reserved Overview default, and a blank name: an add that could never
    // land must not be offered as though it could.
    expect(
      isAddableWithoutNameCollision(OVERVIEW_DASHBOARD_NAME, new Set()),
    ).toBe(false);
    expect(isAddableWithoutNameCollision("   ", new Set())).toBe(false);
    expect(prospectiveCopyName(OVERVIEW_DASHBOARD_NAME)).toBeNull();
    expect(prospectiveCopyName("")).toBeNull();
  });
});

describe("compareCatalogRows — deterministic ordering", () => {
  it("orders by name, then package, then id so duplicates never shuffle", () => {
    const rows = [
      { name: "B", packageName: "@x/z", templateId: "t3" },
      { name: "A", packageName: "@x/b", templateId: "t2" },
      { name: "A", packageName: "@x/a", templateId: "t9" },
      { name: "A", packageName: "@x/a", templateId: "t1" },
    ];
    expect([...rows].sort(compareCatalogRows).map((r) => r.templateId)).toEqual([
      "t1",
      "t9",
      "t2",
      "t3",
    ]);
  });
});
