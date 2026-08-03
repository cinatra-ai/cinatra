/**
 * The ASSIGNED tier inside `getAssignedSkillIdsForAgent` (cinatra#2347 S2,
 * epic #2345).
 *
 * Test 1 (`agent-assigned-skills-injection.test.ts`) owns the tier's own
 * contract. THIS suite owns its place in the resolver: where the ids land in the
 * union, that the first-seen dedup and the fail-closed lifecycle gate apply to
 * them like every other tier, that an actor-LESS call (the worker shape) sees
 * them, that the degraded catalog-read return also loads them, and that a
 * read error leaves the rest of the resolution intact.
 *
 * WHAT IS REAL HERE. The resolver, the tier, the shared S1 assignability
 * predicate, the shared canonical agent resolver, the visibility filter and the
 * runtime-delivery predicate all run for real. Doubled: `@/lib/database`, the
 * installed-agent template reader, the skills barrel's catalog/`skill_matches`
 * readers, the `agent_assigned_skills` store, and the S1 I/O seam (ONE module,
 * exactly as S1's own suites double it).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The @cinatra-ai/skills barrel transitively imports personal-skills.ts →
// @cinatra-ai/llm; stub before any import.
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

const AGENT_PKG = "@cinatra-ai/web-scrape-agent";
const AGENT_SLUG = "web-scrape-agent";
const OWNER_PKG = "@cinatra-ai/list-curation-skill";
const ASSIGNED = `${OWNER_PKG}:list-curation`;
const OTHER_PKG = "@cinatra-ai/asset-blog";
const AUTO_ONLY = `${OTHER_PKG}:generate-blog-ideas`;
const SELF_SKILL = "self-owned-agent-skill";

// --- catalog / scan / install status (the predicate's leaf reads) ------------
type CatalogSkill = Record<string, unknown>;
let catalogSkills: CatalogSkill[] = [];
let scanned: Array<Record<string, unknown>> = [];
let installStatus: Record<string, "active" | "archived"> = {};
let agentPopulation: Array<Record<string, unknown>> = [];

// ONE seam for every real-world read the assignment slice performs — doubling it
// leaves the predicate, the canonical resolver and the tier REAL.
vi.mock("../../../packages/skills/src/agent-skill-assignment-sources", () => ({
  readCatalogSource: async () => ({ skills: catalogSkills }),
  scanExtensionsSource: async () => scanned,
  readInstallStatusSource: async (names: string[]) =>
    new Map(names.filter((n) => n in installStatus).map((n) => [n, installStatus[n]!])),
  readAgentPopulationSource: async () => agentPopulation,
  readPackageKindSource: async () => "agent",
  isAssistantPackageSource: async () => false,
}));

// --- the S1 assignment store -------------------------------------------------
let assignmentRows: Array<{ skillId: string }> = [];
let assignmentReadError: Error | null = null;
const readAssignedSkillsForAgentPackageMock = vi.fn(async (pkg: string) => {
  if (assignmentReadError) throw assignmentReadError;
  return assignmentRows.map((r, i) => ({
    agentPackageName: pkg,
    skillId: r.skillId,
    position: i + 1,
    createdBy: "admin_1",
    createdAt: "2026-08-03T00:00:00.000Z",
  }));
});
vi.mock("@/lib/agent-assigned-skills-store", () => ({
  readAssignedSkillsForAgentPackage: (pkg: string) =>
    readAssignedSkillsForAgentPackageMock(pkg),
}));

// --- lifecycle states (the fail-closed runtime-delivery gate) ---------------
let lifecycleStates: Record<string, string | null> = {};
let lifecycleReadOk = true;

vi.mock("@/lib/database", () => ({
  readAgentSkillMatchesFromDatabase: vi.fn(() => ({ matches: [], matchedAt: "" })),
  replaceAgentSkillMatchesInDatabase: vi.fn(),
  readAgentSkillExclusionsFromDatabase: vi.fn(() => ({ exclusions: [], updatedAt: "" })),
  replaceAgentSkillExclusionsInDatabase: vi.fn(),
  readAgentCatalogFromDatabase: vi.fn(() => ({ agents: [] })),
  replaceAgentCatalogInDatabase: vi.fn(),
  readCustomSkillAssignmentsForAgent: vi.fn(() => []),
  readSystemGlobalSkillIdsForAgent: vi.fn(() => []),
  readSkillLifecycleStates: (ids: string[]) =>
    lifecycleReadOk
      ? {
          ok: true,
          states: new Map(
            ids.map((id) => [
              id,
              id in lifecycleStates ? lifecycleStates[id]! : ("active" as string | null),
            ]),
          ),
        }
      : { ok: false, states: new Map() },
}));

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

// --- the skills barrel (real pure predicates, doubled readers) --------------
let catalogReadError: Error | null = null;
let matchRows: Array<{ skillId: string; matched: boolean; status: string }> = [];

vi.mock("@cinatra-ai/skills", async () => {
  const visibility = await vi.importActual<
    typeof import("../../../packages/skills/src/llm-matching/visibility")
  >("../../../packages/skills/src/llm-matching/visibility");
  const skillSource = await vi.importActual<
    typeof import("../../../packages/skills/src/skill-source")
  >("../../../packages/skills/src/skill-source");
  return {
    filterMatchRowsByVisibility: visibility.filterMatchRowsByVisibility,
    isRuntimeDeliverableLifecycleState: skillSource.isRuntimeDeliverableLifecycleState,
    MANUAL_VERSION: "manual",
    resolveEffectiveSkillAccessPolicy: (skill: { accessPolicy?: unknown } | undefined) =>
      skill?.accessPolicy ?? null,
    readSkillsCatalog: async () => {
      if (catalogReadError) throw catalogReadError;
      return { skills: catalogSkills, skillPackages: [] };
    },
    skillMatchesStore: {
      readSkillMatchesByAgent: async () => matchRows,
      readAllMatched: async () => [],
      upsertSkillMatch: async () => {},
    },
  };
});

const { getAssignedSkillIdsForAgent } = await import("../agents-store");

/**
 * A workspace-level (globally visible) actor for the union-ORDER tests.
 *
 * The `skill_matches` tier is behind the read-time VISIBILITY filter, and a
 * workspace-level row is only visible to an authenticated workspace principal —
 * so an ordering assertion that needs an automatic match present must resolve
 * WITH an actor. Actor-INDEPENDENCE of the assigned tier is proven separately
 * below (it bypasses that filter by construction: the shared predicate already
 * refused every owner-scoped skill at assign time and again here).
 */
