/**
 * THREE-PATH DELIVERY of a directly assigned skill (cinatra#2347 S2, epic #2345).
 *
 * The acceptance criterion is that an assignment REACHES THE MODEL, not merely
 * that a row exists — on an attributed run, on an actor-less worker run, and on
 * an unattributable dispatch. This suite proves it END TO END, from the
 * `agent_assigned_skills` row to the injected set the LLM adapter is handed:
 *
 *   assignment row
 *     → the REAL S2 tier (canonical agent resolution + revalidation)
 *     → the REAL `getAssignedSkillIdsForAgent` union + lifecycle gate
 *     → the REAL bridge injection ports
 *     → the REAL `resolveInjectedSkillSet`
 *     → the FAKE LLM adapter's `injectedSkills` argument.
 *
 * Only the leaf adapters are fake: the LLM task runner, the DB readers, the
 * assignment store, and the S1 I/O seam. Everything between the row and the
 * model is production code.
 *
 * It also asserts the SELECTED-REVISION parity the issue requires be asserted
 * rather than changed (scope item 5): an authoritative per-run selection —
 * explicit, or written by the headless auto-apply policy — bypasses assigned and
 * automatically matched skills ALIKE.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  getCustomSkillForCurrentUserAndAgentMock,
  resolveAssignedSkillsActorForRunMock,
  resolveAgentRunMcpActorMock,
  getLlmMcpCredentialsMock,
  readAgentRunByContextIdMock,
  readAgentRunByIdMock,
  readAgentRunByTokenHashMock,
  readAgentRunTokenHashByIdMock,
  readAgentTemplateByIdMock,
  readRunSelectedSkillRevisionsMock,
  readAssignedSkillsForAgentPackageMock,
  resolveDeclaredSkillEdgeForExtensionDirMock,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  getCustomSkillForCurrentUserAndAgentMock: vi.fn(
    async (): Promise<{ id: string; content: string; revisionId: string } | null> => null,
  ),
  resolveAssignedSkillsActorForRunMock: vi.fn(),
  resolveAgentRunMcpActorMock: vi.fn(async () => null),
  getLlmMcpCredentialsMock: vi.fn(() => ({ clientId: "c", clientSecret: "s" })),
  readAgentRunByContextIdMock: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  readAgentRunByIdMock: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  readAgentRunByTokenHashMock: vi.fn(
    async (): Promise<{ id: string; orgId: string; runBy: string | null } | null> => null,
  ),
  readAgentRunTokenHashByIdMock: vi.fn(async (): Promise<string | null> => null),
  readAgentTemplateByIdMock: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  readRunSelectedSkillRevisionsMock: vi.fn((): Array<Record<string, unknown>> => []),
  readAssignedSkillsForAgentPackageMock: vi.fn(),
  resolveDeclaredSkillEdgeForExtensionDirMock: vi.fn(
    async (): Promise<{ skillId: string; sourcePath: string } | null> => null,
  ),
}));

vi.mock("server-only", () => ({}));

const AGENT_PKG = "@cinatra-ai/web-scrape-agent";
const AGENT_SLUG = "web-scrape-agent";
const OWNER_PKG = "@cinatra-ai/list-curation-skill";
const ASSIGNED = `${OWNER_PKG}:list-curation`;
const OTHER_PKG = "@cinatra-ai/asset-blog";
const AUTO_ONLY = `${OTHER_PKG}:generate-blog-ideas`;
/** Extra assigned / automatically-matched skills for the cap-pressure arm. */
const ASSIGNED_EXTRA = [`${OWNER_PKG}:extra-a`, `${OWNER_PKG}:extra-b`];
const AUTO_EXTRA = Array.from({ length: 4 }, (_, i) => `${OTHER_PKG}:auto-${i + 1}`);

// --- leaf reads behind the S1 seam ------------------------------------------
let catalogSkills: Array<Record<string, unknown>> = [];
let scanned: Array<Record<string, unknown>> = [];
let installStatus: Record<string, "active" | "archived"> = {};
let agentPopulation: Array<Record<string, unknown>> = [];

