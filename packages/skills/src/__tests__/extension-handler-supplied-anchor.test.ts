/**
 * cinatra#3204 criterion 16, the SKILL half — a supplied skill install resolves
 * its finalized store payload at the anchor the OPERATOR chose, not at the
 * organization the actor happens to be in.
 *
 * The two differ on every "Workspace: All" install: the dispatcher finalizes the
 * store payload at the org-NULL workspace anchor, while the actor still has an
 * active organization. Looking the payload up at `actor.orgId` found nothing and
 * the handler refused a package that had just been installed correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { verdaccioMock, matchMock, rebuildMock, githubMock, uninstallMock } = vi.hoisted(() => ({
  verdaccioMock: vi.fn().mockResolvedValue(undefined),
  matchMock: vi.fn().mockResolvedValue(undefined),
  rebuildMock: vi.fn().mockResolvedValue({ skillPackages: [], skills: [] }),
  githubMock: vi.fn().mockResolvedValue(undefined),
  uninstallMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("../verdaccio", () => ({ installSkillPackageFromVerdaccio: verdaccioMock }));
vi.mock("../github", () => ({ installSkillPackageFromGitHub: githubMock }));
vi.mock("../skills-store", () => ({ uninstallSkillPackage: uninstallMock }));
vi.mock("../skill-packages", () => ({ rebuildSkillsCatalog: rebuildMock }));
vi.mock("@/lib/agents-store", () => ({ matchAgentsToSkills: matchMock }));

import { createSkillExtensionHandler } from "../extension-handler";

const actor = { actorType: "human" as const, userId: "u1", source: "ui" as const, orgId: "org-1" };

/** A package the operator SUPPLIED as a file — declared provenance, no registry. */
const suppliedRef = {
  registryUrl: "supplied:package",
  packageName: "@acme/thing-skill",
  version: "1.0.0",
  provenance: { type: "local" as const },
};

describe("the skill handler installs at the PLANNED anchor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a WORKSPACE-anchored install resolves its payload at the org-NULL anchor, not the actor's org", async () => {
    const handler = createSkillExtensionHandler();
    await handler.install(suppliedRef as never, actor as never, {
      rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null },
    } as never);
    expect(verdaccioMock).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@acme/thing-skill", orgId: null }),
    );
  });

  it("an ORGANIZATION-anchored install resolves at the anchor's own org", async () => {
    const handler = createSkillExtensionHandler();
    await handler.install(suppliedRef as never, actor as never, {
      rowOwnership: { ownerLevel: "organization", ownerId: "org-9", organizationId: "org-9" },
    } as never);
    expect(verdaccioMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-9" }));
  });

  it("with NO planned anchor the derivation is byte-identical to what it was — the actor's org", async () => {
    const handler = createSkillExtensionHandler();
    await handler.install(suppliedRef as never, actor as never);
    expect(verdaccioMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1" }));
  });
});
