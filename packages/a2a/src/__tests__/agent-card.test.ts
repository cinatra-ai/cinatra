import { describe, it, expect } from "vitest";

import type { AgentTemplateRecord, AgentTemplateVersionRecord } from "@cinatra-ai/agents";
import { buildAgentCard } from "../agent-card";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Partial<AgentTemplateRecord> & { hitlScreens?: string[] | null } = {}): AgentTemplateRecord {
  return {
    id: "tpl_1",
    orgId: null,
    creatorId: null,
    name: "Email Outreach",
    description: "Send outbound email campaigns",
    sourceNl: "Send emails to people",
    compiledPlan: [],
    inputSchema: {},
    outputSchema: null,
    approvalPolicy: { steps: [] },
    status: "published",
    executionMode: "agentic",
    type: "leaf",
    taskSpec: null,
    packageName: "@cinatra-ai/email-outreach-agent",
    packageVersion: "1.2.0",
    currentVersionId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    hitlScreens: null,
    durable: false,
    hitlRequired: false,
    executionProvider: "default",
    lgGraphCode: null,
    lgGraphId: null,
    // External A2A template columns default to internal so existing fixtures
    // behave identically.
    sourceType: "internal",
    agentUrl: null,
    connectorSlug: null,
    remoteAgentId: null,
    // Trigger gate metadata is null on legacy fixtures.
    triggerMode: null,
    gatedSteps: null,
    // AgentAuthPolicy default uses DEFAULT_AGENT_AUTH_POLICY when null.
    agentAuthPolicy: null,
    // Extension soft-lifecycle is active by default for fixtures.
    extensionLifecycleStatus: "active" as const,
    ...(overrides as object),
  } as AgentTemplateRecord;
}

