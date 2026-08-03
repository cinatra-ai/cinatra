// The SHARED assignability predicate (cinatra#2346 S1, epic #2345).
//
// This is the epic-wide helper S1 owns and S2/S3 consume, so its three
// conjuncts — canonical install active-or-locked, globally visible catalog row,
// resolved role `injectable` — are pinned here once, on the pure core AND on
// the composed I/O path.
import { describe, expect, it, vi } from "vitest";

import {
  buildSkillIdOwnership,
  DEFAULT_SKILL_ROLE,
  evaluateAssignability,
  isGloballyVisibleCatalogRow,
  resolveSkillAssignability,
  resolveSkillPackageRoles,
  type AssignabilityFacts,
} from "./agent-skill-assignability";
import type { SkillExtensionDescriptor } from "./extension-skill-resolver";
import type { PersistedSkill } from "./skills-store";

function skill(overrides: Partial<PersistedSkill> = {}): PersistedSkill {
  return {
    id: "@cinatra-ai/list-curation-skill:list-curation",
    name: "List Curation",
    slug: "list-curation",
    description: "Curate lists.",
    content: "",
    packageId: "pkg",
    packageName: "@cinatra-ai/list-curation-skill",
    packageSlug: "cinatra-ai-list-curation-skill",
    usedBy: [],
    level: "workspace",
    ...overrides,
  } as PersistedSkill;
}

function facts(overrides: Partial<AssignabilityFacts> = {}): AssignabilityFacts {
  return {
    skillId: "@cinatra-ai/list-curation-skill:list-curation",
    skill: skill(),
    ownerPackageName: "@cinatra-ai/list-curation-skill",
    installStatus: "active",
    role: "injectable",
    ...overrides,
  };
}

function descriptor(overrides: Partial<SkillExtensionDescriptor>): SkillExtensionDescriptor {
  return {
    pkgDir: "/x",
    pkgName: "@cinatra-ai/list-curation-skill",
    pkgDirName: "list-curation-skill",
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs: ["list-curation"],
    ...overrides,
  };
}

describe("evaluateAssignability — the three conjuncts, fail-closed", () => {
  it("admits a workspace-level skill of a live, injectable extension", () => {
    const out = evaluateAssignability(facts());
    expect(out.assignable).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.skill).toMatchObject({ name: "List Curation", level: "workspace" });
  });

  it("refuses an UNKNOWN skill id", () => {
    expect(evaluateAssignability(facts({ skill: null }))).toMatchObject({
      assignable: false,
      reason: "unknown-skill",
    });
  });

  it("refuses a NON-globally-visible catalog row (owner-scoped)", () => {
    // The assignment store carries no owner tuple, so an owner-scoped skill
    // could never be resolved consistently by an actor-less worker run.
    const cases: Array<Partial<PersistedSkill>> = [
      { level: "personal" },
      { level: "team", scope: "team_123" },
      { level: "project", scope: "proj_9" },
      { level: "organization", scope: "org_1" },
      { level: "agent", agentId: "@cinatra-ai/web-scrape-agent" },
      { isCustomSkill: true },
      { isCustom: true },
      { ownerUserId: "user_42" },
      { level: undefined },
    ];
    for (const patch of cases) {
      expect(
        evaluateAssignability(facts({ skill: skill(patch) })),
        JSON.stringify(patch),
      ).toMatchObject({ assignable: false, reason: "not-globally-visible" });
    }
  });

  it("admits system level (globally visible, no owner scoping)", () => {
    expect(isGloballyVisibleCatalogRow(skill({ level: "system" }))).toBe(true);
  });

  it("refuses a skill NO on-disk extension owns", () => {
    expect(evaluateAssignability(facts({ ownerPackageName: null }))).toMatchObject({
      assignable: false,
      reason: "no-owning-extension",
    });
  });

  it("refuses a package with NO canonical install row (bundled/vendored)", () => {
    // Deliberate inversion of the delivery scan's fail-OPEN "no row = keep":
    // offering an assignment against an untracked lifecycle could never honor
    // the uninstall teardown.
    expect(evaluateAssignability(facts({ installStatus: "none" }))).toMatchObject({
      assignable: false,
      reason: "not-installed",
    });
  });

  it("refuses an ARCHIVED package", () => {
    expect(evaluateAssignability(facts({ installStatus: "archived" }))).toMatchObject({
      assignable: false,
      reason: "archived",
    });
  });

  it("refuses when the lifecycle status could not be read", () => {
    expect(evaluateAssignability(facts({ installStatus: "unreadable" }))).toMatchObject({
      assignable: false,
      reason: "lifecycle-read-failed",
    });
  });

  it("refuses a NON-injectable role", () => {
    for (const role of ["matcher", "internal"] as const) {
      expect(evaluateAssignability(facts({ role }))).toMatchObject({
        assignable: false,
        reason: "not-injectable",
      });
    }
  });

  it("reports the FIRST failing conjunct so refusal reasons stay stable", () => {
    // Everything is wrong at once; the caller still gets the visibility reason
    // (conjunct 2) rather than a race between them.
    expect(
      evaluateAssignability(
        facts({ skill: skill({ level: "personal" }), installStatus: "archived", role: "matcher" }),
      ).reason,
    ).toBe("not-globally-visible");
  });
});

