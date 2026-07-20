// Artifact-scope projection lanes in graphiti-projector.ts (cinatra#1436).
//
// Generalizes the #1379 memory-lane mechanism to ARTIFACT rows: the generic
// artifact object type AND any DISPOSITION-GOVERNED type whose type-driven
// disposition is artifact-safe / faceted NEST under a server-derived per-scope
// lane (AC1), move lanes on a scope change purging the prior-lane episode (AC2),
// and reuse the SAME hardened scope->lane function memory uses — never an
// independent artifact branch (AC6). A governed 'raw' opt-in keeps the single
// ambient org lane (guardrail).
//
// Same harness as graphiti-projector-memory.test.ts: mock @/lib/postgres-sync +
// ../graphiti-client; identityHashToUuid is lane-AWARE (`${hash}@${group}`) so a
// lane-move deletes the OLD lane's UUID and writes the NEW lane's. The
// disposition comes from the type-driven registry (epic #1785); the
// effective-identity resolver is mocked to drive the faceted path.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  identityHashToUuid: (h: string, g: string) => `${h}@${g}`,
}));
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: vi.fn(() => []),
}));
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentity: vi.fn(() => ({
    identity: { kind: "no-primary" },
    eligibleExtensions: [],
  })),
}));

import { z } from "zod";

import { projectObjectToGraphiti } from "../graphiti-projector";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { addEpisode, deleteEpisode } from "../graphiti-client";
import { deriveProjectionGroupId, deriveScopeLane } from "../graphiti-projection-policy";
import { GENERIC_ARTIFACT_OBJECT_TYPE } from "../effective-identity";
import { objectTypeRegistry } from "../registry";
import type { TypeProjectionDisposition } from "../types";

const runPg = runPostgresQueriesSync as unknown as ReturnType<typeof vi.fn>;
const addEp = addEpisode as unknown as ReturnType<typeof vi.fn>;
const delEp = deleteEpisode as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-1";
const BASE = deriveProjectionGroupId(ORG); // cinatra-org-org-1
const CLAIMED_TYPE = "@cinatra-ai/email:message";

// Register CLAIMED_TYPE as a disposition-GOVERNED type with the given projection
// (the type-driven authority the retirement replaced the DB claim with).
function registerClaimed(projection: TypeProjectionDisposition) {
  objectTypeRegistry.register({
    type: CLAIMED_TYPE,
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
    dispositions: { projection },
  });
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
  runPg.mockReset();
  addEp.mockReset();
  delEp.mockReset();
  addEp.mockResolvedValue({ uuid: "ep", name: "x", content: "{}", group_id: "g" });
  delEp.mockResolvedValue(undefined);
});

// A generic artifact row (artifactType + latestRepresentationRevisionId ⇒
// projectArtifactSafe applies; never claimed).
function artifactRow(over: Record<string, unknown> = {}) {
  return {
    id: "obj-art-1",
    type: GENERIC_ARTIFACT_OBJECT_TYPE,
    data: { artifactType: "text/markdown", latestRepresentationRevisionId: "rev-1", title: "Notes" },
    version: 1,
    org_id: ORG,
    run_id: "r1",
    agent_id: "a1",
    graphiti_episode_uuid: null,
    graphiti_projected_version: null,
    source: "route",
    created_at: "2026-01-01T00:00:00Z",
    owner_level: "user",
    owner_id: "user-42",
    visibility: "private",
    project_id: null,
    projected_group_id: null,
    ...over,
  };
}

// A governed typed row with a scope; the type's disposition decides faceting.
function claimedRow(over: Record<string, unknown> = {}) {
  return {
    id: "obj-clm-1",
    type: CLAIMED_TYPE,
    data: { subject: "Q3 update", body: "hi" },
    version: 1,
    org_id: ORG,
    run_id: null,
    agent_id: null,
    graphiti_episode_uuid: null,
    graphiti_projected_version: null,
    source: "route",
    created_at: "2026-01-01T00:00:00Z",
    owner_level: "user",
    owner_id: "user-42",
    visibility: "private",
    project_id: null,
    projected_group_id: null,
    ...over,
  };
}

