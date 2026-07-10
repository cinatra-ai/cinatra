// ---------------------------------------------------------------------------
// admin-extension-parity P7 (#1132) — composed two-admin cross-surface proof.
//
// The per-phase suites each pin ONE surface in isolation (the P1 evaluator
// matrix, the P3 manifest/install-row gates, the P4 run-path policy, the P6
// actor plumbing). This suite is the epic-level (#1124) integration arm: it
// drives ONE shared two-org / two-admin fixture — Admin A the installer, and
// Admin B tested as BOTH a fresh platform_admin and a fresh org_admin of the
// same org — through EVERY real access surface at once, so there is no residual
// surface where two admins of the same scope diverge, and no member-facing
// expansion.
//
// It is the deterministic, CI-gating counterpart to the real-surface Playwright
// arm (tests/e2e/admin-parity) — same scenario, run against the pure decision
// cores rather than a live browser, so the contract is pinned even where the
// dispatch-only browser suite cannot run.
//
// Surfaces exercised (all REAL functions, no stubs):
//   • P1  evaluateExtensionAccess / adminStandingOps  (@cinatra-ai/extensions)
//   • P3  manifestVisibleToScope                       (@cinatra-ai/extension-types) — catalog/list
//   • P3/P5 isInstallRowAddressableByActor / pickActiveInstallId
//          (@/lib/extension-install-resolution)        — lifecycle row addressing
//   • P4  policyAllows                                 (@cinatra-ai/agents/auth-policy) — run path
//
// Contract asserted for BOTH Admin-B variants, over shared + org-scoped
// extensions installed/created by Admin A:
//   1. B lists/reads/uses/executes/manages every one of A's extensions on every
//      surface (evaluator + catalog + install-row), by role, with no per-row
//      grant — EXCEPT the two carve-outs:
//        · connection: B sees/reads/manages but NEVER uses/executes A's
//          credential (owner-gated),
//        · agent_run: B manages but NEVER reads/uses A's run data (owner-private).
//   2. No-member-regression: a plain member sees EXACTLY the pre-parity
//      contract (workspace-tier only; OWNER/team/user rows stay hidden).
//   3. Vendor `only` ceiling / system protections still hold: a cross-org admin
//      and an org-less/workspace-owned row never over-broaden.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import {
  evaluateExtensionAccess,
  adminStandingOps,
  type ExtensionOwnerContext,
  type ExtensionAccessOp,
} from "@cinatra-ai/extensions/enforce-extension-access";
import {
  manifestVisibleToScope,
  type ActiveExtensionManifest,
  type ExtensionDiscoveryScope,
} from "@cinatra-ai/extension-types";
import { policyAllows } from "@cinatra-ai/agents/auth-policy";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibilitySelection,
} from "@cinatra-ai/agents/auth-policy-types";
import {
  isInstallRowAddressableByActor,
  buildActorScopeForPick,
  pickActiveInstallId,
  type InstallRowForPick,
} from "@/lib/extension-install-resolution";
import type { ActorContext } from "@/lib/authz";
import type { ExtensionKind } from "@cinatra-ai/extensions/permissions-kind-hooks";

// ---------------------------------------------------------------------------
// Fixture: two orgs, the actors, and A's extensions.
// ---------------------------------------------------------------------------

const ORG_A = "org-a";
const ORG_B = "org-b";
const TEAM_A1 = "team-a1"; // a team in ORG_A that A is on and B is NOT.

const ADMIN_A = "user-admin-a"; // installer / author of every fixture extension.
const ADMIN_B = "user-admin-b"; // the second admin (platform / org variants below).
const MEMBER_A = "user-member-a"; // plain member of ORG_A (no-regression subject).

/** Admin A — org_admin + installer of ORG_A, a member of TEAM_A1. */
const adminA: ActorContext = {
  principalType: "HumanUser",
  principalId: ADMIN_A,
  organizationId: ORG_A,
  orgRole: "org_admin",
  platformRole: "member",
  teamIds: [TEAM_A1],
  projectIds: [],
  authSource: "ui",
  policyVersion: "v2",
};

/** Admin B, variant 1 — a FRESH platform_admin (deliberately anchored to the
 *  OTHER org to prove platform standing is instance-wide, not org-scoped). */
