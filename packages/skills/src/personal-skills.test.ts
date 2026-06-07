/**
 * Contract tests for personal skill generation and based_on frontmatter.
 *
 * The createOrUpdatePersonalSkillForAgent system prompt must instruct
 * delta-only output AND explicitly forbid reproducing base skill content.
 * The prompt must not ask to merge base skills into one coherent personal
 * skill because that permits copying instead of producing targeted changes.
 *
 * After createOrUpdatePersonalSkillForAgent persists the skill, the saved
 * content must include a `based_on:` block with double-quoted base skill IDs.
 *
 * The prompt assertions go beyond just /delta/i — also assert
 * "do not reproduce / never reproduce", "additions", "amendments".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the module-under-test is imported
// ---------------------------------------------------------------------------

const {
  runResolvedDeterministicLlmTaskMock,
  resolveConfiguredLlmRuntimeMock,
  parseStructuredJsonMock,
  upsertCustomSkillMock,
  listInstalledSkillsMock,
  getInstalledSkillByIdMock,
  readAgentsCatalogMock,
  getAssignedSkillIdsForAgentMock,
  listPersonalSkillsForCurrentUserAndAgentMock,
} = vi.hoisted(() => {
  const defaultSkillContent = JSON.stringify({
    name: "X",
    description: "y",
    content: "---\ndisplay_name: X\n---\nbody",
  });
  return {
    runResolvedDeterministicLlmTaskMock: vi.fn(async () => ({
      text: defaultSkillContent,
      rawBody: null,
    })),
    resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
      provider: "openai" as const,
      connection: { apiKey: "sk-test" },
    })),
    parseStructuredJsonMock: vi.fn(<T>(value: string) => JSON.parse(value) as T),
    upsertCustomSkillMock: vi.fn(async (args: { content: string; [k: string]: unknown }) => ({
      id: "persisted-1",
      name: args.name ?? "Test",
      slug: "test",
      description: args.description ?? "desc",
      content: args.content ?? "",
      packageId: "pkg-1",
      packageName: "Custom Skills",
      packageSlug: "custom",
      usedBy: [],
      isCustomSkill: true,
      level: "personal" as const,
    })),
    listInstalledSkillsMock: vi.fn(async () => [
      {
        id: "@cinatra-ai/asset-blog:generate-blog-ideas",
        name: "Generate",
        description: "x",
        content: "base content",
        packageId: "pkg-1",
        packageName: "Blog",
        packageSlug: "blog",
        slug: "generate-blog-ideas",
        usedBy: [],
      },
    ]),
    getInstalledSkillByIdMock: vi.fn(async () => null),
    readAgentsCatalogMock: vi.fn(async () => [
      {
        id: "agent-x",
        identifier: "agent-x",
        humanReadableName: "Agent X",
        description: "An agent",
        content: "# Agent X",
        frontmatterRaw: undefined,
      },
    ]),
    getAssignedSkillIdsForAgentMock: vi.fn(async () => [
      "@cinatra-ai/asset-blog:generate-blog-ideas",
    ]),
    listPersonalSkillsForCurrentUserAndAgentMock: vi.fn(async () => []),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: runResolvedDeterministicLlmTaskMock,
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  parseStructuredJson: parseStructuredJsonMock,
}));

vi.mock("@/lib/agents-store", () => ({
  readAgentsCatalog: readAgentsCatalogMock,
  getAssignedSkillIdsForAgent: getAssignedSkillIdsForAgentMock,
}));

vi.mock("./skills-registry", () => ({
  listInstalledSkills: listInstalledSkillsMock,
  getInstalledSkillById: getInstalledSkillByIdMock,
}));

vi.mock("./skills-store", () => ({
  upsertCustomSkill: upsertCustomSkillMock,
  getCustomSkillForAgent: vi.fn(async () => null),
  listCustomSkills: vi.fn(async () => []),
  listCustomSkillsForAgent: vi.fn(async () => []),
}));

vi.mock("./constants", () => ({
  LOCAL_USER_ID: "local-test-user",
}));

import { createOrUpdatePersonalSkillForAgent } from "./personal-skills";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOrUpdatePersonalSkillForAgent — prompt delta semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore defaults after clearAllMocks resets implementations
    runResolvedDeterministicLlmTaskMock.mockResolvedValue({
      text: JSON.stringify({
        name: "X",
        description: "y",
        content: "---\ndisplay_name: X\n---\nbody",
      }),
      rawBody: null,
    });
    resolveConfiguredLlmRuntimeMock.mockResolvedValue({
      provider: "openai" as const,
      connection: { apiKey: "sk-test" },
    });
    parseStructuredJsonMock.mockImplementation(<T>(value: string) => JSON.parse(value) as T);
    upsertCustomSkillMock.mockResolvedValue({
      id: "persisted-1",
      name: "Test",
      slug: "test",
      description: "desc",
      content: "---\ndisplay_name: Test\n---\nbody",
      packageId: "pkg-1",
      packageName: "Custom Skills",
      packageSlug: "custom",
      usedBy: [],
      isCustomSkill: true,
      level: "personal" as const,
    });
    readAgentsCatalogMock.mockResolvedValue([
      {
        id: "agent-x",
        identifier: "agent-x",
        humanReadableName: "Agent X",
        description: "An agent",
        content: "# Agent X",
        frontmatterRaw: undefined,
      },
    ]);
    getAssignedSkillIdsForAgentMock.mockResolvedValue([
      "@cinatra-ai/asset-blog:generate-blog-ideas",
    ]);
    listInstalledSkillsMock.mockResolvedValue([
      {
        id: "@cinatra-ai/asset-blog:generate-blog-ideas",
        name: "Generate",
        description: "x",
        content: "base content",
        packageId: "pkg-1",
        packageName: "Blog",
        packageSlug: "blog",
        slug: "generate-blog-ideas",
        usedBy: [],
      },
    ]);
    listPersonalSkillsForCurrentUserAndAgentMock.mockResolvedValue([]);
  });

  it("emits a system prompt that instructs delta-only output and forbids reproducing base content", async () => {
    // The prompt must require targeted changes, not copied or merged base content.

    await createOrUpdatePersonalSkillForAgent({
      agentId: "agent-x",
      promptEntries: [{ id: "p1", kind: "initial", prompt: "be more concise", savedAt: new Date().toISOString() }],
      skillName: "Test",
    });

    expect(runResolvedDeterministicLlmTaskMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call: any = (runResolvedDeterministicLlmTaskMock.mock.calls as any[][])[0]?.[0];

    // Core assertion — prompt must use delta terminology
    expect(call.system).toMatch(/delta/i);

    // Prompt must forbid reproducing base content
    expect(call.system).toMatch(/do not reproduce|never reproduce|not reproduce/i);

    // Prompt must use "additions" for new instructions
    expect(call.system).toMatch(/additions/i);

    // Prompt must use "amendments" for changes
    expect(call.system).toMatch(/amendments/i);

    // The old copy-prone phrase must be gone
    expect(call.system).not.toMatch(/merge.*coherent/i);
  });
});

describe("createOrUpdatePersonalSkillForAgent — based_on frontmatter injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore defaults
    runResolvedDeterministicLlmTaskMock.mockResolvedValue({
      text: JSON.stringify({
        name: "X",
        description: "y",
        content: "---\ndisplay_name: X\n---\nbody",
      }),
      rawBody: null,
    });
    resolveConfiguredLlmRuntimeMock.mockResolvedValue({
      provider: "openai" as const,
      connection: { apiKey: "sk-test" },
    });
    parseStructuredJsonMock.mockImplementation(<T>(value: string) => JSON.parse(value) as T);
    upsertCustomSkillMock.mockResolvedValue({
      id: "persisted-1",
      name: "X",
      slug: "x",
      description: "y",
      content: "---\ndisplay_name: X\n---\nbody",
      packageId: "pkg-1",
      packageName: "Custom Skills",
      packageSlug: "custom",
      usedBy: [],
      isCustomSkill: true,
      level: "personal" as const,
    });
    readAgentsCatalogMock.mockResolvedValue([
      {
        id: "agent-x",
        identifier: "agent-x",
        humanReadableName: "Agent X",
        description: "An agent",
        content: "# Agent X",
        frontmatterRaw: undefined,
      },
    ]);
    getAssignedSkillIdsForAgentMock.mockResolvedValue([
      "@cinatra-ai/asset-blog:generate-blog-ideas",
      "@cinatra-ai/email-outreach-agent:campaign-email-outreach",
    ]);
    listInstalledSkillsMock.mockResolvedValue([
      {
        id: "@cinatra-ai/asset-blog:generate-blog-ideas",
        name: "Blog Ideas",
        description: "x",
        content: "base content",
        packageId: "pkg-1",
        packageName: "Blog",
        packageSlug: "blog",
        slug: "generate-blog-ideas",
        usedBy: [],
      },
      {
        id: "@cinatra-ai/email-outreach-agent:campaign-email-outreach",
        name: "Email Outreach",
        description: "y",
        content: "email content",
        packageId: "pkg-2",
        packageName: "Email",
        packageSlug: "email",
        slug: "campaign-email-outreach",
        usedBy: [],
      },
    ]);
    listPersonalSkillsForCurrentUserAndAgentMock.mockResolvedValue([]);
  });

  it("injects based_on: with quoted base skill IDs into the persisted content", async () => {
    // Persisted personal skills must record the base skills they derive from.

    await createOrUpdatePersonalSkillForAgent({
      agentId: "agent-x",
      promptEntries: [{ id: "p1", kind: "initial", prompt: "be more concise", savedAt: new Date().toISOString() }],
      skillName: "Test",
    });

    expect(upsertCustomSkillMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upsertArgs = (upsertCustomSkillMock.mock.calls as any[][])[0]?.[0] as { content: string };

    // based_on: block with first skill ID
    expect(upsertArgs.content).toMatch(
      /based_on:\n\s+-\s+"@cinatra\/asset-blog:generate-blog-ideas"/,
    );

    // based_on: block with second skill ID
    expect(upsertArgs.content).toMatch(
      /based_on:\n[\s\S]+-\s+"@cinatra\/email-outreach:campaign-email-outreach"/,
    );
  });
});
