import { describe, it, expect } from "vitest";

import {
  projectStoredObjectRows,
  type ScopeNameResolver,
} from "../stored-objects-inventory";

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
