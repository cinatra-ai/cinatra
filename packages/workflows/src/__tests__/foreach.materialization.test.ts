// Foreach materializer unit tests.
//
// Covers: happy path, itemKey slug edge cases (empty, emoji, long, duplicate),
// index fallback, max-fanout overflow (declared + hard ceiling), variable
// substitution, deterministic IDs/keys, parent_task_id correctness,
// approval sidecar, dependency resolution + unresolved-ref error.

import { describe, it, expect } from "vitest";
import {
  materializeForeachChildren,
  deterministicChildTaskId,
  isForeachError,
  type ForeachConfig,
} from "../engine/foreach";

const PARENT = { id: "wtask_parent_abc", key: "drafts" };
const WORKFLOW_ID = "wf_test_123";
const EMPTY_KEY_MAP = new Map<string, string>();

function configFor(overrides: Partial<ForeachConfig> = {}): ForeachConfig {
  return {
    source: "ideas",
    as: "idea",
    itemKey: null,
    template: {
      key: "draft_template",
      type: "agent_task",
      title: "Write draft for {{idea.title}}",
      agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
      input: { idea: "{{idea}}", position: "{{$position}}", total: "{{$total}}" },
    },
    rollupPolicy: "any_fails",
    ...overrides,
  };
}

describe("materializeForeachChildren — happy paths", () => {
  it("returns 0 plans for empty items array (zero-child case)", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor(),
      sourceOutput: { items: [] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    expect(isForeachError(result)).toBe(false);
    if (isForeachError(result)) return;
    expect(result.plans).toHaveLength(0);
    expect(result.parentTaskId).toBe(PARENT.id);
    expect(result.parentKey).toBe(PARENT.key);
  });

  it("materializes one child per item with deterministic ID + key + parent_task_id", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor(),
      sourceOutput: { items: [{ title: "AI for ops" }, { title: "MCP servers" }] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    if (isForeachError(result)) throw new Error("expected success");

    expect(result.plans).toHaveLength(2);
    const [a, b] = result.plans;
    expect(a.taskRow.key).toBe("drafts__0000");
    expect(b.taskRow.key).toBe("drafts__0001");
    expect(a.taskRow.id).toBe(deterministicChildTaskId(WORKFLOW_ID, PARENT.key, "0000"));
    expect(b.taskRow.id).toBe(deterministicChildTaskId(WORKFLOW_ID, PARENT.key, "0001"));
    // Every child sets parent_task_id explicitly (load-bearing for the hierarchy).
    expect(a.taskRow.parentTaskId).toBe(PARENT.id);
    expect(b.taskRow.parentTaskId).toBe(PARENT.id);
    // foreachConfig = NULL always (no nested foreach).
    expect(a.taskRow.foreachConfig).toBeNull();
    expect(b.taskRow.foreachConfig).toBeNull();
  });

  it("is deterministic — two runs over the same input produce byte-identical row IDs, keys, AND sidecar IDs", () => {
    const map = new Map([["kickoff", "wtask_kickoff_id"]]);
    const input = {
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({
        template: {
          type: "approval",
          key: "approve_template",
          title: "Approve {{idea.title}}",
          requiredScope: { level: "organization" },
          dependsOn: [{ taskKey: "kickoff", outcome: "success" }],
        },
      }),
      sourceOutput: { items: [{ title: "x" }, { title: "y" }, { title: "z" }] },
      workflowTaskIdByKey: map,
    };
    const a = materializeForeachChildren(input);
    const b = materializeForeachChildren(input);
    if (isForeachError(a) || isForeachError(b)) throw new Error("unexpected error");
    // Task IDs + keys deterministic.
    expect(a.plans.map((p) => p.taskRow.id)).toEqual(b.plans.map((p) => p.taskRow.id));
    expect(a.plans.map((p) => p.taskRow.key)).toEqual(b.plans.map((p) => p.taskRow.key));
    // Sidecar IDs deterministic too.
    expect(a.plans.map((p) => p.dependencies.map((d) => d.id)))
      .toEqual(b.plans.map((p) => p.dependencies.map((d) => d.id)));
    expect(a.plans.map((p) => p.approval?.id ?? null))
      .toEqual(b.plans.map((p) => p.approval?.id ?? null));
  });

  it("substitutes variable bindings: whole token returns raw value; partial returns string", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({
        itemKey: "id",
        template: {
          type: "agent_task",
          key: "draft_template",
          title: "Draft #{{$position}} of {{$total}}: {{idea.title}}",
          agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
          input: { idea: "{{idea}}", topic: "{{idea.topic}}", index: "{{$index}}" },
        },
      }),
      sourceOutput: {
        items: [
          { id: "first-id", title: "A", topic: { name: "ops" } },
          { id: "second-id", title: "B", topic: { name: "mcp" } },
        ],
      },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    if (isForeachError(result)) throw new Error("expected success");
    expect(result.plans[0].taskRow.title).toBe("Draft #1 of 2: A");
    // Whole token resolution returns the raw object (not stringified).
    expect(result.plans[0].taskRow.input).toEqual({
      idea: { id: "first-id", title: "A", topic: { name: "ops" } },
      topic: { name: "ops" },
      index: 0,
    });
    expect(result.plans[1].taskRow.title).toBe("Draft #2 of 2: B");
  });
});

