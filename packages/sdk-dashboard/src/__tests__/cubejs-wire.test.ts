import { describe, expect, it } from "vitest";

import {
  resolveCubeIdFromQuery,
  resolveAndValidateCubeId,
  collectQueryCubeIds,
  humanizeCubeId,
  describeCrossCubeQuery,
  checkUnsupportedAnalysisType,
  checkUnsupportedQueryFeature,
  collectQueryFeatureViolations,
  findUnknownFilterMembers,
  findInvalidMetaMembers,
  queryComplexityOf,
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
  // cinatra#1512: the error arms carry human-readable copy (`userMessage`).
  // drizzle-cube's CubeClient throws `new Error(body.error)` and the portlet
  // error card renders `error.message` verbatim, so the route sends
  // `userMessage` as the wire `error` — it must read as product language, not
  // a machine code.
  it("cube_id_ambiguous userMessage names every mixed data source in product language", () => {
    const out = resolveAndValidateCubeId({
      measures: ["agent_runs.count", "teams.count", "projects.count"],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.userMessage).toBe(
        "This portlet mixes fields from Agent Runs, Teams, and Projects. " +
          "Choose fields from one data source. Edit this card to change its " +
          "fields — retrying will not fix an invalid configuration.",
      );
    }
  });
  it("cube_id_ambiguous userMessage names the offending BARE members when only one cube is qualified", () => {
    const out = resolveAndValidateCubeId({
      measures: ["agent_runs.count"],
      dimensions: ["status"],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("cube_id_ambiguous");
      expect(out.userMessage).toContain("don't belong to the Agent Runs data source (status)");
      expect(out.userMessage).not.toContain("mixes fields from");
    }
  });
  it("cube_id_required userMessage explains the missing-fields recovery", () => {
    const out = resolveAndValidateCubeId({});
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.userMessage).toContain("doesn't reference any data source fields");
      expect(out.userMessage).toContain("Edit this card");
    }
  });
});

describe("collectQueryCubeIds — distinct cube prefixes across all member surfaces", () => {
  it("collects from measures, dimensions, and segments in first-seen order", () => {
    expect(
      collectQueryCubeIds({
        measures: ["agent_runs.count", "teams.count"],
        dimensions: ["projects.name"],
        segments: ["agent_runs.completed"],
      }),
    ).toEqual(["agent_runs", "teams", "projects"]);
  });
  it("collects from timeDimensions, object order keys, and filter members", () => {
    expect(
      collectQueryCubeIds({
        timeDimensions: [{ dimension: "agent_runs.created_at" }],
        order: { "teams.count": "desc" },
        filters: [{ member: "projects.id", operator: "equals", values: ["p1"] }],
      }),
    ).toEqual(["agent_runs", "teams", "projects"]);
  });
  it("collects from the legacy tuple-array order form", () => {
    expect(
      collectQueryCubeIds({ order: [["teams.count", "desc"]] }),
    ).toEqual(["teams"]);
  });
  it("dedupes a cube referenced through several surfaces", () => {
    expect(
      collectQueryCubeIds({
        measures: ["agent_runs.count"],
        dimensions: ["agent_runs.status"],
        order: { "agent_runs.count": "desc" },
      }),
    ).toEqual(["agent_runs"]);
  });
  it("tolerates malformed shapes (non-object, bare members, junk entries)", () => {
    expect(collectQueryCubeIds(null)).toEqual([]);
    expect(collectQueryCubeIds("measures")).toEqual([]);
    expect(
      collectQueryCubeIds({
        measures: ["count", 42, null],
        filters: [null, { operator: "equals" }],
        timeDimensions: [null, {}],
        order: 7,
      }),
    ).toEqual([]);
  });
});