vi.mock("../../../../../packages/skills/src/agent-skill-assignment-sources", () => ({
  // Revalidation reads the PURE SNAPSHOT; the SYNCING read throws, so a
  // dispatch that reached it would fail the delivery assertions loudly rather
  // than rebuild the whole catalog per run.
  readCatalogSource: async () => {
    throw new Error(
      "readCatalogSource (syncInstalledSkillsToDatabase) must never be reached from a run dispatch",
    );
  },
  readCatalogSnapshotSource: async () => ({ skills: catalogSkills }),
  scanExtensionsSource: async () => scanned,
  readInstallStatusSource: async (names: string[]) =>
    new Map(names.filter((n) => n in installStatus).map((n) => [n, installStatus[n]!])),
  readAgentPopulationSource: async () => agentPopulation,
  readPackageKindSource: async () => "agent",
  isAssistantPackageSource: async () => false,
}));

// --- the S1 assignment store -------------------------------------------------
let assignmentRows: Array<{ skillId: string }> = [];
vi.mock("@/lib/agent-assigned-skills-store", () => ({
  readAssignedSkillsForAgentPackage: (pkg: string) =>
    readAssignedSkillsForAgentPackageMock(pkg),
}));

// --- DB readers the resolver uses (layered over the root stub) ---------------
let matchRows: Array<{ skillId: string; matched: boolean; status: string }> = [];

vi.mock("@/lib/database", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/database");
  return {
    ...actual,
    readAgentSkillMatchesFromDatabase: vi.fn(() => ({ matches: [], matchedAt: "" })),
    replaceAgentSkillMatchesInDatabase: vi.fn(),
    readAgentSkillExclusionsFromDatabase: vi.fn(() => ({ exclusions: [], updatedAt: "" })),
    replaceAgentSkillExclusionsInDatabase: vi.fn(),
    readAgentCatalogFromDatabase: vi.fn(() => ({ agents: [] })),
    replaceAgentCatalogInDatabase: vi.fn(),
    readCustomSkillAssignmentsForAgent: vi.fn(() => []),
    readSystemGlobalSkillIdsForAgent: vi.fn(() => []),
    readSkillLifecycleStates: (ids: string[]) => ({
      ok: true,
      states: new Map(ids.map((id) => [id, "active" as string | null])),
    }),
  };
});

vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: vi.fn(async () => [
    { packageName: AGENT_PKG, name: "Web Scrape", description: "" },
  ]),
}));

vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => "/nonexistent-install-dir"),
  resolveDevExtensionSourceRoot: vi.fn(() => "/nonexistent-install-dir"),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
}));

// --- the skills barrel: the union of what the ROUTE and the RESOLVER need ----
vi.mock("@cinatra-ai/skills", async () => {
  const visibility = await vi.importActual<
    typeof import("../../../../../packages/skills/src/llm-matching/visibility")
  >("../../../../../packages/skills/src/llm-matching/visibility");
  const skillSource = await vi.importActual<
    typeof import("../../../../../packages/skills/src/skill-source")
  >("../../../../../packages/skills/src/skill-source");
  return {
    // Route-side.
    resolveDeclaredSkillEdgeForExtensionDir: resolveDeclaredSkillEdgeForExtensionDirMock,
    getCustomSkillForCurrentUserAndAgent: getCustomSkillForCurrentUserAndAgentMock,
    // Resolver-side.
    filterMatchRowsByVisibility: visibility.filterMatchRowsByVisibility,
    isRuntimeDeliverableLifecycleState: skillSource.isRuntimeDeliverableLifecycleState,
    MANUAL_VERSION: "manual",
    resolveEffectiveSkillAccessPolicy: (skill: { accessPolicy?: unknown } | undefined) =>
      skill?.accessPolicy ?? null,
    readSkillsCatalog: async () => ({ skills: catalogSkills, skillPackages: [] }),
    skillMatchesStore: {
      readSkillMatchesByAgent: async () => matchRows,
      readAllMatched: async () => [],
      upsertSkillMatch: async () => {},
    },
  };
});

// The REAL resolver — the root vitest alias points `@/lib/agents-store` at a
// stub, so the real module is re-supplied here by relative path. Its own leaf
// reads are the doubles above.
vi.mock("@/lib/agents-store", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../../lib/agents-store");
  return { ...actual };
});

vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: readRunSelectedSkillRevisionsMock,
}));

vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAssignedSkillsActorForRun: resolveAssignedSkillsActorForRunMock,
  resolveAgentRunMcpActor: resolveAgentRunMcpActorMock,
}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask: runResolvedSkillAwareDeterministicLlmTaskMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  resolveConfiguredLlmRuntime: vi.fn(async () => ({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  })),
  createLocalSkillShellTool: vi.fn(() => null),
  openAiModelSupportsShell: (modelId: string) => modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  resolveProviderAdapter: vi.fn(async () => ({})),
  PreferredProviderUnavailableError: class PreferredProviderUnavailableError extends Error {
    requestedProvider: string;
    reason: string;
    constructor(requestedProvider: string, reason: string) {
      super(`Preferred provider ${requestedProvider} unavailable (${reason})`);
      this.requestedProvider = requestedProvider;
      this.reason = reason;
    }
  },
}));

vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: readAgentRunByContextIdMock,
    readAgentRunById: readAgentRunByIdMock,
    readAgentRunByTokenHash: readAgentRunByTokenHashMock,
    readAgentRunTokenHashById: readAgentRunTokenHashByIdMock,
    readAgentTemplateById: readAgentTemplateByIdMock,
    // The run-environment seam narrows on this class; without it the mocked
    // barrel throws before the LLM adapter is reached.
    PinnedRunSnapshotUnreachableError: class PinnedRunSnapshotUnreachableError extends Error {},
    canProviderSatisfyCapability: (provider: string, capability: string): boolean => {
      switch (capability) {
        case "media_input":
          return provider === "gemini";
        case "function_tools":
          return provider === "openai" || provider === "anthropic" || provider === "gemini";
        case "native_mcp":
          return provider === "openai" || provider === "anthropic";
        default:
          return false;
      }
    },
    describeCapabilityRequirement: (): string => "cap",
    OasCinatraLlmSchema: z
      .object({
        preferredProvider: z.enum(["openai", "anthropic", "gemini"]).optional(),
        preferredModel: z.string().min(1).optional(),
        capabilityRequired: z.enum(["media_input", "function_tools", "native_mcp"]).optional(),
      })
      .strict()
      .optional(),
    LLM_PROVIDERS: ["openai", "anthropic", "gemini"] as const,
    LLM_CAPABILITIES: ["media_input", "function_tools", "native_mcp"] as const,
    ALLOWED_MODEL_IDS: {
      openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
      anthropic: ["claude-sonnet-4-6", "claude-opus-4-7"],
      gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
    },
  };
});

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));

import {
  INJECTED_SKILL_CAP,
  injectedCatalogSkillIds,
  injectedSkillMembers,
} from "@cinatra-ai/skills/injection";
import {
  decideRecommendationContinuation,
  SELECTION_SOURCES,
} from "@cinatra-ai/skills/recommendation";

let POST: (req: Request) => Promise<Response>;

const SCOPED_ACTOR = {
  principalType: "HumanUser" as const,
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: ["team-1"],
  projectIds: ["proj-1"],
  platformRole: "member" as const,
  authSource: "a2a" as const,
  policyVersion: "v2",
};
const VERIFIED_RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  sourceType: null,
  // No template row: the run-environment binding block is orthogonal to skill
  // injection, and leaving it out keeps this suite about the injected set.
  templateId: null,
  projectId: null,
  dependentInstallId: "inst-7",
};
const PROBE = { id: VERIFIED_RUN.id, orgId: VERIFIED_RUN.orgId, runBy: VERIFIED_RUN.runBy };
/**
 * A genuine WORKER-originated run: the platform, not a human, owns it, so the
 * run row carries `runBy: null`. This is what production means by an actor-less
 * worker run — NOT a human-owned run whose actor build happened to fail.
 */
const WORKER_RUN = { ...VERIFIED_RUN, runBy: null };
const WORKER_PROBE = { id: WORKER_RUN.id, orgId: WORKER_RUN.orgId, runBy: null };
const RUN_TOKEN = "raw-run-token-xyz";

function skillRow(id: string, pkg: string, slug: string) {
  return {
    id,
    name: slug,
    slug,
    description: "",
    content: "",
    packageId: "pkg",
    packageName: pkg,
    packageSlug: pkg.replace(/[@/]/g, "-"),
    usedBy: [],
    level: "workspace",
  };
}

