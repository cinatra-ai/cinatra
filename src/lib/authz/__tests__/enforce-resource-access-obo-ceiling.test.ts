/**
 * Agent-run OBO scope-ceiling gate inside `enforceResourceAccess` (W2/#1051).
 *
 * The load-bearing property: the ceiling is checked BEFORE every ownership
 * short-circuit (user-owner / co-owner / team-admin) AND before the kernel
 * `can()` / platform-admin path, so a delegated agent cannot reach a resource
 * outside its anchored scope even when the invoking user could. Runs are
 * EXCLUDED here (the authoritative run ceiling lives in `enforceRunAccess`).
 */
import { describe, it, expect } from "vitest";

import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import type { Permission } from "@/lib/authz/permissions";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

const ORG = "org-A";
const U = "user-U";
const TEAM = "team-T";
const PROJECT = "proj-P";

function actor(
  oboCeiling: OboCeilingChain | undefined,
  extra: Record<string, unknown> = {},
): PrimitiveActorContext {
  return {
    userId: U,
    orgId: ORG,
    actorType: "model",
    source: "agent",
    ...(oboCeiling ? { oboCeiling } : {}),
    ...extra,
  } as unknown as PrimitiveActorContext;
}

// User U owns this object — the owner short-circuit WOULD allow U.
const userObjectOwnedByU: ResourceForAccessCheck = {
  resourceType: "object",
  resourceId: "o-user",
  organizationId: ORG,
  ownerLevel: "user",
  ownerId: U,
  visibility: "private",
};

const teamObject: ResourceForAccessCheck = {
  resourceType: "object",
  resourceId: "o-team",
  organizationId: ORG,
  ownerLevel: "team",
  ownerId: TEAM,
  visibility: "team",
};

// User U's object, additionally tagged for project P.
const userObjectInProjectP: ResourceForAccessCheck = {
  resourceType: "object",
  resourceId: "o-proj",
  organizationId: ORG,
  ownerLevel: "user",
  ownerId: U,
  visibility: "private",
  projectId: PROJECT,
};

const userChain: OboCeilingChain = [
  { tier: "user", id: U },
  { tier: "organization", id: ORG },
];
const teamChain: OboCeilingChain = [
  { tier: "team", id: TEAM },
  { tier: "organization", id: ORG },
];
const projectChain: OboCeilingChain = [
  { tier: "project", id: PROJECT },
  { tier: "organization", id: ORG },
];

describe("OBO ceiling in enforceResourceAccess (W2/#1051)", () => {
  it("denies BEFORE the owner short-circuit: a team-anchored agent invoked by the owner U cannot read U's own object", async () => {
    // Owner short-circuit (actor.userId === resource.ownerId) WOULD return; the
    // ceiling must fire first and deny (a user-owned object does not satisfy a
    // team-tier ceiling).
    await expect(
      enforceResourceAccess(userObjectOwnedByU, actor(teamChain), "object.read"),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("allows the anchored user's own object once the ceiling passes", async () => {
    await expect(
      enforceResourceAccess(userObjectOwnedByU, actor(userChain), "object.read"),
    ).resolves.toBeUndefined();
  });

  it("denies BEFORE the platform-admin bypass: an admin-invoked user-anchored agent cannot update a team object", async () => {
    await expect(
      enforceResourceAccess(
        teamObject,
        actor(userChain, { platformRole: "platform_admin", roles: ["platform_admin"] }),
        "object.update",
      ),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("project-anchored ceiling allows an object tagged for the anchored project", async () => {
    await expect(
      enforceResourceAccess(userObjectInProjectP, actor(projectChain), "object.read"),
    ).resolves.toBeUndefined();
  });

  it("project-anchored ceiling denies an object NOT in the anchored project (projectId undefined never matches)", async () => {
    await expect(
      enforceResourceAccess(userObjectOwnedByU, actor(projectChain), "object.read"),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("is inert when the actor carries no oboCeiling (human/session/machine)", async () => {
    await expect(
      enforceResourceAccess(userObjectOwnedByU, actor(undefined), "object.read"),
    ).resolves.toBeUndefined();
  });

  it("EXCLUDES resourceType 'run' — the delegated run-probe is not re-checked here", async () => {
    // A run row user-owned by U with a team-anchored ceiling that WOULD deny an
    // object. Because runs are excluded, the owner short-circuit is reached and
    // allows — proving the kernel gate does not double-check the run-probe.
    const runProbe: ResourceForAccessCheck = {
      resourceType: "run",
      resourceId: "r1",
      organizationId: ORG,
      ownerLevel: "user",
      ownerId: U,
      visibility: null,
    };
    await expect(
      enforceResourceAccess(runProbe, actor(teamChain), "run.read" as Permission),
    ).resolves.toBeUndefined();
  });

  it("read denials hide existence (404), mutation denials are 403", async () => {
    const readErr = await enforceResourceAccess(
      teamObject,
      actor(userChain),
      "object.read",
    ).catch((e) => e);
    expect(readErr).toBeInstanceOf(AuthzError);
    expect((readErr as AuthzError).statusCode).toBe(404);

    const writeErr = await enforceResourceAccess(
      teamObject,
      actor(userChain),
      "object.update",
    ).catch((e) => e);
    expect(writeErr).toBeInstanceOf(AuthzError);
    expect((writeErr as AuthzError).statusCode).toBe(403);
  });
});
