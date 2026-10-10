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
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/nonexistent",
  resolveDevExtensionSourceRoot: () => "/nonexistent",
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

// ---------------------------------------------------------------------------
// cinatra#2484 — the same nesting lift for OBJECT sub-shape.
//
// An `object`-typed StartNode input declares `{title, summary, outline}` under
// `json_schema.properties` (+ `json_schema.required`), exactly as an array
// declares `json_schema.items`. Without the lift the resolved property is a
// bare `{type:"object"}`, the Setup form has no sub-fields to build, and it
// degrades to ONE free-text box that accepts a bare sentence — the run then
// starts with a type-violating `input_params`.
// ---------------------------------------------------------------------------
describe("input-schema-resolver — object `properties` extraction (cinatra#2484)", () => {
  it("reads `properties`/`required` from nested `json_schema` (agentspec convention)", () => {
    const oas = buildOasWithStartInputs(
      [
        {
          title: "idea",
          type: "object",
          json_schema: {
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              outline: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
          },
        },
      ],
      ["idea"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    expect(resolved).not.toBeNull();
    const prop = resolved!.properties.idea as Record<string, unknown>;
    expect(prop.type).toBe("object");
    expect(prop.properties).toEqual({
      title: { type: "string" },
      summary: { type: "string" },
      outline: { type: "array", items: { type: "string" } },
    });
    expect(prop.required).toEqual(["title"]);
  });

  it("reads `properties` from top level (canonical JSON Schema shape)", () => {
    const oas = buildOasWithStartInputs(
      [
        {
          title: "idea",
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      ],
      ["idea"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    const prop = resolved!.properties.idea as Record<string, unknown>;
    expect(prop.properties).toEqual({ title: { type: "string" } });
    expect(prop.required).toEqual(["title"]);
  });

  it("prefers top-level `properties` over nested `json_schema.properties`", () => {
    const oas = buildOasWithStartInputs(
      [
        {
          title: "idea",
          type: "object",
          properties: { top: { type: "string" } },
          json_schema: { properties: { nested: { type: "string" } } },
        },
      ],
      ["idea"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    const prop = resolved!.properties.idea as Record<string, unknown>;
    expect(prop.properties).toEqual({ top: { type: "string" } });
  });

  it("leaves a SCHEMA-LESS object input as a bare {type:'object'} (blog-draft-writer@0.1.2)", () => {
    // The installed pin declares no json_schema at all. The resolver must not
    // fabricate sub-properties — the renderer's validation leg owns this case.
    const oas = buildOasWithStartInputs([{ title: "idea", type: "object" }], ["idea"]);
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    const prop = resolved!.properties.idea as Record<string, unknown>;
    expect(prop.type).toBe("object");
    expect(prop.properties).toBeUndefined();
    expect(prop.required).toBeUndefined();
  });

  it("never injects `properties` into a NON-object input (no false positive)", () => {
    const oas = buildOasWithStartInputs(
      [
        { title: "plain", type: "string", json_schema: { properties: { a: { type: "string" } } } },
        { title: "tags", type: "array", json_schema: { items: { type: "string" }, properties: {} } },
      ],
      ["plain"],
    );
    const resolved = __testOnly.deriveFullSchemaFromOas(oas);
    expect((resolved!.properties.plain as Record<string, unknown>).properties).toBeUndefined();
    expect((resolved!.properties.tags as Record<string, unknown>).properties).toBeUndefined();
  });
});


describe("cinatra#3759 — existing predispatch API checks visible missing inputs", () => {
  const field = { title: "postId", type: "string" };
  const mounted = (declaration: Record<string, unknown> = {}, required: string[] = [], hidden: string[] = []) => ({
    component_type: "Flow", inputs: [{ ...field, ...declaration }],
    start_node: { $component_ref: "start" },
    $referenced_components: { start: { component_type: "StartNode", inputs: [{ ...field, ...declaration }], metadata: { cinatra: { required, hidden } } } },
  });
  const args = {
    properties: { postId: { type: "string" } }, alreadySupplied: {},
    packageName: "@cinatra-ai/wordpress-agent", packageVersion: "0.1.0",
    readOas: async () => mounted(),
  };
  it("refuses a visible missing input through the unchanged caller API, without using the install floor", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    await expect(assertUnsatisfiableHiddenInputs(args)).rejects.toThrow(/wordpress-agent@0.1.0[\s\S]*postId/);
  });
  it.each(["", null, false, 0, [], "123"])("permits the supplied own key %j", async value => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    await expect(assertUnsatisfiableHiddenInputs({ ...args, alreadySupplied: { postId: value } })).resolves.toBeUndefined();
  });
  it.each(["", null, false, 0, []])("permits the declared Flow default %j", async value => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    await expect(assertUnsatisfiableHiddenInputs({ ...args, readOas: async () => mounted({ default: value }) })).resolves.toBeUndefined();
  });
  it("keeps required setup fields on their existing path", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    await expect(assertUnsatisfiableHiddenInputs({ ...args, readOas: async () => mounted({}, ["postId"]) })).resolves.toBeUndefined();
  });
  it("does not clear a refusal with an inherited input key", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    await expect(assertUnsatisfiableHiddenInputs({ ...args, alreadySupplied: Object.create({ postId: "123" }) })).rejects.toThrow(/postId/);
  });
  it("confirms stale schema against the actual Flow default", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    await expect(assertUnsatisfiableHiddenInputs({ ...args, readOas: async () => mounted({ default: "" }) })).resolves.toBeUndefined();
  });
  it("a removed Flow default is not rescued by a stale stored default", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    await expect(assertUnsatisfiableHiddenInputs({ ...args, properties: { postId: { type: "string", default: "" } } })).rejects.toThrow(/postId/);
  });
  it("a default only on StartNode cannot satisfy the Flow", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    const oas = mounted();
    Object.assign(oas.$referenced_components.start.inputs[0], { default: "" });
    await expect(assertUnsatisfiableHiddenInputs({ ...args, readOas: async () => oas })).rejects.toThrow(/postId/);
  });
  it("preserves missing/unreadable/invalid mounted OAS confirmation semantics", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    for (const oas of [null, {}, { inputs: [field] }, { component_type: "Agent", inputs: [field] }, { ...mounted(), inputs: [] }]) {
      await expect(assertUnsatisfiableHiddenInputs({ ...args, readOas: async () => oas })).resolves.toBeUndefined();
    }
  });
  it("does not apply the root-start rule to embedded Flow inputs", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    const oas = mounted({ default: "" });
    Object.assign(oas.$referenced_components, { child: mounted() });
    await expect(assertUnsatisfiableHiddenInputs({ ...args, readOas: async () => oas })).resolves.toBeUndefined();
  });
  it("keeps platform-supplied inputs on their existing path", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    const oas = mounted();
    oas.inputs[0].title = "cinatra_run_id";
    oas.$referenced_components.start.inputs[0].title = "cinatra_run_id";
    await expect(assertUnsatisfiableHiddenInputs({ ...args, properties: { cinatra_run_id: { type: "string" } }, readOas: async () => oas })).resolves.toBeUndefined();
  });
});


