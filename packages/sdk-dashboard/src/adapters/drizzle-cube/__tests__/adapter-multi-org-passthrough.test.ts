/**
 * Regression coverage: prove the HTTP cubejs `AdapterHandle.executeQuery()`
 * path propagates `accessibleOrgIds` through `toDcSecurityContext` (the
 * layer-widening helper) into drizzle-cube's SecurityContext, so the cube's SQL
 * function sees the full multi-org set.
 *
 * A direct `layer.generateSQL` test with a hand-built drizzle-cube
 * SecurityContext that already includes `accessibleOrgIds` bypasses the adapter
 * mapping where this class of bug lives.
 *
 * Strategy: intercept the drizzle-cube `executeQuery` call by wrapping a stub
 * `SemanticLayerCompiler`. Assert the SecurityContext the cube receives carries
 * our `accessibleOrgIds` verbatim.
 */
import { describe, it, expect } from "vitest";
import { _buildAdapterFromLayer } from "../create-adapter";
import type { RegisteredCube } from "../types";

describe("_buildAdapterFromLayer accessibleOrgIds passthrough", () => {
  it("propagates accessibleOrgIds into drizzle-cube SecurityContext on executeQuery", async () => {
    const captured: Array<{ cubeName: string; ctx: Record<string, unknown> }> = [];
    const stubLayer = {
      executeQuery: async (cubeName: string, _query: unknown, ctx: Record<string, unknown>) => {
        captured.push({ cubeName, ctx });
        return { data: [], annotation: {}, query: {} };
      },
    } as unknown as Parameters<typeof _buildAdapterFromLayer>[0];

    const fakeCube = {
      descriptor: { id: "agent_runs", version: "1.0.0", displayName: "Agent Runs", dimensions: [], measures: [] },
      dcCube: { name: "agent_runs" },
    } as unknown as RegisteredCube;

    const adapter = _buildAdapterFromLayer(stubLayer, [fakeCube]);

    await adapter.executeQuery(
      "agent_runs",
      { measures: ["count"] },
      {
        userId: "user-1",
        organizationId: "org-active",
        workspaceId: "",
        teamIds: [],
        ownerLevel: "organization",
        accessibleOrgIds: ["org-active", "org-second", "org-third"],
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].cubeName).toBe("agent_runs");
    // `toDcSecurityContext` must preserve `accessibleOrgIds`; stripping it
    // would drop multi-org visibility for cube queries.
    expect(captured[0].ctx.accessibleOrgIds).toEqual(["org-active", "org-second", "org-third"]);
    expect(captured[0].ctx.organizationId).toBe("org-active");
    expect(captured[0].ctx.userId).toBe("user-1");
  });
});

describe("_buildAdapterFromLayer filter prefixing", () => {
  it("re-prefixes same-cube equals filters into <cube>.<member> for SemanticQuery", async () => {
    const captured: Array<{ query: Record<string, unknown> }> = [];
    const stubLayer = {
      executeQuery: async (
        _cubeName: string,
        query: Record<string, unknown>,
      ) => {
        captured.push({ query });
        return { data: [], annotation: {}, query: {} };
      },
    } as unknown as Parameters<typeof _buildAdapterFromLayer>[0];

    const fakeCube = {
      descriptor: { id: "teams", version: "1.0.0", displayName: "Teams", dimensions: [], measures: [] },
      dcCube: { name: "teams" },
    } as unknown as RegisteredCube;

    const adapter = _buildAdapterFromLayer(stubLayer, [fakeCube]);

    await adapter.executeQuery(
      "teams",
      {
        measures: ["member_count"],
        dimensions: ["name"],
        filters: [{ member: "id", operator: "equals", values: ["t1"] }],
      },
      {
        userId: "u1",
        organizationId: "org",
        workspaceId: "",
        teamIds: [],
        ownerLevel: "organization",
        accessibleOrgIds: ["org"],
      },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].query.filters).toEqual([
      { member: "teams.id", operator: "equals", values: ["t1"] },
    ]);
    expect(captured[0].query.measures).toEqual(["teams.member_count"]);
    expect(captured[0].query.dimensions).toEqual(["teams.name"]);
  });
});
