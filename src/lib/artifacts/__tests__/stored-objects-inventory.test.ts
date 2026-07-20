import { afterEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import {
  loadStoredArtifactObjects,
  projectStoredObjectRows,
  type ScopeNameResolver,
} from "../stored-objects-inventory";

// The loader's dynamic dependencies (lazily imported inside
// loadStoredArtifactObjects) — mocked so the fan-out logic is testable without
// a DB. The pure-projection tests below never invoke these paths.
const listObjectsByFilter = vi.fn();
vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: () => {},
}));
vi.mock("@/lib/better-auth-db", () => {
  const q = { from: () => q, where: () => Promise.resolve([]) };
  return {
    betterAuthDb: { select: () => q },
    betterAuthOrganizations: { id: {}, name: {} },
    betterAuthTeams: { id: {}, name: {} },
  };
});

const names: ScopeNameResolver = (level, ownerId) => {
  const table: Record<string, string> = {
    "team:tm_growth": "Growth",
    "organization:org_acme": "Acme Corp",
  };
  return table[`${level}:${ownerId}`] ?? null;
};

function rec(over: Partial<Parameters<typeof projectStoredObjectRows>[0][number]>) {
  return {
    id: "obj_x",
    data: { artifactType: "@cinatra-ai/email:draft", title: "A draft" },
    version: 1,
    updatedAt: "2026-07-18T10:00:00.000Z",
    ownerLevel: "organization" as const,
    ownerId: "org_acme",
    ...over,
  };
}

describe("loadStoredArtifactObjects — type-driven fan-out (epic #1785 A4)", () => {
  const GENERIC = "@cinatra-ai/artifact:object";
  const PACK_TYPE = "@cinatra-ai/pdf-artifact:document";
  const PACK_EXT = "@cinatra-ai/pdf-artifact";

  afterEach(() => {
    listObjectsByFilter.mockReset();
    objectTypeRegistry._clearForTests();
  });

  it("reads the generic base AND every registered isArtifact pack type (pack rows are not stranded)", async () => {
    objectTypeRegistry.register(
      {
        type: PACK_TYPE,
        category: "report",
        schema: z.record(z.string(), z.unknown()),
        lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
        renderers: { listRow: null, card: null, detail: null },
        isArtifact: { accepts: { file: { mimeTypes: ["application/pdf"] } } },
        dispositions: { projection: "artifact-safe" },
      } as never,
      PACK_EXT,
    );
    const row = (id: string, type: string) => ({
      id,
      type,
      data: { artifactType: type, title: id },
      version: 1,
      updatedAt: `2026-07-1${id === "g1" ? "8" : "9"}T10:00:00.000Z`,
      ownerLevel: "organization" as const,
      ownerId: "org_acme",
    });
    listObjectsByFilter.mockImplementation((f: { type: string }) =>
      f.type === GENERIC ? [row("g1", GENERIC)] : f.type === PACK_TYPE ? [row("p1", PACK_TYPE)] : [],
    );

    const rows = await loadStoredArtifactObjects({ orgId: "org_acme" });
    expect(rows.map((r) => r.objectId).sort()).toEqual(["g1", "p1"]);
    const queriedTypes = listObjectsByFilter.mock.calls
      .map((c) => (c[0] as { type: string }).type)
      .sort();
    expect(queriedTypes).toEqual([GENERIC, PACK_TYPE].sort());
  });

  it("returns [] for a null org without querying", async () => {
    const rows = await loadStoredArtifactObjects({ orgId: null });
    expect(rows).toEqual([]);
    expect(listObjectsByFilter).not.toHaveBeenCalled();
  });
});

describe("projectStoredObjectRows", () => {
  it("projects display name, type id, version, updated, and an entity-named scope", () => {
    const rows = projectStoredObjectRows(
      [
        rec({
          id: "obj_2a4e",
          data: { artifactType: "@cinatra-ai/email:draft", title: "Q3 re-engagement email" },
          version: 1,
          updatedAt: "2026-07-18T09:52:00.000Z",
          ownerLevel: "team",
          ownerId: "tm_growth",
        }),
      ],
      names,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      objectId: "obj_2a4e",
      typeId: "@cinatra-ai/email:draft",
      displayName: "Q3 re-engagement email",
      version: 1,
      scopeLabel: "Team: Growth",
    });
  });

  it("labels organization / workspace / user scopes", () => {
    const rows = projectStoredObjectRows(
      [
        rec({ id: "a", ownerLevel: "organization", ownerId: "org_acme", updatedAt: "2026-07-18T04:00:00.000Z" }),
        rec({ id: "b", ownerLevel: "workspace", ownerId: "ws_1", updatedAt: "2026-07-18T03:00:00.000Z" }),
        rec({ id: "c", ownerLevel: "user", ownerId: "usr_1", updatedAt: "2026-07-18T02:00:00.000Z" }),
      ],
      names,
    );
    expect(rows.map((r) => r.scopeLabel)).toEqual([
      "Organization: Acme Corp",
      "Workspace",
      "Private",
    ]);
  });

  it("falls back to the bare level when the entity name is unknown", () => {
    const rows = projectStoredObjectRows(
      [
        rec({ id: "a", ownerLevel: "team", ownerId: "tm_unknown" }),
        rec({ id: "b", ownerLevel: "organization", ownerId: "org_unknown" }),
      ],
      names,
    );
    expect(rows.map((r) => r.scopeLabel)).toEqual(["Team", "Organization"]);
  });

  it("falls back the display name to the object id when title is missing/blank", () => {
    const rows = projectStoredObjectRows(
      [
        rec({ id: "obj_notitle", data: { artifactType: "@x/y:z" } }),
        rec({ id: "obj_blank", data: { artifactType: "@x/y:z", title: "   " } }),
      ],
      names,
    );
    expect(rows.find((r) => r.objectId === "obj_notitle")?.displayName).toBe("obj_notitle");
    expect(rows.find((r) => r.objectId === "obj_blank")?.displayName).toBe("obj_blank");
  });

  it("orders rows most-recently-updated first, then by object id", () => {
    const rows = projectStoredObjectRows(
      [
        rec({ id: "older", updatedAt: "2026-07-18T01:00:00.000Z" }),
        rec({ id: "newest", updatedAt: "2026-07-18T12:00:00.000Z" }),
        rec({ id: "mid", updatedAt: "2026-07-18T06:00:00.000Z" }),
      ],
      names,
    );
    expect(rows.map((r) => r.objectId)).toEqual(["newest", "mid", "older"]);
  });

  it("defaults an unknown/absent type id to 'file'", () => {
    const rows = projectStoredObjectRows([rec({ id: "a", data: { title: "x" } })], names);
    expect(rows[0].typeId).toBe("file");
  });
});
