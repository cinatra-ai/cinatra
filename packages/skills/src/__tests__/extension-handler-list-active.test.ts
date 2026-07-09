// Unit test for the true-IoC reader facet `listActive` on the skill handler.
// Runs with no DB: `listInstalledSkills` (the skills catalog reader) is mocked,
// and the install-source modules the handler imports are stubbed so the module
// graph loads. The shared manifest-gate helper (`visibleManifestPackageNames`)
// is left real so the actual intersection logic is exercised.
//
// Contract: the skills catalog is the VISIBILITY authority. listActive keeps a
// skill ONLY when its package is BOTH lifecycle-live + owner-visible per the
// dispatcher's `manifests` (the coarse status gate) AND the skill row itself is
// visible to the actor's resolved scope. This fixes BOTH over-exposure (never
// surface another owner's row by package name) and under-exposure (scoped rows
// are included when the actor's scope permits).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("../github", () => ({ installSkillPackageFromGitHub: vi.fn() }));
vi.mock("../verdaccio", () => ({ installSkillPackageFromVerdaccio: vi.fn() }));
vi.mock("../skills-store", () => ({ uninstallSkillPackage: vi.fn() }));
vi.mock("../skill-package-source", () => ({ resolveSkillPackageSource: vi.fn() }));

vi.mock("@/lib/agents-store", () => ({
  matchAgentsToSkills: vi.fn(),
  readAgentSkillMatches: vi.fn(),
  saveAgentSkillMatches: vi.fn(),
}));

vi.mock("../skills-registry", () => ({ listInstalledSkills: vi.fn() }));

import { createSkillExtensionHandler } from "../extension-handler";
import { listInstalledSkills } from "../skills-registry";
import type {
  ActiveExtensionManifest,
  ExtensionDiscoveryScope,
} from "@cinatra-ai/extension-types";

const actor = { userId: "u1", actorType: "human", source: "ui" } as never;

function skill(over: Record<string, unknown>): never {
  return {
    id: "s",
    name: "Skill",
    slug: "skill",
    description: "",
    packageId: "p",
    packageName: "@cinatra-ai/some-skill",
    packageSlug: "some-skill",
    content: "",
    usedBy: [],
    ...over,
  } as never;
}

function manifest(over: Partial<ActiveExtensionManifest> = {}): ActiveExtensionManifest {
  return {
    id: "m",
    packageName: "@cinatra-ai/some-skill",
    kind: "skill",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    status: "active",
    ...over,
  };
}

function scope(over: Partial<ExtensionDiscoveryScope> = {}): ExtensionDiscoveryScope {
  return {
    userId: "u1",
    organizationId: "org-1",
    teamIds: [],
    projectIds: [],
    ...over,
  };
}

