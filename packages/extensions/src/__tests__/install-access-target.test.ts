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
  accessTargetToInstallPolicy,
  isInstallAccessTargetKind,
} from "../install-access-target";
import { evaluateExtensionAccess } from "../enforce-extension-access";
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
