import { beforeEach, describe, expect, it, vi } from "vitest";

// Context Slot Resolver unit tests.
// Mocks postgres-sync so the resolver runs against canned row sets.

const { runPgMock } = vi.hoisted(() => ({
  runPgMock: vi.fn(),
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPgMock,
}));
// cinatra#3603: the admissible-type CLAIM read reaches the query layer through
// the claim store, which takes `ensurePostgresSchema` from `postgres-schema-init`
// rather than from `@/lib/database`. Substituting it here too keeps this suite's
// stand-in for the synchronous query layer COMPLETE, so the calls it counts are
// the statements it means and not a one-off schema-init DDL batch.
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: () => {},
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));

// `buildOwnershipFilter` is REAL — we want the actual SQL fragment to flow
// through so the test exercises the integration with the canonical helper.

import {
  resolveContextSlot,
  expandAcceptedViaSatisfies,
  rejectProjectAsOwnerLevel,
  type ResolvedContextRef,
} from "../context-resolver";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";

const ACTOR_BASE: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-a",
  teamIds: ["team-1"],
  projectIds: ["proj-x"],
  authSource: "ui",
  policyVersion: "v2",
};

const SLOT_BASE: AgentContextSlot = {
  slotId: "offeringContext",
  acceptedArtifactExtensions: [
    "@cinatra-ai/marketing-icp-artifact",
    "@cinatra-ai/marketing-strategy-artifact",
  ],
  selectionMode: "interactive",
  resolutionMode: "accumulate",
};

function stageRows(
  rows: Array<{
    artifact_id: string;
    owner_level: string;
    owner_id: string;
    visibility: string;
    project_id?: string | null;
    semantic_assertion_id: string;
    extension: string;
    representation_revision_id: string;
    revision: number;
  }>,
) {
  runPgMock.mockReturnValue([{ rows, rowCount: rows.length }]);
}


// cinatra#3603: `resolveContextSlot` now makes TWO synchronous query calls —
// FIRST the organisation's artifact-type CLAIM read (the admissible-type source
// the artifact WRITE side has always used, now shared by the read side), THEN
// the context-candidate query. Every assertion below is aimed at the statement
// it has always meant, selected by that statement's OWN text rather than by a
// call index, so each stays exactly as strict as it was.
function queryMatching(needle: string): { text: string; values: unknown[] } {
  const calls = runPgMock.mock.calls as Array<
    [{ queries: Array<{ text: string; values: unknown[] }> }]
  >;
  const hits = calls
    .map((c) => c[0].queries[0])
    .filter((q) => q.text.includes(needle));
  expect(hits).toHaveLength(1);
  return hits[0];
}

/** The context-candidate statement, selected by its own `visible_objects` CTE. */
function contextQuery(): { text: string; values: unknown[] } {
  return queryMatching("visible_objects AS");
}

/** The admissible-type CLAIM read, selected by its own org-scope-chain clause. */
function claimQuery(): { text: string; values: unknown[] } {
  return queryMatching("scope = 'platform' OR scope =");
}

describe("expandAcceptedViaSatisfies", () => {
  it("returns the directly-accepted set when no installed extension satisfies any of them", () => {
    expect(
      expandAcceptedViaSatisfies(["@v/a"], [
        { extension: "@v/b", satisfies: ["@v/c"] },
      ]).sort(),
    ).toEqual(["@v/a"]);
  });

  it("adds an installed extension that satisfies a directly-accepted extension", () => {
    const expanded = expandAcceptedViaSatisfies(
      ["@v/a"],
      [{ extension: "@v/b", satisfies: ["@v/a"] }],
    );
    expect(new Set(expanded)).toEqual(new Set(["@v/a", "@v/b"]));
  });

  it("single-hop only — does NOT recurse through chained satisfies", () => {
    const expanded = expandAcceptedViaSatisfies(
      ["@v/a"],
      [
        { extension: "@v/b", satisfies: ["@v/a"] },
        // @v/c satisfies @v/b — but b is not directly-accepted, so c
        // should NOT join the expanded set (single-hop semantics).
        { extension: "@v/c", satisfies: ["@v/b"] },
      ],
    );
    expect(new Set(expanded)).toEqual(new Set(["@v/a", "@v/b"]));
  });

  it("survives a satisfies-cycle (A↔B) without recursing", () => {
    const expanded = expandAcceptedViaSatisfies(
      ["@v/a"],
      [
        { extension: "@v/b", satisfies: ["@v/a"] },
        { extension: "@v/a", satisfies: ["@v/b"] }, // pathological cycle
      ],
    );
    // a is directly accepted; b satisfies a (added). a satisfies b but a is
    // already in the set. No recursion happens.
    expect(new Set(expanded)).toEqual(new Set(["@v/a", "@v/b"]));
  });
});

describe("rejectProjectAsOwnerLevel", () => {
  it("throws on ownerLevel='project'", () => {
    expect(() => rejectProjectAsOwnerLevel("project")).toThrow(
      /project is a refinement/i,
    );
  });
  it.each([["user"], ["team"], ["organization"], ["workspace"], [undefined]])(
    "permits %s",
    (level) => {
      expect(() => rejectProjectAsOwnerLevel(level)).not.toThrow();
    },
  );
});

