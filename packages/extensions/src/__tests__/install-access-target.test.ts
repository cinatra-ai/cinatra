// install-access-target — target→policy mapping + schema contract (cinatra#805).
//
// The mapping is the ONLY translation between the pre-install access selector
// (org / team / project) and the persisted install-time access policy, so it
// is locked here, INCLUDING an integration lock against the pure
// evaluateExtensionAccess evaluator: a team/project-mapped policy must ADMIT
// members of the selected scope and DENY other same-org members — otherwise
// the selector would be decorative.
import { describe, expect, it } from "vitest";

import {
  INSTALL_ACCESS_TARGET_KINDS,
  InstallAccessTargetSchema,
  WORKSPACE_ANCHOR_ROW_OWNERSHIP,
  accessTargetToInstallPolicy,
  accessTargetToRowOwnership,
  isInstallAccessTargetKind,
  resolveInstallAccessTargetContract,
} from "../install-access-target";
import {
  DEFAULT_EXTENSION_ACCESS_POLICY,
  evaluateExtensionAccess,
  hasAdminStandingOverExtension,
  type ExtensionOwnerContext,
} from "../enforce-extension-access";
import type { ActorContext } from "@/lib/authz";

const TEAM_ID = "11111111-2222-4333-8444-555555555555";
const PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("accessTargetToInstallPolicy", () => {
  it("organization target → undefined (per-kind default applies)", () => {
    expect(
      accessTargetToInstallPolicy({ level: "organization", id: "org-1" }),
    ).toBeUndefined();
  });

  it("team target → all three visibility tiers scoped to team:<id>, sharing off", () => {
    expect(accessTargetToInstallPolicy({ level: "team", id: TEAM_ID })).toEqual({
      runListVisibility: [`team:${TEAM_ID}`],
      runDataVisibility: [`team:${TEAM_ID}`],
      runExecuteVisibility: [`team:${TEAM_ID}`],
      allowRunSharing: false,
    });
  });

  it("project target → all three visibility tiers scoped to project:<id>, sharing off", () => {
    expect(
      accessTargetToInstallPolicy({ level: "project", id: PROJECT_ID }),
    ).toEqual({
      runListVisibility: [`project:${PROJECT_ID}`],
      runDataVisibility: [`project:${PROJECT_ID}`],
      runExecuteVisibility: [`project:${PROJECT_ID}`],
      allowRunSharing: false,
    });
  });

  // cinatra#1527 — the always-offered workspace scopes map to an EXPLICIT
  // audience token (never undefined → never silently a per-kind default). The
  // id is ignored (audience tokens carry no id).
  it("workspace target → all three tiers = ['workspace'], sharing off (id ignored)", () => {
    expect(
      accessTargetToInstallPolicy({ level: "workspace", id: "ignored" }),
    ).toEqual({
      runListVisibility: ["workspace"],
      runDataVisibility: ["workspace"],
      runExecuteVisibility: ["workspace"],
      allowRunSharing: false,
    });
  });

  it("admin target → all three tiers = ['admin'], sharing off (id ignored)", () => {
    expect(
      accessTargetToInstallPolicy({ level: "admin", id: "ignored" }),
    ).toEqual({
      runListVisibility: ["admin"],
      runDataVisibility: ["admin"],
      runExecuteVisibility: ["admin"],
      allowRunSharing: false,
    });
  });
});