describe("humanizeCubeId / describeCrossCubeQuery — error copy", () => {
  it("title-cases snake_case cube ids", () => {
    expect(humanizeCubeId("agent_runs")).toBe("Agent Runs");
    expect(humanizeCubeId("teams")).toBe("Teams");
  });
  it("formats two cubes with 'and', three-plus with an Oxford comma", () => {
    expect(describeCrossCubeQuery(["agent_runs", "teams"])).toBe(
      "This portlet mixes fields from Agent Runs and Teams. Choose fields from one data source.",
    );
    expect(describeCrossCubeQuery(["agent_runs", "teams", "projects"])).toBe(
      "This portlet mixes fields from Agent Runs, Teams, and Projects. Choose fields from one data source.",
    );
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
  // cinatra#1911 — timeDimensions with granularity are now EXECUTABLE.
  it("accepts a single granularity-bearing timeDimension (with and without dateRange)", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at", granularity: "day" }],
      }),
    ).toBeNull();
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [
          { dimension: "agent_runs.created_at", granularity: "month", dateRange: "last 6 months" },
        ],
      }),
    ).toBeNull();
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [
          { dimension: "agent_runs.created_at", granularity: "week", dateRange: ["2024-01-01", "2024-01-31"] },
        ],
      }),
    ).toBeNull();
  });
  it("rejects a granularity-less timeDimension (drizzle-cube would group daily implicitly)", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at" }],
      }),
    ).toMatchObject({ code: "unsupported_query_feature" });
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at", dateRange: ["2024-01-01", "2024-01-31"] }],
      }),
    ).toMatchObject({ code: "unsupported_query_feature" });
    // Unsupported granularity value.
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at", granularity: "hour" }],
      }),
    ).toMatchObject({ code: "unsupported_query_feature" });
  });
  it("rejects multiple timeDimensions entries", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        timeDimensions: [
          { dimension: "agent_runs.created_at", granularity: "day" },
          { dimension: "agent_runs.finished_at", granularity: "day" },
        ],
      }),
    ).toMatchObject({ code: "unsupported_query_feature" });
  });
  it("rejects an invalid timeDimension dateRange shape", () => {
    for (const dateRange of ["", ["", ""], ["2024-01-01", "2024-02-01", "2024-03-01"], 7]) {
      expect(
        checkUnsupportedQueryFeature({
          measures: ["agent_runs.count"],
          timeDimensions: [
            { dimension: "agent_runs.created_at", granularity: "day", dateRange },
          ],
        } as unknown as CubeJsWireQuery),
      ).toMatchObject({ code: "unsupported_query_feature" });
    }
  });
  // cinatra#1911 — `in` and `inDateRange` filters are now EXECUTABLE.
  it("accepts `in` filters with non-empty string values", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.status", operator: "in", values: ["failed", "stopped"] }],
      } as unknown as CubeJsWireQuery),
    ).toBeNull();
  });
  it("accepts `inDateRange` filters with one relative token or a [from, to] pair", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.created_at", operator: "inDateRange", values: ["last 30 days"] }],
      } as unknown as CubeJsWireQuery),
    ).toBeNull();
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [
          { member: "agent_runs.created_at", operator: "inDateRange", values: ["2024-01-01", "2024-03-31"] },
        ],
      } as unknown as CubeJsWireQuery),
    ).toBeNull();
  });
  it("rejects `inDateRange` filters with more than two values", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [
          {
            member: "agent_runs.created_at",
            operator: "inDateRange",
            values: ["2024-01-01", "2024-02-01", "2024-03-01"],
          },
        ],
      } as unknown as CubeJsWireQuery),
    ).toMatchObject({ code: "unsupported_query_feature" });
  });
  it("rejects empty-string filter values (all operators)", () => {
    expect(
      checkUnsupportedQueryFeature({
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.status", operator: "in", values: ["ok", ""] }],
      } as unknown as CubeJsWireQuery),
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

// ─── cinatra#1911 — shared feature predicate + meta-dependent members ────

describe("collectQueryFeatureViolations (cinatra#1911)", () => {
  it("is tolerant of non-object and empty input", () => {
    expect(collectQueryFeatureViolations(undefined)).toEqual([]);
    expect(collectQueryFeatureViolations(null)).toEqual([]);
    expect(collectQueryFeatureViolations("{}")).toEqual([]);
    expect(collectQueryFeatureViolations({})).toEqual([]);
  });
  it("returns structured violations with stable kinds", () => {
    const violations = collectQueryFeatureViolations({
      filters: [
        { member: "agent_runs.status", operator: "contains", values: ["x"] },
        { or: [] },
      ],
      timeDimensions: [{ dimension: "agent_runs.created_at" }],
    });
    expect(violations.map((v) => v.kind).sort()).toEqual([
      "grouped_boolean_filters",
      "missing_or_invalid_granularity",
      "unsupported_filter_operator",
    ]);
    // Product copy names the offending member and the supported surface.
    const op = violations.find((v) => v.kind === "unsupported_filter_operator");
    expect(op?.member).toBe("agent_runs.status");
    expect(op?.message).toContain('"contains"');
    expect(op?.message).toContain("inDateRange");
  });
  it("accepts the reference-dashboard query shapes (issue #1911's six portlets)", () => {
    // timeDimensions time series, inDateRange window, in-filter breakdown —
    // the exact feature mix that used to 400 on every portlet.
    expect(
      collectQueryFeatureViolations({
        measures: ["agent_runs.count"],
        timeDimensions: [{ dimension: "agent_runs.created_at", granularity: "day", dateRange: "last 30 days" }],
      }),
    ).toEqual([]);
    expect(
      collectQueryFeatureViolations({
        measures: ["agent_runs.count"],
        dimensions: ["agent_runs.status"],
        filters: [{ member: "agent_runs.created_at", operator: "inDateRange", values: ["last 30 days"] }],
      }),
    ).toEqual([]);
    expect(
      collectQueryFeatureViolations({
        measures: ["agent_runs.count"],
        dimensions: ["agent_runs.agent_id"],
        filters: [
          { member: "agent_runs.status", operator: "in", values: ["failed", "stopped"] },
          { member: "agent_runs.created_at", operator: "inDateRange", values: ["last 30 days"] },
        ],
      }),
    ).toEqual([]);
  });
});

describe("queryComplexityOf (cinatra#1911 — shared cap arithmetic)", () => {
  it("counts measures + dimensions + timeDimensions and tolerates junk", () => {
    expect(queryComplexityOf({})).toBe(0);
    expect(queryComplexityOf(null)).toBe(0);
    expect(
      queryComplexityOf({
        measures: ["a.count"],
        dimensions: ["a.x", "a.y"],
        timeDimensions: [{ dimension: "a.t", granularity: "day" }],
      }),
    ).toBe(4);
  });
});

describe("findInvalidMetaMembers (cinatra#1911)", () => {
  const dims = [
    { id: "status", type: "string" },
    { id: "created_at", type: "date" },
  ];
  it("flags unknown filter members (all supported operators) and unknown timeDimensions", () => {
    const res = findInvalidMetaMembers(
      {
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.nope", operator: "in", values: ["x"] }],
        timeDimensions: [{ dimension: "agent_runs.missing", granularity: "day" }],
      } as unknown as CubeJsWireQuery,
      "agent_runs",
      dims,
    );
    expect(res.unknownMembers.sort()).toEqual(["agent_runs.missing", "agent_runs.nope"]);
    expect(res.nonTimeMembers).toEqual([]);
  });
  it("flags non-time-typed members for inDateRange and timeDimensions", () => {
    const res = findInvalidMetaMembers(
      {
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.status", operator: "inDateRange", values: ["last 30 days"] }],
        timeDimensions: [{ dimension: "agent_runs.status", granularity: "day" }],
      } as unknown as CubeJsWireQuery,
      "agent_runs",
      dims,
    );
    expect(res.unknownMembers).toEqual([]);
    expect(res.nonTimeMembers).toEqual(["agent_runs.status", "agent_runs.status"]);
  });
  it("accepts a valid time-typed usage", () => {
    const res = findInvalidMetaMembers(
      {
        measures: ["agent_runs.count"],
        filters: [
          { member: "agent_runs.status", operator: "equals", values: ["ok"] },
          { member: "agent_runs.created_at", operator: "inDateRange", values: ["last 30 days"] },
        ],
        timeDimensions: [{ dimension: "agent_runs.created_at", granularity: "day" }],
      } as unknown as CubeJsWireQuery,
      "agent_runs",
      dims,
    );
    expect(res.unknownMembers).toEqual([]);
    expect(res.nonTimeMembers).toEqual([]);
  });
});

describe("toQuerySpec — timeDimensions + new operators (cinatra#1911)", () => {
  it("maps timeDimensions with prefix stripping and dateRange normalization", () => {
    const spec = toQuerySpec(
      {
        measures: ["agent_runs.count"],
        timeDimensions: [
          { dimension: "agent_runs.created_at", granularity: "day", dateRange: ["last 30 days"] },
        ],
      },
      "agent_runs",
    );
    // 1-element dateRange array normalizes to the bare relative token.
    expect(spec.timeDimensions).toEqual([
      { dimension: "created_at", granularity: "day", dateRange: "last 30 days" },
    ]);
    const spec2 = toQuerySpec(
      {
        measures: ["agent_runs.count"],
        timeDimensions: [
          { dimension: "agent_runs.created_at", granularity: "week", dateRange: ["2024-01-01", "2024-03-31"] },
        ],
      },
      "agent_runs",
    );
    expect(spec2.timeDimensions).toEqual([
      { dimension: "created_at", granularity: "week", dateRange: ["2024-01-01", "2024-03-31"] },
    ]);
  });
  it("maps in / inDateRange filters preserving the operator", () => {
    const spec = toQuerySpec(
      {
        measures: ["agent_runs.count"],
        filters: [
          { member: "agent_runs.status", operator: "in", values: ["failed", "stopped"] },
          { member: "agent_runs.created_at", operator: "inDateRange", values: ["last 30 days"] },
        ],
      } as unknown as CubeJsWireQuery,
      "agent_runs",
    );
    expect(spec.filters).toEqual([
      { member: "status", operator: "in", values: ["failed", "stopped"] },
      { member: "created_at", operator: "inDateRange", values: ["last 30 days"] },
    ]);
  });
});
