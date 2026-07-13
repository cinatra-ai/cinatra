import { describe, it, expect } from "vitest";
import {
  pickActiveInstall,
  pickActiveInstallId,
  isInstallRowAddressableByActor,
  buildActorScopeForPick,
  type ActorScopeForPick,
  type InstallRowForPick,
} from "@/lib/extension-install-resolution";

const ORG = "org-1";
const USER = "user-1";
const TEAM = "team-1";

function row(p: Partial<InstallRowForPick>): InstallRowForPick {
  return {
    id: "inst-x",
    status: "active",
    organizationId: ORG,
    ownerId: null,
    ownerLevel: "organization",
    ...p,
  };
}

// Default actor: a member of ORG and TEAM. Override per test.
function actor(p: Partial<ActorScopeForPick> = {}): ActorScopeForPick {
  return { organizationId: ORG, ownerId: USER, teamIds: [TEAM], ...p };
}

// cinatra#1392 S9: `pickActiveInstallId` now delegates to the row-returning
// `pickActiveInstall` so the setup-hydration caller can read the picked
// install's version identity (isDefault/version).
describe("pickActiveInstall (row-returning; pickActiveInstallId delegates to it)", () => {
  it("returns the WHOLE picked row (not just the id), preserving extra fields", () => {
    const rows = [
      { ...row({ id: "inst-nd", organizationId: ORG, ownerLevel: "organization" }), isDefault: false, version: "0.1.4" },
    ];
    const picked = pickActiveInstall(rows, actor());
    expect(picked?.id).toBe("inst-nd");
    expect(picked?.isDefault).toBe(false);
    expect((picked as { version?: string }).version).toBe("0.1.4");
    // The delegating wrapper returns the same row's id.
    expect(pickActiveInstallId(rows, actor())).toBe("inst-nd");
  });

  it("returns null (both forms) when no row is addressable", () => {
    expect(pickActiveInstall([], actor())).toBeNull();
    expect(pickActiveInstallId([], actor())).toBeNull();
  });
});

describe("pickActiveInstallId", () => {
  it("returns the id of an active org-scoped row for a member of that org", () => {
    const rows = [row({ id: "inst-1", organizationId: ORG, ownerLevel: "organization" })];
    expect(pickActiveInstallId(rows, actor())).toBe("inst-1");
  });

  it("treats a 'locked' row as live", () => {
    const rows = [row({ id: "inst-2", status: "locked" })];
    expect(pickActiveInstallId(rows, actor())).toBe("inst-2");
  });

  it("skips archived (non-live) rows", () => {
    const rows = [row({ id: "inst-3", status: "archived" })];
    expect(pickActiveInstallId(rows, actor())).toBeNull();
  });

  it("never addresses a cross-org row", () => {
    const rows = [row({ id: "inst-4", organizationId: "org-other" })];
    expect(pickActiveInstallId(rows, actor())).toBeNull();
  });

  it("addresses a workspace-level (no-org) row for any authenticated actor", () => {
    const rows = [row({ id: "inst-5", organizationId: null, ownerLevel: "workspace", ownerId: null })];
    expect(pickActiveInstallId(rows, actor())).toBe("inst-5");
  });

  it("only surfaces a user-owned row to its owner", () => {
    const mine = [row({ id: "inst-6", ownerLevel: "user", ownerId: USER })];
    const theirs = [row({ id: "inst-7", ownerLevel: "user", ownerId: "user-2" })];
    expect(pickActiveInstallId(mine, actor())).toBe("inst-6");
    expect(pickActiveInstallId(theirs, actor())).toBeNull();
  });

  it("surfaces a team-owned row to a member of that team (positive)", () => {
    const rows = [row({ id: "inst-team", ownerLevel: "team", ownerId: TEAM })];
    // actor is in TEAM but is NOT the owner principal — the legacy bug compared
    // ownerId to principalId and never surfaced legitimate team installs.
    expect(pickActiveInstallId(rows, actor({ teamIds: [TEAM] }))).toBe("inst-team");
  });

  it("never surfaces a team-owned row to a non-member of that team (negative)", () => {
    const rows = [row({ id: "inst-team2", ownerLevel: "team", ownerId: "team-other" })];
    // actor is in TEAM, not team-other.
    expect(pickActiveInstallId(rows, actor({ teamIds: [TEAM] }))).toBeNull();
    // and an actor in no team at all sees nothing.
    expect(pickActiveInstallId(rows, actor({ teamIds: [] }))).toBeNull();
  });

  it("does NOT confuse the actor's principalId with team membership for a team row", () => {
    // A team row whose ownerId happens to equal the actor's principalId must NOT
    // match unless that id is genuinely a team the actor belongs to.
    const rows = [row({ id: "inst-team3", ownerLevel: "team", ownerId: USER })];
    expect(pickActiveInstallId(rows, actor({ ownerId: USER, teamIds: [TEAM] }))).toBeNull();
  });

  it("fails closed on a malformed owner-less USER row (ownerId: null is never surfaced)", () => {
    // The DB invariant is that a user row always carries an owner, but the pure
    // auth predicate must not trust that invariant — a null owner can never be
    // authorized against a concrete actor.
    const rows = [row({ id: "inst-user-null", ownerLevel: "user", ownerId: null })];
    expect(pickActiveInstallId(rows, actor({ ownerId: USER }))).toBeNull();
    // Even an actor with a null ownerId must not match a null-owner user row.
    expect(pickActiveInstallId(rows, actor({ ownerId: null }))).toBeNull();
  });

  it("fails closed on a malformed owner-less TEAM row (ownerId: null is never surfaced)", () => {
    const rows = [row({ id: "inst-team-null", ownerLevel: "team", ownerId: null })];
    expect(pickActiveInstallId(rows, actor({ teamIds: [TEAM] }))).toBeNull();
    // and an actor in no team at all also sees nothing.
    expect(pickActiveInstallId(rows, actor({ teamIds: [] }))).toBeNull();
  });

  it("returns the first matching live row when several exist", () => {
    const rows = [
      row({ id: "archived", status: "archived" }),
      row({ id: "live-a" }),
      row({ id: "live-b" }),
    ];
    expect(pickActiveInstallId(rows, actor())).toBe("live-a");
  });

  it("returns null when no rows exist (caller renders the Install / Activate CTA)", () => {
    expect(pickActiveInstallId([], actor())).toBeNull();
  });
});

