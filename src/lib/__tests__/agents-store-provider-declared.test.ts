/**
 * Regression tests for provider-declared agent discovery and skill matching:
 *
 *   - `readAgentsForSkillMatching()` must surface provider-declared
 *     agents under `<installDir>/cinatra/<slug>/` (mirrors `agent_source_list`).
 *     Without these the Matches tab shows only the few user-installed agents
 *     from `agent_templates` and hides the ~30 shipped Cinatra agents.
 *
 *   - The dropdown in `/configuration/skills?tab=matches` must
 *     exclude `level=agent` skills — agents are self-contained and their
 *     bundled skills are never assignable to a different agent. Covered by
 *     direct filter tests; the dropdown filter lives in `page.tsx` and is
 *     a one-line `level !== "agent"` guard, but we pin the contract on the
 *     reader so future refactors that surface bundled skills via the
 *     matcher's catalog read won't regress the UX.
 *
 *   - `matchAgentsToSkills()` must NOT add self-owned agent skills into the
 *     Matches projection. A `score=100`, rationale="Self-owned agent skill
 *     (level=agent)" row for every (agent, level=agent skill where
 *     skill.agentId === packageId) pair makes bundled skills look like
 *     cross-agent matches.
 *
 * DB-wins union (mandatory contract):
 *   - When the same `packageId` exists in both `agent_templates` and on
 *     disk, the DB row wins (richer metadata: humanReadableName from
 *     `agent_templates.name`, description from the saved template).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { InstanceIdentity } from "@/lib/instance-identity-store";

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

const readInstalledAgentTemplatesMock = vi.fn();
vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: () => readInstalledAgentTemplatesMock(),
}));

const resolveAgentInstallDirMock = vi.fn();
vi.mock("@cinatra-ai/agents/agent-install-path", () => ({
  resolveAgentInstallDir: () => resolveAgentInstallDirMock(),
}));

// cinatra#538 (defect 2): the picker now enumerates the operator's OWN vendor
// segment (from the instance identity) in addition to first-party "cinatra-ai".
// Mock `readInstanceIdentity` so the picker never reaches the synchronous
// Postgres worker (which would HANG the vitest worker — the known footgun).
// Default: no identity → first-party "cinatra-ai" only. Tests override.
const readInstanceIdentityMock = vi.fn((): InstanceIdentity | null => null);
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => readInstanceIdentityMock(),
}));

// Build a complete InstanceIdentity for the mock. Only `instanceNamespace`
// matters to the picker; the other required fields are inert filler.
function makeInstanceIdentity(
  instanceNamespace: string,
  instanceDisplayName: string,
): InstanceIdentity {
  return {
    instanceNamespace,
    instanceDisplayName,
    firstPublishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

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

import { readAgentsForSkillMatching, readProviderDeclaredAgents } from "../agents-store";

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

function makeProviderAgentDir(
  installRoot: string,
  slug: string,
  spec: {
    layout?: "new-oas" | "new-agent" | "legacy-cinatra" | "legacy-flat";
    legacyDirName?: string;
    packageName?: string | null;
    metadataPackageName?: string | null;
    description?: string | null;
    name?: string;
    siblingPackageName?: string | null;
    siblingDescription?: string | null;
    /** On-disk vendor segment for new-* layouts; defaults to first-party. */
    vendor?: string;
  },
) {
  const dirName = spec.legacyDirName ?? slug;
  const layout = spec.layout ?? "new-oas";
  const vendor = spec.vendor ?? "cinatra-ai";

  let jsonDir: string;
  let jsonFile: string;
  switch (layout) {
    case "new-oas":
      jsonDir = path.join(installRoot, vendor, dirName, "cinatra");
      jsonFile = "oas.json";
      break;
    case "new-agent":
      jsonDir = path.join(installRoot, vendor, dirName, "cinatra");
      jsonFile = "agent.json";
      break;
    case "legacy-cinatra":
      jsonDir = path.join(installRoot, dirName, "cinatra");
      jsonFile = "agent.json";
      break;
    case "legacy-flat":
      jsonDir = path.join(installRoot, dirName);
      jsonFile = "agent.json";
      break;
  }
  mkdirSync(jsonDir, { recursive: true });

  const agentContent: Record<string, unknown> = {
    name: spec.name ?? "Unnamed Agent",
    description: spec.description ?? null,
    packageName: spec.packageName ?? null,
    metadata: spec.metadataPackageName
      ? { cinatra: { packageName: spec.metadataPackageName } }
      : undefined,
  };
  writeFileSync(path.join(jsonDir, jsonFile), JSON.stringify(agentContent));

  if (spec.siblingPackageName !== undefined || spec.siblingDescription !== undefined) {
    const pkgDir =
      layout === "new-oas" || layout === "new-agent"
        ? path.join(installRoot, vendor, dirName)
        : path.join(installRoot, dirName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: spec.siblingPackageName ?? undefined,
        description: spec.siblingDescription ?? undefined,
      }),
    );
  }
}

