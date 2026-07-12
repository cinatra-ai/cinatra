
/**
 * Tests for matchAgentsToSkills + getAssignedSkillIdsForAgent.
 *
 * The canonical source of cross-agent matches is the persisted
 * `skill_matches` table (read via `skillMatchesStore`). agents-store is a
 * thin projector/reader over that table; declarative `match_when` rule
 * evaluation lives in the matcher that *writes* the table, not here.
 *
 * Covered:
 *   - matchAgentsToSkills() projects persisted skill_matches rows into the
 *     compatibility AgentSkillMatch shape, keyed by the agent's slug-shape
 *     `id`, and drops rows whose agent or skill is no longer installed.
 *   - level:"agent" bundled skills are NEVER in the matchAgentsToSkills()
 *     projection (the Matches tab is cross-agent-only); they are not
 *     persisted to skill_matches so they never appear.
 *   - getAssignedSkillIdsForAgent(<npm-name>) resolves level:"agent"
 *     self-skills directly from the catalog, by npm name AND directory slug.
 *   - getAssignedSkillIdsForAgent unions persisted skill_matches rows
 *     (queried by the resolved packageId) with catalog-derived self/system
 *     skills.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// @cinatra-ai/skills barrel transitively imports personal-skills.ts which
// imports @cinatra-ai/llm. Stub that out before any import of
// @cinatra-ai/skills.
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

// Module-level mock state so tests can reseed per case.
const skillsCatalogState: { skills: any[]; skillPackages: any[] } = { skills: [], skillPackages: [] };
// Persisted skill_matches rows (the canonical cross-agent match table).
const persistedMatchRows: any[] = [];
// Installed agent templates returned by the agents reader.
const installedTemplates: any[] = [];
// Mirror of replaceAgentSkillMatchesInDatabase writes for assertion.
const agentSkillMatchesState: { matches: any[]; matchedAt: string } = { matches: [], matchedAt: "" };
// A3 (cinatra#1363): the lifecycle-gate reader. Default = every requested id is
// 'active' (deliverable) so existing union assertions hold; the lifecycle-gate
// describe reassigns this to inject archived/draft/unknown states or a reader
// error, and restores the default afterEach.
type LifecycleReadResult =
  | { ok: true; states: Map<string, string | null> }
  | { ok: false };
const defaultLifecycleReader = (ids: string[]): LifecycleReadResult => ({
  ok: true,
  states: new Map(ids.map((id) => [id, "active" as string | null])),
});
let readSkillLifecycleStatesImpl: (ids: string[]) => LifecycleReadResult = defaultLifecycleReader;

vi.mock("@/lib/database", () => ({
  readAgentSkillMatchesFromDatabase: vi.fn(() => agentSkillMatchesState),
  replaceAgentSkillMatchesInDatabase: vi.fn((next: any) => {
    agentSkillMatchesState.matches = next.matches;
    agentSkillMatchesState.matchedAt = next.matchedAt;
  }),
  readAgentSkillExclusionsFromDatabase: vi.fn(() => ({ exclusions: [], updatedAt: "" })),
  replaceAgentSkillExclusionsInDatabase: vi.fn(),
  readAgentCatalogFromDatabase: vi.fn(() => ({ agents: [] })),
  replaceAgentCatalogInDatabase: vi.fn(),
  // Custom-assignment / system-global read paths are only touched when an
  // actor is supplied; these tests call without an actor.
  readCustomSkillAssignmentsForAgent: vi.fn(async () => []),
  readSystemGlobalSkillIdsForAgent: vi.fn(async () => []),
  readSkillLifecycleStates: (ids: string[]) => readSkillLifecycleStatesImpl(ids),
}));

// Installed agents reader — resolves npm packageId for skill_matches keying.
vi.mock("@cinatra-ai/agents/store", () => ({
  readInstalledAgentTemplates: vi.fn(async () => installedTemplates),
}));

// No filesystem provider-declared agents in these unit tests.
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => "/nonexistent-install-dir"),
  resolveDevExtensionSourceRoot: vi.fn(() => "/nonexistent-install-dir"),
}));

// cinatra#538 (defect 2): defensive mock — the provider-declared picker reads
// the instance identity. The nonexistent install dir short-circuits before it
// is called, but mocking keeps the synchronous Postgres worker unreachable.
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
}));

vi.mock("@cinatra-ai/skills", async () => {
  // The @cinatra-ai/skills barrel transitively pulls personal-skills.ts
  // (→ @cinatra-ai/llm) which does not fully resolve under vitest aliasing,
  // so we cannot importActual the barrel. filterMatchRowsByVisibility is a
  // pure function with a type-only dependency — importActual its own module
  // directly to exercise the real level-based visibility semantics.
  const visibility = await vi.importActual<
    typeof import("../../../packages/skills/src/llm-matching/visibility")
  >("../../../packages/skills/src/llm-matching/visibility");
  // A3 (cinatra#1363): the runtime-delivery predicate is a pure skill-source
  // leaf; import the REAL implementation so the gate's semantics are exercised.
  const skillSource = await vi.importActual<
    typeof import("../../../packages/skills/src/skill-source")
  >("../../../packages/skills/src/skill-source");
  return {
    filterMatchRowsByVisibility: visibility.filterMatchRowsByVisibility,
    isRuntimeDeliverableLifecycleState: skillSource.isRuntimeDeliverableLifecycleState,
    MANUAL_VERSION: "manual",
    // W4 (#1073): getAssignedSkillIdsForAgent resolves each skill's effective
    // access policy (own override else parent package's) to feed the visibility
    // filter. Mirror the real resolver inline (avoids importActual of the
    // server-only-guarded skill-packages module); with no accessPolicy set the
    // filter falls back to the (level, scope) tuple these tests already assert.
    resolveEffectiveSkillAccessPolicy: (
      skill: { packageId?: string; accessPolicy?: unknown } | undefined,
      skillPackages: Array<{ id?: string; packageId?: string; accessPolicy?: unknown }> = [],
    ) =>
      skill?.accessPolicy ??
      skillPackages.find(
        (p) => p.packageId === skill?.packageId || p.id === skill?.packageId,
      )?.accessPolicy ??
      null,
    readSkillsCatalog: vi.fn(async () => skillsCatalogState),
    skillMatchesStore: {
      readAllMatched: vi.fn(async () => persistedMatchRows),
      readSkillMatchesByAgent: vi.fn(async (packageId: string) =>
        persistedMatchRows.filter((r) => r.agentId === packageId),
      ),
      upsertSkillMatch: vi.fn(),
    },
  };
});

import {
  matchAgentsToSkills,
  getAssignedSkillIdsForAgent,
} from "../agents-store";

function row(over: Partial<any>): any {
  return {
    agentId: over.agentId ?? "@cinatra-ai/email-recipient-selection-agent",
    skillId: over.skillId ?? "third-party:writing-style",
    source: over.source ?? "llm",
    matched: over.matched ?? true,
    score: over.score ?? 0.5,
    rationale: over.rationale ?? "Matched declarative rule",
    evaluatorVersion: over.evaluatorVersion ?? "v1",
    agentInputHash: over.agentInputHash ?? "a",
    skillInputHash: over.skillInputHash ?? "s",
    status: over.status ?? "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: over.evaluatedAt ?? new Date(),
    jobStartedAt: over.jobStartedAt ?? new Date(),
  };
}

function template(packageName: string, name: string, description = ""): any {
  return { packageName, name, description, status: "active" };
}

function seedExternalSkill(id: string, name: string) {
  return {
    id,
    name,
    slug: id.split(":").pop() ?? id,
    description: "",
    content: "body",
    packageId: "third-party:style",
    packageName: "style",
    packageSlug: "style",
    usedBy: [],
    // third-party passes the no-actor visibility filter unchanged.
    level: "third-party",
  };
}

function seedAgentSkill(id: string, agentPackageId: string) {
  return {
    id,
    name: "Email Recipients",
    slug: id.split(":").pop() ?? id,
    description: "",
    content: "body",
    packageId: "custom:email-recipient-selection",
    packageName: agentPackageId,
    packageSlug: "email-recipient-selection",
    usedBy: [],
    level: "agent",
    agentId: agentPackageId,
  };
}

beforeEach(() => {
  skillsCatalogState.skills = [];
  skillsCatalogState.skillPackages = [];
  persistedMatchRows.length = 0;
  installedTemplates.length = 0;
  agentSkillMatchesState.matches = [];
  agentSkillMatchesState.matchedAt = "";
  // A3 (cinatra#1363): reset the lifecycle gate to deliverable-by-default so
  // the union assertions above are unaffected; the gate describe overrides it.
  readSkillLifecycleStatesImpl = defaultLifecycleReader;
});

describe("matchAgentsToSkills — bundled skills are NOT projected", () => {
  it("level:'agent' bundled skill is NEVER in matchAgentsToSkills() projection — Matches tab shows cross-agent skills only", async () => {
    installedTemplates.push(
      template("@cinatra-ai/email-recipient-selection-agent", "Email Recipients"),
    );
    skillsCatalogState.skills = [
      seedAgentSkill(
        "custom:email-recipient-selection:email-recipient-selection",
        "@cinatra-ai/email-recipient-selection-agent",
      ),
    ];
    // No persisted skill_matches row for the bundled self-skill — bundled
    // (level=agent) skills are never written to skill_matches.

    const result = await matchAgentsToSkills();
    expect(
      result.matches.find((m) => m.skillId === "custom:email-recipient-selection:email-recipient-selection"),
    ).toBeUndefined();
  });
});

describe("matchAgentsToSkills — projects persisted skill_matches rows", () => {
  it("projects a persisted cross-agent row, keyed by the agent's slug-shape id", async () => {
    installedTemplates.push(
      template("@cinatra-ai/email-outreach-agent", "Email Outreach"),
    );
    skillsCatalogState.skills = [seedExternalSkill("third-party:cold-email", "Cold Email")];
    persistedMatchRows.push(
      row({ agentId: "@cinatra-ai/email-outreach-agent", skillId: "third-party:cold-email" }),
    );

    const result = await matchAgentsToSkills();
    const matches = result.matches.filter((m) => m.skillId === "third-party:cold-email");
    // agentId is projected as the slug-shape id derived from the packageId.
    expect(matches.map((m) => m.agentId).sort()).toEqual(["email-outreach-agent"]);
  });

  it("a single skill matched to multiple agents projects one row per agent (no per-skill dedup)", async () => {
    installedTemplates.push(
      template("@cinatra-ai/email-recipient-selection-agent", "Email Recipients"),
      template("@cinatra-ai/email-outreach-agent", "Email Outreach"),
    );
    skillsCatalogState.skills = [seedExternalSkill("third-party:writing-style", "Writing Style")];
    persistedMatchRows.push(
      row({ agentId: "@cinatra-ai/email-recipient-selection-agent", skillId: "third-party:writing-style" }),
      row({ agentId: "@cinatra-ai/email-outreach-agent", skillId: "third-party:writing-style" }),
    );

    const result = await matchAgentsToSkills();
    const matches = result.matches.filter((m) => m.skillId === "third-party:writing-style");
    expect(matches.length).toBe(2);
    expect(new Set(matches.map((m) => m.agentId))).toEqual(
      new Set(["email-recipient-selection-agent", "email-outreach-agent"]),
    );
  });

  it("drops persisted rows whose agent is not installed", async () => {
    // Skill exists in the catalog but no installed agent claims the row.
    skillsCatalogState.skills = [seedExternalSkill("third-party:orphan", "Orphan")];
    persistedMatchRows.push(
      row({ agentId: "@cinatra-ai/uninstalled-agent", skillId: "third-party:orphan" }),
    );

    const result = await matchAgentsToSkills();
    expect(result.matches.find((m) => m.skillId === "third-party:orphan")).toBeUndefined();
  });
});

describe("getAssignedSkillIdsForAgent — self-match short-circuit", () => {
  beforeEach(() => {
    installedTemplates.push(
      template("@cinatra-ai/email-recipient-selection-agent", "Email Recipients"),
    );
    skillsCatalogState.skills = [
      seedAgentSkill(
        "custom:email-recipient-selection:email-recipient-selection",
        "@cinatra-ai/email-recipient-selection-agent",
      ),
    ];
  });

  it("npm name: direct match by skill.agentId === input npm name", async () => {
    const ids = await getAssignedSkillIdsForAgent("@cinatra-ai/email-recipient-selection-agent");
    expect(ids).toContain("custom:email-recipient-selection:email-recipient-selection");
  });

  it("slug fallback: direct match by directory slug input", async () => {
    const ids = await getAssignedSkillIdsForAgent("email-recipient-selection-agent");
    expect(ids).toContain("custom:email-recipient-selection:email-recipient-selection");
  });
});

describe("getAssignedSkillIdsForAgent — unions persisted skill_matches with self-skills", () => {
  it("returns the self-skill AND the persisted external match for the agent", async () => {
    installedTemplates.push(
      template("@cinatra-ai/email-recipient-selection-agent", "Email Recipients"),
    );
    skillsCatalogState.skills = [
      seedAgentSkill(
        "custom:email-recipient-selection:email-recipient-selection",
        "@cinatra-ai/email-recipient-selection-agent",
      ),
      seedExternalSkill("third-party:writing-style", "Writing Style"),
    ];
    persistedMatchRows.push(
      row({
        agentId: "@cinatra-ai/email-recipient-selection-agent",
        skillId: "third-party:writing-style",
      }),
    );

    const ids = await getAssignedSkillIdsForAgent("@cinatra-ai/email-recipient-selection-agent");
    expect(ids).toContain("custom:email-recipient-selection:email-recipient-selection");
    expect(ids).toContain("third-party:writing-style");
  });
});

describe("getAssignedSkillIdsForAgent — npm-name resolves packageId-keyed rows", () => {
  it("querying by npm name returns external matches keyed by the resolved packageId", async () => {
    installedTemplates.push(
      template("@cinatra-ai/email-recipient-selection-agent", "Email Recipients"),
    );
    skillsCatalogState.skills = [seedExternalSkill("third-party:writing-style", "Writing Style")];
    // skill_matches rows are keyed by canonical packageId.
    persistedMatchRows.push(
      row({
        agentId: "@cinatra-ai/email-recipient-selection-agent",
        skillId: "third-party:writing-style",
      }),
    );

    const ids = await getAssignedSkillIdsForAgent("@cinatra-ai/email-recipient-selection-agent");
    expect(ids).toContain("third-party:writing-style");
  });
});

describe("static — scoreAgentSkill is absent", () => {
  it("agents-store.ts source does not reference scoreAgentSkill", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.join(process.cwd(), "src/lib/agents-store.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/scoreAgentSkill/);
  });
});

describe("getAssignedSkillIdsForAgent — A3 lifecycle runtime-delivery gate (cinatra#1363)", () => {
  const AGENT = "@cinatra-ai/email-recipient-selection-agent";
  const ACTIVE = "custom:er:active";
  const GATED = "custom:er:gated";

  beforeEach(() => {
    installedTemplates.push(template(AGENT, "Email Recipients"));
    skillsCatalogState.skills = [seedAgentSkill(ACTIVE, AGENT), seedAgentSkill(GATED, AGENT)];
  });

  // Reseed the gate to return the given state per id (unlisted ids ⇒ 'active').
  const seedStates = (map: Record<string, string | null>) => {
    readSkillLifecycleStatesImpl = (ids) => ({
      ok: true,
      states: new Map(ids.map((id) => [id, id in map ? map[id] : "active"])),
    });
  };

  it("drops an ARCHIVED skill from the resolved union; keeps active", async () => {
    seedStates({ [GATED]: "archived" });
    const ids = await getAssignedSkillIdsForAgent(AGENT);
    expect(ids).toContain(ACTIVE);
    expect(ids).not.toContain(GATED);
  });

  it("drops a DRAFT skill (owner-visible only, never runtime-delivered)", async () => {
    seedStates({ [GATED]: "draft" });
    const ids = await getAssignedSkillIdsForAgent(AGENT);
    expect(ids).toContain(ACTIVE);
    expect(ids).not.toContain(GATED);
  });

  it("keeps DEPRECATED (delivered + badged) and a NULL/derived (extension) skill", async () => {
    seedStates({ [ACTIVE]: "deprecated", [GATED]: null });
    const ids = await getAssignedSkillIdsForAgent(AGENT);
    expect(ids).toContain(ACTIVE);
    expect(ids).toContain(GATED);
  });

  it("FAILS CLOSED on an unknown state AND on a row missing from the lifecycle read", async () => {
    // Only ACTIVE resolves; GATED is absent from the returned map ⇒ withheld.
    readSkillLifecycleStatesImpl = (ids) => ({
      ok: true,
      states: new Map(ids.filter((id) => id === ACTIVE).map((id) => [id, "active" as string | null])),
    });
    const ids = await getAssignedSkillIdsForAgent(AGENT);
    expect(ids).toContain(ACTIVE);
    expect(ids).not.toContain(GATED);
  });

  it("FAILS CLOSED on a lifecycle READER ERROR — the whole union is withheld ([])", async () => {
    readSkillLifecycleStatesImpl = () => ({ ok: false });
    const ids = await getAssignedSkillIdsForAgent(AGENT);
    expect(ids).toEqual([]);
  });

  it("gates the DEGRADED early-return path too — a catalog-read failure still drops archived", async () => {
    // Force the catalog read to throw so the early return fires; the union then
    // comes from customAssignmentIds, which the lifecycle gate still filters on
    // the degraded early-return path.
    const skills = await import("@cinatra-ai/skills");
    vi.mocked(skills.readSkillsCatalog).mockRejectedValueOnce(new Error("catalog boom"));
    const db = await import("@/lib/database");
    vi.mocked(db.readCustomSkillAssignmentsForAgent).mockResolvedValueOnce([
      { skillId: ACTIVE, ownerType: "user", ownerId: "u1" } as any,
      { skillId: GATED, ownerType: "user", ownerId: "u1" } as any,
    ]);
    seedStates({ [GATED]: "archived" });
    const ids = await getAssignedSkillIdsForAgent(AGENT, {
      principalId: "u1",
      organizationId: "org1",
    });
    expect(ids).toContain(ACTIVE);
    expect(ids).not.toContain(GATED);
  });
});
