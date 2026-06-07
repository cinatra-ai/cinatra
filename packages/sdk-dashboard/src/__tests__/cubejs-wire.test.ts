import { describe, expect, it } from "vitest";

import {
  resolveCubeIdFromQuery,
  resolveAndValidateCubeId,
  checkUnsupportedAnalysisType,
  checkUnsupportedQueryFeature,
  findUnknownFilterMembers,
  toQuerySpec,
  toCubeMetaCube,
  toCubeMeta,
  type CubeJsWireQuery,
} from "../cubejs-wire";
import type { CubeDescriptor } from "../types/cube";

/**
 * Cube.js wire-format conversion.
 *
 * Covers:
 *   - resolveCubeIdFromQuery: measures-only, dimensions-only,
 *     timeDimensions-only, order-only, segments-only, missing, ambiguous.
 *   - checkUnsupportedAnalysisType: funnel/flow/retention/multi-query.
 *   - checkUnsupportedQueryFeature: filters / timeDimensions.granularity.
 *   - toQuerySpec: prefix stripping + order object → tuple array.
 *   - toCubeMetaCube: Cinatra "date" → drizzle-cube "time", granularities
 *     emitted as string-literal array (NOT objects).
 */

describe("resolveCubeIdFromQuery", () => {
  it("derives from measures[0]", () => {
    expect(resolveCubeIdFromQuery({ measures: ["agent_runs.count"] })).toBe("agent_runs");
  });
  it("derives from dimensions[0] when measures absent (dimensions-only query)", () => {
    expect(resolveCubeIdFromQuery({ dimensions: ["agent_runs.status"] })).toBe("agent_runs");
  });
  it("derives from timeDimensions[0].dimension when measures+dimensions absent", () => {
    expect(
      resolveCubeIdFromQuery({
        timeDimensions: [{ dimension: "agent_runs.created_at" }],
      }),
    ).toBe("agent_runs");
  });
  it("derives from order keys when nothing else", () => {
    expect(
      resolveCubeIdFromQuery({
        order: { "agent_runs.count": "desc" },
      }),
    ).toBe("agent_runs");
  });
  it("derives from segments[0] as last resort", () => {
    expect(
      resolveCubeIdFromQuery({ segments: ["agent_runs.completed"] }),
    ).toBe("agent_runs");
  });
  it("returns null when nothing has a dot prefix", () => {
    expect(resolveCubeIdFromQuery({ measures: ["count"] })).toBeNull();
  });
  it("returns null when no member fields present at all", () => {
    expect(resolveCubeIdFromQuery({})).toBeNull();
  });
});