describe("generic artifact row — AC1 scope-derived lane (reuses deriveScopeLane, AC6)", () => {
  it("projects a user-private artifact into the user lane, NOT the ambient org lane", async () => {
    runPg.mockReturnValueOnce([{ rows: [artifactRow()] }]); // readCanonicalRow
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]); // semantic read + markProjected
    const result = await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 1, orgId: ORG });
    expect(result.skipped).toBeUndefined();
    expect(addEp).toHaveBeenCalledOnce();
    // AC1: nested user lane — the SAME lane deriveScopeLane computes for this scope.
    const derived = deriveScopeLane(ORG, { ownerLevel: "user", ownerId: "user-42", visibility: "private", projectId: null });
    expect(derived).toEqual({ kind: "lane", groupId: `${BASE}-user-user-42` });
    expect(addEp.mock.calls[0][0].group_id).toBe(`${BASE}-user-user-42`);
    // Still the artifact-safe body (metadata only), never raw bytes.
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.artifactType).toBe("text/markdown");
    expect(body.cinatra_object_id).toBe("obj-art-1");
  });

  it("routes team → team lane, org → ambient lane, and suffixes -proj-<id>", async () => {
    // team-owned
    runPg.mockReturnValueOnce([{ rows: [artifactRow({ owner_level: "team", owner_id: "team-9", visibility: "team" })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 1, orgId: ORG });
    expect(addEp.mock.calls[0][0].group_id).toBe(`${BASE}-team-team-9`);

    addEp.mockClear();
    runPg.mockReset();
    // org-visible + project
    runPg.mockReturnValueOnce([{ rows: [artifactRow({ owner_level: "organization", owner_id: ORG, visibility: "organization", project_id: "proj-7" })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 1, orgId: ORG });
    expect(addEp.mock.calls[0][0].group_id).toBe(`${BASE}-proj-proj-7`);
  });

  it("terminal-skips a PUBLIC artifact row (no addEpisode) — fail-closed like memory", async () => {
    runPg.mockReturnValueOnce([{ rows: [artifactRow({ visibility: "public" })] }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 1, orgId: ORG });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
  });

  it("persists the derived lane in projected_group_id via markProjected", async () => {
    runPg.mockReturnValueOnce([{ rows: [artifactRow()] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 1, orgId: ORG });
    const markCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /UPDATE\s+"cinatra"\."objects"\s+SET\s+graphiti_sync_status/i.test(t) && /projected_group_id\s*=\s*\$4/.test(t);
    });
    expect(markCall![0].queries[0].values).toContain(`${BASE}-user-user-42`);
  });
});

describe("generic artifact row — AC2 lane-move", () => {
  it("a scope change (user → org) purges the PRIOR-lane episode then re-projects into the NEW lane", async () => {
    const priorLane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{
      rows: [artifactRow({
        version: 2,
        graphiti_projected_version: 1,
        graphiti_episode_uuid: `obj-art-1@${priorLane}`,
        projected_group_id: priorLane,
        owner_level: "organization",
        owner_id: ORG,
        visibility: "organization",
      })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 2, orgId: ORG });
    expect(result.skipped).toBeUndefined();
    // Prior-lane episode deleted, located via projected_group_id (not re-derived).
    expect(delEp).toHaveBeenCalledOnce();
    expect(delEp.mock.calls[0][0]).toEqual({ uuid: `obj-art-1@${priorLane}` });
    // Re-projected into the ambient lane with the NEW lane's UUID.
    expect(addEp.mock.calls[0][0].group_id).toBe(BASE);
    const markCall = runPg.mock.calls.find((c) => /projected_group_id\s*=\s*\$4/.test(c[0]?.queries?.[0]?.text ?? ""));
    expect(markCall![0].queries[0].values).toContain(BASE);
    expect(markCall![0].queries[0].values).toContain(`obj-art-1@${BASE}`);
  });

  it("no lane-move when the derived lane is unchanged (never calls deleteEpisode)", async () => {
    const lane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{ rows: [artifactRow({ version: 2, graphiti_projected_version: 1, projected_group_id: lane })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 2, orgId: ORG });
    expect(delEp).not.toHaveBeenCalled();
    expect(addEp).toHaveBeenCalledOnce();
  });

  it("turning PUBLIC retracts the prior-lane episode + clears bookkeeping (no residual searchable copy)", async () => {
    const priorLane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{
      rows: [artifactRow({ version: 2, graphiti_projected_version: 1, projected_group_id: priorLane, visibility: "public" })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-art-1", objectVersion: 2, orgId: ORG });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
    expect(delEp.mock.calls[0][0]).toEqual({ uuid: `obj-art-1@${priorLane}` });
    const retractCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /projected_group_id\s*=\s*NULL/.test(t) && /graphiti_episode_uuid\s*=\s*NULL/.test(t);
    });
    expect(retractCall).toBeDefined();
  });
});

describe("claimed faceted row — AC1 scope-derived lane; 'raw' opt-in stays ambient (guardrail)", () => {
  it("an artifact-safe (faceted) claimed row nests under its scope-derived lane", async () => {
    registerClaimed("artifact-safe");
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ owner_level: "team", owner_id: "team-3", visibility: "team" })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-clm-1", objectVersion: 1, orgId: ORG });
    expect(addEp).toHaveBeenCalledOnce();
    // Nested team lane (NOT the ambient org lane) — same derivation as memory/artifact.
    expect(addEp.mock.calls[0][0].group_id).toBe(`${BASE}-team-team-3`);
    // Faceted body (never raw row.data).
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.baseType).toBe(CLAIMED_TYPE);
  });

  it("a claimed row with null dispositions (⇒ artifact-safe default) also nests by scope", async () => {
    registerClaimed("artifact-safe"); // bridge default when a manifest omits dispositions
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ owner_level: "user", owner_id: "user-9", visibility: "private" })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-clm-1", objectVersion: 1, orgId: ORG });
    expect(addEp.mock.calls[0][0].group_id).toBe(`${BASE}-user-user-9`);
  });

  it("a claimed 'raw' opt-in keeps the SINGLE ambient org lane (excluded from lane treatment)", async () => {
    registerClaimed("raw");
    // Even a user-private scope stays ambient for a raw row (no nesting, no lane-move).
    runPg.mockReturnValueOnce([{ rows: [claimedRow({ owner_level: "user", owner_id: "user-42", visibility: "private", data: { subject: "S", customField: "kept" } })] }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-clm-1", objectVersion: 1, orgId: ORG });
    expect(addEp).toHaveBeenCalledOnce();
    expect(addEp.mock.calls[0][0].group_id).toBe(BASE); // ambient, NOT -user-user-42
    // Raw body kept verbatim (the explicit opt-in).
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.customField).toBe("kept");
    expect(body.baseType).toBeUndefined();
    // No lane-move delete (raw rows are not lane-tracked by scope).
    expect(delEp).not.toHaveBeenCalled();
  });

  it("a disposition flip artifact-safe → raw purges the PRIOR nested-lane episode (no orphan) then projects raw into the ambient lane", async () => {
    // Previously faceted + nested in the user lane; the claim's winner now says
    // projection='raw', so the row LEAVES lane treatment. The prior nested
    // episode must be purged (it lives outside the ambient group a rebuild
    // clears) and the row re-projects into the ambient org lane as raw.
    registerClaimed("raw");
    const priorLane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{
      rows: [claimedRow({
        version: 2,
        graphiti_projected_version: 1,
        projected_group_id: priorLane,
        owner_level: "user",
        owner_id: "user-42",
        visibility: "private",
        data: { subject: "S", customField: "kept" },
      })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    await projectObjectToGraphiti({ objectId: "obj-clm-1", objectVersion: 2, orgId: ORG });
    // Prior nested-lane episode purged.
    expect(delEp).toHaveBeenCalledOnce();
    expect(delEp.mock.calls[0][0]).toEqual({ uuid: `obj-clm-1@${priorLane}` });
    // Re-projected raw into the ambient org lane.
    expect(addEp.mock.calls[0][0].group_id).toBe(BASE);
    const body = JSON.parse(addEp.mock.calls[0][0].episode_body);
    expect(body.customField).toBe("kept");
    expect(body.baseType).toBeUndefined();
    const markCall = runPg.mock.calls.find((c) => /projected_group_id\s*=\s*\$4/.test(c[0]?.queries?.[0]?.text ?? ""));
    expect(markCall![0].queries[0].values).toContain(BASE);
  });

  it("a disposition flip artifact-safe → none purges the PRIOR nested-lane episode + retracts bookkeeping (no orphan)", async () => {
    // The claim's winner now says projection='none' — the row must not project.
    // A prior nested-lane episode (from when it was artifact-safe) must be
    // purged, not orphaned: the ambient-group rebuild that a claim change opens
    // never reaches a nested lane, and 'none' types are excluded from verify.
    registerClaimed("none");
    const priorLane = `${BASE}-user-user-42`;
    runPg.mockReturnValueOnce([{
      rows: [claimedRow({
        version: 2,
        graphiti_projected_version: 1,
        projected_group_id: priorLane,
        owner_level: "user",
        owner_id: "user-42",
        visibility: "private",
      })],
    }]);
    runPg.mockReturnValue([{ rows: [], rowCount: 1 }]);
    const result = await projectObjectToGraphiti({ objectId: "obj-clm-1", objectVersion: 2, orgId: ORG });
    expect(result.skipped).toBe(true);
    expect(addEp).not.toHaveBeenCalled();
    // Prior nested-lane episode purged.
    expect(delEp).toHaveBeenCalledOnce();
    expect(delEp.mock.calls[0][0]).toEqual({ uuid: `obj-clm-1@${priorLane}` });
    // Bookkeeping retracted (projected_group_id + episode uuid cleared).
    const retractCall = runPg.mock.calls.find((c) => {
      const t = c[0]?.queries?.[0]?.text ?? "";
      return /projected_group_id\s*=\s*NULL/.test(t) && /graphiti_episode_uuid\s*=\s*NULL/.test(t);
    });
    expect(retractCall).toBeDefined();
  });
});
