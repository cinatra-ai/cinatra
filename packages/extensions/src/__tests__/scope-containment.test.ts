/**
 * scope-containment pure subset rule tests.
 *
 * Pure logic — no DB. ContainmentLookups is injected as a stub so we can
 * test team→org and project→org parentage outcomes deterministically.
 *
 * Coverage matrix:
 *   1. owner ⊆ any
 *   2. team:X ⊆ team:X (exact)
 *   3. team:X ⊆ org:A iff team X is in org A
 *   4. project:P ⊆ project:P (exact)
 *   5. project:P ⊆ org:A iff project P is in org A
 *   6. team:X and project:P are PEERS — neither contains the other
 *   7. org:A ⊆ workspace
 *   8. admin ⊆ admin (cross-org peer)
 *   9. workspace ⊆ workspace (widest)
 *  10. Legacy "org" resolves via resolveLegacyOrg
 *  11. Policy-level rejection surfaces the failing field
 */
import { describe, it, expect, vi } from "vitest";

import {
  policyContainedBy,
  visibilityContainedBy,
  type ContainmentLookups,
} from "../scope-containment";
import type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const TEAM_X_IN_A = "10000000-0000-0000-0000-000000000001";
const TEAM_Y_IN_B = "10000000-0000-0000-0000-000000000002";
const PROJECT_P_IN_A = "20000000-0000-0000-0000-000000000001";
const PROJECT_Q_IN_B = "20000000-0000-0000-0000-000000000002";

function makeLookups(opts?: { legacyOrg?: string | null }): ContainmentLookups {
  return {
    teamOrg: vi.fn(async (teamId: string) => {
      if (teamId === TEAM_X_IN_A) return ORG_A;
      if (teamId === TEAM_Y_IN_B) return ORG_B;
      return null;
    }),
    projectOrg: vi.fn(async (projectId: string) => {
      if (projectId === PROJECT_P_IN_A) return ORG_A;
      if (projectId === PROJECT_Q_IN_B) return ORG_B;
      return null;
    }),
    resolveLegacyOrg: vi.fn(async () => opts?.legacyOrg ?? null),
  };
}

function policy(v: AgentAuthPolicyVisibility): AgentAuthPolicy {
  return {
    runListVisibility: v,
    runDataVisibility: v,
    runExecuteVisibility: v,
    allowRunSharing: false,
  };
}

describe("scope-containment / visibilityContainedBy (pure subset rule)", () => {
  const lookups = makeLookups({ legacyOrg: ORG_A });

  it("owner ⊆ anything", async () => {
    for (const parent of [
      "owner",
      "admin",
      "workspace",
      `org:${ORG_A}` as const,
      `team:${TEAM_X_IN_A}` as const,
      `project:${PROJECT_P_IN_A}` as const,
    ] satisfies readonly AgentAuthPolicyVisibility[]) {
      expect(await visibilityContainedBy("owner", parent, lookups)).toBe(true);
    }
  });

  it("team:X ⊆ team:X (exact)", async () => {
    expect(
      await visibilityContainedBy(`team:${TEAM_X_IN_A}`, `team:${TEAM_X_IN_A}`, lookups),
    ).toBe(true);
  });

  it("team:X ⊆ org:A iff team X is in org A", async () => {
    expect(
      await visibilityContainedBy(`team:${TEAM_X_IN_A}`, `org:${ORG_A}`, lookups),
    ).toBe(true);
    expect(
      await visibilityContainedBy(`team:${TEAM_X_IN_A}`, `org:${ORG_B}`, lookups),
    ).toBe(false);
    expect(
      await visibilityContainedBy(`team:${TEAM_Y_IN_B}`, `org:${ORG_B}`, lookups),
    ).toBe(true);
  });

  it("project:P ⊆ project:P (exact)", async () => {
    expect(
      await visibilityContainedBy(`project:${PROJECT_P_IN_A}`, `project:${PROJECT_P_IN_A}`, lookups),
    ).toBe(true);
  });

  it("project:P ⊆ org:A iff project P is in org A", async () => {
    expect(
      await visibilityContainedBy(`project:${PROJECT_P_IN_A}`, `org:${ORG_A}`, lookups),
    ).toBe(true);
    expect(
      await visibilityContainedBy(`project:${PROJECT_P_IN_A}`, `org:${ORG_B}`, lookups),
    ).toBe(false);
  });

  it("team:X and project:P are peers — neither contains the other", async () => {
    expect(
      await visibilityContainedBy(`team:${TEAM_X_IN_A}`, `project:${PROJECT_P_IN_A}`, lookups),
    ).toBe(false);
    expect(
      await visibilityContainedBy(`project:${PROJECT_P_IN_A}`, `team:${TEAM_X_IN_A}`, lookups),
    ).toBe(false);
  });

  it("org:A ⊆ workspace", async () => {
    expect(await visibilityContainedBy(`org:${ORG_A}`, "workspace", lookups)).toBe(true);
  });

  it("org:A ⊆ org:A (exact); org:A NOT ⊆ org:B", async () => {
    expect(await visibilityContainedBy(`org:${ORG_A}`, `org:${ORG_A}`, lookups)).toBe(true);
    expect(await visibilityContainedBy(`org:${ORG_A}`, `org:${ORG_B}`, lookups)).toBe(false);
  });

  it("admin ⊆ admin (cross-org peer)", async () => {
    expect(await visibilityContainedBy("admin", "admin", lookups)).toBe(true);
    expect(await visibilityContainedBy("admin", `org:${ORG_A}`, lookups)).toBe(false);
    expect(await visibilityContainedBy(`org:${ORG_A}`, "admin", lookups)).toBe(false);
    expect(await visibilityContainedBy("admin", "workspace", lookups)).toBe(true);
  });

  it("workspace ⊆ workspace (widest)", async () => {
    expect(await visibilityContainedBy("workspace", "workspace", lookups)).toBe(true);
    expect(await visibilityContainedBy("workspace", `org:${ORG_A}`, lookups)).toBe(false);
  });

  it("legacy \"org\" on child resolves via resolveLegacyOrg", async () => {
    // child "org" resolved to "org:ORG_A" via lookup
    expect(
      await visibilityContainedBy("org", `org:${ORG_A}`, makeLookups({ legacyOrg: ORG_A })),
    ).toBe(true);
    // child "org" against a different parent → rejected
    expect(
      await visibilityContainedBy("org", `org:${ORG_B}`, makeLookups({ legacyOrg: ORG_A })),
    ).toBe(false);
    // legacy "org" with unresolvable id → fail-closed
    expect(
      await visibilityContainedBy("org", `org:${ORG_A}`, makeLookups({ legacyOrg: null })),
    ).toBe(false);
  });

  it("project under team parent — rejected in v1 (peers)", async () => {
    expect(
      await visibilityContainedBy(`project:${PROJECT_P_IN_A}`, `team:${TEAM_X_IN_A}`, lookups),
    ).toBe(false);
  });
});

