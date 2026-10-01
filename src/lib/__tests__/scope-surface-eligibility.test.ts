/**
 * THE PER-SCOPE ELIGIBILITY LOADER (cinatra#2808, per-scope surfaces S2).
 *
 * The acceptance names the fixture set exactly: "Per-scope list fixtures (five
 * scopes; multi-org workspace union; admin-only visibility both ways; hidden
 * bindings absent; exact-project installs present; viewed-org != active-org
 * correct)." Each is written below.
 *
 * The VANTAGE arm is the platform's REAL one (`policyFieldAdmitsScopeVantage`,
 * a pure module) so the fixtures measure the platform's own semantics rather
 * than a restatement of them; the ACTOR arm is a fixture modelling the one axis
 * these cases turn on — admin standing — because the real evaluator needs a
 * permissions store this tier's pure core deliberately has none of.
 */
import { describe, expect, it, vi } from "vitest";
import { policyFieldAdmitsScopeVantage } from "@cinatra-ai/extensions/access-scope-vantage";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";

import {
  installReachesScope,
  resolveScopeSurfaceEligibility,
  scopeSurfaceCandidateVantages,
  type ScopeSurfaceAnchor,
  type ScopeSurfaceInstall,
} from "@/lib/scope-surface-eligibility";
import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_A = "org-a";
const ORG_B = "org-b";
const TEAM = "team-1";
const PROJECT = "proj-1";

function policy(tokens: string[]): AgentAuthPolicy {
  return {
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  } as unknown as AgentAuthPolicy;
}

function install(over: Partial<ScopeSurfaceInstall> & { installId: string }): ScopeSurfaceInstall {
  return {
    packageName: `@acme/${over.installId}`,
    displayName: over.installId,
    description: null,
    organizationId: ORG_A,
    ownerLevel: "organization",
    ownerId: ORG_A,
    status: "active",
    version: "1.0.0",
    bindings: [],
    ...over,
  };
}

/** The arms: the real vantage arm, and an actor arm over admin standing. */
function arms(policies: Map<string, AgentAuthPolicy>, actorIsAdmin: boolean) {
  const policyFor = vi.fn((i: ScopeSurfaceInstall) => policies.get(i.installId) ?? policy(["workspace"]));
  return {
    policyFor,
    vantageAdmits: (p: AgentAuthPolicy, v: Parameters<typeof policyFieldAdmitsScopeVantage>[1]) =>
      policyFieldAdmitsScopeVantage(p.runDataVisibility, v),
    // The one axis these fixtures turn on: an `admin` selection admits an
    // administrator and nobody else; every other selection admits a member.
    actorAdmits: (p: AgentAuthPolicy) =>
      (p.runDataVisibility as unknown as string[]).includes("admin") ? actorIsAdmin : true,
  };
}

const workspaceAnchor = (orgIds: string[]): ScopeSurfaceAnchor => ({
  userId: "user-1",
  viewedOrgId: null,
  workspace: buildWorkspaceVantage({
    userId: "user-1",
    memberships: orgIds.map((orgId) => ({ orgId })),
  }),
});

const orgAnchor = (viewedOrgId: string | null): ScopeSurfaceAnchor => ({
  userId: "user-1",
  viewedOrgId,
  workspace: null,
});

async function run(
  scope: ScopeSurfaceRef,
  anchor: ScopeSurfaceAnchor,
  installs: ScopeSurfaceInstall[],
  policies = new Map<string, AgentAuthPolicy>(),
  actorIsAdmin = false,
) {
  return resolveScopeSurfaceEligibility({ scope, anchor, installs, arms: arms(policies, actorIsAdmin) });
}