function descriptorRow(pkg: string, dirName: string, slugs: string[]) {
  return {
    pkgDir: `/x/${dirName}`,
    pkgName: pkg,
    pkgDirName: dirName,
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-for-assigned-skill";
  const mod = await import("../route");
  POST = mod.POST;
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({ text: "ok", artifacts: [] });
  getCustomSkillForCurrentUserAndAgentMock.mockResolvedValue(null);
  getLlmMcpCredentialsMock.mockReturnValue({ clientId: "c", clientSecret: "s" });
  resolveAssignedSkillsActorForRunMock.mockResolvedValue(undefined);
  resolveAgentRunMcpActorMock.mockResolvedValue(null);
  readAgentRunByContextIdMock.mockResolvedValue(null);
  readAgentRunByIdMock.mockResolvedValue(null);
  readAgentRunByTokenHashMock.mockResolvedValue(null);
  readAgentRunTokenHashByIdMock.mockResolvedValue(null);
  readAgentTemplateByIdMock.mockResolvedValue(null);
  readRunSelectedSkillRevisionsMock.mockReturnValue([]);
  resolveDeclaredSkillEdgeForExtensionDirMock.mockResolvedValue(null);
  readAssignedSkillsForAgentPackageMock.mockImplementation(async (pkg: string) =>
    assignmentRows.map((r, i) => ({
      agentPackageName: pkg,
      skillId: r.skillId,
      position: i + 1,
      createdBy: "admin_1",
      createdAt: "2026-08-03T00:00:00.000Z",
    })),
  );

  agentPopulation = [
    { packageId: AGENT_PKG, id: AGENT_SLUG, identifier: AGENT_SLUG, packageSlug: AGENT_SLUG },
  ];
  catalogSkills = [
    skillRow(ASSIGNED, OWNER_PKG, "list-curation"),
    ...ASSIGNED_EXTRA.map((id) => skillRow(id, OWNER_PKG, id.split(":")[1]!)),
    skillRow(AUTO_ONLY, OTHER_PKG, "generate-blog-ideas"),
    ...AUTO_EXTRA.map((id) => skillRow(id, OTHER_PKG, id.split(":")[1]!)),
  ];
  scanned = [
    descriptorRow(OWNER_PKG, "list-curation-skill", [
      "list-curation",
      ...ASSIGNED_EXTRA.map((id) => id.split(":")[1]!),
    ]),
    descriptorRow(OTHER_PKG, "asset-blog", [
      "generate-blog-ideas",
      ...AUTO_EXTRA.map((id) => id.split(":")[1]!),
    ]),
  ];
  installStatus = { [OWNER_PKG]: "active", [OTHER_PKG]: "active" };
  assignmentRows = [{ skillId: ASSIGNED }];
  matchRows = [];
});

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** The injected set the FAKE LLM adapter was handed. */
function deliveredSet() {
  const calls = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls as unknown[][];
  if (calls.length === 0) throw new Error("the LLM adapter was never invoked");
  return (calls[0]![0] as { injectedSkills: never }).injectedSkills;
}
function deliveredCatalogIds(): string[] {
  return [...injectedCatalogSkillIds(deliveredSet())];
}