describe("scope-containment / policyContainedBy (full policy)", () => {
  const lookups = makeLookups({ legacyOrg: ORG_A });

  it("subset accepted across all three visibility fields", async () => {
    const child = policy("owner");
    const parent = policy(`org:${ORG_A}`);
    const result = await policyContainedBy(child, parent, lookups);
    expect(result.ok).toBe(true);
  });

  it("rejected with field surfaced when any one visibility exceeds parent", async () => {
    const child: AgentAuthPolicy = {
      runListVisibility: "owner",
      runDataVisibility: `org:${ORG_B}`,
      runExecuteVisibility: "owner",
      allowRunSharing: false,
    };
    const parent = policy(`org:${ORG_A}`);
    const result = await policyContainedBy(child, parent, lookups);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("runDataVisibility");
      expect(result.child).toBe(`org:${ORG_B}`);
      expect(result.parent).toBe(`org:${ORG_A}`);
    }
  });

  it("missing-parent default (all owner) rejects any non-owner child", async () => {
    const ownerOnly = policy("owner");
    expect((await policyContainedBy(ownerOnly, ownerOnly, lookups)).ok).toBe(true);
    expect(
      (await policyContainedBy(policy(`org:${ORG_A}`), ownerOnly, lookups)).ok,
    ).toBe(false);
    expect(
      (await policyContainedBy(policy("workspace"), ownerOnly, lookups)).ok,
    ).toBe(false);
  });

  // Additional regression cases.

  it("allowRunSharing widening is rejected (child=true requires parent=true)", async () => {
    const parent: AgentAuthPolicy = {
      runListVisibility: `org:${ORG_A}`,
      runDataVisibility: `org:${ORG_A}`,
      runExecuteVisibility: `org:${ORG_A}`,
      allowRunSharing: false,
    };
    const child: AgentAuthPolicy = {
      runListVisibility: `org:${ORG_A}`,
      runDataVisibility: `org:${ORG_A}`,
      runExecuteVisibility: `org:${ORG_A}`,
      allowRunSharing: true,
    };
    const result = await policyContainedBy(child, parent, lookups);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("allowRunSharing");
    }
    // Reverse direction (parent=true, child=false) is fine — narrowing is OK.
    const okChild: AgentAuthPolicy = { ...parent, allowRunSharing: false };
    const okParent: AgentAuthPolicy = { ...parent, allowRunSharing: true };
    expect((await policyContainedBy(okChild, okParent, lookups)).ok).toBe(true);
  });

  it("parent-side legacy \"org\" resolves via lookup; child=team:X under parent=\"org\" passes iff team in resolved org", async () => {
    const childInA = policy(`team:${TEAM_X_IN_A}`);
    const parentLegacy = policy("org");
    expect(
      (await policyContainedBy(childInA, parentLegacy, makeLookups({ legacyOrg: ORG_A }))).ok,
    ).toBe(true);
    expect(
      (await policyContainedBy(childInA, parentLegacy, makeLookups({ legacyOrg: ORG_B }))).ok,
    ).toBe(false);
  });

  it("team:X is NOT a subset of team:Y (different teams)", async () => {
    expect(
      await visibilityContainedBy(`team:${TEAM_X_IN_A}`, `team:${TEAM_Y_IN_B}`, lookups),
    ).toBe(false);
  });

  it("project:P is NOT a subset of project:Q (different projects)", async () => {
    expect(
      await visibilityContainedBy(`project:${PROJECT_P_IN_A}`, `project:${PROJECT_Q_IN_B}`, lookups),
    ).toBe(false);
  });

  it("team:X and project:P under workspace parent — both pass (workspace is widest)", async () => {
    expect(
      await visibilityContainedBy(`team:${TEAM_X_IN_A}`, "workspace", lookups),
    ).toBe(true);
    expect(
      await visibilityContainedBy(`project:${PROJECT_P_IN_A}`, "workspace", lookups),
    ).toBe(true);
  });
});