const adminBPlatform: ActorContext = {
  principalType: "HumanUser",
  principalId: ADMIN_B,
  organizationId: ORG_B,
  orgRole: "member",
  platformRole: "platform_admin",
  teamIds: [],
  projectIds: [],
  authSource: "ui",
  policyVersion: "v2",
};

/** Admin B, variant 2 — a FRESH org_admin of ORG_A (same org as A), NOT on
 *  TEAM_A1, NOT the installer of anything. Role-derived standing only. */
const adminBOrg: ActorContext = {
  principalType: "HumanUser",
  principalId: ADMIN_B,
  organizationId: ORG_A,
  orgRole: "org_admin",
  platformRole: "member",
  teamIds: [],
  projectIds: [],
  authSource: "ui",
  policyVersion: "v2",
};

/** A plain member of ORG_A — the no-regression subject. */
const memberA: ActorContext = {
  principalType: "HumanUser",
  principalId: MEMBER_A,
  organizationId: ORG_A,
  orgRole: "member",
  platformRole: "member",
  teamIds: [],
  projectIds: [],
  authSource: "ui",
  policyVersion: "v2",
};

/** An org_admin of ORG_B — the cross-org control (must NEVER reach ORG_A rows). */
const adminCrossOrg: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-admin-crossorg",
  organizationId: ORG_B,
  orgRole: "org_admin",
  platformRole: "member",
  teamIds: [],
  projectIds: [],
  authSource: "ui",
  policyVersion: "v2",
};

const adminBVariants: ReadonlyArray<readonly [string, ActorContext]> = [
  ["platform_admin", adminBPlatform],
  ["org_admin (same org)", adminBOrg],
];

// Owner contexts for A's extensions. All are anchored to ORG_A (the M1
// org-anchor invariant); they differ only in owner LEVEL to prove admin
// standing crosses user / team / organization levels uniformly.
const orgOwned: ExtensionOwnerContext = {
  ownerLevel: "organization",
  ownerId: ORG_A,
  organizationId: ORG_A,
};
const userOwnedByA: ExtensionOwnerContext = {
  ownerLevel: "user",
  ownerId: ADMIN_A,
  organizationId: ORG_A,
};
const teamOwnedA1: ExtensionOwnerContext = {
  ownerLevel: "team",
  ownerId: TEAM_A1,
  organizationId: ORG_A,
};

// The OWNER-default install policy — the worst case for parity: only the owner
// passes the visibility tier, so any admit for a non-installer admin comes
// PURELY from role-derived admin standing (not the tier). Kinds agent / skill /
// connection default to owner at install (install-access-contract).
const OWNER_POLICY: AgentAuthPolicy = Object.freeze({
  runListVisibility: Object.freeze(["owner"]),
  runDataVisibility: Object.freeze(["owner"]),
  runExecuteVisibility: Object.freeze(["owner"]),
  allowRunSharing: false,
}) as unknown as AgentAuthPolicy;

const sel = (t: string): AgentAuthPolicyVisibilitySelection =>
  Object.freeze([t]) as unknown as AgentAuthPolicyVisibilitySelection;

const WORKSPACE_POLICY: AgentAuthPolicy = Object.freeze({
  runListVisibility: sel("workspace"),
  runDataVisibility: sel("workspace"),
  runExecuteVisibility: sel("workspace"),
  allowRunSharing: false,
}) as unknown as AgentAuthPolicy;

function decide(
  kind: ExtensionKind,
  owner: ExtensionOwnerContext,
  actor: ActorContext,
  op: ExtensionAccessOp,
  policy: AgentAuthPolicy = OWNER_POLICY,
): boolean {
  return evaluateExtensionAccess({
    kind,
    policy,
    coOwnerUserIds: [],
    installedByUserId: ADMIN_A, // A is the installer on every fixture row.
    owner,
    actor,
    op,
  }).allowed;
}

const READ_OPS: readonly ExtensionAccessOp[] = ["list", "read", "use", "execute"];

// ---------------------------------------------------------------------------
// 1. Evaluator (P1) — full parity on non-carve-out kinds, both B variants.
// ---------------------------------------------------------------------------

