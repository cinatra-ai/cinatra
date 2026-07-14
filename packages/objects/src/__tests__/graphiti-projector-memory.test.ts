// Memory-concept projection: nested lane derivation (AC1), lane-move (AC2),
// and the capped projection body (AC3) in graphiti-projector.ts.
//
// Same harness as graphiti-projector.test.ts: mock @/lib/postgres-sync (capture
// SQL/values) and ../graphiti-client (capture addEpisode/deleteEpisode). The
// identityHashToUuid mock is lane-AWARE here (returns `${hash}@${group}`) so the
// test can assert the episode UUID is lane-scoped and that a lane-move deletes
// the OLD lane's UUID and writes the NEW lane's.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  identityHashToUuid: (h: string, g: string) => `${h}@${g}`,
}));

import {
  projectObjectToGraphiti,
  projectMemoryConceptCapped,
  MEMORY_CONCEPT_PROJECTION_EXCERPT_MAX_BYTES,
} from "../graphiti-projector";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { addEpisode, deleteEpisode } from "../graphiti-client";
import { MEMORY_CONCEPT_TYPE_ID } from "../integration/register-types";
import { deriveProjectionGroupId } from "../graphiti-projection-policy";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;
const addEp = addEpisode as unknown as ReturnType<typeof vi.fn>;
const delEp = deleteEpisode as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";
const BASE = deriveProjectionGroupId(ORG); // cinatra-org-org-1

beforeEach(() => {
  runPg.mockReset();
  addEp.mockReset();
  delEp.mockReset();
  addEp.mockResolvedValue({ uuid: "ep", name: "x", content: "{}", group_id: "g" });
  delEp.mockResolvedValue(undefined);
});

function memoryEnvelope(over: Record<string, unknown> = {}) {
  return {
    conceptId: "conventions/ts/no-default-exports",
    bundleId: "9f4d9e0a-1b2c-4d3e-8f5a-6b7c8d9e0f1a",
    externalId: "a".repeat(64),
    okfType: "convention",
    frontmatter: { type: "convention", title: "No default exports", extra: "leak-me" },
    bodyMarkdown: "Use named exports everywhere.\n".repeat(10),
    links: [{ target: "./other", resolvedConceptId: "other" }],
    okfVersion: "0.1",
    ...over,
  };
}

function memoryRow(over: Record<string, unknown> = {}) {
  return {
    id: "obj-mem-1",
    type: MEMORY_CONCEPT_TYPE_ID,
    data: memoryEnvelope(),
    version: 1,
    org_id: ORG,
    run_id: "r1",
    agent_id: "a1",
    graphiti_episode_uuid: null,
    graphiti_projected_version: null,
    source: "agent",
    created_at: "2026-01-01T00:00:00Z",
    owner_level: "user",
    owner_id: "user-42",
    visibility: "private",
    project_id: null,
    projected_group_id: null,
    ...over,
  };
}

// The AC3 pure whitelist function.
describe("projectMemoryConceptCapped — AC3 whitelist body", () => {
  it("keeps ONLY { conceptId, okfType, title, excerpt } — never the full envelope", () => {
    const body = projectMemoryConceptCapped(memoryEnvelope());
    expect(Object.keys(body).sort()).toEqual(["conceptId", "excerpt", "okfType", "title"]);
    expect(body.conceptId).toBe("conventions/ts/no-default-exports");
    expect(body.okfType).toBe("convention");
    expect(body.title).toBe("No default exports");
    // NEVER: raw frontmatter passthrough, links[], bundleId/externalId, full body.
    expect((body as Record<string, unknown>).frontmatter).toBeUndefined();
    expect((body as Record<string, unknown>).links).toBeUndefined();
    expect((body as Record<string, unknown>).bundleId).toBeUndefined();
    expect((body as Record<string, unknown>).externalId).toBeUndefined();
    expect((body as Record<string, unknown>).bodyMarkdown).toBeUndefined();
  });

  it("caps the excerpt at 4 KiB of UTF-8 bytes without splitting a code point", () => {
    const big = "€".repeat(5000); // 3 bytes each => 15000 bytes, over the 4 KiB cap
    const body = projectMemoryConceptCapped(memoryEnvelope({ bodyMarkdown: big }));
    const bytes = new TextEncoder().encode(body.excerpt as string).length;
    expect(bytes).toBeLessThanOrEqual(MEMORY_CONCEPT_PROJECTION_EXCERPT_MAX_BYTES);
    // No replacement char (U+FFFD) — truncation landed on a code-point boundary.
    expect((body.excerpt as string).includes("�")).toBe(false);
  });
});