describe("resolveContextSlot — boundary guards", () => {
  beforeEach(() => runPgMock.mockReset());

  it("throws on empty acceptedArtifactExtensions", () => {
    expect(() =>
      resolveContextSlot({
        actor: ACTOR_BASE,
        slot: { ...SLOT_BASE, acceptedArtifactExtensions: [] },
        installedExtensions: [],
      }),
    ).toThrow(/acceptedArtifactExtensions is empty/);
  });

  it("throws when actor.organizationId is absent (fail-closed)", () => {
    expect(() =>
      resolveContextSlot({
        actor: { ...ACTOR_BASE, organizationId: undefined as never },
        slot: SLOT_BASE,
        installedExtensions: [],
      }),
    ).toThrow(/organizationId is required/);
  });

  it("returns [] when projectId is set but NOT in actor.projectIds (fail-closed)", () => {
    const refs = resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      projectId: "proj-not-mine",
      installedExtensions: [],
    });
    expect(refs).toEqual([]);
    // No DB call made — fail-closed BEFORE the query.
    expect(runPgMock).not.toHaveBeenCalled();
  });

  it("permits projectId when present in actor.projectIds + runs the query", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      projectId: "proj-x",
      installedExtensions: [],
    });
    // cinatra#3603: TWO calls now — the admissible-type claim read, then the
    // candidate query. The candidate query itself still runs exactly once.
    expect(runPgMock).toHaveBeenCalledTimes(2);
  });
});

describe("resolveContextSlot — dashboard-form exclusion (cinatra#1896, epic #1883 §D8 v1)", () => {
  beforeEach(() => runPgMock.mockReset());

  it("the candidate query excludes any object holding a dashboard-form representation", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    const text = contextQuery().text;
    // The exclusion is a NOT EXISTS over dashboard-form representations, applied
    // in the visible_objects CTE (before the assertion/representation joins), so a
    // dashboards-artifact twin never reaches the candidate set.
    expect(text).toMatch(/NOT EXISTS/);
    expect(text).toMatch(/rdash\.form = 'dashboard'/);
    // It sits inside the visible_objects CTE WHERE, alongside the deleted_at guard.
    const cte = text.slice(text.indexOf("visible_objects AS"), text.indexOf("pins AS"));
    expect(cte).toMatch(/rdash\.form = 'dashboard'/);
  });
});

describe("resolveContextSlot — accumulate mode (narrow→broad ordering)", () => {
  beforeEach(() => runPgMock.mockReset());

  it("returns rows sorted narrow→broad with derived sourceScope", () => {
    stageRows([
      // Mixed-scope rows; the resolver should sort.
      {
        artifact_id: "art-org",
        owner_level: "organization",
        owner_id: "org-a",
        visibility: "organization",
        semantic_assertion_id: "sa-org",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-org-1",
        revision: 1,
      },
      {
        artifact_id: "art-user",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        semantic_assertion_id: "sa-user",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-user-1",
        revision: 1,
      },
      {
        artifact_id: "art-team",
        owner_level: "team",
        owner_id: "team-1",
        visibility: "team",
        semantic_assertion_id: "sa-team",
        extension: "@cinatra-ai/marketing-strategy-artifact",
        representation_revision_id: "rep-team-1",
        revision: 1,
      },
    ]);
    const refs = resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    expect(refs.map((r) => r.sourceScope)).toEqual([
      "user",
      "team",
      "organization",
    ]);
  });

  it("project-tagged rows resolve to sourceScope 'project' (narrowest tier)", () => {
    stageRows([
      {
        artifact_id: "art-proj",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        project_id: "proj-x",
        semantic_assertion_id: "sa-proj",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-proj-1",
        revision: 1,
      },
      {
        artifact_id: "art-user",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        semantic_assertion_id: "sa-user",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-user-1",
        revision: 1,
      },
    ]);
    const refs = resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    expect(refs[0].sourceScope).toBe("project");
    expect(refs[1].sourceScope).toBe("user");
  });
});

describe("resolveContextSlot — override mode", () => {
  beforeEach(() => runPgMock.mockReset());

  it("keeps ONLY the narrowest-tier matches", () => {
    stageRows([
      {
        artifact_id: "art-user-1",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        semantic_assertion_id: "sa-u1",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-u1",
        revision: 1,
      },
      {
        artifact_id: "art-user-2",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        semantic_assertion_id: "sa-u2",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-u2",
        revision: 1,
      },
      {
        artifact_id: "art-org",
        owner_level: "organization",
        owner_id: "org-a",
        visibility: "organization",
        semantic_assertion_id: "sa-org",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-org",
        revision: 1,
      },
    ]);
    const refs = resolveContextSlot({
      actor: ACTOR_BASE,
      slot: { ...SLOT_BASE, resolutionMode: "override" },
      installedExtensions: [],
    });
    // Both user-tier rows kept; org-tier row dropped (override mode wins).
    expect(refs).toHaveLength(2);
    for (const r of refs) {
      expect(r.sourceScope).toBe("user");
    }
  });

  it("returns [] when no rows match (override on empty result)", () => {
    stageRows([]);
    const refs = resolveContextSlot({
      actor: ACTOR_BASE,
      slot: { ...SLOT_BASE, resolutionMode: "override" },
      installedExtensions: [],
    });
    expect(refs).toEqual([]);
  });
});