describe("resolveSkillPackageRoles — authoritative manifest data only", () => {
  it("defaults an unreferenced skill package to injectable", () => {
    const roles = resolveSkillPackageRoles([descriptor({})]);
    expect(roles.get("@cinatra-ai/list-curation-skill")).toBe(DEFAULT_SKILL_ROLE);
    expect(DEFAULT_SKILL_ROLE).toBe("injectable");
  });

  it("demotes a package consumed through a role:'matcher' dependency edge", () => {
    const roles = resolveSkillPackageRoles([
      descriptor({ pkgName: "@cinatra-ai/blog-idea-matcher-skill", pkgDirName: "blog-idea-matcher-skill" }),
      descriptor({
        pkgName: "@cinatra-ai/blog-idea-artifact",
        pkgDirName: "blog-idea-artifact",
        kind: "artifact",
        slugs: [],
        dependencies: [
          {
            packageName: "@cinatra-ai/blog-idea-matcher-skill",
            kind: "skill",
            role: "matcher",
            edgeType: "runtime",
            requirement: "required",
          },
        ],
      }),
    ]);
    expect(roles.get("@cinatra-ai/blog-idea-matcher-skill")).toBe("matcher");
  });

  it("demotes a package consumed through a role:'authoring' edge", () => {
    const roles = resolveSkillPackageRoles([
      descriptor({ pkgName: "@cinatra-ai/marketing-icp-authoring-skill", pkgDirName: "marketing-icp-authoring-skill" }),
      descriptor({
        pkgName: "@cinatra-ai/marketing-icp-artifact",
        pkgDirName: "marketing-icp-artifact",
        kind: "artifact",
        slugs: [],
        dependencies: [
          {
            packageName: "@cinatra-ai/marketing-icp-authoring-skill",
            kind: "skill",
            role: "authoring",
            edgeType: "runtime",
            requirement: "required",
          },
        ],
      }),
    ]);
    expect(roles.get("@cinatra-ai/marketing-icp-authoring-skill")).toBe("matcher");
  });

  it("an UNROLED edge leaves the package injectable (an absent role means plain delivery)", () => {
    const roles = resolveSkillPackageRoles([
      descriptor({}),
      descriptor({
        pkgName: "@cinatra-ai/web-scrape-agent",
        pkgDirName: "web-scrape-agent",
        kind: "agent",
        slugs: [],
        dependencies: [
          {
            packageName: "@cinatra-ai/list-curation-skill",
            kind: "skill",
            edgeType: "runtime",
            requirement: "required",
          },
        ],
      }),
    ]);
    expect(roles.get("@cinatra-ai/list-curation-skill")).toBe("injectable");
  });

  it("the package's OWN cinatra.skillRole declaration WINS over consumer edges", () => {
    const roles = resolveSkillPackageRoles([
      descriptor({ skillRole: "injectable" }),
      descriptor({
        pkgName: "@some/artifact",
        pkgDirName: "artifact",
        kind: "artifact",
        slugs: [],
        dependencies: [
          {
            packageName: "@cinatra-ai/list-curation-skill",
            kind: "skill",
            role: "matcher",
            edgeType: "runtime",
            requirement: "required",
          },
        ],
      }),
    ]);
    expect(roles.get("@cinatra-ai/list-curation-skill")).toBe("injectable");
  });

  it("an `internal` declaration is honored", () => {
    const roles = resolveSkillPackageRoles([descriptor({ skillRole: "internal" })]);
    expect(roles.get("@cinatra-ai/list-curation-skill")).toBe("internal");
  });

  it("an unrecognized declared value falls back to the inferred role (never trusted verbatim)", () => {
    const roles = resolveSkillPackageRoles([descriptor({ skillRole: "wharrgarbl" })]);
    expect(roles.get("@cinatra-ai/list-curation-skill")).toBe("injectable");
  });
});