describe("resolveAndValidateCubeId — full validation", () => {
  it("OK when all members share the same prefix", () => {
    const out = resolveAndValidateCubeId({
      measures: ["agent_runs.count"],
      dimensions: ["agent_runs.status"],
      order: { "agent_runs.count": "desc" },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.cubeId).toBe("agent_runs");
  });
  it("returns cube_id_ambiguous when members span two cubes", () => {
    const out = resolveAndValidateCubeId({
      measures: ["agent_runs.count", "metrics_cost.total"],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("cube_id_ambiguous");
      expect(out.details.foreignMembers).toEqual(["metrics_cost.total"]);
    }
  });
  it("returns cube_id_required when no fully-qualified members", () => {
    const out = resolveAndValidateCubeId({ measures: ["count"] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("cube_id_required");
  });
  it("returns cube_id_required when query has no member fields", () => {
    const out = resolveAndValidateCubeId({});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("cube_id_required");
  });
  it("returns cube_id_ambiguous when a filter member belongs to another cube", () => {
    const out = resolveAndValidateCubeId({
      measures: ["teams.count"],
      filters: [{ member: "organizations.id", operator: "equals", values: ["o1"] }],
    } as unknown as CubeJsWireQuery);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("cube_id_ambiguous");
      expect(out.details.foreignMembers).toEqual(["organizations.id"]);
    }
  });
  it("resolves the cube id from a filters-only query", () => {
    const out = resolveAndValidateCubeId({
      filters: [{ member: "teams.id", operator: "equals", values: ["t1"] }],
    } as unknown as CubeJsWireQuery);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.cubeId).toBe("teams");
  });
});

describe("checkUnsupportedAnalysisType", () => {
  it("rejects funnel", () => {
    expect(checkUnsupportedAnalysisType({ funnel: {} } as CubeJsWireQuery)).toMatchObject({ code: "unsupported_analysis_type" });
  });
  it("rejects flow", () => {
    expect(checkUnsupportedAnalysisType({ flow: {} } as CubeJsWireQuery)).toMatchObject({ code: "unsupported_analysis_type" });
  });
  it("rejects retention", () => {
    expect(checkUnsupportedAnalysisType({ retention: {} } as CubeJsWireQuery)).toMatchObject({ code: "unsupported_analysis_type" });
  });
  it("rejects multi-query (top-level queries[])", () => {
    expect(checkUnsupportedAnalysisType({ queries: [] } as unknown as CubeJsWireQuery)).toMatchObject({ code: "unsupported_analysis_type" });
  });
  it("passes a regular single-query body", () => {
    expect(checkUnsupportedAnalysisType({ measures: ["agent_runs.count"] })).toBeNull();
  });
});

describe("checkUnsupportedQueryFeature", () => {
  it("accepts same-cube `equals` filters with non-empty string values", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.status", operator: "equals", values: ["ok"] }],
      } as unknown as CubeJsWireQuery),
    ).toBeNull();
  });
  it("rejects non-equals filter operators", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.count", operator: "gt", values: ["3"] }],
      } as unknown as CubeJsWireQuery),
    ).toMatchObject({ code: "unsupported_query_feature" });
  });
  it("rejects grouped and/or filters", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ or: [{ member: "agent_runs.status", operator: "equals", values: ["ok"] }] }],
      } as unknown as CubeJsWireQuery),
    ).toMatchObject({ code: "unsupported_query_feature" });
  });
  it("rejects equals filters with empty or non-string values", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.status", operator: "equals", values: [] }],
      } as unknown as CubeJsWireQuery),
    ).toMatchObject({ code: "unsupported_query_feature" });
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.status", operator: "equals", values: [1] }],
      } as unknown as CubeJsWireQuery),
    ).toMatchObject({ code: "unsupported_query_feature" });
  });
  it("rejects timeDimensions entirely", () => {
    // Granularity case.
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at", granularity: "day" }],
      }),
    ).toMatchObject({ code: "unsupported_query_feature" });
    // Bare time dimensions without granularity or dateRange must be rejected
    // because toQuerySpec does not carry timeDimensions forward.
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at" }],
      }),
    ).toMatchObject({ code: "unsupported_query_feature" });
    // dateRange / fillMissingDates also silently dropped — same fix.
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at", dateRange: ["2024-01-01", "2024-01-31"] }],
      }),
    ).toMatchObject({ code: "unsupported_query_feature" });
  });
  it("accepts a query with an empty timeDimensions array (defensive)", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [],
      }),
    ).toBeNull();
  });
  it("passes a regular query without filters", () => {
    expect(checkUnsupportedQueryFeature({ measures: ["agent_runs.count"] })).toBeNull();
  });
});

describe("toQuerySpec — Cube.js wire → Cinatra DTO", () => {
  it("strips <cube>. prefix from measures and dimensions", () => {
    const spec = toQuerySpec(
      {
        measures: ["agent_runs.count"],
        dimensions: ["agent_runs.status", "agent_runs.agent_id"],
        limit: 10,
      },
      "agent_runs",
    );
    expect(spec.measures).toEqual(["count"]);
    expect(spec.dimensions).toEqual(["status", "agent_id"]);
    expect(spec.limit).toBe(10);
  });
  it("converts order object to tuple array", () => {
    const spec = toQuerySpec(
      {
        measures: ["agent_runs.count"],
        order: { "agent_runs.count": "desc", "agent_runs.status": "asc" },
      },
      "agent_runs",
    );
    expect(spec.order).toEqual([
      ["count", "desc"],
      ["status", "asc"],
    ]);
  });
  it("omits empty arrays from the output spec", () => {
    const spec = toQuerySpec(
      { measures: ["agent_runs.count"] },
      "agent_runs",
    );
    expect(spec.dimensions).toBeUndefined();
    expect(spec.order).toBeUndefined();
    expect(spec.filters).toBeUndefined();
  });
  it("maps same-cube equals filters and strips the <cube>. prefix", () => {
    const spec = toQuerySpec(
      {
        measures: ["teams.member_count"],
        dimensions: ["teams.name"],
        filters: [{ member: "teams.id", operator: "equals", values: ["t1"] }],
      } as unknown as CubeJsWireQuery,
      "teams",
    );
    expect(spec.filters).toEqual([
      { member: "id", operator: "equals", values: ["t1"] },
    ]);
  });
});

