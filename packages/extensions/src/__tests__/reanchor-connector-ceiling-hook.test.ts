/**
 * The INSTALLED-CONNECTOR ceiling validator (cinatra#2694 / S5 #2802, change 5).
 *
 * A connector that declares `access.scope.only` caps the audience its INSTALL
 * ROW may carry, and the §V picker is a grant surface — so the ceiling is
 * enforced at write time, before the atomic re-anchor, and a refusal writes
 * nothing.
 *
 * The validator is written fresh rather than borrowed from the `connection`
 * kind: that one reasons about a connection identity (its owner user, its org
 * anchor, its person-grants), none of which describes an install row, whose
 * anchor is the very thing the save moves. This suite pins the difference:
 * the ceiling is read from the ROW's cached `accessDeclaration` and measured
 * against the DESTINATION organization.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

vi.mock("server-only", () => ({}));

const ORG_A = "org-a-2802";
const ORG_B = "org-b-2802";

const rowState: {
  kind: string;
  organizationId: string | null;
  accessDeclaration: unknown;
} = {
  kind: "connector",
  organizationId: ORG_A,
  accessDeclaration: {
    formatVersion: 1,
    mode: "only",
    scope: "organization",
    source: "declared",
  },
};

vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: vi.fn(async (id: string) =>
    id === "missing"
      ? null
      : {
          id,
          packageName: "@cinatra-ai/ceiling-2802",
          ownerLevel: "organization",
          ownerId: rowState.organizationId,
          organizationId: rowState.organizationId,
          kind: rowState.kind,
          status: "active",
          accessDeclaration: rowState.accessDeclaration,
        },
  ),
}));

function policy(...tokens: string[]): AgentAuthPolicy {
  const selection = tokens as AgentAuthPolicy["runListVisibility"];
  return {
    runListVisibility: selection,
    runDataVisibility: selection,
    runExecuteVisibility: selection,
    allowRunSharing: false,
  };
}

async function veto(
  p: AgentAuthPolicy,
  destinationOrganizationId?: string | null,
): Promise<string | null | undefined> {
  const { getExtensionKindHooks, __resetExtensionKindHooksCacheForTesting } = await import(
    "../permissions-kind-hooks"
  );
  __resetExtensionKindHooksCacheForTesting();
  const hooks = await getExtensionKindHooks("connector");
  return hooks.validatePolicyWrite?.("iext_ceiling_2802", p, {
    userId: "u-2802",
    ...(destinationOrganizationId === undefined ? {} : { destinationOrganizationId }),
  });
}

beforeEach(() => {
  rowState.kind = "connector";
  rowState.organizationId = ORG_A;
  rowState.accessDeclaration = {
    formatVersion: 1,
    mode: "only",
    scope: "organization",
    source: "declared",
  };
});

describe("cinatra#2802 — the installed-connector ceiling", () => {
  it("refuses a workspace widening past an `only: organization` ceiling", async () => {
    await expect(veto(policy("workspace"), null)).resolves.toBe("scope_locked_by_connector");
    await expect(veto(policy("admin"), null)).resolves.toBe("scope_locked_by_connector");
  });

  it("admits the organization audience AT THE DESTINATION organization", async () => {
    await expect(veto(policy(`org:${ORG_B}`), ORG_B)).resolves.toBeNull();
    // The SAME token measured against a different destination is out of ceiling
    // — the anchor is what the save moves, so the destination is the yardstick.
    await expect(veto(policy(`org:${ORG_B}`), ORG_A)).resolves.toBe("scope_locked_by_connector");
  });

  it("admits an admin-only audience under a workspace ceiling", async () => {
    rowState.accessDeclaration = {
      formatVersion: 1,
      mode: "only",
      scope: "workspace",
      source: "declared",
    };
    await expect(veto(policy("admin"), null)).resolves.toBeNull();
    await expect(veto(policy("workspace"), null)).resolves.toBeNull();
  });

  it("does not lock a `default`-mode declaration", async () => {
    rowState.accessDeclaration = {
      formatVersion: 1,
      mode: "default",
      scope: "organization",
      source: "declared",
    };
    await expect(veto(policy("workspace"), null)).resolves.toBeNull();
  });

  it("does not lock a row with no cached declaration", async () => {
    rowState.accessDeclaration = null;
    await expect(veto(policy("workspace"), null)).resolves.toBeNull();
  });

  it("falls back to the row's own organization when no destination is supplied", async () => {
    await expect(veto(policy(`org:${ORG_A}`))).resolves.toBeNull();
    await expect(veto(policy(`org:${ORG_B}`))).resolves.toBe("scope_locked_by_connector");
  });

  it("fails closed on a kind mismatch", async () => {
    rowState.kind = "artifact";
    await expect(veto(policy("owner"), ORG_A)).resolves.toBe("not_found");
  });

  it("is not mounted for the artifact and workflow kinds", async () => {
    const { getExtensionKindHooks, __resetExtensionKindHooksCacheForTesting } = await import(
      "../permissions-kind-hooks"
    );
    __resetExtensionKindHooksCacheForTesting();
    expect((await getExtensionKindHooks("artifact")).validatePolicyWrite).toBeUndefined();
    expect((await getExtensionKindHooks("workflow")).validatePolicyWrite).toBeUndefined();
  });
});