describe("cinatra#3759 — actual mounted inputs survive stored-schema drift", () => {
  const mounted = (inputs: Array<Record<string, unknown>>, required: string[] = [], hidden: string[] = []) => ({
    component_type: "Flow", inputs,
    start_node: { $component_ref: "start" },
    $referenced_components: { start: { component_type: "StartNode", inputs, metadata: { cinatra: { required, hidden } } } },
  });
  const visible = { title: "newInput", type: "string" };
  const guard = async (properties: Record<string, Record<string, unknown>>, alreadySupplied: Record<string, unknown>, oas: Record<string, unknown> | null) => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    return assertUnsatisfiableHiddenInputs({ properties, alreadySupplied, packageName: "@test/drift-agent", readOas: async () => oas });
  };
  it("refuses a mounted visible input absent from stored properties", async () => {
    await expect(guard({}, {}, mounted([visible]))).rejects.toThrow(/newInput/);
  });
  it("stored hiddenness and a stored default do not conceal actual visible missing input", async () => {
    await expect(guard({ newInput: { type: "string", "x-hidden": true, default: "" } }, {}, mounted([visible]))).rejects.toThrow(/visible input[\s\S]*newInput/);
  });
  it("all stored fields supplied does not conceal a newly declared Flow input", async () => {
    await expect(guard({ old: { type: "string" } }, { old: "answered" }, mounted([visible]))).rejects.toThrow(/newInput/);
  });
  it("uses one coherent mount reading for old hidden and new visible checks", async () => {
    const { assertUnsatisfiableHiddenInputs } = await import("../input-schema-resolver");
    let reads = 0;
    await expect(assertUnsatisfiableHiddenInputs({
      properties: { secret: { type: "string", "x-hidden": true } }, alreadySupplied: {}, packageName: "@test/drift-agent",
      readOas: async () => {
        reads += 1;
        return mounted([{ title: "secret", type: "string", default: "" }, reads === 1 ? visible : { ...visible, default: "" }], [], ["secret"]);
      },
    })).rejects.toThrow(/visible input[\s\S]*newInput/);
    expect(reads).toBe(1);
  });
  it("keeps actual required/hidden/platform inputs on their existing roads", async () => {
    const inputs = ["required", "hidden", "cinatra_run_id", "agent_run_id"].map(title => ({ title, type: "string" }));
    await expect(guard({}, {}, mounted(inputs, ["required"], ["hidden"]))).resolves.toBeUndefined();
  });
  it.each(["", null, false, 0, []])("uses the actual declared Flow default %j", async value => {
    await expect(guard({}, {}, mounted([{ ...visible, default: value }]))).resolves.toBeUndefined();
  });
  it.each(["", null, false, 0, [], "answered"])("permits supplied actual own key %j without stored property", async value => {
    await expect(guard({}, { newInput: value }, mounted([visible]))).resolves.toBeUndefined();
  });
  it("an inherited caller value still does not supply the new actual input", async () => {
    await expect(guard({}, Object.create({ newInput: "answer" }), mounted([visible]))).rejects.toThrow(/newInput/);
  });
  it("preserves null/nonFlow/unconfirmable mount semantics", async () => {
    for (const oas of [null, {}, { ...mounted([visible]), component_type: "Agent" }, { component_type: "Flow", inputs: [visible] }]) {
      await expect(guard({}, {}, oas)).resolves.toBeUndefined();
    }
  });
  it("defers new visible confirmation for malformed StartNode input entries", async () => {
    const oas = mounted([visible]);
    Object.assign(oas.$referenced_components.start, { inputs: [null] });
    await expect(guard({}, {}, oas)).resolves.toBeUndefined();
  });
  it("keeps old hidden-first refusal despite malformed StartNode input entries", async () => {
    const oas = mounted([{ title: "secret", type: "string" }, visible], [], ["secret"]);
    Object.assign(oas.$referenced_components.start, { inputs: [null] });
    await expect(guard({ secret: { type: "string", "x-hidden": true } }, {}, oas)).rejects.toThrow(/hidden input[\s\S]*secret/);
  });
  it("keeps the existing hidden refusal when hidden and visible inputs are both invalid", async () => {
    await expect(guard({ secret: { type: "string", "x-hidden": true } }, {}, mounted([{ title: "secret", type: "string" }, visible], [], ["secret"]))).rejects.toThrow(/hidden input[\s\S]*secret/);
  });
});