describe("skill handler listActive (true-IoC reader facet)", () => {
  let handler: ReturnType<typeof createSkillExtensionHandler>;
  beforeEach(() => {
    vi.resetAllMocks();
    handler = createSkillExtensionHandler();
  });

  it("returns only skills whose packageName is in a visible-live manifest", async () => {
    vi.mocked(listInstalledSkills).mockResolvedValue([
      skill({ id: "1", packageName: "@cinatra-ai/live-skill", level: "workspace" }),
      skill({ id: "2", packageName: "@cinatra-ai/not-live-skill", level: "workspace" }),
    ]);
    const result = (await handler.listActive!({
      actor,
      scope: scope(),
      // only live-skill is lifecycle-live
      manifests: [manifest({ packageName: "@cinatra-ai/live-skill" })],
    })) as Array<{ id: string }>;
    expect(result.map((s) => s.id)).toEqual(["1"]);
  });

  it("excludes a skill whose package's manifest is owner-scoped to another owner (not owner-visible)", async () => {
    vi.mocked(listInstalledSkills).mockResolvedValue([
      skill({ id: "1", packageName: "@acme/private-skill", level: "workspace" }),
    ]);
    const result = await handler.listActive!({
      actor,
      // actor is in org-1, but the manifest is owned by a different org -> the
      // shared manifest gate drops the package name, so the skill is excluded
      // even though the row-level predicate would pass.
      scope: scope({ organizationId: "org-1" }),
      manifests: [
        manifest({
          packageName: "@acme/private-skill",
          ownerLevel: "organization",
          organizationId: "org-OTHER",
        }),
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("applies skill-row visibility: a personal skill owned by another user is excluded", async () => {
    vi.mocked(listInstalledSkills).mockResolvedValue([
      // lifecycle-live + owner-visible package, but the ROW belongs to user u2
      skill({ id: "mine", packageName: "@cinatra-ai/personal-pack", level: "personal", scope: "u1" }),
      skill({ id: "theirs", packageName: "@cinatra-ai/personal-pack", level: "personal", scope: "u2" }),
    ]);
    const result = (await handler.listActive!({
      actor,
      scope: scope({ userId: "u1" }),
      manifests: [manifest({ packageName: "@cinatra-ai/personal-pack" })],
    })) as Array<{ id: string }>;
    expect(result.map((s) => s.id)).toEqual(["mine"]);
  });

  it("drops skills with no packageName", async () => {
    vi.mocked(listInstalledSkills).mockResolvedValue([
      skill({ id: "1", packageName: null, level: "workspace" }),
      skill({ id: "2", packageName: "@cinatra-ai/live-skill", level: "workspace" }),
    ]);
    const result = (await handler.listActive!({
      actor,
      scope: scope(),
      manifests: [manifest({ packageName: "@cinatra-ai/live-skill" })],
    })) as Array<{ id: string }>;
    expect(result.map((s) => s.id)).toEqual(["2"]);
  });

  it("system-level skills are visible only to platform admins", async () => {
    vi.mocked(listInstalledSkills).mockResolvedValue([
      skill({ id: "sys", packageName: "@cinatra-ai/sys-skill", level: "system" }),
    ]);
    const memberResult = await handler.listActive!({
      actor,
      scope: scope({ platformRole: "member" }),
      manifests: [manifest({ packageName: "@cinatra-ai/sys-skill" })],
    });
    expect(memberResult).toHaveLength(0);

    const adminResult = await handler.listActive!({
      actor,
      scope: scope({ platformRole: "platform_admin" }),
      manifests: [manifest({ packageName: "@cinatra-ai/sys-skill" })],
    });
    expect(adminResult).toHaveLength(1);
  });

  describe("admin standing (P3)", () => {
    it("platform_admin sees another user's personal skill even behind a user-level manifest", async () => {
      // Pre-P3 the manifest gate had no platform_admin bypass, so a user-owned
      // manifest hid the package name from a platform admin. Surface 1 fixes the
      // gate; skillVisibleToScope already admits platform_admin ⇒ full parity.
      vi.mocked(listInstalledSkills).mockResolvedValue([
        skill({ id: "theirs", packageName: "@cinatra-ai/personal-pack", level: "personal", scope: "u2" }),
      ]);
      const result = (await handler.listActive!({
        actor,
        scope: scope({ userId: "u1", organizationId: "org-1", platformRole: "platform_admin" }),
        manifests: [
          manifest({
            packageName: "@cinatra-ai/personal-pack",
            ownerLevel: "user",
            ownerId: "u2",
            organizationId: "org-1",
          }),
        ],
      })) as Array<{ id: string }>;
      expect(result.map((s) => s.id)).toEqual(["theirs"]);
    });

    it("org_admin does NOT see another user's personal skill via the facet (org carve-out deferred; no leak)", async () => {
      // The org-admin skills-facet carve-out is deferred pending a per-skill org
      // anchor (skill rows carry no org; package names can collide across orgs).
      // The per-row predicate stays authoritative for org admins.
      vi.mocked(listInstalledSkills).mockResolvedValue([
        skill({ id: "mine", packageName: "@cinatra-ai/personal-pack", level: "personal", scope: "u1" }),
        skill({ id: "theirs", packageName: "@cinatra-ai/personal-pack", level: "personal", scope: "u2" }),
      ]);
      const result = (await handler.listActive!({
        actor,
        scope: scope({ userId: "u1", organizationId: "org-1", orgRole: "org_admin" }),
        manifests: [
          manifest({
            packageName: "@cinatra-ai/personal-pack",
            ownerLevel: "user",
            ownerId: "u1",
            organizationId: "org-1",
          }),
        ],
      })) as Array<{ id: string }>;
      // sees only their OWN personal row, not u2's.
      expect(result.map((s) => s.id)).toEqual(["mine"]);
    });

    it("an org admin never sees another org's package via the manifest gate (cross-org safe)", async () => {
      vi.mocked(listInstalledSkills).mockResolvedValue([
        skill({ id: "org2secret", packageName: "@acme/org2-pack", level: "personal", scope: "u9" }),
      ]);
      const result = await handler.listActive!({
        actor,
        scope: scope({ userId: "u1", organizationId: "org-1", orgRole: "org_admin" }),
        manifests: [
          manifest({
            packageName: "@acme/org2-pack",
            ownerLevel: "user",
            ownerId: "u9",
            organizationId: "org-2",
          }),
        ],
      });
      expect(result).toHaveLength(0);
    });
  });
});