describe("an assigned skill REACHES THE MODEL on all three run shapes (AC 1)", () => {
  it("ATTRIBUTED run — a vetted run with a scope-aware actor", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);

    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );

    expect(deliveredCatalogIds()).toContain(ASSIGNED);
    // At recommendation rank — the SAME rank automatic matches ride (scope
    // item 4: no contract change, no privileged rank for assignments).
    expect(
      injectedSkillMembers(deliveredSet()).find((m) => m.skillId === ASSIGNED)?.rank,
    ).toBe("recommendation");
  });

  it("ACTOR-LESS WORKER run — a vetted run the PLATFORM owns (`runBy: null`)", async () => {
    // The real worker shape: no present human, so the run row carries no owner
    // and the contract never even asks for a scope-aware actor. Nothing about
    // the actor-lessness is manufactured by a mock here. Before the S1 table
    // this shape could never see a configured assignment at all — the old
    // `custom_skill_assignments` read is actor-gated and returns nothing
    // without a principal.
    readAgentRunByTokenHashMock.mockResolvedValue(WORKER_PROBE);
    readAgentRunByIdMock.mockResolvedValue(WORKER_RUN);
    // Left at its default (SCOPED_ACTOR would be a lie for a worker run); the
    // assertion below is that it is never consulted.
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);

    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );

    expect(resolveAssignedSkillsActorForRunMock).not.toHaveBeenCalled();
    expect(deliveredCatalogIds()).toContain(ASSIGNED);
  });

  it("ACTOR-LESS by FAIL-CLOSED actor build — a human-owned run whose actor cannot be built", async () => {
    // The second actor-less shape (a nonmember owner, a membership-read
    // failure): the route asks for the actor, gets `undefined`, and falls back
    // to the actor-less resolution. Assignments must survive that too.
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(undefined);

    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );

    expect(resolveAssignedSkillsActorForRunMock).toHaveBeenCalledOnce();
    expect(deliveredCatalogIds()).toContain(ASSIGNED);
  });

  it("UNATTRIBUTABLE dispatch — no run claimed, no verified owner", async () => {
    await POST(makeRequest({ user: "hi", agent_id: AGENT_SLUG }));

    expect(resolveAssignedSkillsActorForRunMock).not.toHaveBeenCalled();
    expect(deliveredCatalogIds()).toContain(ASSIGNED);
  });

  it("MUTATION GUARD — with NO assignment row the same three shapes deliver nothing", async () => {
    assignmentRows = [];
    await POST(makeRequest({ user: "hi", agent_id: AGENT_SLUG }));
    expect(deliveredCatalogIds()).not.toContain(ASSIGNED);
  });

  it("REVALIDATION reaches delivery — an archived owning extension is not delivered", async () => {
    installStatus = { [OWNER_PKG]: "archived", [OTHER_PKG]: "active" };
    await POST(makeRequest({ user: "hi", agent_id: AGENT_SLUG }));
    expect(deliveredCatalogIds()).not.toContain(ASSIGNED);
  });

  it("a FAILING assignment read degrades delivery without failing the dispatch", async () => {
    readAssignedSkillsForAgentPackageMock.mockRejectedValueOnce(
      new Error("agent_assigned_skills unreadable"),
    );
    const res = await POST(makeRequest({ user: "hi", agent_id: AGENT_SLUG }));
    expect(res.status).toBe(200);
    expect(deliveredCatalogIds()).not.toContain(ASSIGNED);
  });
});

describe("cap pressure at the REAL bridge — the union order survives to the model (AC 2)", () => {
  it("assigned skills keep their slots; automatic matches are the ones truncated", async () => {
    // End-to-end cap pressure, with NOTHING about the ordering reconstructed by
    // the test: the assignment rows, the `skill_matches` rows, the resolver's
    // union, the bridge's ports and the contract's rank-and-cap are all real.
    // Only the leaf reads and the LLM adapter are fake.
    //
    // Candidates: 1 personal delta + 1 declared dependency + 3 assigned + 5
    // automatic matches = 10, against the cap of 8. Retention order therefore
    // has to drop exactly two, and they must both be automatic matches.
    const assigned = [ASSIGNED, ...ASSIGNED_EXTRA];
    const auto = [AUTO_ONLY, ...AUTO_EXTRA];
    assignmentRows = assigned.map((skillId) => ({ skillId }));
    matchRows = auto.map((skillId) => ({ skillId, matched: true, status: "ok" }));
    resolveDeclaredSkillEdgeForExtensionDirMock.mockResolvedValue({
      skillId: "declared-dep-1",
      sourcePath: "/nonexistent-install-dir/declared/SKILL.md",
    });
    getCustomSkillForCurrentUserAndAgentMock.mockResolvedValue({
      id: "personal-delta-1",
      content: "MY DELTA",
      revisionId: "prev-1",
    });
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);

    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );

    const members = injectedSkillMembers(deliveredSet());
    expect(members).toHaveLength(INJECTED_SKILL_CAP);
    // The delta and the declared dependency keep their slots (they OUTRANK the
    // assignments) ...
    expect(members.some((m) => m.rank === "personal_delta")).toBe(true);
    expect(members.map((m) => m.skillId)).toContain("declared-dep-1");
    // ... every ASSIGNED skill survives ...
    for (const id of assigned) expect(members.map((m) => m.skillId), id).toContain(id);
    // ... and the two dropped members are AUTOMATIC matches, nothing else.
    const keptAuto = auto.filter((id) => members.some((m) => m.skillId === id));
    expect(keptAuto).toHaveLength(auto.length - 2);
  });

  it("MUTATION GUARD — the same pressure with NO assignments keeps all five auto matches", async () => {
    // Proves the truncation above is caused by the assigned tier competing for
    // slots, not by an unrelated property of the fixture.
    const auto = [AUTO_ONLY, ...AUTO_EXTRA];
    assignmentRows = [];
    matchRows = auto.map((skillId) => ({ skillId, matched: true, status: "ok" }));
    resolveDeclaredSkillEdgeForExtensionDirMock.mockResolvedValue({
      skillId: "declared-dep-1",
      sourcePath: "/nonexistent-install-dir/declared/SKILL.md",
    });
    getCustomSkillForCurrentUserAndAgentMock.mockResolvedValue({
      id: "personal-delta-1",
      content: "MY DELTA",
      revisionId: "prev-1",
    });
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);

    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );

    const kept = injectedSkillMembers(deliveredSet()).map((m) => m.skillId);
    for (const id of auto) expect(kept, id).toContain(id);
  });
});

