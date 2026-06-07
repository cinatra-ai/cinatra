import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import type {
  AgentTemplateRecord,
  AgentTemplateVersionRecord,
} from "@cinatra-ai/agents";
import { buildAgentCard } from "../agent-card";

// ---------------------------------------------------------------------------
// Fixture helpers (local copy of agent-card.test.ts helpers, kept independent)
// ---------------------------------------------------------------------------

function makeTemplate(
  overrides: Partial<AgentTemplateRecord> & {
    hitlScreens?: string[] | null;
  } = {},
): AgentTemplateRecord {
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
    hitlScreens: null,
    durable: false,
    hitlRequired: false,
    executionProvider: "default",
    lgGraphCode: null,
    lgGraphId: null,
    // External A2A template columns.
    sourceType: "internal",
    agentUrl: null,
    connectorSlug: null,
    remoteAgentId: null,
    // Trigger gate metadata (null on legacy fixtures).
    triggerMode: null,
    gatedSteps: null,
    // AgentAuthPolicy default (null = use DEFAULT_AGENT_AUTH_POLICY).
    agentAuthPolicy: null,
    // Extension soft-lifecycle (active by default for fixtures).
    extensionLifecycleStatus: "active" as const,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...(overrides as object),
  } as AgentTemplateRecord;
}

function makeVersion(
  semver: string,
  templateId = "tpl_1",
): AgentTemplateVersionRecord {
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

// Repo root = packages/a2a/../.. — resolve via import.meta-less relative path.
// __dirname is not available in ESM vitest, but path resolution from process.cwd()
// depends on where vitest is invoked. Use a fixed walk up from this test file's
// known location within the workspace using process.cwd().
// In practice vitest runs from packages/a2a when invoked via `pnpm test`, so the
// route file lives at ../../src/app/.well-known/agent.json/route.ts relative to cwd.
const ROUTE_REL_FROM_A2A = "../../src/app/.well-known/agent.json/route.ts";
const ROUTE_REL_FROM_ROOT = "src/app/.well-known/agent.json/route.ts";

function readRouteFile(): string {
  // Try from packages/a2a (vitest's cwd when invoked in this package first).
  const candidates = [
    path.resolve(process.cwd(), ROUTE_REL_FROM_A2A),
    path.resolve(process.cwd(), ROUTE_REL_FROM_ROOT),
    path.resolve(process.cwd(), "../..", ROUTE_REL_FROM_ROOT),
    path.resolve(process.cwd(), "..", ROUTE_REL_FROM_ROOT),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(
    `agent.json/route.ts not found; tried: ${candidates.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-card-route (GET /.well-known/agent.json)", () => {
  it("Test 1 (shape): two templates produce AgentCard with two skills whose ids match sanitizePackageNameToToolName", () => {
    const t1 = makeTemplate({
      id: "tpl_1",
      name: "First",
      packageName: "@cinatra/first",
    });
    const t2 = makeTemplate({
      id: "tpl_2",
      name: "Second",
      packageName: "@cinatra/second",
    });
    const versions = {
      tpl_1: [makeVersion("1.0.0", "tpl_1")],
      tpl_2: [makeVersion("2.0.0", "tpl_2")],
    };

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      tokenEndpoint: "https://cinatra.test/api/auth/oauth2/token",
      templates: [t1, t2],
      versionsByTemplateId: versions,
    });

    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].id).toBe(card.skills[0].toolName);
    expect(card.skills[1].id).toBe(card.skills[1].toolName);
    // id must look like the MCP tool name.
    expect(card.skills[0].id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(card.skills[1].id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(card.skills[0].packageName).toBe("@cinatra/first");
    expect(card.skills[1].packageName).toBe("@cinatra/second");
  });

  it("Test 2 (empty): no templates → HTTP 200-equivalent AgentCard with skills: [] and all top-level fields", () => {
    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      tokenEndpoint: "https://cinatra.test/api/auth/oauth2/token",
      templates: [],
      versionsByTemplateId: {},
    });

    expect(card.name).toBe("Cinatra");
    expect(card.url).toBe("https://cinatra.test/api/a2a");
    expect(card.version).toBe("1.0.0");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.authentication.schemes).toEqual(["Bearer", "OAuth2"]);
    expect(card.skills).toEqual([]);
  });

  it("Test 3 (no legacy): route file never imports or calls any legacy code-based factory", () => {
    const src = readRouteFile();
    const forbidden = [
      "createScrapeAgentModule",
      "createResearchAgentModule",
      "createEnrichmentAgentModule",
      "createRossIndexAgentModule",
      "createEmailOutreachAgentModule",
    ];
    for (const factory of forbidden) {
      expect(src).not.toContain(factory);
    }
  });

  it("Test 4 (CORS + content-type): route file sets Access-Control-Allow-Origin: * and application/json", () => {
    const src = readRouteFile();
    expect(src).toContain("Access-Control-Allow-Origin");
    expect(src).toContain("application/json");
  });

  it("Test 5 (hitlScreens passthrough): template hitlScreens flow into skill.hitlScreens verbatim", () => {
    const template = makeTemplate({
      hitlScreens: ["@cinatra-ai/email-delivery-agent:send-confirmation"],
    });

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: {},
    });

    expect(card.skills[0].hitlScreens).toEqual([
      { id: "@cinatra-ai/email-delivery-agent:send-confirmation", schema: {} },
    ]);
  });

  it("Test 6 (version metadata): packageVersion 2.0.0 + versions [1.0.0, 1.1.0, 2.0.0] → operativeVersion 2.0.0 and full supportedVersions", () => {
    const template = makeTemplate({
      packageVersion: "2.0.0",
    });
    const versions = [
      makeVersion("1.0.0"),
      makeVersion("1.1.0"),
      makeVersion("2.0.0"),
    ];

    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      templates: [template],
      versionsByTemplateId: { tpl_1: versions },
    });

    expect(card.skills[0].operativeVersion).toBe("2.0.0");
    expect(card.skills[0].supportedVersions).toEqual([
      "1.0.0",
      "1.1.0",
      "2.0.0",
    ]);
  });

  it("Test 7 (tokenEndpoint advertised): route file passes ${baseUrl}/api/auth/oauth2/token AND buildAgentCard emits it verbatim", () => {
    // Static inspection of route file.
    const src = readRouteFile();
    expect(src).toContain("tokenEndpoint");
    expect(src).toContain("api/auth/oauth2/token");
    // Also cited in .well-known/agent.json/route.ts
    expect(src).toContain(".well-known/agent.json".replace(/^/, ""));

    // Behavioral confirmation — tokenEndpoint input flows to authentication.tokenEndpoint.
    const card = buildAgentCard({
      baseUrl: "https://cinatra.test",
      tokenEndpoint: "https://cinatra.test/api/auth/oauth2/token",
      templates: [],
      versionsByTemplateId: {},
    });
    expect(card.authentication.tokenEndpoint).toBe(
      "https://cinatra.test/api/auth/oauth2/token",
    );
  });
});