describe("per-scope eligibility — the five scopes", () => {
  const orgRow = install({ installId: "org-row", organizationId: ORG_A, ownerId: ORG_A });
  const teamRow = install({
    installId: "team-row",
    organizationId: ORG_A,
    ownerLevel: "team",
    ownerId: TEAM,
  });
  const projectRow = install({
    installId: "project-row",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: null,
    bindings: [{ kind: "project", id: PROJECT }],
  });
  const otherOrgRow = install({ installId: "other-org", organizationId: ORG_B, ownerId: ORG_B });
  const all = [orgRow, teamRow, projectRow, otherOrgRow];

  it("PERSONAL: the actor's invocable set — this organization's rows plus the org-NULL rows", async () => {
    const rows = await run({ kind: "personal" }, orgAnchor(ORG_A), all);
    expect(rows.map((r) => r.packageName).sort()).toEqual([
      orgRow.packageName,
      projectRow.packageName,
      teamRow.packageName,
    ].sort());
  });

  it("ORGANIZATION: exact-org installs only — another organization's row never appears", async () => {
    const rows = await run({ kind: "organization", id: ORG_A }, orgAnchor(ORG_A), all);
    const names = rows.map((r) => r.packageName);
    expect(names).toContain(orgRow.packageName);
    expect(names).toContain(teamRow.packageName); // anchored in org A
    expect(names).not.toContain(otherOrgRow.packageName);
    expect(names).not.toContain(projectRow.packageName); // org-NULL is the workspace tier's
  });

  it("TEAM: exact-team + exact-org", async () => {
    const rows = await run({ kind: "team", id: TEAM }, orgAnchor(ORG_A), all);
    const names = rows.map((r) => r.packageName);
    expect(names).toContain(teamRow.packageName); // exact-team
    expect(names).toContain(orgRow.packageName); // exact-org
    expect(names).not.toContain(otherOrgRow.packageName);
  });

  it("PROJECT: EXACT-PROJECT INSTALLS PRESENT, plus exact-org", async () => {
    const rows = await run({ kind: "project", id: PROJECT }, orgAnchor(ORG_A), all);
    const names = rows.map((r) => r.packageName);
    expect(names).toContain(projectRow.packageName);
    expect(names).toContain(orgRow.packageName);
    expect(names).not.toContain(otherOrgRow.packageName);
  });

  it("WORKSPACE: the multi-org UNION, with org-NULL rows admitted once", async () => {
    const rows = await run({ kind: "workspace" }, workspaceAnchor([ORG_A, ORG_B]), all);
    const names = rows.map((r) => r.packageName);
    expect(names).toContain(orgRow.packageName);
    expect(names).toContain(otherOrgRow.packageName);
    expect(names.filter((n) => n === projectRow.packageName)).toHaveLength(1);
  });

  it("WORKSPACE: a row is absent once its organization leaves the vantage", async () => {
    const rows = await run({ kind: "workspace" }, workspaceAnchor([ORG_A]), all);
    expect(rows.map((r) => r.packageName)).not.toContain(otherOrgRow.packageName);
  });
});

describe("hidden bindings", () => {
  it("HIDDEN BINDINGS ABSENT: a hidden project binding never surfaces the row", async () => {
    const hidden = install({
      installId: "hidden-row",
      organizationId: null,
      ownerLevel: "workspace",
      ownerId: null,
      bindings: [{ kind: "project", id: PROJECT, hidden: true }],
    });
    const rows = await run({ kind: "project", id: PROJECT }, orgAnchor(ORG_A), [hidden]);
    expect(rows).toEqual([]);
    expect(installReachesScope({ kind: "project", id: PROJECT }, orgAnchor(ORG_A), hidden)).toBe(
      false,
    );
  });

  it("a hidden binding is never even a CONTRIBUTING reason beside a visible one", async () => {
    const both = install({
      installId: "both-row",
      organizationId: null,
      ownerLevel: "workspace",
      ownerId: null,
      bindings: [
        { kind: "project", id: "proj-other", hidden: true },
        { kind: "project", id: PROJECT },
      ],
    });
    expect(installReachesScope({ kind: "project", id: PROJECT }, orgAnchor(ORG_A), both)).toBe(true);
    expect(
      installReachesScope({ kind: "project", id: "proj-other" }, orgAnchor(ORG_B), both),
    ).toBe(false);
  });
});