// ---------------------------------------------------------------------------
// cinatra#2695 S1 — the target→OWNERSHIP contract. Which canonical row identity
// each target anchors to. CONTRACT ONLY: the write path that persists the tuple
// is S2 (#2696).
// ---------------------------------------------------------------------------
describe("accessTargetToRowOwnership", () => {
  const INSTALLER_ORG = "org-installer";

  it("workspace target → the workspace ANCHOR tuple (workspace / NULL org / __platform__)", () => {
    expect(
      accessTargetToRowOwnership({ level: "workspace", id: INSTALLER_ORG }, INSTALLER_ORG),
    ).toEqual({
      ownerLevel: "workspace",
      ownerId: "__platform__",
      organizationId: null,
    });
  });

  it("admin target → the SAME workspace anchor tuple (the audience differs, not the anchor)", () => {
    expect(
      accessTargetToRowOwnership({ level: "admin", id: INSTALLER_ORG }, INSTALLER_ORG),
    ).toEqual({
      ownerLevel: "workspace",
      ownerId: "__platform__",
      organizationId: null,
    });
  });

  it("the workspace anchor ignores the installer org AND the picker-stamped target id", () => {
    // The picker stamps the ACTIVE ORG id on both workspace rows
    // (packages/agents/src/install-targets.ts) — the mapping must ignore it, so
    // the wire shape can stay as-is and a client-forged id cannot move the anchor.
    for (const id of [INSTALLER_ORG, "org-forged", "totally-bogus"]) {
      for (const activeOrg of [INSTALLER_ORG, "org-other", null]) {
        expect(accessTargetToRowOwnership({ level: "workspace", id }, activeOrg)).toEqual(
          WORKSPACE_ANCHOR_ROW_OWNERSHIP,
        );
        expect(accessTargetToRowOwnership({ level: "admin", id }, activeOrg)).toEqual(
          WORKSPACE_ANCHOR_ROW_OWNERSHIP,
        );
      }
    }
  });

  it("returns a COPY — the shared frozen anchor constant cannot be mutated by a caller", () => {
    const tuple = accessTargetToRowOwnership({ level: "workspace", id: "x" }, "org-1");
    tuple.organizationId = "org-1";
    expect(WORKSPACE_ANCHOR_ROW_OWNERSHIP.organizationId).toBeNull();
  });

  // Every OTHER target is UNCHANGED: byte-identical to the canonical default
  // (defaultRowOwnership in src/lib/extension-dependency-plan.ts) derived from
  // the installer's active organization.
  it("organization / team / project targets stay ORG-ANCHORED at the installer's org", () => {
    const expected = {
      ownerLevel: "organization",
      ownerId: INSTALLER_ORG,
      organizationId: INSTALLER_ORG,
    };
    expect(
      accessTargetToRowOwnership({ level: "organization", id: INSTALLER_ORG }, INSTALLER_ORG),
    ).toEqual(expected);
    expect(accessTargetToRowOwnership({ level: "team", id: TEAM_ID }, INSTALLER_ORG)).toEqual(
      expected,
    );
    expect(
      accessTargetToRowOwnership({ level: "project", id: PROJECT_ID }, INSTALLER_ORG),
    ).toEqual(expected);
  });

  it("a null-org installer keeps the platform default for the non-workspace targets", () => {
    for (const target of [
      { level: "organization" as const, id: "ignored" },
      { level: "team" as const, id: TEAM_ID },
      { level: "project" as const, id: PROJECT_ID },
    ]) {
      expect(accessTargetToRowOwnership(target, null)).toEqual({
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
      });
    }
  });
});

describe("resolveInstallAccessTargetContract", () => {
  it("workspace target → workspace anchor + the ['workspace'] audience", () => {
    expect(
      resolveInstallAccessTargetContract({ level: "workspace", id: "org-1" }, "org-1"),
    ).toEqual({
      rowOwnership: {
        ownerLevel: "workspace",
        ownerId: "__platform__",
        organizationId: null,
      },
      policy: {
        runListVisibility: ["workspace"],
        runDataVisibility: ["workspace"],
        runExecuteVisibility: ["workspace"],
        allowRunSharing: false,
      },
    });
  });

  it("admin target → workspace anchor + the ['admin'] audience", () => {
    expect(resolveInstallAccessTargetContract({ level: "admin", id: "org-1" }, "org-1")).toEqual({
      rowOwnership: {
        ownerLevel: "workspace",
        ownerId: "__platform__",
        organizationId: null,
      },
      policy: {
        runListVisibility: ["admin"],
        runDataVisibility: ["admin"],
        runExecuteVisibility: ["admin"],
        allowRunSharing: false,
      },
    });
  });

  it("organization target → org anchor + undefined policy (the kind's install default applies)", () => {
    expect(
      resolveInstallAccessTargetContract({ level: "organization", id: "org-1" }, "org-1"),
    ).toEqual({
      rowOwnership: {
        ownerLevel: "organization",
        ownerId: "org-1",
        organizationId: "org-1",
      },
      policy: undefined,
    });
  });
});