const ACTOR = {
  principalId: "user_1",
  organizationId: "org_1",
  teamIds: [] as string[],
  projectIds: [] as string[],
  platformRole: "member" as const,
};

function skillRow(id: string, pkg: string, slug: string): CatalogSkill {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  agentPopulation = [
    {
      packageId: AGENT_PKG,
      id: AGENT_SLUG,
      identifier: AGENT_SLUG,
      packageSlug: AGENT_SLUG,
    },
  ];
  catalogSkills = [
    skillRow(ASSIGNED, OWNER_PKG, "list-curation"),
    skillRow(AUTO_ONLY, OTHER_PKG, "generate-blog-ideas"),
  ];
  scanned = [
    descriptorRow(OWNER_PKG, "list-curation-skill", ["list-curation"]),
    descriptorRow(OTHER_PKG, "asset-blog", ["generate-blog-ideas"]),
  ];
  installStatus = { [OWNER_PKG]: "active", [OTHER_PKG]: "active" };
  assignmentRows = [];
  assignmentReadError = null;
  lifecycleStates = {};
  lifecycleReadOk = true;
  catalogReadError = null;
  matchRows = [];
});

describe("union placement — after the agent's own skills, before automatic matches", () => {
  it("delivers an assigned skill AHEAD of the automatically matched ones", async () => {
    // The agent's own (level=agent) skill stays first — the assigned tier never
    // displaces the most specific tier.
    catalogSkills = [
      ...catalogSkills,
      { ...skillRow(SELF_SKILL, AGENT_PKG, "self"), level: "agent", agentId: AGENT_PKG },
    ];
    assignmentRows = [{ skillId: ASSIGNED }];
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];

    expect(await getAssignedSkillIdsForAgent(AGENT_PKG, ACTOR)).toEqual([
      SELF_SKILL,
      ASSIGNED,
      AUTO_ONLY,
    ]);
  });

  it("without the assignment the SAME setup delivers only the automatic match", async () => {
    // Mutation guard: the ordering above is produced by the assignment row, not
    // by an incidental property of the fixture.
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG, ACTOR)).toEqual([AUTO_ONLY]);
  });

  it("a skill that is BOTH assigned and auto-matched is delivered ONCE, in the assigned slot", async () => {
    // The recommender returns AUTO_ONLY first; the assignment moves the shared
    // id ahead of it, and first-seen dedup keeps exactly one copy.
    assignmentRows = [{ skillId: ASSIGNED }];
    matchRows = [
      { skillId: AUTO_ONLY, matched: true, status: "ok" },
      { skillId: ASSIGNED, matched: true, status: "ok" },
    ];
    const ids = await getAssignedSkillIdsForAgent(AGENT_PKG, ACTOR);
    expect(ids).toEqual([ASSIGNED, AUTO_ONLY]);
    expect(ids.filter((id) => id === ASSIGNED)).toHaveLength(1);
  });

  it("preserves the STORED order of several assignments", async () => {
    assignmentRows = [{ skillId: AUTO_ONLY }, { skillId: ASSIGNED }];
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG)).toEqual([AUTO_ONLY, ASSIGNED]);
  });

  it("resolves the assignment key from a raw bridge SLUG, not the slug itself", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    expect(await getAssignedSkillIdsForAgent(AGENT_SLUG)).toEqual([ASSIGNED]);
    expect(readAssignedSkillsForAgentPackageMock).toHaveBeenCalledWith(AGENT_PKG);
  });
});