describe("selected-revision parity — ASSERTED, not changed (scope item 5)", () => {
  it("an EXPLICIT selected set bypasses the assignment exactly as it bypasses auto-matches", async () => {
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    // A scope-aware actor, so the workspace-level automatic match WOULD be
    // deliverable on the fallback path — otherwise "the auto-match is bypassed"
    // would be true for the wrong reason.
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);
    readRunSelectedSkillRevisionsMock.mockReturnValue([
      {
        id: "sel-1",
        runId: VERIFIED_RUN.id,
        skillId: "explicitly-selected-skill",
        skillRevisionId: "rev-1",
        selectionSource: SELECTION_SOURCES.userForced,
        selectedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);

    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );

    const ids = deliveredCatalogIds();
    expect(ids).toEqual(["explicitly-selected-skill"]);
    expect(ids).not.toContain(ASSIGNED);
    expect(ids).not.toContain(AUTO_ONLY);
  });

  it("a HEADLESS-AUTO selected set bypasses it too — same seam, same parity", async () => {
    // The selection is produced by the REAL headless policy (the same function
    // the worker's auto-apply calls), not hand-written, so this arm cannot drift
    // from what the headless path actually persists.
    const continuation = decideRecommendationContinuation({
      policyFired: true,
      humanPresent: false,
      recommendations: [
        {
          skillId: "headless-picked-skill",
          skillRevisionId: "rev-9",
          name: "Headless Picked",
          score: 0.9,
          rank: 1,
          recommended: true,
          scoredFeatures: [],
        },
      ],
    });
    // Narrow to the auto-applied arm so `selection` is on the type, and so a
    // policy change that stopped auto-applying would fail here loudly.
    if (continuation.mode !== "auto_applied") {
      throw new Error(`expected an auto_applied continuation, got ${continuation.mode}`);
    }
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);
    readRunSelectedSkillRevisionsMock.mockReturnValue(
      continuation.selection.map((s, i) => ({
        id: `sel-${i}`,
        runId: VERIFIED_RUN.id,
        skillId: s.skillId,
        skillRevisionId: s.skillRevisionId,
        selectionSource: s.selectionSource,
        selectedAt: "2026-08-03T00:00:00.000Z",
      })),
    );

    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );

    const ids = deliveredCatalogIds();
    expect(ids).toEqual(["headless-picked-skill"]);
    expect(ids).not.toContain(ASSIGNED);
    expect(ids).not.toContain(AUTO_ONLY);
  });

  it("BASELINE — with NO selected set the SAME fixture delivers both the assignment AND the auto-match", async () => {
    // The mutation guard for the two bypass arms above: without a selected set
    // both tiers are demonstrably deliverable in this exact fixture, so their
    // absence there is the bypass and nothing else.
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);
    readRunSelectedSkillRevisionsMock.mockReturnValue([]);
    await POST(
      makeRequest({ user: "hi", agent_id: AGENT_SLUG }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
    expect(deliveredCatalogIds()).toEqual([ASSIGNED, AUTO_ONLY]);
  });
});
