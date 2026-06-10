/**
 * Unit tests for `readAgentsForSkillMatching()`.
 *
 * The matcher's "agents" axis was wired to `readAgentsCatalog()` which
 * scans `packages/*` for SKILL.md files — surfacing workspace build
 * packages (not installed runnable agents) in the matches tab UI and in
 * every matcher write/read path. The reader goes through
 * `readInstalledAgentTemplates()` which filters
 * `agent_templates WHERE packageName IS NOT NULL AND status IN
 * ('active', 'published')`.
 *
 * These tests pin:
 *   - Templates without packageName are dropped.
 *   - Templates with status='draft' are NOT in the result (handled by
 *     `readInstalledAgentTemplates()` itself; we assert end-to-end).
 *   - active + published templates produce one PersistedAgent row each.
 *   - Mapped shape matches the legacy `readAgentsCatalog()` contract so
 *     downstream `adaptAgentForMatching()` works unchanged.
 *   - When the underlying reader throws, the function logs + returns []
 *     (defensive — matcher dispatch should not crash on a DB hiccup).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// @cinatra-ai/skills transitively imports @cinatra-ai/llm via the
// barrel; stub to avoid module-resolution noise in the sandbox.
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

const readInstalledAgentTemplatesMock = vi.fn();
vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: () => readInstalledAgentTemplatesMock(),
}));

// agents-store.ts pulls from @/lib/database for the legacy
// readAgentsCatalog path; readAgentsForSkillMatching doesn't touch it,
// but the module-init side imports it.
vi.mock("@/lib/database", () => ({
  readAgentCatalogFromDatabase: vi.fn(() => ({ agents: [] })),
  readAgentSkillExclusionsFromDatabase: vi.fn(() => ({ exclusions: [], updatedAt: "" })),
  readAgentSkillMatchesFromDatabase: vi.fn(() => ({ matches: [], matchedAt: "" })),
  replaceAgentCatalogInDatabase: vi.fn(),
  replaceAgentSkillExclusionsInDatabase: vi.fn(),
  replaceAgentSkillMatchesInDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => ({ skills: [], skillPackages: [] })),
  replaceSkillCatalogInDatabase: vi.fn(),
}));

import { readAgentsForSkillMatching } from "../agents-store";

const baseTemplate = {
  id: "tpl-1",
  orgId: null,
  creatorId: null,
  sourceNl: "",
  compiledPlan: [],
  inputSchema: {},
  outputSchema: null,
  approvalPolicy: {},
  taskSpec: null,
  packageVersion: null,
  currentVersionId: null,
  hitlScreens: null,
  agentDependencies: {},
  ioSpec: null,
  hitlRequired: false,
  executionProvider: "openai" as const,
  lgGraphCode: null,
  lgGraphId: null,
  sourceType: "internal" as const,
  type: "leaf" as const,
};

describe("readAgentsForSkillMatching", () => {
  beforeEach(() => {
    readInstalledAgentTemplatesMock.mockReset();
  });

  it("includes installed templates with packageName", async () => {
    readInstalledAgentTemplatesMock.mockResolvedValue([
      {
        ...baseTemplate,
        id: "tpl-email-outreach",
        name: "Email Outreach Agent",
        description: "Drafts cold emails to leads.",
        packageName: "@cinatra-ai/email-outreach-agent",
        status: "active",
      },
      {
        ...baseTemplate,
        id: "tpl-web-scrape",
        name: "Web Scrape Agent",
        description: "Crawls URLs and extracts structured rows.",
        packageName: "@cinatra-ai/web-scrape-agent",
        status: "published",
      },
    ]);

    const result = await readAgentsForSkillMatching();
    expect(result).toHaveLength(2);
    const packageIds = result.map((r) => r.packageId).sort();
    expect(packageIds).toEqual([
      "@cinatra-ai/email-outreach-agent",
      "@cinatra-ai/web-scrape-agent",
    ]);
  });

  it("drops templates with null/empty packageName", async () => {
    readInstalledAgentTemplatesMock.mockResolvedValue([
      {
        ...baseTemplate,
        id: "tpl-with-pkg",
        name: "Has Package",
        description: "ok",
        packageName: "@cinatra/has-package",
        status: "active",
      },
      {
        ...baseTemplate,
        id: "tpl-no-pkg",
        name: "Legacy Template",
        description: "no packageName",
        packageName: null,
        status: "active",
      },
      {
        ...baseTemplate,
        id: "tpl-empty-pkg",
        name: "Empty Package",
        description: "empty string",
        packageName: "",
        status: "active",
      },
    ]);

    const result = await readAgentsForSkillMatching();
    expect(result).toHaveLength(1);
    expect(result[0].packageId).toBe("@cinatra/has-package");
  });

  it("maps to PersistedAgent shape (packageId + name + description + keywords + slug-derived id)", async () => {
    readInstalledAgentTemplatesMock.mockResolvedValue([
      {
        ...baseTemplate,
        id: "tpl-x",
        name: "Email Outreach Agent",
        description: "Drafts cold emails.",
        packageName: "@cinatra-ai/email-outreach-agent",
        status: "active",
      },
    ]);

    const [agent] = await readAgentsForSkillMatching();
    expect(agent.id).toBe("email-outreach-agent");
    expect(agent.identifier).toBe("email-outreach-agent");
    expect(agent.packageId).toBe("@cinatra-ai/email-outreach-agent");
    expect(agent.humanReadableName).toBe("Email Outreach Agent");
    expect(agent.description).toBe("Drafts cold emails.");
    expect(agent.keywords).toContain("email-outreach-agent");
    expect(agent.keywords).toContain("Email Outreach Agent");
    expect(agent.frontmatter).toEqual({});
    expect(agent.content).toBe("");
    expect(agent.sourcePath).toBe("");
  });

  it("returns [] when the upstream reader throws (defensive)", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    readInstalledAgentTemplatesMock.mockRejectedValue(new Error("db unreachable"));

    const result = await readAgentsForSkillMatching();
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      "[agents-store] readInstalledAgentTemplates failed:",
      expect.any(Error),
    );
    spy.mockRestore();
  });

  it("regression: workspace package names like '@cinatra-ai/agents' or '@cinatra-ai/llm' do NOT appear in the result", async () => {
    // The bug this PR fixes: the legacy readAgentsCatalog() scanned
    // packages/* and would surface @cinatra-ai/agents, @cinatra-ai/llm,
    // etc. — workspace BUILD packages, not installed runnable agents. The
    // new reader goes through agent_templates which only contains user-
    // installed agents, so these would never appear unless someone literally
    // installed an "@cinatra-ai/agents" agent (vanishingly unlikely).
    readInstalledAgentTemplatesMock.mockResolvedValue([
      {
        ...baseTemplate,
        id: "tpl-installed",
        name: "Web Scrape Agent",
        description: "Real installed runnable agent.",
        packageName: "@cinatra-ai/web-scrape-agent",
        status: "active",
      },
    ]);

    const result = await readAgentsForSkillMatching();
    const packageIds = result.map((r) => r.packageId);
    expect(packageIds).not.toContain("@cinatra-ai/agents");
    expect(packageIds).not.toContain("@cinatra-ai/llm");
    expect(packageIds).not.toContain("@cinatra-ai/skills");
    expect(packageIds).toEqual(["@cinatra-ai/web-scrape-agent"]);
  });
});