describe("admin-only visibility, BOTH ways", () => {
  const adminRow = install({ installId: "admin-row", organizationId: ORG_A, ownerId: ORG_A });
  const policies = new Map([[adminRow.installId, policy(["admin"])]]);

  it("a MEMBER never sees an admin-only package on their personal scope", async () => {
    const rows = await run({ kind: "personal" }, orgAnchor(ORG_A), [adminRow], policies, false);
    expect(rows).toEqual([]);
  });

  it("an ADMINISTRATOR does see it on their personal scope", async () => {
    const rows = await run({ kind: "personal" }, orgAnchor(ORG_A), [adminRow], policies, true);
    expect(rows.map((r) => r.packageName)).toEqual([adminRow.packageName]);
  });

  it("no ORGANIZATION scope surfaces it, not even an administrator's — a scope holds no admin standing", async () => {
    const rows = await run(
      { kind: "organization", id: ORG_A },
      orgAnchor(ORG_A),
      [adminRow],
      policies,
      true,
    );
    expect(rows).toEqual([]);
  });
});

describe("the viewed organization", () => {
  it("VIEWED-ORG != ACTIVE-ORG: an organization scope reads its OWN tenant", async () => {
    const rowB = install({ installId: "b-row", organizationId: ORG_B, ownerId: ORG_B });
    // The session points at org A; the reader is on org B's page.
    const rows = await run({ kind: "organization", id: ORG_B }, orgAnchor(ORG_B), [rowB]);
    expect(rows.map((r) => r.packageName)).toEqual([rowB.packageName]);
    expect(scopeSurfaceCandidateVantages({ kind: "organization", id: ORG_B }, orgAnchor(ORG_A))).toEqual([
      { orgId: ORG_B, vantage: { kind: "organization", orgId: ORG_B, scopeId: ORG_B } },
    ]);
  });
});

describe("one policy snapshot, two arms", () => {
  it("reads the stored policy EXACTLY ONCE per install and hands that value to both arms", async () => {
    const row = install({ installId: "snap-row" });
    const seen: AgentAuthPolicy[] = [];
    const one = policy(["workspace"]);
    let reads = 0;
    await resolveScopeSurfaceEligibility({
      scope: { kind: "workspace" },
      anchor: workspaceAnchor([ORG_A, ORG_B]),
      installs: [row],
      arms: {
        policyFor: () => {
          reads += 1;
          return one;
        },
        vantageAdmits: (p, v) => {
          seen.push(p);
          return policyFieldAdmitsScopeVantage(p.runDataVisibility, v);
        },
        actorAdmits: (p) => {
          seen.push(p);
          return true;
        },
      },
    });
    // ONE read, even though the workspace scope evaluated two vantages.
    expect(reads).toBe(1);
    expect(seen.length).toBeGreaterThan(1);
    for (const p of seen) expect(p).toBe(one);
  });
});

describe("workspace rows keep their execution organizations", () => {
  it("retains every eligible CONCRETE execution organization after the package-level dedupe", async () => {
    const pkg = "@acme/shared";
    const inA = install({ installId: "in-a", packageName: pkg, organizationId: ORG_A, ownerId: ORG_A });
    const inB = install({ installId: "in-b", packageName: pkg, organizationId: ORG_B, ownerId: ORG_B });
    const rows = await run({ kind: "workspace" }, workspaceAnchor([ORG_A, ORG_B]), [inA, inB]);
    // ONE card for the package …
    expect(rows).toHaveLength(1);
    // … and both organizations it may actually execute in.
    expect(rows[0]!.executionOrgIds).toEqual([ORG_A, ORG_B]);
  });

  it("every other scope produces exactly its own organization", async () => {
    const rows = await run({ kind: "organization", id: ORG_A }, orgAnchor(ORG_A), [
      install({ installId: "solo" }),
    ]);
    expect(rows[0]!.executionOrgIds).toEqual([ORG_A]);
  });
});

describe("live statuses", () => {
  it("lists active and locked rows and nothing else", async () => {
    const locked = install({ installId: "locked-row", status: "locked" });
    const rows = await run({ kind: "organization", id: ORG_A }, orgAnchor(ORG_A), [locked]);
    expect(rows.map((r) => r.status)).toEqual(["locked"]);
  });
});

// ---------------------------------------------------------------------------
// THE CONVERGENCE ROUND'S FIXTURES (cinatra#2808)
// ---------------------------------------------------------------------------