describe("resolveContextSlot — maxItems truncation", () => {
  beforeEach(() => runPgMock.mockReset());

  it("truncates to maxItems after narrow→broad ordering", () => {
    stageRows([
      {
        artifact_id: "art-1",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        semantic_assertion_id: "sa-1",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-1",
        revision: 1,
      },
      {
        artifact_id: "art-2",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        semantic_assertion_id: "sa-2",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-2",
        revision: 1,
      },
      {
        artifact_id: "art-3",
        owner_level: "user",
        owner_id: "user-1",
        visibility: "private",
        semantic_assertion_id: "sa-3",
        extension: "@cinatra-ai/marketing-icp-artifact",
        representation_revision_id: "rep-3",
        revision: 1,
      },
    ]);
    const refs = resolveContextSlot({
      actor: ACTOR_BASE,
      slot: { ...SLOT_BASE, maxItems: 2 },
      installedExtensions: [],
    });
    expect(refs).toHaveLength(2);
    // Sort tie-break is artifactId localeCompare → art-1, art-2, art-3.
    expect(refs.map((r) => r.artifactId)).toEqual(["art-1", "art-2"]);
  });
});

describe("resolveContextSlot — satisfies-graph expansion at SQL boundary", () => {
  beforeEach(() => runPgMock.mockReset());

  it("expands accepted-extensions before issuing the SQL", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: { ...SLOT_BASE, acceptedArtifactExtensions: ["@v/a"] },
      installedExtensions: [
        { extension: "@v/b", satisfies: ["@v/a"] },
        { extension: "@v/c", satisfies: [] },
      ],
    });
    // cinatra#3603: TWO calls now — the admissible-type claim read, then the
    // candidate query. The candidate query itself still runs exactly once.
    expect(runPgMock).toHaveBeenCalledTimes(2);
    // The accepted-extensions param is somewhere in the values array.
    // We assert it's the expanded set (a + b), not just (a).
    const acceptedParam = contextQuery().values.find(
      (v) => Array.isArray(v) && (v as string[]).includes("@v/a"),
    ) as string[];
    expect(new Set(acceptedParam)).toEqual(new Set(["@v/a", "@v/b"]));
  });
});

describe("resolveContextSlot — eligibility & visibility safety nets", () => {
  beforeEach(() => runPgMock.mockReset());

  it("issues a query that filters on eligibility = 'eligible' literally", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    const sql = contextQuery().text;
    expect(sql).toMatch(/sa\.eligibility = 'eligible'/);
  });

  it("issues a query that filters on the semantic-artifact object type", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    const sql = contextQuery().text;
    expect(sql).toMatch(/o\.type = /);
    // The artifact-type literal is parameterized; find it in the values.
    expect(contextQuery().values).toContain("@cinatra-ai/artifact:object");
  });

  it("issues a query that excludes tombstoned objects (deleted_at IS NULL)", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    const sql = contextQuery().text;
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  it("appends the project-narrowing clause only when projectId is set", () => {
    stageRows([]);
    // Without projectId
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    const sqlNoProj = contextQuery().text;
    expect(sqlNoProj).not.toMatch(/o\.project_id = /);

    runPgMock.mockReset();
    stageRows([]);
    // With projectId (must be in actor.projectIds)
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      projectId: "proj-x",
      installedExtensions: [],
    });
    const sqlProj = contextQuery().text;
    expect(sqlProj).toMatch(/o\.project_id = /);
    // The projectId literal is parameterized.
    expect(contextQuery().values).toContain("proj-x");
  });

  // When `projectId` is
  // NOT supplied, project-tagged rows MUST be excluded even though the
  // actor's projectIds happen to grant access via buildOwnershipFilter.
  // An unrefined slot should never silently receive project-scoped rows.
  it("excludes project-tagged rows when projectId is absent", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    const sql = contextQuery().text;
    expect(sql).toMatch(/o\.project_id IS NULL/);
  });

  it("takes its admissible artifact types from the organisation's CLAIM chain (cinatra#3603)", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      installedExtensions: [],
    });
    // The admissible-type source the artifact WRITER already used: the org's own
    // scope chain (platform + this organisation), arbitrated by the claims leaf.
    const claim = claimQuery();
    expect(claim.text).toMatch(/scope = 'platform' OR scope = \$1/);
    expect(claim.values).toContain("org:org-a");
  });

  it("does NOT add the project-exclusion clause when projectId IS supplied", () => {
    stageRows([]);
    resolveContextSlot({
      actor: ACTOR_BASE,
      slot: SLOT_BASE,
      projectId: "proj-x",
      installedExtensions: [],
    });
    const sql = contextQuery().text;
    expect(sql).not.toMatch(/o\.project_id IS NULL/);
  });
});
