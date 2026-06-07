// MCP DTO filter tests.
//
// Verify the DTO carve-out behavior by IMPORTING the actual production helpers
// from mcp/handlers.ts.

import { describe, it, expect } from "vitest";
import { ALLOWED_METADATA_KEYS, pickPublicMetadata, toPublicTaskDto } from "../mcp/handlers";

describe("pickPublicMetadata", () => {
  it("returns {} for null / undefined / non-object metadata", () => {
    expect(pickPublicMetadata(null)).toEqual({});
    expect(pickPublicMetadata(undefined)).toEqual({});
    // typing escape so we can test runtime defensive path
    expect(pickPublicMetadata("oops" as unknown as Record<string, unknown>)).toEqual({});
  });

  it("exposes the 3 allowed metadata keys when present", () => {
    expect(
      pickPublicMetadata({
        foreach_has_failure: true,
        foreach_has_success: true,
        foreach_materialization_error: "foreach_invalid_source_output",
      }),
    ).toEqual({
      foreach_has_failure: true,
      foreach_has_success: true,
      foreach_materialization_error: "foreach_invalid_source_output",
    });
  });

  it("OMITS any metadata key NOT in the allow-list", () => {
    const out = pickPublicMetadata({
      foreach_has_failure: true,
      _internal_debug: "secret",
      foreach_internal_replay_count: 7,
      foreach_has_success: false,
    });
    expect(out).toEqual({
      foreach_has_failure: true,
      foreach_has_success: false,
    });
    expect(out._internal_debug).toBeUndefined();
    expect(out.foreach_internal_replay_count).toBeUndefined();
  });

  it("ALLOWED_METADATA_KEYS is exactly the 3 foreach keys", () => {
    expect([...ALLOWED_METADATA_KEYS].sort()).toEqual([
      "foreach_has_failure",
      "foreach_has_success",
      "foreach_materialization_error",
    ]);
  });
});

describe("toPublicTaskDto", () => {
  // Minimal row shape matching workflow_task fields used by the DTO. We don't
  // import drizzle's $inferSelect to keep this a pure unit test; the DTO
  // builder is structural / pick-only and doesn't depend on the row's full
  // type.
  const baseRow = {
    id: "wtask_t1",
    key: "draft",
    type: "agent_task",
    title: "Draft",
    status: "running",
    parentTaskId: "wtask_parent_foreach",
    plannedStartUtc: null,
    plannedEndUtc: null,
    actualStartUtc: null,
    actualEndUtc: null,
    dueAtUtc: null,
    required: true,
    failurePolicy: null,
    missedWindowPolicy: null,
    pinned: false,
    risk: null,
    agentPackage: null,
    agentRef: null,
    input: null,
    schedule: null,
    anchor: null,
    metadata: null as Record<string, unknown> | null,
  };

  it("omits foreachConfig entirely (never exposed via MCP)", () => {
    // Build a row that carries a foreachConfig — the DTO should not include it.
    const row = { ...baseRow, foreachConfig: { source: "ideas", as: "idea", template: {} } };
    const dto = toPublicTaskDto(row as typeof baseRow);
    expect(Object.keys(dto)).not.toContain("foreachConfig");
  });

  it("filters metadata to the 3 allowed keys", () => {
    const row = {
      ...baseRow,
      metadata: {
        foreach_has_failure: true,
        foreach_has_success: false,
        foreach_materialization_error: "foreach_max_fanout_exceeded",
        leaked_internal: "should-not-appear",
      },
    };
    const dto = toPublicTaskDto(row);
    expect(dto.metadata).toEqual({
      foreach_has_failure: true,
      foreach_has_success: false,
      foreach_materialization_error: "foreach_max_fanout_exceeded",
    });
    expect((dto.metadata as Record<string, unknown>).leaked_internal).toBeUndefined();
  });

  it("emits an empty metadata object when row.metadata is null", () => {
    const dto = toPublicTaskDto(baseRow);
    expect(dto.metadata).toEqual({});
  });
});
