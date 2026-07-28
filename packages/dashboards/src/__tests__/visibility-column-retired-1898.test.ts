// ACL cutover Phase-3 (cinatra#1898, epic #1883 §D7) — pins the RETIREMENT of
// the dashboard-local `{private, owners, members}` visibility vocabulary and its
// column, so a later change cannot quietly resurrect a second ACL beside the
// canonical scope mapping.
//
// What this asserts, at the three surfaces the column used to reach:
//   1. the store SHAPE — `dashboards` carries no `visibility` column and the
//      module exports no visibility vocabulary;
//   2. the MCP TOOL SCHEMAS — list/create/update neither expose nor honor a
//      `visibility` field (a caller that still sends one is ignored, not
//      obeyed: the zod objects are non-strict, so the key is stripped);
//   3. the WRITE INPUTS — the mutation-service create/update/upsert/entity
//      inputs carry no visibility field (a compile-time property, pinned here
//      as executable text so the retirement survives a refactor).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dashboards } from "../store/schema";
import * as schemaModule from "../store/schema";
import {
  dashboardsListSchema,
  dashboardsCreateSchema,
  dashboardsUpdateSchema,
} from "../mcp/schemas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

describe("cinatra#1898 Phase-3 — the dashboard-local visibility axis is retired", () => {
  it("the `dashboards` table shape carries NO visibility column", () => {
    const columns = Object.keys(dashboards);
    expect(columns).not.toContain("visibility");
    // The SCOPE axis is untouched — it is what the canonical ACL reads.
    expect(columns).toEqual(expect.arrayContaining(["ownerLevel", "ownerId", "projectId", "organizationId"]));
  });

  it("the store module exports NO visibility vocabulary", () => {
    expect(schemaModule).not.toHaveProperty("VISIBILITIES");
    // OWNER_LEVELS stays: the owner tier is the surviving share axis.
    expect(schemaModule.OWNER_LEVELS).toEqual(["user", "team", "organization", "workspace"]);
  });

  it("the MCP list tool neither exposes nor honors a visibility filter", () => {
    expect(Object.keys(dashboardsListSchema.shape)).not.toContain("visibility");
    // A stale caller still sending it is IGNORED (stripped), never obeyed.
    const parsed = dashboardsListSchema.parse({ ownerLevel: "team", ownerId: "t1", visibility: "members" });
    expect(parsed).not.toHaveProperty("visibility");
    expect(parsed.ownerLevel).toBe("team");
  });

  it("the MCP create/update tools neither expose nor honor a visibility field", () => {
    expect(Object.keys(dashboardsCreateSchema.shape)).not.toContain("visibility");
    expect(Object.keys(dashboardsUpdateSchema.shape)).not.toContain("visibility");
    const created = dashboardsCreateSchema.parse({
      name: "D",
      config: { portlets: [] },
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "owners",
    });
    expect(created).not.toHaveProperty("visibility");
    const updated = dashboardsUpdateSchema.parse({ dashboardId: "d1", name: "D2", visibility: "private" });
    expect(updated).not.toHaveProperty("visibility");
  });

  it("no dashboards source module reads or writes a dashboard `visibility` column", () => {
    // Executable form of the retirement: the modules that used to carry the axis
    // must not name it again — as a WRITTEN field (`visibility:` / `visibility,`
    // in an object literal or a type), as a READ off a row/input
    // (`row.visibility`, `input.visibility`, `patch.visibility`, `existing?.visibility`,
    // `t.visibility`), or as a drizzle column reference (`dashboards.visibility`).
    // Comments that DOCUMENT the retirement are fine — the scan strips them.
    const FORBIDDEN: [RegExp, string][] = [
      [/(^|[^.\w])visibility\s*[:,?]/m, "must not declare/assign a visibility field"],
      [/\b\w+\??\.visibility\b/, "must not read a visibility field off a row/input"],
      [/\bVISIBILITIES\b|\bVisibility\b(?!Resolvers)/, "must not use the retired visibility vocabulary"],
    ];
    for (const rel of ["mutation-service.ts", "mcp/handlers.ts", "mcp/schemas.ts", "store/schema.ts", "permissions.ts", "actions.ts"]) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      const codeOnly = text
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      for (const [pattern, why] of FORBIDDEN) {
        expect(codeOnly, `${rel} ${why}`).not.toMatch(pattern);
      }
    }
  });
});