describe("actor-independence — the whole point of the S1 table", () => {
  it("an ACTOR-LESS resolution (the worker shape) delivers the assignment", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG)).toEqual([ASSIGNED]);
  });

  it("an ATTRIBUTED resolution delivers the same assignment", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG, ACTOR)).toEqual([ASSIGNED]);
  });
});

describe("the tiers above and below the assigned one still apply", () => {
  it("the fail-closed LIFECYCLE gate still withholds an archived assigned skill", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];
    lifecycleStates = { [ASSIGNED]: "archived" };
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG, ACTOR)).toEqual([AUTO_ONLY]);
  });

  it("a lifecycle-read failure withholds EVERY tier, assigned included", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];
    lifecycleReadOk = false;
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG, ACTOR)).toEqual([]);
  });

  it("REVALIDATION withholds an assignment whose extension was archived", async () => {
    // End-to-end through the resolver: the catalog row survives the archive and
    // the lifecycle state is a passing NULL, so ONLY the revalidation can catch
    // this. Without it the archived skill would still reach the model.
    assignmentRows = [{ skillId: ASSIGNED }];
    lifecycleStates = { [ASSIGNED]: null };
    installStatus = { [OWNER_PKG]: "archived", [OTHER_PKG]: "active" };
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG)).toEqual([]);
  });

  it("REVALIDATION withholds an assignment whose skill lost global visibility", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    catalogSkills = [
      { ...skillRow(ASSIGNED, OWNER_PKG, "list-curation"), level: "team", scope: "team_7" },
      skillRow(AUTO_ONLY, OTHER_PKG, "generate-blog-ideas"),
    ];
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG)).toEqual([]);
  });
});

describe("fail-closed reads — the run always proceeds (issue AC 5)", () => {
  it("an assignment-store read ERROR drops only the assigned tier", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    matchRows = [{ skillId: AUTO_ONLY, matched: true, status: "ok" }];
    assignmentReadError = new Error("agent_assigned_skills unreadable");

    // The resolution RESOLVES (never rejects) and every other tier survives.
    await expect(getAssignedSkillIdsForAgent(AGENT_PKG, ACTOR)).resolves.toEqual([
      AUTO_ONLY,
    ]);
  });

  it("the DEGRADED catalog-read path still delivers assignments", async () => {
    // Before S2 this return emitted only globals + custom assignments, so an
    // admin's explicit pin vanished for the duration of a catalog blip.
    assignmentRows = [{ skillId: ASSIGNED }];
    catalogReadError = new Error("skills catalog unreadable");
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG)).toEqual([ASSIGNED]);
  });

  it("the degraded path still applies the LIFECYCLE gate to the assignment", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    catalogReadError = new Error("skills catalog unreadable");
    lifecycleStates = { [ASSIGNED]: "archived" };
    expect(await getAssignedSkillIdsForAgent(AGENT_PKG)).toEqual([]);
  });

  it("the degraded path fails CLOSED when the assignment read also fails", async () => {
    assignmentRows = [{ skillId: ASSIGNED }];
    catalogReadError = new Error("skills catalog unreadable");
    assignmentReadError = new Error("agent_assigned_skills unreadable");
    await expect(getAssignedSkillIdsForAgent(AGENT_PKG)).resolves.toEqual([]);
  });
});
