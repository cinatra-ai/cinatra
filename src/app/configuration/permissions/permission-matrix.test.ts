/**
 * Tests for the permission-matrix helper.
 *
 * Run with:
 *   pnpm exec vitest run src/app/configuration/permissions/permission-matrix.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  buildPermissionMatrix,
  ROLES_IN_ORDER,
  CATEGORIES_IN_ORDER,
} from "./permission-matrix";

describe("buildPermissionMatrix", () => {
  it("Test 1: returns one row per role in ROLES_IN_ORDER order", () => {
    const rows = buildPermissionMatrix();
    expect(rows).toHaveLength(ROLES_IN_ORDER.length);
    rows.forEach((row, index) => {
      expect(row.role).toBe(ROLES_IN_ORDER[index]);
    });
  });

  it("Test 2: platform_admin has visible rights in every category", () => {
    const rows = buildPermissionMatrix();
    const adminRow = rows.find((r) => r.role === "platform_admin");
    expect(adminRow).toBeDefined();
    for (const category of CATEGORIES_IN_ORDER) {
      expect(adminRow!.cells[category]).not.toBe("none");
    }
  });

  it("Test 3: member has at least 'partial' for agents", () => {
    const rows = buildPermissionMatrix();
    const memberRow = rows.find((r) => r.role === "member");
    expect(memberRow).toBeDefined();
    expect(["partial", "full"]).toContain(memberRow!.cells.agents);
  });

  it("Test 4: a role missing all perms in a category gets 'none'", () => {
    // The registry category is defined as [registry.install, registry.update,
    // registry.uninstall] — management-only perms. member and team_admin only
    // hold registry.read (not in the category list) → they get "none" for registry.
    // This verifies the computeCellState "none" branch fires with real policy data.
    const rows = buildPermissionMatrix();
    const memberRow = rows.find((r) => r.role === "member");
    expect(memberRow).toBeDefined();
    expect(memberRow!.cells.registry).toBe("none");

    // All cells must be valid states — the union is exhaustive.
    for (const row of rows) {
      for (const category of CATEGORIES_IN_ORDER) {
        expect(["full", "partial", "none"]).toContain(row.cells[category]);
      }
    }

    // Verify at least one "none" cell exists (code path reachability).
    const allCells = rows.flatMap((r) => Object.values(r.cells));
    expect(allCells).toContain("none");
  });

  it("Test 5: no .has() call — regression guard (source is .includes() only)", () => {
    // This test guards against accidental use of Set.prototype.has() on a
    // ReadonlyArray (which doesn't have .has()). We verify the module source
    // doesn't contain '.has(' by importing and calling successfully; if .has()
    // were used, TypeScript would catch it, but we double-check at runtime.
    // The matrix should build without throwing a "is not a function" TypeError.
    expect(() => buildPermissionMatrix()).not.toThrow();

    // Verify platform_admin cells are computed — would fail if .has() were used
    // on the ReadonlyArray returned by EFFECTIVE_GRANTS.
    const rows = buildPermissionMatrix();
    expect(rows[0].role).toBe("platform_admin");
    expect(rows[0].cells.agents).not.toBe("none");
  });

  it("Test 6: CATEGORIES_IN_ORDER surfaces every human-facing permission family", () => {
    expect(CATEGORIES_IN_ORDER).toEqual([
      "agents",
      "objects",
      "projects",
      "teams",
      "organizations",
      "skills",
      "connectors",
      "registry",
      "administration",
    ]);
  });

  it("Test 7: agent display rights group definition and run rights under one business area", () => {
    const rows = buildPermissionMatrix();
    const adminRow = rows.find((r) => r.role === "platform_admin");
    expect(adminRow).toBeDefined();

    const agentLabels = adminRow!.displayRights.agents.map((right) => right.label);
    expect(agentLabels.filter((label) => label === "View")).toHaveLength(1);
    expect(agentLabels.filter((label) => label === "List")).toHaveLength(1);
    expect(agentLabels.filter((label) => label === "Edit")).toHaveLength(1);
    expect(agentLabels.filter((label) => label === "Share")).toHaveLength(1);

    expect(adminRow!.displayRights.agents.find((right) => right.key === "view")?.permissions).toEqual([
      "agent.read",
      "run.read",
    ]);
    expect(adminRow!.displayRights.agents.find((right) => right.key === "list")?.permissions).toEqual([
      "agent.list",
      "run.list",
    ]);
  });
});