describe("buildSkillIdOwnership — the REAL owning package", () => {
  it("maps a plain skill package's slugs to its own name", () => {
    const owners = buildSkillIdOwnership([descriptor({ slugs: ["list-curation", "second"] })]);
    expect(owners.get("@cinatra-ai/list-curation-skill:list-curation")).toBe(
      "@cinatra-ai/list-curation-skill",
    );
    expect(owners.get("@cinatra-ai/list-curation-skill:second")).toBe(
      "@cinatra-ai/list-curation-skill",
    );
  });

  it("maps a VIRTUAL chat-namespace id back to the REAL owning package", () => {
    // The five successor packages register under `@cinatra-ai/chat:` — a
    // namespace with no install row. Resolving them by the catalog row's own
    // packageName would make them permanently unassignable.
    const owners = buildSkillIdOwnership([
      descriptor({
        pkgName: "@cinatra-ai/blog-content-skill",
        pkgDirName: "blog-content-skill",
        slugs: ["chat-blog-content"],
      }),
    ]);
    expect(owners.get("@cinatra-ai/chat:chat-blog-content")).toBe(
      "@cinatra-ai/blog-content-skill",
    );
  });

  it("skips a package impersonating the reserved namespace rather than aborting", () => {
    const owners = buildSkillIdOwnership([
      descriptor({ pkgName: "@cinatra-ai/chat", pkgDirName: "chat", slugs: ["evil"] }),
      descriptor({ slugs: ["list-curation"] }),
    ]);
    expect(owners.has("@cinatra-ai/chat:evil")).toBe(false);
    expect(owners.get("@cinatra-ai/list-curation-skill:list-curation")).toBe(
      "@cinatra-ai/list-curation-skill",
    );
  });

  it("ignores non-skill kinds", () => {
    const owners = buildSkillIdOwnership([
      descriptor({ kind: "agent", pkgName: "@x/a", pkgDirName: "a", slugs: ["s"] }),
    ]);
    expect(owners.size).toBe(0);
  });
});

describe("resolveSkillAssignability — composed, fail-closed", () => {
  const deps = {
    readCatalog: async () => ({ skills: [skill()] }),
    scanExtensions: async () => [descriptor({})],
    readInstallStatus: async (names: string[]) =>
      new Map(names.map((n) => [n, "active" as const])),
  };

  it("returns an assignable verdict for a live workspace skill", async () => {
    const out = await resolveSkillAssignability(
      ["@cinatra-ai/list-curation-skill:list-curation"],
      deps,
    );
    expect(out.get("@cinatra-ai/list-curation-skill:list-curation")).toMatchObject({
      assignable: true,
      ownerPackageName: "@cinatra-ai/list-curation-skill",
      role: "injectable",
    });
  });

  it("refuses EVERY id when the catalog read fails (never an approval)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await resolveSkillAssignability(["a", "b"], {
      ...deps,
      readCatalog: async () => {
        throw new Error("catalog down");
      },
    });
    expect([...out.values()].every((v) => v.assignable === false)).toBe(true);
    expect(out.get("a")?.reason).toBe("lifecycle-read-failed");
    warn.mockRestore();
  });

  it("refuses when the INSTALL-STATUS read fails (fail-closed, not fail-open)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await resolveSkillAssignability(
      ["@cinatra-ai/list-curation-skill:list-curation"],
      {
        ...deps,
        readInstallStatus: async () => {
          throw new Error("extensions store down");
        },
      },
    );
    expect(out.get("@cinatra-ai/list-curation-skill:list-curation")).toMatchObject({
      assignable: false,
      reason: "lifecycle-read-failed",
    });
    warn.mockRestore();
  });

  it("refuses a package whose install rows are ALL archived", async () => {
    const out = await resolveSkillAssignability(
      ["@cinatra-ai/list-curation-skill:list-curation"],
      { ...deps, readInstallStatus: async (names) => new Map(names.map((n) => [n, "archived" as const])) },
    );
    expect(out.get("@cinatra-ai/list-curation-skill:list-curation")).toMatchObject({
      assignable: false,
      reason: "archived",
    });
  });

  it("refuses a package with NO install row at all", async () => {
    const out = await resolveSkillAssignability(
      ["@cinatra-ai/list-curation-skill:list-curation"],
      { ...deps, readInstallStatus: async () => new Map() },
    );
    expect(out.get("@cinatra-ai/list-curation-skill:list-curation")).toMatchObject({
      assignable: false,
      reason: "not-installed",
    });
  });

  it("tolerates installed_extension package-name identity DRIFT (slug-form rows)", async () => {
    // Legacy rows carry the slugified name; the candidate-key union absorbs it,
    // exactly like the delivery-scan lifecycle gate.
    const out = await resolveSkillAssignability(
      ["@cinatra-ai/list-curation-skill:list-curation"],
      {
        ...deps,
        readInstallStatus: async () =>
          new Map([["cinatra-ai-list-curation-skill", "active" as const]]),
      },
    );
    expect(out.get("@cinatra-ai/list-curation-skill:list-curation")?.assignable).toBe(true);
  });

  it("returns an empty map for an empty request (no I/O)", async () => {
    const scan = vi.fn();
    const out = await resolveSkillAssignability([], { ...deps, scanExtensions: scan as never });
    expect(out.size).toBe(0);
    expect(scan).not.toHaveBeenCalled();
  });
});