describe("memory-concept projection — AC1 nested lane + AC3 capped body (end to end)", () => {
  it("projects a user-private memory row into the user lane with a CAPPED body", async () => {
    runPg.mockReturnValueOnce([{ rows: [memoryRow()] }]); // readCanonicalRow
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]); // markProjected etc.
    const result = await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 1, orgId: ORG });
    expect(result.skipped).toBeUndefined();
    expect(addEp).toHaveBeenCalledOnce();
    const call = addEp.mock.calls[0][0];
    // AC1: nested user lane.
    expect(call.group_id).toBe(`${BASE}-user-user-42`);
    // AC3: capped body — envelope leak fields absent, excerpt present.
    const body = JSON.parse(call.episode_body);
    expect(body.conceptId).toBe("conventions/ts/no-default-exports");
    expect(body.okfType).toBe("convention");
    expect(body.title).toBe("No default exports");
    expect(body.excerpt).toContain("Use named exports");
    expect(body.frontmatter).toBeUndefined();
    expect(body.links).toBeUndefined();
    expect(body.bundleId).toBeUndefined();
    // Projection metadata still travels.
    expect(body.cinatra_object_id).toBe("obj-mem-1");
    // readCanonicalRow SELECT widened to carry the scope + prior-lane columns.
    const selectSql = runPg.mock.calls[0][0].queries[0].text;
    expect(selectSql).toMatch(/owner_level/);
    expect(selectSql).toMatch(/projected_group_id/);
  });

  it("markProjected persists the derived lane in projected_group_id", async () => {
    runPg.mockReturnValueOnce([{ rows: [memoryRow()] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 1, orgId: ORG });
    const markCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /UPDATE\s+"cinatra"\."objects"\s+SET\s+graphiti_sync_status/i.test(t) && /projected_group_id\s*=\s*\$4/.test(t);
    });
    expect(markCall).toBeDefined();
    expect(markCall![0].queries[0].values).toContain(`${BASE}-user-user-42`);
  });

  it("routes a team row to the team lane and an org row to the ambient lane", async () => {
    // team
    runPg.mockReturnValueOnce([{ rows: [memoryRow({ owner_level: "team", owner_id: "team-9", visibility: "team" })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 1, orgId: ORG });
    expect(addEp.mock.calls[0][0].group_id).toBe(`${BASE}-team-team-9`);

    addEp.mockClear();
    runPg.mockReset();
    // org
    runPg.mockReturnValueOnce([{ rows: [memoryRow({ owner_level: "organization", owner_id: ORG, visibility: "organization" })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 1, orgId: ORG });
    expect(addEp.mock.calls[0][0].group_id).toBe(BASE);
  });

  it("suffixes the lane with -proj-<id> when the row carries a project_id", async () => {
    runPg.mockReturnValueOnce([{ rows: [memoryRow({ project_id: "proj-7" })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 1, orgId: ORG });
    expect(addEp.mock.calls[0][0].group_id).toBe(`${BASE}-user-user-42-proj-proj-7`);
  });

  it("terminal-skips a public memory row (no addEpisode)", async () => {
    runPg.mockReturnValueOnce([{ rows: [memoryRow({ visibility: "public" })] }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 1, orgId: ORG });
    expect(result.skipped).toBe(true);
    expect(result.episodeUuid).toBeNull();
    expect(addEp).not.toHaveBeenCalled();
  });
});

describe("memory-concept lane-move — AC2", () => {
  it("a scope change deletes the PRIOR-lane episode then re-projects into the NEW lane", async () => {
    // Already projected into the user lane at v1; now promoted to org scope at v2.
    const priorLane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{
      rows: [memoryRow({
        version: 2,
        graphiti_projected_version: 1,
        graphiti_episode_uuid: `obj-mem-1@${priorLane}`,
        projected_group_id: priorLane,
        // NEW scope: org-visible.
        owner_level: "organization",
        owner_id: ORG,
        visibility: "organization",
      })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);

    const result = await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 2, orgId: ORG });
    expect(result.skipped).toBeUndefined();

    // (b) deletes the prior-lane episode, located via projected_group_id.
    expect(delEp).toHaveBeenCalledOnce();
    expect(delEp.mock.calls[0][0]).toEqual({ uuid: `obj-mem-1@${priorLane}` });

    // (c) re-projects into the NEW (ambient) lane with the lane-scoped UUID.
    expect(addEp).toHaveBeenCalledOnce();
    expect(addEp.mock.calls[0][0].group_id).toBe(BASE);
    const markCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /projected_group_id\s*=\s*\$4/.test(t);
    });
    expect(markCall![0].queries[0].values).toContain(BASE);
    // The new episode UUID is the NEW lane's, not the old one's.
    expect(markCall![0].queries[0].values).toContain(`obj-mem-1@${BASE}`);
  });

  it("no lane-move (prior lane == derived lane): never calls deleteEpisode", async () => {
    const lane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{
      rows: [memoryRow({ version: 2, graphiti_projected_version: 1, projected_group_id: lane })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 2, orgId: ORG });
    expect(delEp).not.toHaveBeenCalled();
    expect(addEp).toHaveBeenCalledOnce();
  });

  it("a delete failure on the old lane is BEST-EFFORT — the new lane still projects (the purge is relevance hygiene, not the authz gate)", async () => {
    // The prior-lane purge is best-effort (no episode-uuid control; recall
    // authz is enforced Postgres-side on the current scope). A delete failure
    // must NOT strand the concept out of its new lane, so it is swallowed and
    // the new-lane projection proceeds — mirroring deleteCurrentEpisodeFromGraphiti.
    const priorLane = `${BASE}-user-user-42`;
    delEp.mockRejectedValueOnce(new Error("graphiti delete flaked"));
    runPg.mockReturnValueOnce([{
      rows: [memoryRow({
        version: 2,
        graphiti_projected_version: 1,
        projected_group_id: priorLane,
        owner_level: "organization",
        owner_id: ORG,
        visibility: "organization",
      })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 2, orgId: ORG });
    expect(result.skipped).toBeUndefined();
    expect(addEp).toHaveBeenCalledOnce();
    expect(addEp.mock.calls[0][0].group_id).toBe(BASE);
    // markProjected still records the new lane.
    const markCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /UPDATE\s+"cinatra"\."objects"\s+SET\s+graphiti_sync_status\s*=\s*'synced'/i.test(t) && /projected_group_id\s*=\s*\$4/.test(t);
    });
    expect(markCall![0].queries[0].values).toContain(BASE);
  });
});

describe("memory-concept retract on transition to a NON-projected scope — AC2/privacy (#1379 codex)", () => {
  it("a previously-projected row that turns PUBLIC deletes its prior-lane episode and clears bookkeeping (no leak)", async () => {
    const priorLane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{
      rows: [memoryRow({
        version: 2,
        graphiti_projected_version: 1,
        projected_group_id: priorLane,
        visibility: "public",
      })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 2, orgId: ORG });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
    // The prior private-lane episode is deleted (no residual searchable copy).
    expect(delEp).toHaveBeenCalledOnce();
    expect(delEp.mock.calls[0][0]).toEqual({ uuid: `obj-mem-1@${priorLane}` });
    // Bookkeeping is retracted: projected_group_id + episode uuid cleared.
    const retractCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /projected_group_id\s*=\s*NULL/.test(t) && /graphiti_episode_uuid\s*=\s*NULL/.test(t);
    });
    expect(retractCall).toBeDefined();
  });

  it("a NEVER-projected public row just skips (no delete, no retract UPDATE)", async () => {
    runPg.mockReturnValueOnce([{ rows: [memoryRow({ visibility: "public", projected_group_id: null })] }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 1, orgId: ORG });
    expect(result.skipped).toBe(true);
    expect(delEp).not.toHaveBeenCalled();
    const retractCall = runPg.mock.calls.find((c) => /projected_group_id\s*=\s*NULL/.test(c[0]?.queries?.[0]?.text ?? ""));
    expect(retractCall).toBeUndefined();
  });

  it("a retract delete failure is BEST-EFFORT — still clears bookkeeping and skips (recall authz is Postgres-side)", async () => {
    const priorLane = `${BASE}-user-user-42`;
    delEp.mockRejectedValueOnce(new Error("delete flaked on retract"));
    runPg.mockReturnValueOnce([{
      rows: [memoryRow({ version: 2, graphiti_projected_version: 1, projected_group_id: priorLane, visibility: "public" })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-mem-1", objectVersion: 2, orgId: ORG });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
    // Bookkeeping is still retracted so a re-enqueue does not loop on the purge.
    const retractCall = runPg.mock.calls.find((c) => /projected_group_id\s*=\s*NULL/.test(c[0]?.queries?.[0]?.text ?? ""));
    expect(retractCall).toBeDefined();
  });
});

it("MEMORY_CONCEPT_TYPE_ID inlined literal in the projector matches the registry constant", () => {
  // The projector inlines the id to avoid an import edge; this guards the drift.
  expect(MEMORY_CONCEPT_TYPE_ID).toBe("@cinatra-ai/memory:concept");
});
