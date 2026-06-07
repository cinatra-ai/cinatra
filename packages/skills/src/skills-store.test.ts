/**
 * Contract test for frontmatter list round-tripping.
 *
 * This test imports parseFrontmatter from skills-registry.ts (already exported
 * via the @cinatra-ai/skills barrel at packages/skills/src/index.ts:4) rather
 * than skills-store.ts (where the identical implementation stays PRIVATE).
 * Adding an export to skills-store.ts would create an ambiguous re-export
 * collision via the barrel.
 * The two implementations are identical line-for-line; the contract test
 * validates the parser shape both files must preserve.
 *
 * The line-based parser must handle YAML block-sequence list items (lines with
 * `  - "id"` where the id contains a colon). Each `  - "id"` line must stay
 * associated with the preceding key instead of being split at the first colon
 * into malformed key/value pairs that drop the `based_on` key.
 *
 * Both skills-registry.ts and skills-store.ts parsers must detect `  - ...`
 * continuation lines and concatenate them into the previous key's list value.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

// skills-registry.ts imports @/lib/agents-store which imports @cinatra-ai/skills
// (the barrel) which includes personal-skills.ts which imports
// @cinatra-ai/llm. Mock the chain stubs here so the test process
// can load the module without real DB / LLM dependencies.
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

vi.mock("@/lib/agents-store", () => ({
  readAgentsCatalog: vi.fn(async () => []),
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
  readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({})),
  writeConnectorConfigToDatabase: vi.fn(),
  // Fixed shape: readSkillsCatalog reads .skillPackages and .skills off this
  // return value. Defaults to an empty catalog so the existing parseFrontmatter
  // test (which never calls readSkillsCatalog) is unaffected, and the
  // level:"agent" round-trip test below overrides via mockReturnValueOnce.
  readSkillCatalogFromDatabase: vi.fn(() => ({ skillPackages: [], skills: [] })),
  replaceSkillCatalogInDatabase: vi.fn(),
}));

// Ensure scanInstalledPackageCatalog returns no skills so the custom
// level:"agent" skill is not crowded out by real disk scans.
vi.mock("./skill-packages", () => ({
  installedSkillPackages: [],
}));

// Import from skills-registry (already exported via barrel), not from
// skills-store (where parseFrontmatter is private and must remain so).
import { parseFrontmatter } from "./skills-registry";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseFrontmatter based_on list round-trip", () => {
  it("parses based_on list block preserving every entry without splitting on internal colons", () => {
    // The parser must preserve the based_on key when `  - "id"` continuation
    // lines contain quoted IDs such as "@cinatra-ai/asset-blog:generate-blog-ideas".
    //
    // Continuation lines must be concatenated into the previous key's list
    // value so every skill ID survives intact.

    const input = [
      "---",
      "title: T",
      "based_on:",
      '  - "@cinatra-ai/asset-blog:generate-blog-ideas"',
      '  - "@cinatra-ai/email-outreach-agent:campaign-email-outreach"',
      "---",
      "body",
    ].join("\n");

    const result = parseFrontmatter(input);

    // Body should be extracted cleanly
    expect(result.body.trim()).toBe("body");

    // based_on key must exist in attributes
    expect(result.attributes).toHaveProperty("based_on");

    // The value must preserve both skill IDs intact, including the suffix after
    // the colon.
    const basedOnValue = String(result.attributes["based_on"]);
    expect(basedOnValue).toContain("asset-blog");
    expect(basedOnValue).toContain("generate-blog-ideas");
    expect(basedOnValue).toContain("email-outreach");
    expect(basedOnValue).toContain("campaign-email-outreach");
  });
});

// ---------------------------------------------------------------------------
// level:"agent" round-trip
// ---------------------------------------------------------------------------

describe("level:'agent' round-trip via readSkillsCatalog", () => {
  it("preserves level: 'agent' through DB read -> normalizeStoredSkill", async () => {
    // Re-import the database mock and override its return value just for this test.
    const databaseMock = await import("@/lib/database");
    const readSkillCatalogFromDatabase = databaseMock.readSkillCatalogFromDatabase as unknown as ReturnType<typeof vi.fn>;

    readSkillCatalogFromDatabase.mockReturnValueOnce({
      skillPackages: [
        {
          id: "custom:email-recipient-selection",
          packageId: "custom:email-recipient-selection",
          name: "@cinatra-ai/email-recipient-selection-agent",
          slug: "cinatra-agents-email-recipient-selection",
          description: "agent skills",
          isCustom: true,
        },
      ],
      skills: [
        {
          id: "custom:email-recipient-selection:email-recipient-selection",
          name: "Email Recipients",
          slug: "email-recipient-selection",
          description: "",
          content: "body",
          packageId: "custom:email-recipient-selection",
          packageName: "@cinatra-ai/email-recipient-selection-agent",
          packageSlug: "cinatra-agents-email-recipient-selection",
          sourcePath: "data/skills/~agent/cinatra-agents-email-recipient-selection/email-recipient-selection/SKILL.md",
          usedBy: [],
          isCustom: true,
          level: "agent",                                    // the value under test
          agentId: "@cinatra-ai/email-recipient-selection-agent",
        },
      ],
    });

    const { readSkillsCatalog } = await import("./skills-store");
    const catalog = await readSkillsCatalog();
    const er = catalog.skills.find((s) => s.id === "custom:email-recipient-selection:email-recipient-selection");
    expect(er).toBeDefined();
    expect(er?.level).toBe("agent");
    expect(er?.agentId).toBe("@cinatra-ai/email-recipient-selection-agent");
  });
});

// ---------------------------------------------------------------------------
// personal scope projection
// ---------------------------------------------------------------------------

describe("level:'personal' scope projection via readSkillsCatalog", () => {
  it("derives scope = ownerUserId for personal rows missing a stored scope", async () => {
    // Some older personal-skill rows were written before the scope field was
    // persisted alongside level. `requireResourceAccess` keys owner identity
    // off `scope`; without a fallback, those rows would be filtered out of
    // `/skills?scope=personal` for their own owner. normalizeStoredSkill must
    // backfill scope from ownerUserId when level === "personal" and scope is
    // absent.
    const databaseMock = await import("@/lib/database");
    const readSkillCatalogFromDatabase = databaseMock.readSkillCatalogFromDatabase as unknown as ReturnType<typeof vi.fn>;

    readSkillCatalogFromDatabase.mockReturnValueOnce({
      skillPackages: [
        {
          id: "custom:personal-pkg",
          packageId: "custom:personal-pkg",
          name: "@cinatra-ai/personal-pkg",
          slug: "cinatra-personal-personal-pkg",
          description: "",
          isCustom: true,
        },
      ],
      skills: [
        {
          id: "custom:personal-pkg:my-skill",
          name: "My Personal Skill",
          slug: "my-skill",
          description: "",
          content: "body",
          packageId: "custom:personal-pkg",
          packageName: "@cinatra-ai/personal-pkg",
          packageSlug: "cinatra-personal-personal-pkg",
          sourcePath: "data/skills/~personal/custom-personal-pkg/my-skill/SKILL.md",
          usedBy: [],
          isCustom: true,
          level: "personal",
          ownerUserId: "user-abc",
          // scope intentionally omitted to reproduce the legacy-row shape.
        },
      ],
    });

    const { readSkillsCatalog } = await import("./skills-store");
    const catalog = await readSkillsCatalog();
    const row = catalog.skills.find((s) => s.id === "custom:personal-pkg:my-skill");
    expect(row).toBeDefined();
    expect(row?.level).toBe("personal");
    expect(row?.scope).toBe("user-abc");
  });

  it("persists scope = ownerUserId when upsertCustomSkill writes a personal row", async () => {
    // Writer projection: requireResourceAccess keys owner identity off the
    // catalog `scope` field. Without the writer setting scope = ownerUserId
    // on every personal write, the row would land scope-less and the actor's
    // own personal-skill row would be filtered out of /skills?scope=personal.
    vi.resetModules();

    vi.doMock("server-only", () => ({}));
    vi.doMock("@cinatra-ai/llm", () => ({
      runResolvedDeterministicLlmTask: vi.fn(),
      resolveConfiguredLlmRuntime: vi.fn(),
      parseStructuredJson: vi.fn(),
    }));
    vi.doMock("@/lib/agents-store", () => ({
      readAgentsCatalog: vi.fn(async () => []),
      getAssignedSkillIdsForAgent: vi.fn(async () => []),
      readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
    }));

    let lastWrite: { skillPackages: unknown[]; skills: Array<Record<string, unknown>> } | null = null;
    vi.doMock("@/lib/database", () => ({
      readConnectorConfigFromDatabase: vi.fn(() => ({})),
      writeConnectorConfigToDatabase: vi.fn(),
      readSkillCatalogFromDatabase: vi.fn(() => ({ skillPackages: [], skills: [] })),
      replaceSkillCatalogInDatabase: vi.fn((next: typeof lastWrite) => {
        lastWrite = next;
      }),
      getPostgresConnectionString: vi.fn(() => ""),
      postgresSchema: "cinatra",
      upsertCustomSkillAssignment: vi.fn(),
      deleteCustomSkillAssignment: vi.fn(),
      readCustomSkillAssignments: vi.fn(() => []),
    }));

    // The on-disk write side-effect path isn't under test here; stub it.
    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      rm: vi.fn(async () => undefined),
    }));

    vi.doMock("./skill-packages", () => ({ installedSkillPackages: [] }));

    const { upsertCustomSkill } = await import("./skills-store");
    const result = await upsertCustomSkill({
      ownerUserId: "user-writer-abc",
      agentId: "@cinatra-ai/some-agent",
      name: "Writer Test Skill",
      description: "",
      content: "body",
      ownerType: "user",
      ownerId: "user-writer-abc",
      createdBy: "user-writer-abc",
    });

    expect(result.level).toBe("personal");
    expect(result.scope).toBe("user-writer-abc");
    expect(lastWrite).not.toBeNull();
    const persisted = lastWrite!.skills.find((s) => (s as { id?: string }).id === result.id);
    expect(persisted).toBeDefined();
    expect((persisted as { scope?: string }).scope).toBe("user-writer-abc");
  });

  it("refuses to update a personal skill owned by another user", async () => {
    // Forged-skillId attack: an attacker submits the edit form with a hidden
    // skillId field pointing at another user's personal skill. Without an
    // ownership pre-check inside upsertCustomSkill, the row would be replaced
    // with the attacker's data + reassigned ownership.
    vi.resetModules();

    vi.doMock("server-only", () => ({}));
    vi.doMock("@cinatra-ai/llm", () => ({
      runResolvedDeterministicLlmTask: vi.fn(),
      resolveConfiguredLlmRuntime: vi.fn(),
      parseStructuredJson: vi.fn(),
    }));
    vi.doMock("@/lib/agents-store", () => ({
      readAgentsCatalog: vi.fn(async () => []),
      getAssignedSkillIdsForAgent: vi.fn(async () => []),
      readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
    }));

    vi.doMock("@/lib/database", () => ({
      readConnectorConfigFromDatabase: vi.fn(() => ({})),
      writeConnectorConfigToDatabase: vi.fn(),
      readSkillCatalogFromDatabase: vi.fn(() => ({
        skillPackages: [
          {
            id: "custom:victim-personal-skills",
            packageId: "custom:victim-personal-skills",
            name: "@cinatra-ai/victim-personal-skills",
            slug: "victim-personal-skills",
            description: "",
            isCustom: true,
          },
        ],
        skills: [
          {
            id: "custom:victim-personal-skills:secret-skill",
            name: "Victim's Secret Skill",
            slug: "secret-skill",
            description: "",
            content: "victim body",
            packageId: "custom:victim-personal-skills",
            packageName: "@cinatra-ai/victim-personal-skills",
            packageSlug: "victim-personal-skills",
            sourcePath: "data/skills/~personal/victim/secret-skill/SKILL.md",
            usedBy: [],
            isCustom: true,
            level: "personal",
            ownerUserId: "user-victim",
            scope: "user-victim",
          },
        ],
      })),
      replaceSkillCatalogInDatabase: vi.fn(),
      getPostgresConnectionString: vi.fn(() => ""),
      postgresSchema: "cinatra",
      upsertCustomSkillAssignment: vi.fn(),
      deleteCustomSkillAssignment: vi.fn(),
      readCustomSkillAssignments: vi.fn(() => []),
    }));

    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      rm: vi.fn(async () => undefined),
    }));

    vi.doMock("./skill-packages", () => ({ installedSkillPackages: [] }));

    const { upsertCustomSkill } = await import("./skills-store");
    await expect(
      upsertCustomSkill({
        skillId: "custom:victim-personal-skills:secret-skill",
        ownerUserId: "user-attacker",
        agentId: "@cinatra-ai/some-agent",
        name: "Attacker's Replacement",
        description: "",
        content: "attacker body",
        ownerType: "user",
        ownerId: "user-attacker",
        createdBy: "user-attacker",
      }),
    ).rejects.toThrow(/not the owner of personal skill/);
  });

  it("refuses to update a personal skill row that has NO owner identity", async () => {
    // Fail-closed: a malformed personal row (no ownerUserId AND no scope)
    // has no owner identity to verify against. Any authenticated user must
    // NOT be able to claim it via an upsert.
    vi.resetModules();

    vi.doMock("server-only", () => ({}));
    vi.doMock("@cinatra-ai/llm", () => ({
      runResolvedDeterministicLlmTask: vi.fn(),
      resolveConfiguredLlmRuntime: vi.fn(),
      parseStructuredJson: vi.fn(),
    }));
    vi.doMock("@/lib/agents-store", () => ({
      readAgentsCatalog: vi.fn(async () => []),
      getAssignedSkillIdsForAgent: vi.fn(async () => []),
      readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
    }));

    vi.doMock("@/lib/database", () => ({
      readConnectorConfigFromDatabase: vi.fn(() => ({})),
      writeConnectorConfigToDatabase: vi.fn(),
      readSkillCatalogFromDatabase: vi.fn(() => ({
        skillPackages: [
          {
            id: "custom:orphan-personal-skills",
            packageId: "custom:orphan-personal-skills",
            name: "@cinatra-ai/orphan-personal-skills",
            slug: "orphan-personal-skills",
            description: "",
            isCustom: true,
          },
        ],
        skills: [
          {
            id: "custom:orphan-personal-skills:ownerless",
            name: "Ownerless Personal Skill",
            slug: "ownerless",
            description: "",
            content: "body",
            packageId: "custom:orphan-personal-skills",
            packageName: "@cinatra-ai/orphan-personal-skills",
            packageSlug: "orphan-personal-skills",
            sourcePath: "data/skills/~personal/orphan/ownerless/SKILL.md",
            usedBy: [],
            isCustom: true,
            level: "personal",
            // ownerUserId AND scope both absent — malformed row.
          },
        ],
      })),
      replaceSkillCatalogInDatabase: vi.fn(),
      getPostgresConnectionString: vi.fn(() => ""),
      postgresSchema: "cinatra",
      upsertCustomSkillAssignment: vi.fn(),
      deleteCustomSkillAssignment: vi.fn(),
      readCustomSkillAssignments: vi.fn(() => []),
    }));

    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      rm: vi.fn(async () => undefined),
    }));

    vi.doMock("./skill-packages", () => ({ installedSkillPackages: [] }));

    const { upsertCustomSkill } = await import("./skills-store");
    await expect(
      upsertCustomSkill({
        skillId: "custom:orphan-personal-skills:ownerless",
        ownerUserId: "user-claimant",
        agentId: "@cinatra-ai/some-agent",
        name: "Claimant's Take-Over",
        description: "",
        content: "claimant body",
        ownerType: "user",
        ownerId: "user-claimant",
        createdBy: "user-claimant",
      }),
    ).rejects.toThrow(/has no owner identity/);
  });

  it("refuses to update a personal skill row when ownerUserId and scope disagree with the caller", async () => {
    // Both owner-identity fields present but the caller matches neither.
    // The presentOwners.some(...) check must reject as soon as ANY present
    // field disagrees with input.ownerUserId.
    vi.resetModules();

    vi.doMock("server-only", () => ({}));
    vi.doMock("@cinatra-ai/llm", () => ({
      runResolvedDeterministicLlmTask: vi.fn(),
      resolveConfiguredLlmRuntime: vi.fn(),
      parseStructuredJson: vi.fn(),
    }));
    vi.doMock("@/lib/agents-store", () => ({
      readAgentsCatalog: vi.fn(async () => []),
      getAssignedSkillIdsForAgent: vi.fn(async () => []),
      readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
    }));

    vi.doMock("@/lib/database", () => ({
      readConnectorConfigFromDatabase: vi.fn(() => ({})),
      writeConnectorConfigToDatabase: vi.fn(),
      readSkillCatalogFromDatabase: vi.fn(() => ({
        skillPackages: [
          {
            id: "custom:drift-personal-skills",
            packageId: "custom:drift-personal-skills",
            name: "@cinatra-ai/drift-personal-skills",
            slug: "drift-personal-skills",
            description: "",
            isCustom: true,
          },
        ],
        skills: [
          {
            id: "custom:drift-personal-skills:drifted",
            name: "Drifted Personal Skill",
            slug: "drifted",
            description: "",
            content: "body",
            packageId: "custom:drift-personal-skills",
            packageName: "@cinatra-ai/drift-personal-skills",
            packageSlug: "drift-personal-skills",
            sourcePath: "data/skills/~personal/drift/drifted/SKILL.md",
            usedBy: [],
            isCustom: true,
            level: "personal",
            ownerUserId: "user-a",
            scope: "user-b",  // drifted from ownerUserId — neither matches the caller below
          },
        ],
      })),
      replaceSkillCatalogInDatabase: vi.fn(),
      getPostgresConnectionString: vi.fn(() => ""),
      postgresSchema: "cinatra",
      upsertCustomSkillAssignment: vi.fn(),
      deleteCustomSkillAssignment: vi.fn(),
      readCustomSkillAssignments: vi.fn(() => []),
    }));

    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ""),
      rm: vi.fn(async () => undefined),
    }));

    vi.doMock("./skill-packages", () => ({ installedSkillPackages: [] }));

    const { upsertCustomSkill } = await import("./skills-store");
    // Even if input.ownerUserId === "user-a" (matches ownerUserId), the scope
    // field still disagrees, so the gate must reject. Same goes for "user-b".
    await expect(
      upsertCustomSkill({
        skillId: "custom:drift-personal-skills:drifted",
        ownerUserId: "user-a",
        agentId: "@cinatra-ai/some-agent",
        name: "Replacement",
        description: "",
        content: "replacement body",
        ownerType: "user",
        ownerId: "user-a",
        createdBy: "user-a",
      }),
    ).rejects.toThrow(/not the owner of personal skill/);
    await expect(
      upsertCustomSkill({
        skillId: "custom:drift-personal-skills:drifted",
        ownerUserId: "user-b",
        agentId: "@cinatra-ai/some-agent",
        name: "Replacement",
        description: "",
        content: "replacement body",
        ownerType: "user",
        ownerId: "user-b",
        createdBy: "user-b",
      }),
    ).rejects.toThrow(/not the owner of personal skill/);
  });

  it("preserves an explicit stored scope on personal rows", async () => {
    const databaseMock = await import("@/lib/database");
    const readSkillCatalogFromDatabase = databaseMock.readSkillCatalogFromDatabase as unknown as ReturnType<typeof vi.fn>;

    readSkillCatalogFromDatabase.mockReturnValueOnce({
      skillPackages: [
        {
          id: "custom:personal-pkg",
          packageId: "custom:personal-pkg",
          name: "@cinatra-ai/personal-pkg",
          slug: "cinatra-personal-personal-pkg",
          description: "",
          isCustom: true,
        },
      ],
      skills: [
        {
          id: "custom:personal-pkg:my-skill",
          name: "My Personal Skill",
          slug: "my-skill",
          description: "",
          content: "body",
          packageId: "custom:personal-pkg",
          packageName: "@cinatra-ai/personal-pkg",
          packageSlug: "cinatra-personal-personal-pkg",
          sourcePath: "data/skills/~personal/custom-personal-pkg/my-skill/SKILL.md",
          usedBy: [],
          isCustom: true,
          level: "personal",
          ownerUserId: "user-abc",
          scope: "user-explicit-xyz",
        },
      ],
    });

    const { readSkillsCatalog } = await import("./skills-store");
    const catalog = await readSkillsCatalog();
    const row = catalog.skills.find((s) => s.id === "custom:personal-pkg:my-skill");
    expect(row).toBeDefined();
    expect(row?.scope).toBe("user-explicit-xyz");
  });
});

// ---------------------------------------------------------------------------
// Non-personal level forge attack — defense-in-depth gate (Layer 2)
// ---------------------------------------------------------------------------

// A forged form skillId pointing at a team / organization / workspace /
// project skill MUST NOT replace the row through the personal-skill code
// path. upsertCustomSkill rejects when the existing row's level is anything
// other than "personal", so a downgrade-and-claim attack via a malicious
// hidden skillId on the edit form bottoms out at the store layer even if
// the action-layer authz check is bypassed.

describe("upsertCustomSkill refuses non-personal rows on the personal-skill code path", () => {
  for (const level of ["team", "organization", "workspace", "project"] as const) {
    it(`refuses to overwrite an existing ${level}-level skill row`, async () => {
      vi.resetModules();

      vi.doMock("server-only", () => ({}));
      vi.doMock("@cinatra-ai/llm", () => ({
        runResolvedDeterministicLlmTask: vi.fn(),
        resolveConfiguredLlmRuntime: vi.fn(),
        parseStructuredJson: vi.fn(),
      }));
      vi.doMock("@/lib/agents-store", () => ({
        readAgentsCatalog: vi.fn(async () => []),
        getAssignedSkillIdsForAgent: vi.fn(async () => []),
        readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
      }));

      vi.doMock("@/lib/database", () => ({
        readConnectorConfigFromDatabase: vi.fn(() => ({})),
        writeConnectorConfigToDatabase: vi.fn(),
        readSkillCatalogFromDatabase: vi.fn(() => ({
          skillPackages: [
            {
              id: `custom:victim-${level}-skills`,
              packageId: `custom:victim-${level}-skills`,
              name: `@cinatra-ai/victim-${level}-skills`,
              slug: `victim-${level}-skills`,
              description: "",
              isCustom: true,
            },
          ],
          skills: [
            {
              id: `custom:victim-${level}-skills:owned-skill`,
              name: `Victim's ${level} skill`,
              slug: "owned-skill",
              description: "",
              content: "victim body",
              packageId: `custom:victim-${level}-skills`,
              packageName: `@cinatra-ai/victim-${level}-skills`,
              packageSlug: `victim-${level}-skills`,
              sourcePath: `data/skills/~${level}/victim/owned-skill/SKILL.md`,
              usedBy: [],
              isCustom: true,
              level,
              ownerUserId: "victim-team-admin",
              scope: `${level}-id-1`,
            },
          ],
        })),
        replaceSkillCatalogInDatabase: vi.fn(),
        getPostgresConnectionString: vi.fn(() => ""),
        postgresSchema: "cinatra",
        upsertCustomSkillAssignment: vi.fn(),
        deleteCustomSkillAssignment: vi.fn(),
        readCustomSkillAssignments: vi.fn(() => []),
      }));

      vi.doMock("fs/promises", () => ({
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        readFile: vi.fn(async () => ""),
        rm: vi.fn(async () => undefined),
      }));

      vi.doMock("./skill-packages", () => ({ installedSkillPackages: [] }));

      const { upsertCustomSkill } = await import("./skills-store");
      await expect(
        upsertCustomSkill({
          skillId: `custom:victim-${level}-skills:owned-skill`,
          ownerUserId: "user-attacker",
          agentId: "@cinatra-ai/some-agent",
          name: "Attacker's Replacement",
          description: "",
          content: "attacker body",
          ownerType: "user",
          ownerId: "user-attacker",
          createdBy: "user-attacker",
        }),
      ).rejects.toThrow(/refusing update through personal-skill code path/);
    });
  }
});