function makeVersion(semver: string, templateId = "tpl_1"): AgentTemplateVersionRecord {
  return {
    id: `ver_${semver}`,
    templateId,
    versionNumber: 1,
    semver,
    bumpType: "minor",
    changelogLine: null,
    contentHash: "x",
    snapshot: {} as any,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  } as unknown as AgentTemplateVersionRecord;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAgentCard", () => {
  it("Test 1: empty templates array returns AgentCard with empty skills and correct top-level fields", () => {
    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [],
      versionsByTemplateId: {},
    });

    expect(card.name).toBe("Cinatra");
    expect(card.description).toContain("Cinatra agent platform");
    expect(card.url).toBe("https://cinatra.test/api/a2a");
    expect(card.version).toBe("1.0.0");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.authentication.schemes).toEqual(["Bearer", "OAuth2"]);
    expect(card.authentication.credentials).toBeNull();
    expect(card.skills).toEqual([]);
  });

  it("Test 2: single template with all fields produces matching skill entry", () => {
    const template = makeTemplate({
      hitlScreens: ["@cinatra-ai/email-delivery-agent:send-confirmation"],
    });
    const versions = [makeVersion("1.0.0"), makeVersion("1.1.0"), makeVersion("1.2.0")];

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: { tpl_1: versions },
    });

    expect(card.skills).toHaveLength(1);
    const skill = card.skills[0];
    expect(skill.name).toBe("Email Outreach");
    expect(skill.description).toBe("Send outbound email campaigns");
    expect(skill.operativeVersion).toBe("1.2.0");
    expect(skill.supportedVersions).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    expect(skill.hitlScreens).toEqual([{ id: "@cinatra-ai/email-delivery-agent:send-confirmation", schema: {} }]);
    expect(skill.packageName).toBe("@cinatra-ai/email-outreach-agent");
    expect(skill.inputModes).toEqual(["text"]);
    expect(skill.outputModes).toEqual(["text"]);
  });

  it("Test 3: description null falls back to first sourceNl line", () => {
    const template = makeTemplate({
      description: null,
      sourceNl: "First line\nSecond line",
    });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].description).toBe("First line");
  });

  it("Test 4: packageVersion null produces operativeVersion 0.0.0 and empty supportedVersions", () => {
    const template = makeTemplate({ packageVersion: null });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].operativeVersion).toBe("0.0.0");
    expect(card.skills[0].supportedVersions).toEqual([]);
  });

  it("Test 5: hitlScreens null produces empty array", () => {
    const template = makeTemplate({ hitlScreens: null });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].hitlScreens).toEqual([]);
  });

  it("Test 6: two templates preserves input order", () => {
    const t1 = makeTemplate({ id: "tpl_1", name: "First", packageName: "@cinatra/first" });
    const t2 = makeTemplate({ id: "tpl_2", name: "Second", packageName: "@cinatra/second" });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [t1, t2],
      versionsByTemplateId: {},
    });

    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].name).toBe("First");
    expect(card.skills[1].name).toBe("Second");
  });

  it("Test 7: trailing slash in baseUrl is stripped", () => {
    const card = buildAgentCard({
      baseUrl: "https://x.com/",
      templates: [],
      versionsByTemplateId: {},
    });

    expect(card.url).toBe("https://x.com/api/a2a");
  });

  it("Test 8: sanitized skill.id matches MCP tool name regex", () => {
    const template = makeTemplate();

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });

  it("Test 9: skill.id always equals skill.toolName (invariant)", () => {
    const t1 = makeTemplate({ id: "tpl_1", packageName: "@cinatra/first" });
    const t2 = makeTemplate({ id: "tpl_2", packageName: "@cinatra/second" });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [t1, t2],
      versionsByTemplateId: {},
    });

    for (const skill of card.skills) {
      expect(skill.id).toBe(skill.toolName);
    }
  });

  it("Test 10: deterministic output — identical input → identical JSON.stringify", () => {
    const template = makeTemplate({
      hitlScreens: ["@cinatra-ai/email-delivery-agent:send-confirmation"],
    });
    const versions = [makeVersion("1.0.0"), makeVersion("1.2.0")];
    const input = {
      baseUrl: "https://cinatra.test",
      hostVersion: "2.0.0",
      tokenEndpoint: "https://cinatra.test/api/auth/oauth2/token",
      templates: [template],
      versionsByTemplateId: { tpl_1: versions },
    };

    const a = buildAgentCard(input);
    const b = buildAgentCard(input);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("Test 11: Markdown header line in sourceNl is skipped", () => {
    const template = makeTemplate({
      description: null,
      sourceNl: "# Email Agent\nSend outbound emails\nMore",
    });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].description).toBe("Send outbound emails");
  });

  it("Test 12: header-only sourceNl produces empty description", () => {
    const template = makeTemplate({
      description: null,
      sourceNl: "# Only header",
    });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].description).toBe("");
  });

  it("Test 13: leading blank lines + subheader skipped, real text returned", () => {
    const template = makeTemplate({
      description: null,
      sourceNl: "\n\n## Sub\nReal text",
    });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].description).toBe("Real text");
  });

  it("Test 14: tokenEndpoint included when provided", () => {
    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      tokenEndpoint: "https://cinatra.test/api/auth/oauth2/token",
      templates: [],
      versionsByTemplateId: {},
    });

    expect(card.authentication.tokenEndpoint).toBe("https://cinatra.test/api/auth/oauth2/token");
    expect(card.authentication.schemes).toContain("Bearer");
    expect(card.authentication.schemes).toContain("OAuth2");
  });

  it("Test 15: tokenEndpoint key absent when not provided", () => {
    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [],
      versionsByTemplateId: {},
    });

    expect(Object.prototype.hasOwnProperty.call(card.authentication, "tokenEndpoint")).toBe(false);
  });

  it("Test 16: template missing packageName is filtered defensively", () => {
    const t1 = makeTemplate({ id: "tpl_1", packageName: null as any });
    const t2 = makeTemplate({ id: "tpl_2", packageName: "@cinatra/second" });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [t1, t2],
      versionsByTemplateId: {},
    });

    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].packageName).toBe("@cinatra/second");
  });

  it("Test 17: hostVersion override flows to AgentCard.version", () => {
    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      hostVersion: "3.4.5",
      templates: [],
      versionsByTemplateId: {},
    });

    expect(card.version).toBe("3.4.5");
  });

  // ---------------------------------------------------------------------------
  // agentDependencies surfaced on skills
  // ---------------------------------------------------------------------------

  it("Test 18: includes agentDependencies on each skill when template declares them", () => {
    const template = makeTemplate({
      agentDependencies: { "@cinatra/foo": "^1.0.0" },
    });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].agentDependencies).toEqual({ "@cinatra/foo": "^1.0.0" });
  });

  it("Test 19: defaults agentDependencies to {} when template omits the field", () => {
    const template = makeTemplate();

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].agentDependencies).toEqual({});
    expect("agentDependencies" in card.skills[0]).toBe(true);
  });

  it("Test 20: preserves agentDependencies through JSON serialization round-trip", () => {
    const template = makeTemplate({
      agentDependencies: { "@cinatra/foo": "^1.2.3", "@cinatra/bar": "~2.0.0" },
    });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    const parsed = JSON.parse(JSON.stringify(card));
    expect(parsed.skills[0].agentDependencies).toEqual({
      "@cinatra/foo": "^1.2.3",
      "@cinatra/bar": "~2.0.0",
    });
  });

  // ---------------------------------------------------------------------------
  // type field surfaced on AgentCardSkill
  // ---------------------------------------------------------------------------

  it("AgentCardSkill exposes type field from template", () => {
    const template = makeTemplate({ type: "orchestrator" } as Partial<AgentTemplateRecord>);

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].type).toBe("orchestrator");
  });

  it("AgentCardSkill defaults type to leaf when template omits it", () => {
    // Fixture intentionally omits `type` to simulate legacy data.
    const template = makeTemplate();

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].type).toBe("leaf");
  });

  it("AgentCardSkill type round-trips through JSON serialization", () => {
    const t1 = makeTemplate({ id: "tpl_1", packageName: "@cinatra/first", type: "proxy" } as Partial<AgentTemplateRecord>);
    const t2 = makeTemplate({ id: "tpl_2", packageName: "@cinatra/second", type: "orchestrator" } as Partial<AgentTemplateRecord>);

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [t1, t2],
      versionsByTemplateId: {},
    });

    const parsed = JSON.parse(JSON.stringify(card));
    expect(parsed.skills[0].type).toBe("proxy");
    expect(parsed.skills[1].type).toBe("orchestrator");
  });
});
