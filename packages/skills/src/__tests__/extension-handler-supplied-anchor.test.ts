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

/**
 * cinatra#3204 criterion 6, the REPOSITORY half — a package the operator
 * supplied by a public repository LINK takes the same finalized-store road a
 * package supplied as a FILE takes.
 *
 * Why it must: by the time this handler runs the bytes are already in the
 * content-addressed store, because the dispatcher fires the real-integrity
 * pipeline BEFORE the handler for this kind (criterion 19) and the pipeline has
 * already recorded the repository, the proven ref and the pinned commit on the
 * canonical row. The handler's job is to PROJECT that finalized payload into
 * the skills catalog — the branch is about WHERE THE PAYLOAD IS, not which
 * registry it came from.
 *
 * Why the legacy installer must not be entered: its first act parses its
 * argument as a repository reference (a resolved package name never is one) and
 * its second mints a connection-bearing client, so a supplied repository
 * package handed to it is refused for a connection this road never needed —
 * the operator provided a public link and the instance fetched the ZIP.
 *
 * The discriminator is therefore whether the ref is SUPPLIED (declared
 * provenance carrying a content digest), never the provenance's type.
 */
const SUPPLIED_REPOSITORY_SHA = "58b073bc7a2a4ac9626b07e41ecee5e3218d87a2";

const suppliedRepositoryRef = {
  registryUrl: "supplied:package",
  packageName: "@cinatra-ai/web-research-skill",
  version: "0.1.0",
  provenance: {
    type: "github" as const,
    repo: "cinatra-ai/web-research-skill",
    ref: "main",
    resolvedSha: SUPPLIED_REPOSITORY_SHA,
    contentDigest: "a".repeat(64),
  },
};

/**
 * The pre-existing road this must leave alone: a ref that declares NO supplied
 * provenance and whose package name genuinely IS `owner/repo` — the configured-
 * repository sync. It keeps the legacy installer and its connection.
 */
const configuredRepositoryRef = {
  registryUrl: "",
  packageName: "cinatra-ai/web-research-skill",
};

describe("a SUPPLIED repository package is projected from the FINALIZED store payload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("installs through the finalized-store arm at the planned anchor, and never enters the legacy GitHub installer", async () => {
    const handler = createSkillExtensionHandler();
    await handler.install(suppliedRepositoryRef as never, actor as never, {
      rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null },
    } as never);

    expect(githubMock).not.toHaveBeenCalled();
    // The kind's own observable: the package, its version and the anchor's
    // organization scope — the payload the catalog is registered against.
    expect(verdaccioMock).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/web-research-skill",
      packageVersion: "0.1.0",
      orgId: null,
    });
  });

  it("updates the same way — a supplied repository ref never reaches the legacy installer", async () => {
    const handler = createSkillExtensionHandler();
    await handler.update(suppliedRepositoryRef as never, actor as never);

    expect(githubMock).not.toHaveBeenCalled();
    expect(verdaccioMock).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@cinatra-ai/web-research-skill" }),
    );
  });

  it("leaves the legacy road exactly as it was for a ref that declares NO supplied provenance", async () => {
    const handler = createSkillExtensionHandler();
    await handler.install(configuredRepositoryRef as never, actor as never);

    expect(githubMock).toHaveBeenCalledWith("cinatra-ai/web-research-skill");
    expect(verdaccioMock).not.toHaveBeenCalled();
  });
});
