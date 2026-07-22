// cinatra#1911 — QuerySpec → drizzle-cube SemanticQuery translation: the new
// `in` / `inDateRange` filters and granularity-bearing timeDimensions must
// reach drizzle-cube re-prefixed and shape-intact (drizzle-cube owns the SQL;
// the adapter only maps). Captured through `_buildAdapterFromLayer` with a
// stub layer because `toSemanticQuery` is module-private.

import { describe, expect, it } from "vitest";

import { _buildAdapterFromLayer } from "../adapters/drizzle-cube/create-adapter";
import type { RegisteredCube } from "../adapters/drizzle-cube/types";
import type { SecurityContext } from "../types/index";

const CTX: SecurityContext = {
  userId: "u1",
  organizationId: "o1",
} as SecurityContext;

function capture() {
  const calls: Array<{ cubeId: string; semanticQuery: Record<string, unknown> }> = [];
  const layer = {
    executeQuery: async (cubeId: string, semanticQuery: Record<string, unknown>) => {
      calls.push({ cubeId, semanticQuery });
      return { data: [] };
    },
  };
  const cube = {
    descriptor: {
      id: "agent_runs",
      displayName: "Agent Runs",
      measures: [],
      dimensions: [],
    },
    dcCube: {},
  } as unknown as RegisteredCube;
  const adapter = _buildAdapterFromLayer(
    layer as unknown as Parameters<typeof _buildAdapterFromLayer>[0],
    [cube],
  );
  return { adapter, calls };
}

describe("toSemanticQuery via executeQuery (cinatra#1911)", () => {
  it("re-prefixes and passes through in / inDateRange filters", async () => {
    const { adapter, calls } = capture();
    await adapter.executeQuery(
      "agent_runs",
      {
        measures: ["count"],
        filters: [
          { member: "status", operator: "in", values: ["failed", "stopped"] },
          { member: "created_at", operator: "inDateRange", values: ["last 30 days"] },
        ],
      },
      CTX,
    );
    expect(calls[0].semanticQuery.filters).toEqual([
      { member: "agent_runs.status", operator: "in", values: ["failed", "stopped"] },
      { member: "agent_runs.created_at", operator: "inDateRange", values: ["last 30 days"] },
    ]);
  });

  it("re-prefixes timeDimensions and preserves granularity + dateRange forms", async () => {
    const { adapter, calls } = capture();
    await adapter.executeQuery(
      "agent_runs",
      {
        measures: ["count"],
        timeDimensions: [{ dimension: "created_at", granularity: "day", dateRange: "last 30 days" }],
      },
      CTX,
    );
    expect(calls[0].semanticQuery.timeDimensions).toEqual([
      { dimension: "agent_runs.created_at", granularity: "day", dateRange: "last 30 days" },
    ]);

    await adapter.executeQuery(
      "agent_runs",
      {
        measures: ["count"],
        timeDimensions: [
          { dimension: "created_at", granularity: "month", dateRange: ["2024-01-01", "2024-03-31"] },
        ],
      },
      CTX,
    );
    expect(calls[1].semanticQuery.timeDimensions).toEqual([
      { dimension: "agent_runs.created_at", granularity: "month", dateRange: ["2024-01-01", "2024-03-31"] },
    ]);
  });

  it("omits timeDimensions entirely when the spec carries none (no shape drift)", async () => {
    const { adapter, calls } = capture();
    await adapter.executeQuery("agent_runs", { measures: ["count"] }, CTX);
    expect("timeDimensions" in calls[0].semanticQuery).toBe(false);
    expect("filters" in calls[0].semanticQuery).toBe(false);
  });
});