describe("toCubeMetaCube — Cinatra descriptor → drizzle-cube CubeMeta", () => {
  const descriptor: CubeDescriptor = {
    id: "agent_runs",
    version: "1.0.0",
    displayName: "Agent Runs",
    description: "Test fixture",
    dimensions: [
      { id: "agent_id", displayName: "Agent ID", type: "string" },
      { id: "status", displayName: "Status", type: "string" },
      { id: "created_at", displayName: "Created at", type: "date" },
    ],
    measures: [
      { id: "count", displayName: "Run count", type: "count" },
      { id: "last_run_at", displayName: "Last run at", type: "max" },
    ],
  };

  it("emits fully-qualified <cube>.<member> names", () => {
    const out = toCubeMetaCube(descriptor);
    expect(out.measures.map((m) => m.name)).toEqual([
      "agent_runs.count",
      "agent_runs.last_run_at",
    ]);
    expect(out.dimensions.map((d) => d.name)).toEqual([
      "agent_runs.agent_id",
      "agent_runs.status",
      "agent_runs.created_at",
    ]);
  });

  it("maps Cinatra dimension type 'date' to drizzle-cube 'time'", () => {
    const out = toCubeMetaCube(descriptor);
    const createdAt = out.dimensions.find((d) => d.name === "agent_runs.created_at");
    expect(createdAt?.type).toBe("time");
    // Non-time dimensions keep their type.
    expect(out.dimensions.find((d) => d.name === "agent_runs.status")?.type).toBe("string");
  });

  it("emits granularities as TimeGranularity[] string literals, NOT objects", () => {
    const out = toCubeMetaCube(descriptor);
    const createdAt = out.dimensions.find((d) => d.name === "agent_runs.created_at");
    expect(createdAt?.granularities).toEqual(["day", "week", "month"]);
    // Negative — must NOT be {name: ...} objects.
    expect(createdAt?.granularities?.[0]).toBe("day");
    expect(typeof createdAt?.granularities?.[0]).toBe("string");
  });

  it("emits empty segments[] for shape parity", () => {
    expect(toCubeMetaCube(descriptor).segments).toEqual([]);
  });

  it("toCubeMeta wraps multiple descriptors in { cubes: [] }", () => {
    const meta = toCubeMeta([descriptor]);
    expect(meta.cubes).toHaveLength(1);
    expect(meta.cubes[0].name).toBe("agent_runs");
  });
});

describe("findUnknownFilterMembers — fail-closed member validation", () => {
  const known = new Set(["id", "name", "member_count"]);

  it("returns [] when every filter member is a known cube member", () => {
    expect(
      findUnknownFilterMembers(
        { filters: [{ member: "teams.id", operator: "equals", values: ["t1"] }] } as unknown as CubeJsWireQuery,
        "teams",
        known,
      ),
    ).toEqual([]);
  });

  it("flags an unknown same-cube member (drizzle-cube would silently drop it)", () => {
    expect(
      findUnknownFilterMembers(
        { filters: [{ member: "teams.no_such", operator: "equals", values: ["x"] }] } as unknown as CubeJsWireQuery,
        "teams",
        known,
      ),
    ).toEqual(["teams.no_such"]);
  });

  it("flags an empty suffix (teams.) and a deep suffix (teams.id.extra)", () => {
    expect(
      findUnknownFilterMembers(
        {
          filters: [
            { member: "teams.", operator: "equals", values: ["x"] },
            { member: "teams.id.extra", operator: "equals", values: ["x"] },
          ],
        } as unknown as CubeJsWireQuery,
        "teams",
        known,
      ),
    ).toEqual(["teams.", "teams.id.extra"]);
  });

  it("flags a foreign-cube filter member", () => {
    expect(
      findUnknownFilterMembers(
        { filters: [{ member: "organizations.id", operator: "equals", values: ["o1"] }] } as unknown as CubeJsWireQuery,
        "teams",
        known,
      ),
    ).toEqual(["organizations.id"]);
  });

  it("flags a measure-member filter when the known set is dimensions-only", () => {
    // The cubejs route validates filter members against the cube's DIMENSIONS
    // only — measures are excluded because drizzle-cube silently drops a
    // measure filter in WHERE context (it would fail to narrow → widen). So a
    // measure-member filter must be rejected (fail-closed), not silently passed.
    const dimensionsOnly = new Set(["id", "name"]); // member_count (a measure) excluded
    expect(
      findUnknownFilterMembers(
        { filters: [{ member: "teams.member_count", operator: "equals", values: ["5"] }] } as unknown as CubeJsWireQuery,
        "teams",
        dimensionsOnly,
      ),
    ).toEqual(["teams.member_count"]);
  });
});
