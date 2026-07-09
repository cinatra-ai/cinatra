/**
 * Agent-run OBO scope-ceiling enforcement in `enforceRunAccess` and the
 * `agentTemplateWithinOboCeiling` helper (W2/#1051).
 *
 * Load-bearing property: the run ceiling is checked BEFORE the runBy owner /
 * co-owner short-circuits and the kernel `can()` / platform-admin path, using
 * the run's OWN persisted chain (`run.oboCeiling`) vs the accessing agent's
 * chain (`actor.oboCeiling`) — containment (`run ⊇ actor`). A synthetic probe
 * (no `oboCeiling` field) is skipped; a real run with a corrupt (null) chain
 * fails closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import * as authz from "@/lib/authz";

import { enforceRunAccess, agentTemplateWithinOboCeiling } from "../auth-policy";

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

const ORG = "org-A";
const U = "user-U";
const TEAM = "team-T";
const PROJECT = "proj-P";

const userChain: OboCeilingChain = [
  { tier: "user", id: U },
  { tier: "organization", id: ORG },
];
const orgChain: OboCeilingChain = [{ tier: "organization", id: ORG }];
const teamChain: OboCeilingChain = [
  { tier: "team", id: TEAM },
  { tier: "organization", id: ORG },
];

// Owner-invoked actor: userId === run.runBy so the owner short-circuit WOULD
// allow — every deny below therefore proves the ceiling ran first.
const oboActor = (oboCeiling: OboCeilingChain | undefined): PrimitiveActorContext =>
  ({
    actorType: "model",
    userId: U,
    source: "agent",
    ...(oboCeiling ? { oboCeiling } : {}),
  }) as PrimitiveActorContext;

describe("enforceRunAccess — OBO scope-ceiling (W2/#1051)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("denies BEFORE the runBy owner short-circuit when the agent chain is not contained in the run chain", async () => {
    // Owner-invoked (runBy === actor.userId) — owner short-circuit WOULD return.
    // Run is org-anchored; the agent is user-anchored, whose {user,U} element is
    // NOT in the run's chain → deny.
    const run = { id: "r1", runBy: U, orgId: ORG, oboCeiling: orgChain };
    await expect(
      enforceRunAccess(run, oboActor(userChain), "read"),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("allows the agent's own run (run chain contains the agent chain) — then the owner short-circuit fires", async () => {
    const run = { id: "r1", runBy: U, orgId: ORG, oboCeiling: userChain };
    await expect(
      enforceRunAccess(run, oboActor(userChain), "read"),
    ).resolves.toBeUndefined();
  });

  it("allows an org-anchored agent to read a user-anchored run (org floor contained)", async () => {
    const run = { id: "r1", runBy: U, orgId: ORG, oboCeiling: userChain };
    await expect(
      enforceRunAccess(run, oboActor(orgChain), "read"),
    ).resolves.toBeUndefined();
  });

  it("denies a team-anchored agent reading a user-anchored run", async () => {
    const run = { id: "r1", runBy: U, orgId: ORG, oboCeiling: userChain };
    await expect(
      enforceRunAccess(run, oboActor(teamChain), "read"),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("fails closed on a real run whose persisted chain is corrupt (null)", async () => {
    const run = { id: "r1", runBy: U, orgId: ORG, oboCeiling: null };
    await expect(
      enforceRunAccess(run, oboActor(userChain), "read"),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("SKIPS a synthetic probe (no oboCeiling field) — owner short-circuit allows", async () => {
    // A probe that never carried a persisted chain (undefined) must not be
    // denied: it gates a capability, not access to a real run row.
    const probe = { id: "r1", runBy: U, orgId: ORG };
    await expect(
      enforceRunAccess(probe, oboActor(userChain), "read"),
    ).resolves.toBeUndefined();
  });

  it("is inert for a non-OBO actor (no oboCeiling) even when the run carries a chain", async () => {
    const run = { id: "r1", runBy: U, orgId: ORG, oboCeiling: orgChain };
    // Non-owner, non-OBO actor; mock can() so the kernel path allows — proving
    // the OBO ceiling did not interfere.
    vi.spyOn(authz, "can").mockReturnValue(true);
    const humanActor: PrimitiveActorContext = {
      actorType: "human",
      userId: "someone-else",
      source: "ui",
    };
    await expect(
      enforceRunAccess(run, humanActor, "read"),
    ).resolves.toBeUndefined();
  });
});

describe("agentTemplateWithinOboCeiling (W2/#1051)", () => {
  it("returns true when no ceiling applies (non-OBO caller)", () => {
    expect(
      agentTemplateWithinOboCeiling(undefined, {
        orgId: ORG,
        ownerLevel: "team",
        ownerId: TEAM,
      }),
    ).toBe(true);
  });

  it("allows a user-anchored agent to read its own user-owned template", () => {
    expect(
      agentTemplateWithinOboCeiling(userChain, {
        orgId: ORG,
        ownerLevel: "user",
        ownerId: U,
      }),
    ).toBe(true);
  });

  it("denies a user-anchored agent a team-owned template", () => {
    expect(
      agentTemplateWithinOboCeiling(userChain, {
        orgId: ORG,
        ownerLevel: "team",
        ownerId: TEAM,
      }),
    ).toBe(false);
  });

  it("allows an org-anchored agent any same-org template (org floor)", () => {
    expect(
      agentTemplateWithinOboCeiling(orgChain, {
        orgId: ORG,
        ownerLevel: "team",
        ownerId: TEAM,
      }),
    ).toBe(true);
  });

  it("denies a cross-org template even for an org-anchored agent", () => {
    expect(
      agentTemplateWithinOboCeiling(orgChain, {
        orgId: "org-OTHER",
        ownerLevel: "organization",
        ownerId: "org-OTHER",
      }),
    ).toBe(false);
  });

  it("a project-anchored agent is confined away from (project-less) templates", () => {
    const projectChain: OboCeilingChain = [
      { tier: "project", id: PROJECT },
      { tier: "organization", id: ORG },
    ];
    expect(
      agentTemplateWithinOboCeiling(projectChain, {
        orgId: ORG,
        ownerLevel: "user",
        ownerId: U,
      }),
    ).toBe(false);
  });

  it("normalizes a null owner anchor to the organization tier (deny narrower agents)", () => {
    // null ownerLevel → organization tier: a user-anchored agent is denied…
    expect(
      agentTemplateWithinOboCeiling(userChain, {
        orgId: ORG,
        ownerLevel: null,
        ownerId: null,
      }),
    ).toBe(false);
    // …but an org-anchored agent still passes via the org floor.
    expect(
      agentTemplateWithinOboCeiling(orgChain, {
        orgId: ORG,
        ownerLevel: null,
        ownerId: null,
      }),
    ).toBe(true);
  });
});
