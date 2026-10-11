/**
 * cinatra#3627: the agent settings / Skills writer feeds the next dispatch.
 *
 * Real: page write authorization, assignScopeSkill, assignability, the assigned
 * tier in agents-store, frozen-scope resolution, candidate selection and hold
 * policy. Doubled: catalog/install/membership I/O, the shared assignment store,
 * scorer, park persistence and notifications. No browser or database is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { AgentAssignedSkillRow } from "@/lib/agent-assigned-skills-store";
import type { ScopeAssignmentActionTarget } from "@/lib/scope-assignment/scope-assignment-model";
import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import {
  assignScopeSkill,
  defaultScopeAssignmentWriteDeps,
  type ScopeAssignmentWriteDeps,
} from "@/lib/scope-assignment/scope-assignment-writes.server";

const AGENT = "@cinatra-ai/scope-fixture-agent";
const OWNER = "@cinatra-ai/list-curation-skill";
const SKILL = `${OWNER}:list-curation`;
const WRITER = "settings-user";
const OTHER = "other-user";
const ORG = "org-acme";
let rows: AgentAssignedSkillRow[] = [];
let active = true;

const catalog = () => [{
  id: SKILL, name: "List curation", slug: "list-curation", description: "",
  content: "", packageId: "pkg", packageName: OWNER,
  packageSlug: "list-curation-skill", usedBy: [], level: "workspace",
}];

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));
vi.mock("../../../packages/skills/src/agent-skill-assignment-sources", () => ({
  readCatalogSource: async () => ({ skills: catalog() }),
  readCatalogSnapshotSource: async () => ({ skills: catalog() }),
  scanExtensionsSource: async () => [{
    pkgDir: "/fixture/list-curation-skill", pkgName: OWNER,
    pkgDirName: "list-curation-skill", kind: "skill", dependencies: [],
    capabilities: {}, slugs: ["list-curation"],
  }],
  readInstallStatusSource: async () => new Map([[OWNER, "active"]]),
  readAgentPopulationSource: async () => [{
    packageId: AGENT, id: "scope-fixture-agent", identifier: "scope-fixture-agent",
    packageSlug: "scope-fixture-agent",
  }],
  readPackageKindSource: async () => "agent",
  isAssistantPackageSource: async () => false,
}));
// The writer and reader share this one store; neither receives pre-seeded picks.
vi.mock("@/lib/agent-assigned-skills-store", () => ({
  insertAssignedSkill: async (input: {
    agentPackageName: string; skillId: string; createdBy: string;
    scope: { scopeKind: AgentAssignedSkillRow["scopeKind"]; scopeId: string };
  }) => {
    const row: AgentAssignedSkillRow = {
      agentPackageName: input.agentPackageName, skillId: input.skillId,
      createdBy: input.createdBy, ...input.scope, source: "manual",
      originRunId: null, position: rows.length + 1, createdAt: "2026-10-01T00:00:00Z",
    };
    rows.push(row);
    return { outcome: "assigned", row };
  },
  readAssignedSkillsForAgentPackage: async (packageName: string) =>
    rows.filter((row) => row.agentPackageName === packageName),
}));
vi.mock("@/lib/database", () => ({
  readAgentSkillMatchesFromDatabase: vi.fn(() => ({ matches: [], matchedAt: "" })),
  replaceAgentSkillMatchesInDatabase: vi.fn(),
  readAgentSkillExclusionsFromDatabase: vi.fn(() => ({ exclusions: [], updatedAt: "" })),
  replaceAgentSkillExclusionsInDatabase: vi.fn(),
  readAgentCatalogFromDatabase: vi.fn(() => ({ agents: [] })),
  replaceAgentCatalogInDatabase: vi.fn(),
  readCustomSkillAssignmentsForAgent: vi.fn(() => []),
  readSystemGlobalSkillIdsForAgent: vi.fn(() => []),
  readSkillLifecycleStates: (ids: string[]) => ({
    ok: true, states: new Map(ids.map((id) => [id, active ? "active" : "archived"])),
  }),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: async () => [{ packageName: AGENT, name: "Fixture", description: "" }],
}));
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/nonexistent-install-dir",
  resolveDevExtensionSourceRoot: () => "/nonexistent-install-dir",
}));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@cinatra-ai/skills", async () => {
  const visibility = await vi.importActual<typeof import("../../../packages/skills/src/llm-matching/visibility")>("../../../packages/skills/src/llm-matching/visibility");
  const source = await vi.importActual<typeof import("../../../packages/skills/src/skill-source")>("../../../packages/skills/src/skill-source");
  return {
    filterMatchRowsByVisibility: visibility.filterMatchRowsByVisibility,
    isRuntimeDeliverableLifecycleState: source.isRuntimeDeliverableLifecycleState,
    MANUAL_VERSION: "manual",
    resolveEffectiveSkillAccessPolicy: () => null,
    readSkillsCatalog: async () => ({ skills: catalog(), skillPackages: [] }),
    skillMatchesStore: {
      readSkillMatchesByAgent: async () => [], readAllMatched: async () => [],
      upsertSkillMatch: async () => {},
    },
  };
});
// Root Vitest aliases this import to a stub. Forward it to the REAL module so
// recommendation-hold exercises the same resolver as our direct assertion.
vi.mock("@/lib/agents-store", async () => vi.importActual("../agents-store"));
const resolveRunActor = vi.fn(async (run: { runBy: string | null }) => ({
  principalType: "HumanUser" as const, principalId: run.runBy!,
  organizationId: ORG, teamIds: [], projectIds: [], platformRole: "member" as const,
}));
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAssignedSkillsActorForRun: (run: { runBy: string | null }) => resolveRunActor(run),
}));
const score = vi.fn(async (input: { restrictToSkillIds?: string[] }) =>
  (input.restrictToSkillIds ?? []).map((skillId) => ({
    skillId, skillRevisionId: `${skillId}@1`, name: "List curation",
    score: 0.9, rank: 1, recommended: true, scoredFeatures: [],
  })));
vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  recommendSkillsForAgentTask: (input: { restrictToSkillIds?: string[] }) => score(input),
}));
vi.mock("../../../packages/agents/src/lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: async () => ({ bound: "silent" }),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));
const park = vi.fn();
vi.mock("../../../packages/agents/src/lifecycle-continuation-park-store", () => ({
  readContinuationParksForRun: async () => [],
  maybeParkCheckpoint: (...args: unknown[]) => park(...args),
}));
vi.mock("../../../packages/agents/src/run-wait-notifier", () => ({
  RECOMMENDATION_HOLD_CHECKPOINT: "recommendation",
  dispatchRecommendationHoldEntered: vi.fn(),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({ publishAgUiEvent: vi.fn() }));

const { getAssignedSkillIdsForAgent } = await import("../agents-store");
const holdStore = await import("@/lib/agents-store");
const { resolveRecommendationCandidateSkillIds, maybeHoldRunForRecommendation } =
  await import("../../../packages/agents/src/recommendation-hold");

function writeDeps(): ScopeAssignmentWriteDeps {
  return {
    ...defaultScopeAssignmentWriteDeps,
    target: {
      readSession: async () => ({ userId: WRITER, activeOrgId: ORG }),
      readBaseActor: async () => ({
        principalType: "HumanUser", principalId: WRITER, authSource: "ui",
        policyVersion: "v2", organizationId: ORG, platformRole: "member",
        orgRole: "member", teamIds: [], projectGrants: [],
      } satisfies ActorContext),
      readGrantsInOrg: async () => ({ orgRole: "org_admin", teamIds: [], projectGrants: [] }),
      readMembership: async () => ({
        vantage: buildWorkspaceVantage({ userId: WRITER, memberships: [{ orgId: ORG }] }),
        scopeNames: {},
      }),
      readAgentRows: async () => [{
        key: AGENT, name: "Fixture", description: "", host: "local", packageName: AGENT,
        detailHref: null, runHref: "", settingsHref: "", version: null, status: "active",
      }],
      readAssistantRows: async () => [],
      assertWriteTarget: async () => ({ ok: true }),
    },
    withInstallLock: async (_packageName, fn) => fn(),
  };
}
function target(scope: ScopeAssignmentActionTarget["scope"]): ScopeAssignmentActionTarget {
  return { surface: "agent", vendor: "cinatra-ai", name: "scope-fixture-agent", scope };
}
function run(id: string, human = WRITER, orgId = ORG) {
  return {
    id, orgId, runBy: human, sourceType: "agent_builder", humanPresent: true,
    inputParams: { prompt: "Curate this list" },
    assignmentScopeSnapshot: { v: 1, orgId, teamIds: [], originatingHumanUserId: human },
  };
}
const template = { packageName: AGENT, lifecycleConfig: null };

beforeEach(() => {
  rows = [];
  active = true;
  vi.clearAllMocks();
  park.mockResolvedValue({ parked: true, parkId: "park-next", reevaluationIntent: false });
  vi.stubEnv("CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("agent settings Skills assignment → next-dispatch recommendation (#3627)", () => {
  it("persists the page user's personal tuple and offers it to their next real dispatch", async () => {
    expect(holdStore.getAssignedSkillIdsForAgent).toBe(getAssignedSkillIdsForAgent);
    const before = run("before-assignment");
    expect(await resolveRecommendationCandidateSkillIds({ run: before, packageName: AGENT })).toEqual([]);
    expect(await maybeHoldRunForRecommendation({ run: before, template })).toEqual({
      held: false, reason: "no recommendation candidates",
    });
    expect(park).not.toHaveBeenCalled();

    expect(await assignScopeSkill(target({ kind: "personal" }), SKILL, writeDeps())).toEqual({ ok: true });
    expect(rows).toEqual([expect.objectContaining({
      agentPackageName: AGENT, skillId: SKILL, scopeKind: "user", scopeId: WRITER, createdBy: WRITER,
    })]);
    const next = run("next-dispatch");
    expect(await getAssignedSkillIdsForAgent(AGENT, {
      principalId: WRITER, organizationId: ORG, teamIds: [], projectIds: [],
    }, { snapshot: next.assignmentScopeSnapshot, durableOrgId: ORG })).toEqual([SKILL]);
    expect(await resolveRecommendationCandidateSkillIds({ run: next, packageName: AGENT })).toEqual([SKILL]);
    expect(await maybeHoldRunForRecommendation({ run: next, template })).toMatchObject({ held: true, parkId: "park-next" });
    expect(score).toHaveBeenLastCalledWith({
      agentId: AGENT, intent: { promptText: JSON.stringify(next.inputParams) }, restrictToSkillIds: [SKILL],
    });
    expect(park).toHaveBeenCalledTimes(1);
    expect(park).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ runId: "next-dispatch" }));
  });

  it("does not lend a personal assignment to another run's originating human", async () => {
    expect(await assignScopeSkill(target({ kind: "personal" }), SKILL, writeDeps())).toEqual({ ok: true });
    const other = run("other-human", OTHER);
    // Live actor deliberately still names the writer: the frozen run, not the
    // settings session or a widened current actor, determines the personal tier.
    resolveRunActor.mockResolvedValueOnce({
      principalType: "HumanUser", principalId: WRITER, organizationId: ORG,
      teamIds: [], projectIds: [], platformRole: "member",
    });
    expect(await resolveRecommendationCandidateSkillIds({ run: other, packageName: AGENT })).toEqual([]);
    expect(await maybeHoldRunForRecommendation({ run: other, template })).toMatchObject({ held: false });
    expect(park).not.toHaveBeenCalled();
    expect(await resolveRecommendationCandidateSkillIds({ run: run("writer"), packageName: AGENT })).toEqual([SKILL]);
  });

  it("offers an organization pick to another member, but refuses another frozen organization", async () => {
    expect(await assignScopeSkill(target({ kind: "organization", id: ORG }), SKILL, writeDeps())).toEqual({ ok: true });
    expect(rows[0]).toMatchObject({ createdBy: WRITER, scopeKind: "organization", scopeId: ORG });
    expect(await resolveRecommendationCandidateSkillIds({ run: run("member", OTHER), packageName: AGENT })).toEqual([SKILL]);
    // The live actor is still in ORG; it cannot widen the run's frozen chain.
    const elsewhere = run("other-org", OTHER, "org-elsewhere");
    expect(await resolveRecommendationCandidateSkillIds({ run: elsewhere, packageName: AGENT })).toEqual([]);
    expect(await maybeHoldRunForRecommendation({ run: elsewhere, template })).toMatchObject({ held: false });
    expect(park).not.toHaveBeenCalled();
  });

  it("rechecks delivery lifecycle on the next dispatch instead of trusting the saved pick", async () => {
    expect(await assignScopeSkill(target({ kind: "personal" }), SKILL, writeDeps())).toEqual({ ok: true });
    expect(await resolveRecommendationCandidateSkillIds({ run: run("active"), packageName: AGENT })).toEqual([SKILL]);
    active = false;
    expect(await maybeHoldRunForRecommendation({ run: run("archived"), template })).toMatchObject({ held: false });
    expect(score).toHaveBeenLastCalledWith(expect.objectContaining({ restrictToSkillIds: [] }));
    expect(park).not.toHaveBeenCalled();
  });
});
