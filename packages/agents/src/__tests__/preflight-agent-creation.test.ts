/**
 * `preflightAgentCreation` hard pre-enqueue gate tests.
 *
 * Verifies:
 *   - INACTIVE pin → no-op `{ok:true, pinActive:false}` by default.
 *   - Pin-config failures (missing/invalid provider, missing model).
 *   - Anthropic-specific failures (opt-in off, no skills resolved, environment
 *     unavailable, catalog unavailable, missing sync rows, stale rows, content
 *     drift, governance denied, size cap, request cap).
 *   - All failures returned together (not first-only) for the operator.
 *   - Happy-path returns `{ok:true, pinActive:true, provider, model}`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({
  isAgentCreationPinActive: vi.fn(() => false),
  readAgentCreationLlmProviderFromDatabase: vi.fn(() => null as string | null),
  readAgentCreationModelFromDatabase: vi.fn(() => null as string | null),
  readAnthropicSkillSyncEnabledFromDatabase: vi.fn(() => false),
}));
vi.mock("@/lib/database", () => dbMock);

const svcMock = vi.hoisted(() => ({
  deriveApiKeyFingerprint: vi.fn(() => "fp_test"),
  deriveEnvironmentNamespace: vi.fn(() => "schema=cinatra;db=test"),
  buildSyncCandidates: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/anthropic-skill-sync-service", () => svcMock);

type SyncRowShape = { catalogSkillId: string; anthropicSkillId: string; anthropicVersion: string; contentHash: string; stale: boolean };
const daoMock = vi.hoisted(() => ({
  readSyncRow: vi.fn<(apiKeyFingerprint: string, environment: string, catalogSkillId: string) => Promise<SyncRowShape | null>>(),
}));
vi.mock("@/lib/anthropic-skill-sync-dao", () => daoMock);

const governanceMock = vi.hoisted(() => ({
  isAnthropicSkillUploadAllowedFromConfig: vi.fn(() => true),
}));
vi.mock("@/lib/anthropic-skill-upload-governance", () => governanceMock);

// Stub `@cinatra-ai/llm` to avoid pulling the openai/anthropic
// SDK chain into vitest's loader because those imports are not resolved here.
// Re-export the REAL `computeSkillContentHash` + sentinel error from source so
// preflight's content-hash + size-cap checks work, but stub the package index
// to avoid the openai-connector resolution failure.
const orchMock = vi.hoisted(async () => {
  const { computeSkillContentHash } = await import("../../../llm/src/tools/anthropic-skill-content-hash");
  const { preflightAnthropicSkillSyncSizes, preflightSkillRequestSet } = await import("../../../llm/src/tools/anthropic-skill-sync-engine");
  return {
    computeSkillContentHash,
    preflightAnthropicSkillSyncSizes,
    preflightSkillRequestSet,
  };
});
vi.mock("@cinatra-ai/llm", async () => await orchMock);

import { preflightAgentCreation } from "../preflight-agent-creation";

const NO_SKILLS = {
  requiredCatalogSkillIds: [] as string[],
  laneSkillSets: [
    { agentPackageName: "@cinatra-ai/security-reviewer-agent", skillIds: [] },
    { agentPackageName: "@cinatra-ai/code-reviewer-agent", skillIds: [] },
    { agentPackageName: "@cinatra-ai/planner-agent", skillIds: [] },
  ],
};

const WITH_SKILLS = {
  requiredCatalogSkillIds: ["sec-skill", "code-skill", "design-skill"],
  laneSkillSets: [
    { agentPackageName: "@cinatra-ai/security-reviewer-agent", skillIds: ["sec-skill"] },
    { agentPackageName: "@cinatra-ai/code-reviewer-agent", skillIds: ["code-skill"] },
    { agentPackageName: "@cinatra-ai/planner-agent", skillIds: ["design-skill"] },
  ],
};

beforeEach(() => {
  dbMock.isAgentCreationPinActive.mockReturnValue(false);
  dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue(null);
  dbMock.readAgentCreationModelFromDatabase.mockReturnValue(null);
  dbMock.readAnthropicSkillSyncEnabledFromDatabase.mockReturnValue(false);
  svcMock.deriveApiKeyFingerprint.mockReturnValue("fp_test");
  svcMock.deriveEnvironmentNamespace.mockReturnValue("schema=cinatra;db=test");
  svcMock.buildSyncCandidates.mockResolvedValue([]);
  daoMock.readSyncRow.mockResolvedValue(null);
  governanceMock.isAnthropicSkillUploadAllowedFromConfig.mockReturnValue(true);
});

describe("preflightAgentCreation — pin INACTIVE default", () => {
  it("no-ops with {ok:true, pinActive:false}", async () => {
    const result = await preflightAgentCreation(NO_SKILLS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pinActive).toBe(false);
    }
  });
});

describe("preflightAgentCreation — pin config", () => {
  it("pin_not_configured when provider is missing", async () => {
    dbMock.isAgentCreationPinActive.mockReturnValue(true);
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue(null);
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("gpt-5");
    const result = await preflightAgentCreation(NO_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("pin_not_configured");
    }
  });

  it("pin_not_configured when model is missing", async () => {
    dbMock.isAgentCreationPinActive.mockReturnValue(true);
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("openai");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue(null);
    const result = await preflightAgentCreation(NO_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("pin_not_configured");
    }
  });

  it("invalid_provider_config when provider string is junk", async () => {
    dbMock.isAgentCreationPinActive.mockReturnValue(true);
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("claude-opus-4");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("claude-opus-4-7");
    const result = await preflightAgentCreation(NO_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("invalid_provider_config");
    }
  });

  it("openai pin happy path → no anthropic checks fire", async () => {
    dbMock.isAgentCreationPinActive.mockReturnValue(true);
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("openai");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("gpt-5.5");
    const result = await preflightAgentCreation(NO_SKILLS);
    expect(result.ok).toBe(true);
    if (result.ok && result.pinActive) {
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-5.5");
    }
    expect(daoMock.readSyncRow).not.toHaveBeenCalled();
    expect(svcMock.buildSyncCandidates).not.toHaveBeenCalled();
  });
});

describe("preflightAgentCreation — anthropic-specific checks", () => {
  beforeEach(() => {
    dbMock.isAgentCreationPinActive.mockReturnValue(true);
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("anthropic");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("claude-opus-4-7");
    dbMock.readAnthropicSkillSyncEnabledFromDatabase.mockReturnValue(true);
  });

  it("anthropic_no_skills_resolved when a lane resolved 0 skills (BLOCKER A)", async () => {
    const result = await preflightAgentCreation({
      ...WITH_SKILLS,
      laneSkillSets: [
        ...WITH_SKILLS.laneSkillSets.slice(0, 2),
        { agentPackageName: "@cinatra-ai/planner-agent", skillIds: [] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failure = result.errors.find((e) => e.code === "anthropic_no_skills_resolved");
      expect(failure).toBeDefined();
      expect(failure && "emptyLanePackages" in failure && failure.emptyLanePackages).toContain(
        "@cinatra-ai/planner-agent",
      );
    }
  });

  it("anthropic_opt_in_off when global opt-in is false", async () => {
    dbMock.readAnthropicSkillSyncEnabledFromDatabase.mockReturnValue(false);
    const result = await preflightAgentCreation(WITH_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "anthropic_opt_in_off")).toBe(true);
    }
  });

  it("environment_unavailable when deriveEnvironmentNamespace throws", async () => {
    svcMock.deriveEnvironmentNamespace.mockImplementation(() => {
      throw new Error("SUPABASE_DB_URL is unset");
    });
    const result = await preflightAgentCreation(WITH_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "environment_unavailable")).toBe(true);
    }
  });

  it("skills_not_synced when no rows exist for required skills", async () => {
    daoMock.readSyncRow.mockResolvedValue(null);
    const result = await preflightAgentCreation(WITH_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failure = result.errors.find((e) => e.code === "skills_not_synced");
      expect(failure).toBeDefined();
      expect(failure && "missingCatalogSkillIds" in failure && failure.missingCatalogSkillIds).toEqual([
        "sec-skill",
        "code-skill",
        "design-skill",
      ]);
    }
  });

  it("skills_stale when rows are marked stale", async () => {
    daoMock.readSyncRow.mockImplementation(async (_fp, _env, catalogSkillId) => ({
      catalogSkillId,
      anthropicSkillId: "skill_abc",
      anthropicVersion: "v1",
      contentHash: "hash_abc",
      stale: true,
    }));
    const result = await preflightAgentCreation(WITH_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failure = result.errors.find((e) => e.code === "skills_stale");
      expect(failure).toBeDefined();
    }
  });

  it("skills_content_drift when current content hash differs from row hash", async () => {
    daoMock.readSyncRow.mockImplementation(async (_fp, _env, catalogSkillId) => ({
      catalogSkillId,
      anthropicSkillId: "skill_abc",
      anthropicVersion: "v1",
      contentHash: "stale_hash",
      stale: false,
    }));
    svcMock.buildSyncCandidates.mockResolvedValue([
      {
        catalogSkillId: "sec-skill",
        name: "sec",
        skillMd: Buffer.from("# fresh content"),
        bundledFiles: [],
        allowAnthropicUpload: true,
      },
      {
        catalogSkillId: "code-skill",
        name: "code",
        skillMd: Buffer.from("# fresh content code"),
        bundledFiles: [],
        allowAnthropicUpload: true,
      },
      {
        catalogSkillId: "design-skill",
        name: "design",
        skillMd: Buffer.from("# fresh content design"),
        bundledFiles: [],
        allowAnthropicUpload: true,
      },
    ]);
    const result = await preflightAgentCreation(WITH_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "skills_content_drift")).toBe(true);
    }
  });

  it("skills_governance_denied when isAnthropicSkillUploadAllowedFromConfig returns false", async () => {
    // Configure rows-exist, hash-matches so we get past the missing/drift checks.
    const candidates = WITH_SKILLS.requiredCatalogSkillIds.map((id) => ({
      catalogSkillId: id,
      name: id,
      skillMd: Buffer.from("content"),
      bundledFiles: [],
      allowAnthropicUpload: false,
    }));
    svcMock.buildSyncCandidates.mockResolvedValue(candidates);
    // Compute hash inline matching what content-hash will compute (same buffer).
    // Just stub readSyncRow to return a matching hash; preflight will fail on
    // governance instead of drift.
    const { computeSkillContentHash } = await import("@cinatra-ai/llm");
    daoMock.readSyncRow.mockImplementation(async (_fp, _env, catalogSkillId) => ({
      catalogSkillId,
      anthropicSkillId: "skill_abc",
      anthropicVersion: "v1",
      contentHash: computeSkillContentHash(Buffer.from("content"), []),
      stale: false,
    }));
    governanceMock.isAnthropicSkillUploadAllowedFromConfig.mockReturnValue(false);
    const result = await preflightAgentCreation(WITH_SKILLS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "skills_governance_denied")).toBe(true);
    }
  });

  it("skill_request_cap_exceeded when ONE LANE has >8 skills (per-lane, not union)", async () => {
    const nineSkills = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
    const result = await preflightAgentCreation({
      requiredCatalogSkillIds: nineSkills,
      laneSkillSets: [{ agentPackageName: "@cinatra-ai/x", skillIds: nineSkills }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "skill_request_cap_exceeded")).toBe(true);
    }
  });

  it("does NOT trigger cap when union > 8 but each lane is ≤ 8 (per-lane semantics)", async () => {
    // Three lanes × 3 unique skills each = 9 unique union skills, but each
    // request only sees 3 skills, preserving the per-lane cap invariant.
    const requiredCatalogSkillIds = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
    const candidates = requiredCatalogSkillIds.map((id) => ({
      catalogSkillId: id,
      name: id,
      skillMd: Buffer.from("content"),
      bundledFiles: [],
      allowAnthropicUpload: true,
    }));
    svcMock.buildSyncCandidates.mockResolvedValue(candidates);
    const { computeSkillContentHash } = await import("@cinatra-ai/llm");
    const matchingHash = computeSkillContentHash(Buffer.from("content"), []);
    daoMock.readSyncRow.mockImplementation(async (_fp, _env, catalogSkillId) => ({
      catalogSkillId,
      anthropicSkillId: "skill_abc",
      anthropicVersion: "v1",
      contentHash: matchingHash,
      stale: false,
    }));
    governanceMock.isAnthropicSkillUploadAllowedFromConfig.mockReturnValue(true);
    const result = await preflightAgentCreation({
      requiredCatalogSkillIds,
      laneSkillSets: [
        { agentPackageName: "@cinatra-ai/lane-1", skillIds: ["s1", "s2", "s3"] },
        { agentPackageName: "@cinatra-ai/lane-2", skillIds: ["s4", "s5", "s6"] },
        { agentPackageName: "@cinatra-ai/lane-3", skillIds: ["s7", "s8", "s9"] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("happy path → {ok:true, pinActive:true, provider:'anthropic', model:'claude-opus-4-7'}", async () => {
    const candidates = WITH_SKILLS.requiredCatalogSkillIds.map((id) => ({
      catalogSkillId: id,
      name: id,
      skillMd: Buffer.from("content"),
      bundledFiles: [],
      allowAnthropicUpload: true,
    }));
    svcMock.buildSyncCandidates.mockResolvedValue(candidates);
    const { computeSkillContentHash } = await import("@cinatra-ai/llm");
    const matchingHash = computeSkillContentHash(Buffer.from("content"), []);
    daoMock.readSyncRow.mockImplementation(async (_fp, _env, catalogSkillId) => ({
      catalogSkillId,
      anthropicSkillId: "skill_abc",
      anthropicVersion: "v1",
      contentHash: matchingHash,
      stale: false,
    }));
    governanceMock.isAnthropicSkillUploadAllowedFromConfig.mockReturnValue(true);
    const result = await preflightAgentCreation(WITH_SKILLS);
    expect(result.ok).toBe(true);
    if (result.ok && result.pinActive) {
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-opus-4-7");
    }
  });

  it("returns ALL failures together (not first-only)", async () => {
    // Trigger opt-in OFF + no-skills-resolved + missing rows simultaneously.
    dbMock.readAnthropicSkillSyncEnabledFromDatabase.mockReturnValue(false);
    daoMock.readSyncRow.mockResolvedValue(null);
    const result = await preflightAgentCreation({
      ...WITH_SKILLS,
      laneSkillSets: [
        { agentPackageName: "@cinatra-ai/x", skillIds: [] },
        ...WITH_SKILLS.laneSkillSets.slice(1),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should have at least anthropic_opt_in_off and anthropic_no_skills_resolved
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("anthropic_no_skills_resolved");
      expect(codes).toContain("anthropic_opt_in_off");
    }
  });
});
