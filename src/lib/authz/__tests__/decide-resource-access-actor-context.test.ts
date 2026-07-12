/**
 * cinatra#1428 — sync decision core + ActorContext adapter.
 *
 * `decideResourceAccessForActorContext` is the canonical `object.*` row gate
 * the ARTIFACT surface applies synchronously; `enforceResourceAccess` is the
 * async wrapper the OBJECTS surface applies. Both route through ONE core
 * (`decideResourceAccess`), so this suite locks:
 *   1. the adapter's short-circuit semantics (owner via principalId,
 *      team-admin via teamRoles, OBO ceiling before everything);
 *   2. denial parity with the async wrapper for equivalent actors — the
 *      drift-lock behind the cross-surface invariant ("no row returned by
 *      one surface is denied by the other").
 */
import { describe, it, expect } from "vitest";

import {
  decideResourceAccessForActorContext,
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { Permission } from "@/lib/authz/permissions";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

const ORG = "org-A";
const OTHER_ORG = "org-B";
const TEAM = "team-T";

function resource(
  over: Partial<ResourceForAccessCheck> = {},
): ResourceForAccessCheck {
  return {
    resourceType: "object",
    resourceId: "obj-1",
    organizationId: ORG,
    ownerLevel: "organization",
    ownerId: ORG,
    visibility: "organization",
    projectId: null,
    ...over,
  };
}

function humanActor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u1",
    organizationId: ORG,
    orgRole: "member",
    platformRole: "member",
    authSource: "ui",
    policyVersion: "test",
    ...over,
  } as ActorContext;
}

describe("decideResourceAccessForActorContext (sync canonical object gate)", () => {
  it("allows an org member to read an org-owned row (member holds object.read)", () => {
    expect(
      decideResourceAccessForActorContext(resource(), humanActor(), "object.read"),
    ).toBeNull();
  });

  it("denies a member object.delete on an org-owned row (admin-tier grant), allows org_admin", () => {
    const denial = decideResourceAccessForActorContext(
      resource(),
      humanActor(),
      "object.delete",
    );
    expect(denial).not.toBeNull();
    expect(denial!.statusCode).toBe(403);
    expect(
      decideResourceAccessForActorContext(
        resource(),
        humanActor({ orgRole: "org_admin" }),
        "object.delete",
      ),
    ).toBeNull();
  });

  it("owner short-circuit: user-owned rows allow the owner every op, deny another member's delete", () => {
    const userOwned = resource({ ownerLevel: "user", ownerId: "u1" });
    expect(
      decideResourceAccessForActorContext(userOwned, humanActor(), "object.delete"),
    ).toBeNull();
    const other = humanActor({ principalId: "u2" } as Partial<ActorContext>);
    expect(
      decideResourceAccessForActorContext(userOwned, other, "object.delete"),
    ).not.toBeNull();
  });

  it("team-admin short-circuit: team admins of the owning team pass object.delete", () => {
    const teamOwned = resource({ ownerLevel: "team", ownerId: TEAM });
    const teamAdmin = humanActor({ teamRoles: { [TEAM]: "team_admin" } });
    expect(
      decideResourceAccessForActorContext(teamOwned, teamAdmin, "object.delete"),
    ).toBeNull();
    // Plain member of the org (not the team's admin) lacks the delete grant.
    expect(
      decideResourceAccessForActorContext(teamOwned, humanActor(), "object.delete"),
    ).not.toBeNull();
  });

  it("cross-org guard: same-role actor from another org is denied (read hides as 404)", () => {
    const denial = decideResourceAccessForActorContext(
      resource(),
      humanActor({ organizationId: OTHER_ORG }),
      "object.read",
    );
    expect(denial).not.toBeNull();
    expect(denial!.statusCode).toBe(404);
  });

  it("OBO ceiling is a HARD upper bound: fires before the owner short-circuit", () => {
    const userOwned = resource({ ownerLevel: "user", ownerId: "u1" });
    const confined = humanActor({
      oboCeiling: [{ tier: "team", id: "team-elsewhere" }],
    } as Partial<ActorContext>);
    const denial = decideResourceAccessForActorContext(
      userOwned,
      confined,
      "object.read",
    );
    expect(denial).not.toBeNull();
    expect(denial!.statusCode).toBe(404);
  });

  it("null resource hides as 404; null actor denies as 403", () => {
    expect(
      decideResourceAccessForActorContext(null, humanActor(), "object.read")!
        .statusCode,
    ).toBe(404);
    expect(
      decideResourceAccessForActorContext(resource(), null, "object.read")!
        .statusCode,
    ).toBe(403);
  });
});

describe("cross-surface parity drift-lock (sync core vs async wrapper)", () => {
  // Equivalent actors: the primitive shape the objects surface passes to
  // enforceResourceAccess, and the built ActorContext shape the artifact
  // surface passes to the adapter.
  const cases: Array<{
    name: string;
    primitive: PrimitiveActorContext;
    context: ActorContext;
  }> = [
    {
      name: "org member",
      primitive: {
        actorType: "human",
        source: "ui",
        userId: "u1",
        orgRole: "member",
        organizationId: ORG,
      } as unknown as PrimitiveActorContext,
      context: humanActor(),
    },
    {
      name: "org admin",
      primitive: {
        actorType: "human",
        source: "ui",
        userId: "u3",
        orgRole: "org_admin",
        organizationId: ORG,
      } as unknown as PrimitiveActorContext,
      context: humanActor({ principalId: "u3", orgRole: "org_admin" } as Partial<ActorContext>),
    },
    {
      name: "team admin",
      primitive: {
        actorType: "human",
        source: "ui",
        userId: "u4",
        orgRole: "member",
        organizationId: ORG,
        teamRoles: { [TEAM]: "team_admin" },
      } as unknown as PrimitiveActorContext,
      context: humanActor({
        principalId: "u4",
        teamRoles: { [TEAM]: "team_admin" },
      } as Partial<ActorContext>),
    },
    {
      name: "cross-org member",
      primitive: {
        actorType: "human",
        source: "ui",
        userId: "u5",
        orgRole: "member",
        organizationId: OTHER_ORG,
      } as unknown as PrimitiveActorContext,
      context: humanActor({ principalId: "u5", organizationId: OTHER_ORG } as Partial<ActorContext>),
    },
  ];

  const resources: Array<{ name: string; res: ResourceForAccessCheck }> = [
    { name: "org-owned", res: resource() },
    { name: "user-owned (u1)", res: resource({ ownerLevel: "user", ownerId: "u1" }) },
    { name: "team-owned", res: resource({ ownerLevel: "team", ownerId: TEAM }) },
  ];

  const ops: Permission[] = ["object.read", "object.update", "object.delete"];

  for (const { name: actorName, primitive, context } of cases) {
    for (const { name: resName, res } of resources) {
      for (const op of ops) {
        it(`${actorName} × ${resName} × ${op}: wrapper and sync core agree`, async () => {
          let wrapperDenied: number | null = null;
          try {
            await enforceResourceAccess(res, primitive, op);
          } catch (e) {
            wrapperDenied = (e as { statusCode: number }).statusCode;
          }
          const coreDenial = decideResourceAccessForActorContext(res, context, op);
          expect(coreDenial === null ? null : coreDenial.statusCode).toBe(
            wrapperDenied,
          );
        });
      }
    }
  }
});