describe("P7 two-admin parity — evaluator, non-carve-out kinds (connector/skill/agent/artifact/workflow)", () => {
  const kinds: ExtensionKind[] = ["connector", "skill", "agent_template", "artifact", "workflow"];
  // Owner levels A's extensions can carry, each anchored to ORG_A.
  const owners: ReadonlyArray<readonly [string, ExtensionOwnerContext]> = [
    ["org-owned", orgOwned],
    ["user-owned by A", userOwnedByA],
    ["team-owned (A on team, B not)", teamOwnedA1],
  ];

  for (const [bName, adminB] of adminBVariants) {
    for (const kind of kinds) {
      for (const [oName, owner] of owners) {
        it(`${bName} gets list/read/use/execute/share/manage on A's ${oName} ${kind} (OWNER-default row, no per-row grant)`, () => {
          // Every non-carve-out kind grants admin standing the FULL op set,
          // including `share` — and the admin-standing short-circuit runs BEFORE
          // the allowRunSharing gate, so B shares even on an allowRunSharing=false
          // OWNER-default row (adminStandingOps default = all six ops).
          for (const op of [...READ_OPS, "share", "manage"] as ExtensionAccessOp[]) {
            expect(decide(kind, owner, adminB, op)).toBe(true);
          }
        });
      }
    }
  }

  it("parity is role-derived: it holds even when the installer pointer is NULL", () => {
    for (const [, adminB] of adminBVariants) {
      const allowed = evaluateExtensionAccess({
        kind: "connector",
        policy: OWNER_POLICY,
        coOwnerUserIds: [],
        installedByUserId: null, // installer deleted → FK set-null.
        owner: userOwnedByA,
        actor: adminB,
        op: "read",
      }).allowed;
      expect(allowed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Evaluator carve-outs — connection (no use/execute) + agent_run (manage only).
// ---------------------------------------------------------------------------

// ARCHITECTURE NOTE (why the carve-outs below are asserted at the ORG-ADMIN
// standing path, not the platform-admin path):
//
// `evaluateExtensionAccess` short-circuits `platform_admin` at the very top
// (kernel parity: allowed for EVERY op, ahead of the kind-aware
// `adminStandingOps` logic). So the connection "no use/execute" and agent_run
// "manage only" carve-outs are properties of the ADMIN-STANDING short-circuit —
// they bind the org_owner/org_admin path, which is exactly where a same-org
// second admin's automatic parity flows. The platform-admin credential-use
// ceiling is NOT the evaluator's job: it is enforced by the dedicated
// `decideConnectionUse` gate, whose vendor `only`-clamp neutralizes the
// platform_admin bypass (`stripPlatformAdmin`) — pinned by
// `src/lib/__tests__/connection-use-gate.test.ts`. Likewise agent_run DATA
// privacy on the run path is enforced by `enforceRunAccess` / `policyAllows`
// (§5). Asserting a false "evaluator denies platform_admin use" here would
// misrepresent the architecture, so this suite pins the org-admin evaluator
// carve-out + the platform-admin evaluator BYPASS explicitly, and defers the
// platform ceilings to their owning gates.

describe("P7 two-admin parity — connection carve-out (org-admin standing: see/manage, never use)", () => {
  it("org_admin B: list/read/manage ALLOWED on A's connection", () => {
    for (const op of ["list", "read", "manage"] as ExtensionAccessOp[]) {
      expect(decide("connection", userOwnedByA, adminBOrg, op)).toBe(true);
    }
  });
  it("org_admin B: use/execute DENIED on A's connection (credential use stays an owner share)", () => {
    expect(decide("connection", userOwnedByA, adminBOrg, "use")).toBe(false);
    expect(decide("connection", userOwnedByA, adminBOrg, "execute")).toBe(false);
  });

  it("platform_admin B BYPASSES the evaluator (allowed=true) — its credential-use ceiling is decideConnectionUse's only-clamp, not this gate", () => {
    expect(decide("connection", userOwnedByA, adminBPlatform, "use")).toBe(true);
  });

  it("the owner (A) CAN use their own connection — carve-out only removes the ADMIN-standing grant", () => {
    expect(decide("connection", userOwnedByA, adminA, "use")).toBe(true);
  });

  it("adminStandingOps encodes the connection carve-out (list/read/manage only)", () => {
    const ops = adminStandingOps("connection");
    expect(ops.has("list")).toBe(true);
    expect(ops.has("read")).toBe(true);
    expect(ops.has("manage")).toBe(true);
    expect(ops.has("use")).toBe(false);
    expect(ops.has("execute")).toBe(false);
    expect(ops.has("share")).toBe(false);
  });
});

describe("P7 two-admin parity — agent_run carve-out (org-admin standing: manage only, run data owner-private)", () => {
  it("org_admin B: manage ALLOWED but read/use/execute/share DENIED on A's run", () => {
    expect(decide("agent_run", userOwnedByA, adminBOrg, "manage")).toBe(true);
    for (const op of ["read", "use", "execute", "share"] as ExtensionAccessOp[]) {
      expect(decide("agent_run", userOwnedByA, adminBOrg, op)).toBe(false);
    }
  });

  it("adminStandingOps encodes the agent_run carve-out (manage only)", () => {
    const ops = adminStandingOps("agent_run");
    expect(ops.has("manage")).toBe(true);
    for (const op of ["list", "read", "use", "execute", "share"] as ExtensionAccessOp[]) {
      expect(ops.has(op)).toBe(false);
    }
  });

  it("platform_admin B BYPASSES the evaluator (allowed=true) — run DATA privacy is enforced on the run path (§5), not this gate", () => {
    expect(decide("agent_run", userOwnedByA, adminBPlatform, "read")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Catalog / list (P3) — manifestVisibleToScope: B sees every one of A's rows.
// ---------------------------------------------------------------------------

function manifest(over: Partial<ActiveExtensionManifest>): ActiveExtensionManifest {
  return {
    id: over.id ?? "m",
    packageName: over.packageName ?? "@a/pkg",
    kind: over.kind ?? "connector",
    ownerLevel: over.ownerLevel ?? "organization",
    ownerId: over.ownerId ?? null,
    organizationId: over.organizationId ?? null,
    status: over.status ?? "active",
  };
}

function scopeOf(actor: ActorContext): ExtensionDiscoveryScope {
  return {
    userId: actor.principalType === "HumanUser" ? actor.principalId : null,
    organizationId: actor.organizationId ?? null,
    teamIds: actor.teamIds ?? [],
    platformRole: actor.platformRole,
    orgRole: actor.orgRole,
  };
}

describe("P7 two-admin parity — catalog visibility (manifestVisibleToScope)", () => {
  const aManifests: ReadonlyArray<readonly [string, ActiveExtensionManifest]> = [
    ["org", manifest({ ownerLevel: "organization", organizationId: ORG_A, packageName: "@a/org" })],
    ["user (A)", manifest({ ownerLevel: "user", ownerId: ADMIN_A, organizationId: ORG_A, packageName: "@a/user" })],
    ["team (A1)", manifest({ ownerLevel: "team", ownerId: TEAM_A1, organizationId: ORG_A, packageName: "@a/team" })],
  ];

  for (const [bName, adminB] of adminBVariants) {
    for (const [mName, m] of aManifests) {
      it(`${bName} sees A's ${mName}-owned manifest in the catalog`, () => {
        expect(manifestVisibleToScope(m, scopeOf(adminB))).toBe(true);
      });
    }
  }

  it("a plain member sees ONLY the org row, NOT A's user/team rows (no member expansion)", () => {
    expect(manifestVisibleToScope(aManifests[0][1], scopeOf(memberA))).toBe(true); // org row: any same-org member
    expect(manifestVisibleToScope(aManifests[1][1], scopeOf(memberA))).toBe(false); // A's user row
    expect(manifestVisibleToScope(aManifests[2][1], scopeOf(memberA))).toBe(false); // A's team row (member not on team)
  });

  it("a cross-org admin sees NONE of A's org-anchored rows — org, user, AND team (guard wins)", () => {
    expect(manifestVisibleToScope(aManifests[0][1], scopeOf(adminCrossOrg))).toBe(false); // A's org row
    expect(manifestVisibleToScope(aManifests[1][1], scopeOf(adminCrossOrg))).toBe(false); // A's user row
    expect(manifestVisibleToScope(aManifests[2][1], scopeOf(adminCrossOrg))).toBe(false); // A's team row
  });
});

// ---------------------------------------------------------------------------
// 4. Lifecycle row addressing (P3/P5) — isInstallRowAddressableByActor +
//    pickActiveInstallId: B can address A's install rows to run lifecycle ops.
// ---------------------------------------------------------------------------

function installRow(over: Partial<InstallRowForPick>): InstallRowForPick {
  return {
    id: over.id ?? "row",
    status: over.status ?? "active",
    organizationId: over.organizationId ?? null,
    ownerId: over.ownerId ?? null,
    ownerLevel: over.ownerLevel ?? "organization",
  };
}

describe("P7 two-admin parity — lifecycle install-row addressing", () => {
  const aRows: ReadonlyArray<readonly [string, InstallRowForPick]> = [
    ["org", installRow({ id: "r-org", ownerLevel: "organization", organizationId: ORG_A })],
    ["user (A)", installRow({ id: "r-user", ownerLevel: "user", ownerId: ADMIN_A, organizationId: ORG_A })],
    ["team (A1)", installRow({ id: "r-team", ownerLevel: "team", ownerId: TEAM_A1, organizationId: ORG_A })],
  ];

  for (const [bName, adminB] of adminBVariants) {
    const scope = buildActorScopeForPick(adminB);
    for (const [rName, row] of aRows) {
      it(`${bName} can address A's ${rName}-owned install row (lifecycle parity)`, () => {
        expect(isInstallRowAddressableByActor(row, scope)).toBe(true);
      });
    }
    it(`${bName} resolves A's user-owned install id via pickActiveInstallId`, () => {
      expect(pickActiveInstallId([aRows[1][1]], scope)).toBe("r-user");
    });
  }

  it("a plain member CANNOT address A's user/team install rows (no regression)", () => {
    const scope = buildActorScopeForPick(memberA);
    expect(isInstallRowAddressableByActor(aRows[0][1], scope)).toBe(true); // org row: same-org
    expect(isInstallRowAddressableByActor(aRows[1][1], scope)).toBe(false); // A's user row
    expect(isInstallRowAddressableByActor(aRows[2][1], scope)).toBe(false); // A's team row
    expect(pickActiveInstallId([aRows[1][1]], scope)).toBeNull();
  });

  it("a cross-org admin CANNOT address A's org-anchored rows (guard wins)", () => {
    const scope = buildActorScopeForPick(adminCrossOrg);
    for (const [, row] of aRows) {
      expect(isInstallRowAddressableByActor(row, scope)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Run path (P4) — policyAllows. The run "admin" tier has a SPLIT semantic
//    (admin-parity P4, cinatra#1129): OWNER-AWARE for READ-tier ops (an
//    org_owner/org_admin of the run's org is admitted, mirroring the extension
//    evaluator), but platform/kernel-only for EXECUTE-tier ops
//    (execute/approveHitl/respondToHitl/cancel) — the run path never
//    execute-WIDENS to org admins. So an org admin's READ parity is admitted by
//    policyAllows directly, while its EXECUTE parity on the agent flows through
//    the owner-aware EXTENSION evaluator (admin standing, §1), NOT the run
//    "admin" execute tier. Pin every corner so neither half can silently drift.
// ---------------------------------------------------------------------------

describe("P7 two-admin parity — run path (policyAllows) owner-aware admin tier (P4)", () => {
  const ADMIN_TIER: AgentAuthPolicy = Object.freeze({
    runListVisibility: sel("admin"),
    runDataVisibility: sel("admin"),
    runExecuteVisibility: sel("admin"),
    allowRunSharing: false,
  }) as unknown as AgentAuthPolicy;

  it("platform_admin B satisfies the run 'admin' tier for read AND execute (bypass)", () => {
    expect(policyAllows(ADMIN_TIER, "read", adminBPlatform)).toBe(true);
    expect(policyAllows(ADMIN_TIER, "execute", adminBPlatform)).toBe(true);
  });

  it("org_admin B IS admitted on the run 'admin' tier for READ-tier ops (P4 owner-aware)", () => {
    expect(policyAllows(ADMIN_TIER, "read", adminBOrg)).toBe(true);
    expect(policyAllows(ADMIN_TIER, "list", adminBOrg)).toBe(true);
  });

  it("org_admin B is DENIED EXECUTE-tier ops on the run 'admin' tier (execute-widening stays platform/kernel)", () => {
    expect(policyAllows(ADMIN_TIER, "execute", adminBOrg)).toBe(false);
    expect(policyAllows(ADMIN_TIER, "approveHitl", adminBOrg)).toBe(false);
  });

  it("org_admin B's EXECUTE parity on the agent flows through the owner-aware EXTENSION evaluator instead", () => {
    expect(decide("agent_template", orgOwned, adminBOrg, "read", ADMIN_TIER)).toBe(true);
    expect(decide("agent_template", orgOwned, adminBOrg, "execute", ADMIN_TIER)).toBe(true);
  });

  it("a plain member is denied the run 'admin' tier for read AND execute (orgRole member)", () => {
    expect(policyAllows(ADMIN_TIER, "read", memberA)).toBe(false);
    expect(policyAllows(ADMIN_TIER, "execute", memberA)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. No-member-regression — a plain member's decisions equal the pre-parity
//    contract across every surface, for the WORKSPACE-tier baseline (what a
//    member IS meant to see) and the OWNER default (what stays hidden).
// ---------------------------------------------------------------------------

describe("P7 no-member-regression — plain member unchanged across surfaces", () => {
  it("evaluator: member reads a WORKSPACE-tier org row but NOT an OWNER-default row", () => {
    expect(decide("connector", orgOwned, memberA, "read", WORKSPACE_POLICY)).toBe(true);
    expect(decide("connector", orgOwned, memberA, "read", OWNER_POLICY)).toBe(false);
  });

  it("evaluator: member cannot MANAGE any row (admin/installer/co-owner only)", () => {
    expect(decide("connector", orgOwned, memberA, "manage", WORKSPACE_POLICY)).toBe(false);
  });

  it("run path: member follows the tier exactly (workspace allow, owner deny)", () => {
    expect(policyAllows(WORKSPACE_POLICY, "read", memberA)).toBe(true);
    expect(policyAllows(OWNER_POLICY, "read", memberA)).toBe(false);
  });

  it("catalog: member sees a workspace manifest but not A's user row", () => {
    const wsManifest = manifest({ ownerLevel: "workspace", packageName: "@x/ws" });
    expect(manifestVisibleToScope(wsManifest, scopeOf(memberA))).toBe(true);
    expect(
      manifestVisibleToScope(
        manifest({ ownerLevel: "user", ownerId: ADMIN_A, organizationId: ORG_A }),
        scopeOf(memberA),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Standing ceiling — an org-less (no organization_id) USER-owned row is not
//    an org an org_admin can be admin OF, so org-admin standing does NOT reach
//    it; only a platform admin (instance-wide) does. This pins the fail-closed
//    edge of hasAdminStandingOverExtension — an org_admin never over-broadens
//    to unanchored rows.
//
//    SCOPE NOTE: this is NOT the vendor `only` ceiling nor system-extension
//    protection. Those are enforced by their OWN gates — the per-connection
//    `decideConnectionUse` `only`-clamp (neutralizes even the platform_admin
//    bypass) and the platform-scoped / system-extension lifecycle gates — each
//    with its own suite (e.g. connection-use-gate.test.ts). This file
//    deliberately does not re-assert those; it proves the role-derived STANDING
//    layer that feeds them.
// ---------------------------------------------------------------------------

describe("P7 standing ceiling — org-less user-owned row excludes org-admin standing", () => {
  const orgLess: ExtensionOwnerContext = {
    ownerLevel: "user",
    ownerId: "some-other-user",
    organizationId: null, // no org anchor.
  };

  it("platform_admin B still reads an org-less row (instance-wide)", () => {
    expect(decide("connector", orgLess, adminBPlatform, "read")).toBe(true);
  });

  it("org_admin B does NOT read an org-less row they did not install (no org to be admin of)", () => {
    expect(decide("connector", orgLess, adminBOrg, "read")).toBe(false);
  });
});