describe("the per-install tenant fence", () => {
  it("never lets one organization's install collect ANOTHER organization's execution organization", async () => {
    // Both arms say yes to everything — the fence, and only the fence, is what
    // keeps org A's install out of org B. (This is the platform-administrator
    // shape: the real evaluator's cross-org guard is bypassed wholesale for
    // one, so the guard cannot be what this rule rests on.)
    const rows = await resolveScopeSurfaceEligibility({
      scope: { kind: "workspace" },
      anchor: workspaceAnchor([ORG_A, ORG_B]),
      installs: [install({ installId: "org-a-row", organizationId: ORG_A, ownerId: ORG_A })],
      arms: {
        policyFor: () => policy(["workspace"]),
        vantageAdmits: () => true,
        actorAdmits: () => true,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.executionOrgIds).toEqual([ORG_A]);
  });

  it("keeps an org-NULL row reaching every member organization", async () => {
    const rows = await resolveScopeSurfaceEligibility({
      scope: { kind: "workspace" },
      anchor: workspaceAnchor([ORG_A, ORG_B]),
      installs: [
        install({
          installId: "platform-row",
          organizationId: null,
          ownerLevel: "workspace",
          ownerId: null,
        }),
      ],
      arms: {
        policyFor: () => policy(["workspace"]),
        vantageAdmits: () => true,
        actorAdmits: () => true,
      },
    });
    expect(rows[0]!.executionOrgIds).toEqual([ORG_A, ORG_B].sort());
  });
});

describe("the workspace vantage union carries the teams and projects too", () => {
  const vantage = (): ScopeSurfaceAnchor => ({
    userId: "user-1",
    viewedOrgId: null,
    workspace: buildWorkspaceVantage({
      userId: "user-1",
      memberships: [{ orgId: ORG_A }],
      teamIdsByOrg: { [ORG_A]: [TEAM] },
      projectIdsByOrg: { [ORG_A]: [PROJECT] },
    }),
  });

  it("reaches a row a generic member of the actor's OWN team can reach", async () => {
    const teamOnly = install({ installId: "team-only", organizationId: ORG_A, ownerId: ORG_A });
    const rows = await run(
      { kind: "workspace" },
      vantage(),
      [teamOnly],
      new Map([[teamOnly.installId, policy([`team:${TEAM}`])]]),
    );
    expect(rows.map((r) => r.packageName)).toEqual([teamOnly.packageName]);
    // Still exactly its own organization — the widening adds no tenant.
    expect(rows[0]!.executionOrgIds).toEqual([ORG_A]);
  });

  it("reaches a row a generic member of the actor's OWN project can reach", async () => {
    const projectOnly = install({
      installId: "project-only",
      organizationId: ORG_A,
      ownerId: ORG_A,
    });
    const rows = await run(
      { kind: "workspace" },
      vantage(),
      [projectOnly],
      new Map([[projectOnly.installId, policy([`project:${PROJECT}`])]]),
    );
    expect(rows.map((r) => r.packageName)).toEqual([projectOnly.packageName]);
  });

  it("still refuses a row scoped to a team the actor is NOT in", async () => {
    const foreign = install({ installId: "foreign-team", organizationId: ORG_A, ownerId: ORG_A });
    const rows = await run(
      { kind: "workspace" },
      vantage(),
      [foreign],
      new Map([[foreign.installId, policy(["team:team-999"])]]),
    );
    expect(rows).toEqual([]);
  });

  it("takes the policy snapshot ONCE per install however many vantages an organization carries", async () => {
    const row = install({ installId: "counted", organizationId: ORG_A, ownerId: ORG_A });
    const policyFor = vi.fn(() => policy(["workspace"]));
    const actorAdmits = vi.fn(() => true);
    await resolveScopeSurfaceEligibility({
      scope: { kind: "workspace" },
      anchor: vantage(),
      installs: [row],
      arms: { policyFor, vantageAdmits: () => true, actorAdmits },
    });
    expect(policyFor).toHaveBeenCalledTimes(1);
    // ...and the organization is judged ONCE, not once per team/project vantage.
    expect(actorAdmits).toHaveBeenCalledTimes(1);
  });
});