describe("isInstallRowAddressableByActor — admin standing (P3)", () => {
  it("a platform_admin addresses any row, including cross-org and non-owned", () => {
    const pa = actor({ organizationId: ORG, ownerId: USER, platformRole: "platform_admin" });
    expect(
      isInstallRowAddressableByActor(
        row({ organizationId: "org-other", ownerLevel: "user", ownerId: "user-9" }),
        pa,
      ),
    ).toBe(true);
  });

  it("an org_admin addresses user/team rows of their org they do not own / belong to", () => {
    const admin = actor({ orgRole: "org_admin", ownerId: USER, teamIds: [] });
    expect(
      isInstallRowAddressableByActor(
        row({ organizationId: ORG, ownerLevel: "user", ownerId: "user-2" }),
        admin,
      ),
    ).toBe(true);
    expect(
      isInstallRowAddressableByActor(
        row({ organizationId: ORG, ownerLevel: "team", ownerId: "team-z" }),
        admin,
      ),
    ).toBe(true);
  });

  it("an org_admin does NOT address a cross-org row (cross-org safety)", () => {
    const admin = actor({ orgRole: "org_admin" });
    expect(
      isInstallRowAddressableByActor(
        row({ organizationId: "org-other", ownerLevel: "user", ownerId: "user-2" }),
        admin,
      ),
    ).toBe(false);
  });

  it("a plain member gains no admin addressability (unchanged)", () => {
    expect(
      isInstallRowAddressableByActor(
        row({ organizationId: ORG, ownerLevel: "user", ownerId: "user-2" }),
        actor({ orgRole: "member" }),
      ),
    ).toBe(false);
  });
});

describe("pickActiveInstallId — same-org determinism for a platform_admin (P3)", () => {
  it("prefers the actor's active-org row over a cross-org row a platform_admin can also address", () => {
    const pa = actor({ organizationId: ORG, platformRole: "platform_admin" });
    const rows = [
      row({ id: "cross", organizationId: "org-other", ownerLevel: "organization" }),
      row({ id: "mine", organizationId: ORG, ownerLevel: "organization" }),
    ];
    expect(pickActiveInstallId(rows, pa)).toBe("mine");
  });

  it("still addresses a lone cross-org row for a platform_admin (no same-org candidate)", () => {
    const pa = actor({ organizationId: ORG, platformRole: "platform_admin" });
    const rows = [row({ id: "cross-only", organizationId: "org-other", ownerLevel: "organization" })];
    expect(pickActiveInstallId(rows, pa)).toBe("cross-only");
  });
});

describe("buildActorScopeForPick", () => {
  it("threads the admin-standing role fields from the actor", () => {
    const scope = buildActorScopeForPick({
      organizationId: ORG,
      principalId: USER,
      teamIds: [TEAM],
      platformRole: "platform_admin",
      orgRole: "org_admin",
    });
    expect(scope).toEqual({
      organizationId: ORG,
      ownerId: USER,
      teamIds: [TEAM],
      platformRole: "platform_admin",
      orgRole: "org_admin",
    });
  });

  it("defaults ids to null and leaves roles undefined for a roleless actor", () => {
    expect(buildActorScopeForPick({})).toEqual({
      organizationId: null,
      ownerId: null,
      teamIds: [],
      platformRole: undefined,
      orgRole: undefined,
    });
  });
});
