/**
 * Regression gate — array-typed StartNode inputs MUST carry `items` in the
 * resolved input schema, whether the OAS uses the agentspec 26.1.0
 * convention `{type:"array", json_schema:{items:{...}}}` OR the flat
 * `{type:"array", items:{...}}` shape.
 *
 * Without the fallback, an array input gets resolved as `{type:"array"}`
 * with no `items`. The chat's explicit-dispatch LLM-extraction pre-router
 * then builds an OpenAI `response_format` schema with that shape, OpenAI
 * rejects it with `400 array schema missing items`, the catch returns
 * `"{}"`, and the agent run dispatches with empty inputParams — the bug
 * observed live in the autonomous chat campaign (Apollo prospecting agent,
 * 2026-05-23, run `162162dd-...` stuck at pending_approval).
 *
 * Mirror fix in `packages/agents/src/oas-compiler.ts` ~ line 1490 for the
 * persisted compiled inputSchema path.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: () => "/nonexistent",
}));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: () => false }));

import { __testOnly } from "../input-schema-resolver";

function buildOasWithStartInputs(
  inputs: Array<Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return {
    component_type: "Flow",
    start_node: { $component_ref: "start" },
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        inputs,
        metadata: {
          cinatra: { required, hidden: [] },
        },
      },
    },
  };
}

describe("input-schema-resolver — array `items` extraction", () => {
  it("reads `items` from top-level (canonical JSON Schema shape)", () => {
    const oas = buildOasWithStartInputs(
      [
        {
          title: "tags",
          type: "array",
          items: { type: "string" },
        },
      ],
      ["tags"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    expect(resolved).not.toBeNull();
    const tagsProp = resolved!.properties.tags as Record<string, unknown>;
    expect(tagsProp.type).toBe("array");
    expect(tagsProp.items).toEqual({ type: "string" });
  });

  it("reads `items` from nested `json_schema.items` (agentspec 26.1.0 convention)", () => {
    const oas = buildOasWithStartInputs(
      [
        {
          title: "organizationDomains",
          type: "array",
          json_schema: { items: { type: "string" } },
        },
      ],
      ["organizationDomains"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    expect(resolved).not.toBeNull();
    const prop = resolved!.properties.organizationDomains as Record<string, unknown>;
    expect(prop.type).toBe("array");
    // The bug-triggering case: before the fix this was undefined because the
    // resolver only destructured top-level fields.
    expect(prop.items).toEqual({ type: "string" });
  });

  it("prefers top-level `items` over nested `json_schema.items` when both present", () => {
    const oas = buildOasWithStartInputs(
      [
        {
          title: "mixed",
          type: "array",
          items: { type: "string" },
          json_schema: { items: { type: "number" } },
        },
      ],
      ["mixed"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    expect(resolved).not.toBeNull();
    const prop = resolved!.properties.mixed as Record<string, unknown>;
    expect(prop.items).toEqual({ type: "string" });
  });

  it("leaves `items` undefined for non-array typed inputs (no false-positive injection)", () => {
    const oas = buildOasWithStartInputs(
      [
        { title: "plain", type: "string" },
        { title: "flag", type: "boolean" },
      ],
      ["plain"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    expect(resolved).not.toBeNull();
    expect((resolved!.properties.plain as Record<string, unknown>).items).toBeUndefined();
    expect((resolved!.properties.flag as Record<string, unknown>).items).toBeUndefined();
  });
});