describe("InstallAccessTargetSchema", () => {
  it("accepts the five selectable levels (cinatra#1527 adds workspace + admin)", () => {
    for (const level of [
      "organization",
      "team",
      "project",
      "workspace",
      "admin",
    ] as const) {
      expect(
        InstallAccessTargetSchema.safeParse({ level, id: "x" }).success,
      ).toBe(true);
    }
  });

  it("rejects user / junk levels and empty ids (fail closed before auth)", () => {
    expect(
      InstallAccessTargetSchema.safeParse({ level: "user", id: "x" }).success,
    ).toBe(false);
    // "org" is the legacy bare token, not a level — still rejected.
    expect(
      InstallAccessTargetSchema.safeParse({ level: "org", id: "x" }).success,
    ).toBe(false);
    expect(
      InstallAccessTargetSchema.safeParse({ level: "owner", id: "x" }).success,
    ).toBe(false);
    expect(
      InstallAccessTargetSchema.safeParse({ level: "team", id: "" }).success,
    ).toBe(false);
    // workspace/admin still require a non-empty id (the action re-derives it).
    expect(
      InstallAccessTargetSchema.safeParse({ level: "workspace", id: "" }).success,
    ).toBe(false);
    expect(InstallAccessTargetSchema.safeParse(null).success).toBe(false);
  });
});