describe("materializeForeachChildren — error paths", () => {
  it("rejects invalid source-output shape", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor(),
      sourceOutput: { wrongKey: [] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    expect(isForeachError(result) && result.code).toBe("foreach_invalid_source_output");
  });

  it("rejects empty-slugify itemKey (emoji-only)", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({ itemKey: "name" }),
      sourceOutput: { items: [{ name: "🚀🎉" }] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    expect(isForeachError(result) && result.code).toBe("foreach_invalid_item_key");
  });

  it("rejects duplicate stableId", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({ itemKey: "name" }),
      sourceOutput: { items: [{ name: "alpha" }, { name: "alpha" }] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    expect(isForeachError(result) && result.code).toBe("foreach_duplicate_item_key");
  });

  it("truncates long itemKey with __hash suffix (still unique)", () => {
    const longA = "a".repeat(40) + "_one";
    const longB = "a".repeat(40) + "_two";
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({ itemKey: "name" }),
      sourceOutput: { items: [{ name: longA }, { name: longB }] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    if (isForeachError(result)) throw new Error("expected success");
    expect(result.plans[0].taskRow.key).not.toEqual(result.plans[1].taskRow.key);
    // Both stableIds keep the 32-char total limit (with __<4 hex>).
    const stableA = result.plans[0].taskRow.key.split("__").slice(1).join("__");
    expect(stableA.length).toBeLessThanOrEqual(32);
  });

  it("rejects exceeding declared maxFanout", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}` }));
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({ maxFanout: 5 }),
      sourceOutput: { items },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    expect(isForeachError(result) && result.code).toBe("foreach_max_fanout_exceeded");
  });

  it("rejects unresolved sibling dependency", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({
        template: {
          type: "agent_task",
          key: "draft_template",
          title: "Draft",
          agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
          dependsOn: [{ taskKey: "nope_does_not_exist" }],
        },
      }),
      sourceOutput: { items: [{ id: "x" }] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    expect(isForeachError(result) && result.code).toBe("foreach_unresolved_dependency");
  });

  it("resolves dependsOn against the workflow-global key map", () => {
    const map = new Map([["kickoff", "wtask_kickoff_id"]]);
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({
        template: {
          type: "agent_task",
          key: "draft_template",
          title: "Draft",
          agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
          dependsOn: [{ taskKey: "kickoff", outcome: "success" }],
        },
      }),
      sourceOutput: { items: [{ id: "x" }] },
      workflowTaskIdByKey: map,
    });
    if (isForeachError(result)) throw new Error("expected success");
    expect(result.plans[0].dependencies).toHaveLength(1);
    expect(result.plans[0].dependencies[0].dependsOnTaskKey).toBe("kickoff");
  });
});

describe("materializeForeachChildren — approval sidecar", () => {
  it("emits a workflow_approval row for approval templates", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor({
        template: {
          type: "approval",
          key: "approve_template",
          title: "Approve {{idea.title}}",
          requiredScope: { level: "organization" },
        },
      }),
      sourceOutput: { items: [{ title: "X" }] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    if (isForeachError(result)) throw new Error("expected success");
    expect(result.plans[0].approval).not.toBeNull();
    expect(result.plans[0].approval?.status).toBe("pending");
    expect(result.plans[0].approval?.requiredScope).toEqual({ level: "organization" });
  });

  it("emits null approval for non-approval templates", () => {
    const result = materializeForeachChildren({
      workflowId: WORKFLOW_ID,
      parent: PARENT,
      foreachConfig: configFor(),
      sourceOutput: { items: [{ id: "x" }] },
      workflowTaskIdByKey: EMPTY_KEY_MAP,
    });
    if (isForeachError(result)) throw new Error("expected success");
    expect(result.plans[0].approval).toBeNull();
  });
});