describe("readProviderDeclaredAgents + readAgentsForSkillMatching union", () => {
  let tmpRoot: string;

  beforeEach(() => {
    readInstalledAgentTemplatesMock.mockReset();
    resolveAgentInstallDirMock.mockReset();
    readInstanceIdentityMock.mockReset();
    readInstanceIdentityMock.mockReturnValue(null);
    tmpRoot = mkdtempSync(path.join(tmpdir(), "cinatra-provider-declared-"));
    resolveAgentInstallDirMock.mockReturnValue(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("surfaces a new-canonical (oas.json) provider agent", () => {
    makeProviderAgentDir(tmpRoot, "email-drafting-agent", {
      layout: "new-oas",
      metadataPackageName: "@cinatra-ai/email-drafting-agent",
      name: "Email Drafting Agent",
      description: "Drafts cold-outreach emails for a list of contacts.",
    });

    const result = readProviderDeclaredAgents();
    expect(result).toHaveLength(1);
    expect(result[0].packageId).toBe("@cinatra-ai/email-drafting-agent");
    expect(result[0].humanReadableName).toBe("Email Drafting Agent");
    expect(result[0].description).toBe("Drafts cold-outreach emails for a list of contacts.");
  });

  it("cinatra#538: discovers an agent under a NON-cinatra-ai operator vendor dir", () => {
    // Post-#537, a user agent authored on this instance is written under the
    // operator's OWN vendor segment (instanceNamespace), e.g.
    // `<installRoot>/marcushorndt-local/<slug>/cinatra/oas.json`. Before the
    // fix the picker only scanned `cinatra-ai`, so this agent never appeared
    // in `/agents/run`.
    readInstanceIdentityMock.mockReturnValue(
      makeInstanceIdentity("marcushorndt-local", "Marcus Local"),
    );
    makeProviderAgentDir(tmpRoot, "page-summarizer-agent", {
      layout: "new-oas",
      vendor: "marcushorndt-local",
      metadataPackageName: "@marcushorndt-local/page-summarizer-agent",
      name: "Page Summarizer Agent",
      description: "Summarizes a web page.",
    });

    const result = readProviderDeclaredAgents();
    expect(result).toHaveLength(1);
    expect(result[0].packageId).toBe("@marcushorndt-local/page-summarizer-agent");
    expect(result[0].humanReadableName).toBe("Page Summarizer Agent");
  });

  it("cinatra#538: unions operator-vendor AND first-party cinatra-ai agents", () => {
    // Operator vendor dir and the first-party dir must BOTH be enumerated.
    readInstanceIdentityMock.mockReturnValue(
      makeInstanceIdentity("marcushorndt-local", "Marcus Local"),
    );
    makeProviderAgentDir(tmpRoot, "page-summarizer-agent", {
      layout: "new-oas",
      vendor: "marcushorndt-local",
      metadataPackageName: "@marcushorndt-local/page-summarizer-agent",
      name: "Page Summarizer Agent",
      description: "User agent under the operator vendor dir.",
    });
    makeProviderAgentDir(tmpRoot, "email-drafting-agent", {
      layout: "new-oas",
      vendor: "cinatra-ai",
      metadataPackageName: "@cinatra-ai/email-drafting-agent",
      name: "Email Drafting Agent",
      description: "First-party agent under cinatra-ai.",
    });

    const packageIds = readProviderDeclaredAgents()
      .map((a) => a.packageId)
      .sort();
    expect(packageIds).toEqual([
      "@cinatra-ai/email-drafting-agent",
      "@marcushorndt-local/page-summarizer-agent",
    ]);
  });

  it("cinatra#538: a SAME-slug agent under operator AND cinatra-ai both surface (no shadowing)", () => {
    // Regression for the per-vendor resolution fix: when the operator authors an
    // agent whose slug collides with a shipped first-party slug, the picker must
    // return BOTH (distinct packageIds) — the operator dir must NOT shadow/hide
    // the first-party agent (the prior "operator-first, return first hit"
    // behavior dropped the first-party one).
    readInstanceIdentityMock.mockReturnValue(
      makeInstanceIdentity("marcushorndt-local", "Marcus Local"),
    );
    makeProviderAgentDir(tmpRoot, "email-drafting-agent", {
      layout: "new-oas",
      vendor: "marcushorndt-local",
      metadataPackageName: "@marcushorndt-local/email-drafting-agent",
      name: "My Email Drafter",
      description: "Operator's same-slug agent.",
    });
    makeProviderAgentDir(tmpRoot, "email-drafting-agent", {
      layout: "new-oas",
      vendor: "cinatra-ai",
      metadataPackageName: "@cinatra-ai/email-drafting-agent",
      name: "Email Drafting Agent",
      description: "First-party same-slug agent.",
    });

    const packageIds = readProviderDeclaredAgents()
      .map((a) => a.packageId)
      .sort();
    expect(packageIds).toEqual([
      "@cinatra-ai/email-drafting-agent",
      "@marcushorndt-local/email-drafting-agent",
    ]);
  });

  it("cinatra#538: with NO instance identity, still scans first-party cinatra-ai only", () => {
    // Default null identity → first-party segment retained; no operator dir.
    readInstanceIdentityMock.mockReturnValue(null);
    makeProviderAgentDir(tmpRoot, "email-drafting-agent", {
      layout: "new-oas",
      vendor: "cinatra-ai",
      metadataPackageName: "@cinatra-ai/email-drafting-agent",
      name: "Email Drafting Agent",
      description: "First-party agent.",
    });
    // An agent under a vendor dir we should NOT scan (no identity configured).
    makeProviderAgentDir(tmpRoot, "page-summarizer-agent", {
      layout: "new-oas",
      vendor: "marcushorndt-local",
      metadataPackageName: "@marcushorndt-local/page-summarizer-agent",
      name: "Page Summarizer Agent",
      description: "Should NOT be discovered without an instance identity.",
    });

    const packageIds = readProviderDeclaredAgents().map((a) => a.packageId);
    expect(packageIds).toEqual(["@cinatra-ai/email-drafting-agent"]);
  });

  it("walks transitional and legacy layouts (4-rung resolver parity with handleAgentBuilderGitList)", () => {
    makeProviderAgentDir(tmpRoot, "agent-a", {
      layout: "new-agent",
      packageName: "@cinatra/agent-a",
      name: "Agent A",
      description: "Transitional layout",
    });
    makeProviderAgentDir(tmpRoot, "drupal-agent", {
      layout: "legacy-cinatra",
      legacyDirName: "drupal-content-editor",
      packageName: "@cinatra-ai/drupal-agent",
      name: "Drupal Agent",
      description: "Legacy cinatra layout + legacy slug map",
    });
    makeProviderAgentDir(tmpRoot, "agent-c", {
      layout: "legacy-flat",
      packageName: "@cinatra/agent-c",
      name: "Agent C",
      description: "Legacy flat layout",
    });

    const packageIds = readProviderDeclaredAgents()
      .map((a) => a.packageId)
      .sort();
    expect(packageIds).toEqual([
      "@cinatra-ai/drupal-agent",
      "@cinatra/agent-a",
      "@cinatra/agent-c",
    ]);
  });

  it("falls back to sibling package.json for packageName + description", () => {
    makeProviderAgentDir(tmpRoot, "fallback-agent", {
      layout: "new-oas",
      packageName: null,
      metadataPackageName: null,
      description: null,
      name: "Fallback Agent",
      siblingPackageName: "@cinatra/fallback-agent",
      siblingDescription: "Fallback description from package.json",
    });

    const [agent] = readProviderDeclaredAgents();
    expect(agent.packageId).toBe("@cinatra/fallback-agent");
    expect(agent.description).toBe("Fallback description from package.json");
  });

  it("drops agents with no resolvable packageName (cannot be keyed in skill_matches)", () => {
    makeProviderAgentDir(tmpRoot, "no-package-name", {
      layout: "new-oas",
      packageName: null,
      metadataPackageName: null,
      description: "Display name only",
      name: "No-Package Agent",
    });

    expect(readProviderDeclaredAgents()).toHaveLength(0);
  });

  it("union of DB-installed + provider-declared agents", async () => {
    readInstalledAgentTemplatesMock.mockResolvedValue([
      {
        ...baseTemplate,
        id: "tpl-installed",
        name: "Installed Web Scrape",
        description: "From agent_templates",
        packageName: "@cinatra-ai/web-scrape-agent",
        status: "active",
      },
    ]);
    makeProviderAgentDir(tmpRoot, "email-drafting-agent", {
      layout: "new-oas",
      metadataPackageName: "@cinatra-ai/email-drafting-agent",
      name: "Email Drafting Agent",
      description: "Provider-only — not in agent_templates.",
    });

    const result = await readAgentsForSkillMatching();
    const ids = result.map((r) => r.packageId).sort();
    expect(ids).toEqual([
      "@cinatra-ai/email-drafting-agent",
      "@cinatra-ai/web-scrape-agent",
    ]);
  });

  it("DB row wins when packageId collides", async () => {
    readInstalledAgentTemplatesMock.mockResolvedValue([
      {
        ...baseTemplate,
        id: "tpl-shared",
        name: "DB-rich Web Scrape",
        description: "DB description should win",
        packageName: "@cinatra-ai/web-scrape-agent",
        status: "active",
      },
    ]);
    makeProviderAgentDir(tmpRoot, "web-scrape-agent", {
      layout: "new-oas",
      metadataPackageName: "@cinatra-ai/web-scrape-agent",
      name: "Filesystem Web Scrape",
      description: "Filesystem description should LOSE",
    });

    const result = await readAgentsForSkillMatching();
    expect(result).toHaveLength(1);
    expect(result[0].humanReadableName).toBe("DB-rich Web Scrape");
    expect(result[0].description).toBe("DB description should win");
  });

  it("throwOnError propagates filesystem readdir failures", () => {
    resolveAgentInstallDirMock.mockImplementation(() => {
      throw new Error("install dir resolution failed");
    });

    expect(() => readProviderDeclaredAgents({ throwOnError: true })).toThrow(
      /install dir resolution failed/,
    );
    // Default behavior swallows the error and returns [].
    expect(readProviderDeclaredAgents()).toEqual([]);
  });

  it("throwOnError propagates a malformed sibling package.json when it's the only packageName source", () => {
    // Provider agent without packageName in agent.json — depends on sibling
    // package.json fallback. If that sibling file exists but is malformed,
    // we must NOT silently drop the agent under throwOnError:true (matcher
    // write path); we must propagate so the projection doesn't get a
    // misleading snapshot. A missing sibling (ENOENT) is fine — that's a
    // legitimate "no fallback available" path.
    const slugDir = path.join(tmpRoot, "cinatra-ai", "needs-sibling", "cinatra");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      path.join(slugDir, "oas.json"),
      JSON.stringify({ name: "Needs Sibling", description: "ok" }),
    );
    // Malformed sibling package.json.
    writeFileSync(
      path.join(tmpRoot, "cinatra-ai", "needs-sibling", "package.json"),
      "{ broken json",
    );

    expect(() => readProviderDeclaredAgents({ throwOnError: true })).toThrow(
      /failed to read sibling package\.json/,
    );

    // Default behavior: log + skip (the agent is silently dropped because
    // we couldn't resolve packageName).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readProviderDeclaredAgents()).toEqual([]);
    warn.mockRestore();
  });

  it("throwOnError propagates a malformed per-agent oas.json (so the matcher write path fails closed)", () => {
    const slugDir = path.join(tmpRoot, "cinatra-ai", "broken-agent", "cinatra");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(path.join(slugDir, "oas.json"), "{ this is not valid json");

    // Default permissive behavior: log + skip, don't blow up.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readProviderDeclaredAgents()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    // throwOnError must surface the parse failure to the matcher write path
    // so the legacy `agent_skill_matches` projection cannot be clobbered
    // with a partial / misleading snapshot on a transient corruption.
    expect(() => readProviderDeclaredAgents({ throwOnError: true })).toThrow(
      /failed to parse provider agent\.json at .*broken-agent/,
    );
  });
});

// Re-declare afterEach to satisfy the linter when vitest globals aren't enabled.
// This block is harmless when vitest globals are on.
import { afterEach } from "vitest";

import { readFileSync } from "fs";

describe("skill matching source contracts", () => {
  it("page.tsx dropdown filters out level=agent skills", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/configuration/skills/page.tsx"),
      "utf8",
    );
    // The filter must drop level=agent BEFORE the assignment check so the
    // dropdown never lists bundled skills from a different agent.
    expect(source).toMatch(/\.filter\(\(skill\) => skill\.level !== "agent"/);
  });

  it("matchAgentsToSkills does not push self-owned agent skills into the projection", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/agents-store.ts"),
      "utf8",
    );
    // Rows with this rationale string make bundled skills look like
    // cross-agent matches. Any reappearance would re-introduce the bug.
    expect(source).not.toContain('rationale: "Self-owned agent skill (level=agent)"');
    // The source comment must explicitly document the invariant so future
    // edits don't reintroduce self-owned agent skills into the projection.
    expect(source).toContain("The self-owned agent-skill projection is intentionally absent here.");
  });
});