describe("isInstallAccessTargetKind", () => {
  it("covers exactly connector / artifact / workflow", () => {
    expect([...INSTALL_ACCESS_TARGET_KINDS]).toEqual([
      "connector",
      "artifact",
      "workflow",
    ]);
    expect(isInstallAccessTargetKind("connector")).toBe(true);
    expect(isInstallAccessTargetKind("artifact")).toBe(true);
    expect(isInstallAccessTargetKind("workflow")).toBe(true);
    expect(isInstallAccessTargetKind("agent")).toBe(false);
    expect(isInstallAccessTargetKind("skill")).toBe(false);
    expect(isInstallAccessTargetKind("unknown")).toBe(false);
    expect(isInstallAccessTargetKind(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration lock: the mapped policy is actually ENFORCED by the pure
// evaluator the runtime gates (connector-policy / artifact-extension-access /
// workflow-host-deps) delegate to.
// ---------------------------------------------------------------------------
describe("mapped policy → evaluateExtensionAccess enforcement", () => {
  const ORG = "org-1";
  const owner = {
    ownerLevel: "organization" as const,
    ownerId: ORG,
    organizationId: ORG,
  };

  const memberActor = (extra: Partial<ActorContext>): ActorContext =>
    ({
      principalType: "HumanUser",
      principalId: "user-member",
      organizationId: ORG,
      platformRole: "member",
      ...extra,
    }) as ActorContext;

  it("team-scoped policy admits a member of the selected team and denies other same-org members", () => {
    const policy = accessTargetToInstallPolicy({ level: "team", id: TEAM_ID })!;
    const base = {
      kind: "skill" as const,
      policy,
      coOwnerUserIds: [],
      installedByUserId: "installer-1",
      owner,
      op: "use" as const,
    };
    expect(
      evaluateExtensionAccess({
        ...base,
        actor: memberActor({ teamIds: [TEAM_ID] }),
      }).allowed,
    ).toBe(true);
    expect(
      evaluateExtensionAccess({
        ...base,
        actor: memberActor({ teamIds: ["other-team"] }),
      }).allowed,
    ).toBe(false);
  });

  it("project-scoped policy admits a member of the selected project and denies other same-org members", () => {
    const policy = accessTargetToInstallPolicy({
      level: "project",
      id: PROJECT_ID,
    })!;
    const base = {
      kind: "skill" as const,
      policy,
      coOwnerUserIds: [],
      installedByUserId: "installer-1",
      owner,
      op: "use" as const,
    };
    expect(
      evaluateExtensionAccess({
        ...base,
        actor: memberActor({ projectIds: [PROJECT_ID] }),
      }).allowed,
    ).toBe(true);
    expect(
      evaluateExtensionAccess({
        ...base,
        actor: memberActor({ projectIds: [] }),
      }).allowed,
    ).toBe(false);
  });

  it("the installer keeps access regardless of the narrowed tier (owner short-circuit)", () => {
    const policy = accessTargetToInstallPolicy({ level: "team", id: TEAM_ID })!;
    expect(
      evaluateExtensionAccess({
        kind: "skill",
        policy,
        coOwnerUserIds: [],
        installedByUserId: "user-member",
        owner,
        actor: memberActor({ teamIds: [] }),
        op: "use",
      }).allowed,
    ).toBe(true);
  });

  // cinatra#1527 — the two workspace scopes are enforced downstream, not just
  // at install time (issue AC3/AC5). The audience is what evaluateExtensionAccess
  // actually admits per the mapped policy.
  it("workspace-scoped policy admits EVERY same-org member (list/read/use/execute)", () => {
    const policy = accessTargetToInstallPolicy({ level: "workspace", id: ORG })!;
    for (const op of ["list", "read", "use", "execute"] as const) {
      expect(
        evaluateExtensionAccess({
          kind: "skill",
          policy,
          coOwnerUserIds: [],
          installedByUserId: "installer-1",
          owner,
          // A plain member with no team/project membership — workspace = all.
          actor: memberActor({}),
          op,
        }).allowed,
      ).toBe(true);
    }
  });

  it("admin-scoped policy DENIES a plain member and ADMITS a platform admin (no one wider than admins)", () => {
    const policy = accessTargetToInstallPolicy({ level: "admin", id: ORG })!;
    const base = {
      kind: "skill" as const,
      policy,
      coOwnerUserIds: [],
      installedByUserId: "installer-1",
      owner,
      op: "read" as const,
    };
    // Plain same-org member → DENIED (audience tier, not the cross-org guard).
    expect(
      evaluateExtensionAccess({ ...base, actor: memberActor({}) }).allowed,
    ).toBe(false);
    // Platform admin → ADMITTED.
    expect(
      evaluateExtensionAccess({
        ...base,
        actor: memberActor({ platformRole: "platform_admin" }),
      }).allowed,
    ).toBe(true);
    // The established "admin" audience is OWNER-AWARE: the owning org's admin is
    // also admitted (documented divergence in enforce-extension-access). Locked
    // here so the semantics are explicit for the paired spec.
    expect(
      evaluateExtensionAccess({
        ...base,
        actor: memberActor({ orgRole: "org_admin" }),
      }).allowed,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2695 S1 — MULTI-ORG fixture at the level this slice owns: the
// contract (target → row anchor + audience) composed with the PURE enforcement
// evaluator the runtime gates delegate to. It proves REACH ("Workspace: All"
// is visible + usable from two different organizations) and the FENCE (an
// "Organization"-target install stays organization-fenced) for the row the
// contract resolves.
//
// SCOPE NOTE: the end-to-end proof that an actual install WRITES this row is
// S2 (#2696) — today's batch executor still derives ownership from the actor's
// organization and discards the planned tuple. This fixture therefore builds
// the owner context FROM THE CONTRACT rather than from a persisted row; it is
// the whole of the reach/fence claim that is decidable before the write path
// exists, and it is exactly what would regress if the contract drifted.
// ---------------------------------------------------------------------------
describe("multi-org reach + fence (contract ∘ evaluator)", () => {
  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";

  const memberOf = (orgId: string, extra: Partial<ActorContext> = {}): ActorContext =>
    ({
      principalType: "HumanUser",
      principalId: `user-${orgId}`,
      organizationId: orgId,
      orgRole: "member",
      ...extra,
    }) as ActorContext;

  const ownerCtxFor = (
    target: Parameters<typeof accessTargetToRowOwnership>[0],
    installerOrg: string,
  ): ExtensionOwnerContext => accessTargetToRowOwnership(target, installerOrg);

  it("REACH: a 'Workspace: All' install is visible + usable from BOTH organizations", () => {
    const target = { level: "workspace" as const, id: ORG_A };
    const { rowOwnership, policy } = resolveInstallAccessTargetContract(target, ORG_A);
    expect(policy).toBeDefined();
    for (const org of [ORG_A, ORG_B]) {
      for (const op of ["list", "read", "use", "execute"] as const) {
        expect(
          evaluateExtensionAccess({
            kind: "artifact",
            policy: policy!,
            coOwnerUserIds: [],
            installedByUserId: "platform-admin-installer",
            owner: rowOwnership,
            actor: memberOf(org),
            op,
          }),
        ).toEqual({ allowed: true });
      }
    }
  });

  it("REACH: an org-LESS actor also reaches the workspace-anchored row (no org to fence)", () => {
    const { rowOwnership, policy } = resolveInstallAccessTargetContract(
      { level: "workspace", id: ORG_A },
      ORG_A,
    );
    expect(
      evaluateExtensionAccess({
        kind: "artifact",
        policy: policy!,
        coOwnerUserIds: [],
        installedByUserId: null,
        owner: rowOwnership,
        actor: memberOf(ORG_A, { organizationId: undefined }),
        op: "use",
      }).allowed,
    ).toBe(true);
  });

  it("'Workspace: Admins only' reaches PLATFORM admins in every org and no plain member", () => {
    const { rowOwnership, policy } = resolveInstallAccessTargetContract(
      { level: "admin", id: ORG_A },
      ORG_A,
    );
    const at = (actor: ActorContext) =>
      evaluateExtensionAccess({
        kind: "artifact",
        policy: policy!,
        coOwnerUserIds: [],
        installedByUserId: null,
        owner: rowOwnership,
        actor,
        op: "read",
      }).allowed;
    for (const org of [ORG_A, ORG_B]) {
      expect(at(memberOf(org, { platformRole: "platform_admin" }))).toBe(true);
      expect(at(memberOf(org))).toBe(false);
      // Org admins of ANY org get NO standing over an org-NULL row — the
      // owner-aware "admin" tier fails closed without an owning org (S1 item 3).
      expect(at(memberOf(org, { orgRole: "org_admin" }))).toBe(false);
    }
  });

  it("FENCE: an 'Organization'-target install stays organization-fenced across orgs", () => {
    const target = { level: "organization" as const, id: ORG_A };
    const { rowOwnership, policy } = resolveInstallAccessTargetContract(target, ORG_A);
    // The organization target defers to the kind's install default; for
    // artifact/workflow that default is the workspace-token policy — the WIDEST
    // default there is, which makes this the strongest fence assertion.
    expect(policy).toBeUndefined();
    const effective = DEFAULT_EXTENSION_ACCESS_POLICY;
    const at = (org: string) =>
      evaluateExtensionAccess({
        kind: "artifact",
        policy: effective,
        coOwnerUserIds: [],
        installedByUserId: null,
        owner: rowOwnership,
        actor: memberOf(org),
        op: "use",
      });
    expect(at(ORG_A)).toEqual({ allowed: true });
    expect(at(ORG_B)).toEqual({ allowed: false, reason: "cross_org" });
  });

  it("ADMIN STANDING over the workspace-anchored row = platform admins only", () => {
    const owner = ownerCtxFor({ level: "workspace", id: ORG_A }, ORG_A);
    expect(hasAdminStandingOverExtension(memberOf(ORG_A, { orgRole: "org_admin" }), owner)).toBe(
      false,
    );
    expect(hasAdminStandingOverExtension(memberOf(ORG_A, { orgRole: "org_owner" }), owner)).toBe(
      false,
    );
    expect(hasAdminStandingOverExtension(memberOf(ORG_B, { orgRole: "org_owner" }), owner)).toBe(
      false,
    );
    expect(
      hasAdminStandingOverExtension(memberOf(ORG_B, { platformRole: "platform_admin" }), owner),
    ).toBe(true);
    // …and the org-ANCHORED row is unchanged: the owning org's admin keeps standing.
    const orgOwner = ownerCtxFor({ level: "organization", id: ORG_A }, ORG_A);
    expect(hasAdminStandingOverExtension(memberOf(ORG_A, { orgRole: "org_admin" }), orgOwner)).toBe(
      true,
    );
  });

  it("MANAGE over the workspace-anchored row is refused to an org admin (no new authz built)", () => {
    const { rowOwnership, policy } = resolveInstallAccessTargetContract(
      { level: "workspace", id: ORG_A },
      ORG_A,
    );
    expect(
      evaluateExtensionAccess({
        kind: "artifact",
        policy: policy!,
        coOwnerUserIds: [],
        installedByUserId: "platform-admin-installer",
        owner: rowOwnership,
        actor: memberOf(ORG_A, { orgRole: "org_admin" }),
        op: "manage",
      }),
    ).toEqual({ allowed: false, reason: "manage_requires_admin" });
    expect(
      evaluateExtensionAccess({
        kind: "artifact",
        policy: policy!,
        coOwnerUserIds: [],
        installedByUserId: null,
        owner: rowOwnership,
        actor: memberOf(ORG_B, { platformRole: "platform_admin" }),
        op: "manage",
      }).allowed,
    ).toBe(true);
  });
});
