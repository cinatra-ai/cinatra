/**
 * The `idea` input's payload contract, pinned end to end.
 *
 * blog-draft-writer-agent's setup form presents ONE editable field named Idea.
 * The canonical payload transformation is stated in the agent's own pull
 * request and pinned here: the PRESENTATION layer synthesizes the minimum valid
 * object, so the single control submits `{title: "<what the operator typed>"}`
 * and the wire contract stays an object. This file is the HOST half of that
 * statement, because the agent repository has no test runner.
 *
 * Three payload shapes, three observable diagnostics:
 *
 *   - `idea: "plain text"`        → REJECTED by the schema layer. A bare string
 *                                   for an object-typed input is exactly the
 *                                   cinatra#2484 defect, and the earlier
 *                                   fail-loud guarantee (cinatra#2510's motive:
 *                                   a typed string must not slip silently into
 *                                   the agent's degenerate branch) lives here.
 *   - `idea: {}`                  → REJECTED, naming the missing `title`.
 *   - `idea: {title: "…"}`        → ACCEPTED. The minimum valid object, and the
 *                                   exact value the single control emits.
 *
 * Both inputSchema pipelines are covered, because a hint that survived only one
 * of them would render one form on a freshly compiled template and a different
 * one on a template derived from disk.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/single-idea-field-contract.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";
import { __testOnly } from "../input-schema-resolver";
import { jsonSchemaToZod } from "../json-schema-to-zod";
import { resolveObjectTextProperty } from "../schema-field-renderer";

/**
 * The `idea` declaration blog-draft-writer-agent ships, verbatim. All three of
 * its declarations (Flow input, StartNode input, write ApiNode input) carry
 * this shape; the StartNode one is what both pipelines read.
 *
 * Note what is ABSENT: the `anyOf` requiring summary-or-outline. Neither
 * pipeline ever lifted it, so it constrained nothing while making the authored
 * schema stricter than every surface that consumed it. `required: ["title"]` is
 * now the whole requirement, and it is enforced.
 */
const SHIPPED_IDEA_INPUT = {
  title: "idea",
  type: "object",
  json_schema: {
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      outline: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
    "x-object-text-property": "title",
    "x-multiline": true,
    "x-placeholder": "What should this post be about?",
  },
} as const;

function buildAgentJson(inputs: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    metadata: { cinatra: { type: "leaf" } },
    inputs,
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [{ $component_ref: "startNode" }, { $component_ref: "endNode" }],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start-to-end",
        from_node: { $component_ref: "startNode" },
        to_node: { $component_ref: "endNode" },
      },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Start",
        inputs,
        metadata: { cinatra: { required: ["idea"] } },
      },
      endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;

beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "single-idea-field-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function compiledInputSchema(): Promise<Record<string, unknown>> {
  const agentJsonPath = path.join(tempDir, "agent.json");
  writeFileSync(
    agentJsonPath,
    JSON.stringify(buildAgentJson([SHIPPED_IDEA_INPUT as unknown as Record<string, unknown>]), null, 2),
  );
  const result = await compileOasAgentJson({
    packageName: "@test/pkg",
    oasSourcePath: agentJsonPath,
    registryPath: path.join(tempDir, "components.json"),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("compile failed");
  return result.value.inputSchema as Record<string, unknown>;
}

function derivedInputSchema(): Record<string, Record<string, unknown>> {
  const derived = __testOnly.deriveFullSchemaFromOas(
    buildAgentJson([SHIPPED_IDEA_INPUT as unknown as Record<string, unknown>]),
  );
  expect(derived).not.toBeNull();
  return derived!.properties;
}

describe("single Idea field — the presentation hint reaches BOTH inputSchema pipelines", () => {
  it("the compiled schema carries the hint and resolves to the `title` property", async () => {
    const schema = await compiledInputSchema();
    const idea = (schema.properties as Record<string, Record<string, unknown>>).idea;
    expect(idea["x-object-text-property"]).toBe("title");
    expect(idea["x-multiline"]).toBe(true);
    expect(idea["x-placeholder"]).toBe("What should this post be about?");
    expect(resolveObjectTextProperty(idea)).toBe("title");
  });

  it("the derived-from-disk schema carries the same hint", () => {
    const idea = derivedInputSchema().idea;
    expect(idea["x-object-text-property"]).toBe("title");
    expect(resolveObjectTextProperty(idea)).toBe("title");
  });

  it("drops nothing else: the object sub-shape and `required` still ride through", async () => {
    const schema = await compiledInputSchema();
    const idea = (schema.properties as Record<string, Record<string, unknown>>).idea;
    expect(idea.type).toBe("object");
    expect(idea.properties).toEqual({
      title: { type: "string" },
      summary: { type: "string" },
      outline: { type: "array", items: { type: "string" } },
    });
    expect(idea.required).toEqual(["title"]);
  });

  it("HONORS the hint only when it names a declared STRING property", () => {
    // Fail-safe: an unusable hint must degrade to the structured form rather
    // than render a control that emits a value the schema then rejects.
    const base = { type: "object", properties: { title: { type: "string" } } };
    expect(resolveObjectTextProperty({ ...base, "x-object-text-property": "nope" })).toBeNull();
    expect(
      resolveObjectTextProperty({
        type: "object",
        properties: { outline: { type: "array" } },
        "x-object-text-property": "outline",
      }),
    ).toBeNull();
    expect(resolveObjectTextProperty({ ...base, "x-object-text-property": "  " })).toBeNull();
    expect(resolveObjectTextProperty({ ...base })).toBeNull();
    expect(resolveObjectTextProperty({ ...base, "x-object-text-property": "title" })).toBe("title");
  });
});

describe("single Idea field — the three payload shapes", () => {
  it("REFUSES `idea: \"plain text\"` — a bare string never satisfies the object input", async () => {
    const zod = jsonSchemaToZod(await compiledInputSchema());
    const parsed = zod.safeParse({ idea: "human purpose in an age of agentic AI" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path[0] === "idea");
    expect(issue).toBeDefined();
    // The diagnostic names the FIELD and the expected type — never a silent
    // coercion into `idea.title`, and never a silent pass into the agent's
    // degenerate branch.
    expect(JSON.stringify(issue)).toMatch(/object/i);
  });

  it("REFUSES `idea: {}` — the object is present but `title` is missing", async () => {
    const zod = jsonSchemaToZod(await compiledInputSchema());
    const parsed = zod.safeParse({ idea: {} });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.path.join(".") === "idea.title")).toBe(true);
  });

  it("REFUSES a blank title — an empty Idea field cannot resume the run", async () => {
    const zod = jsonSchemaToZod(await compiledInputSchema());
    expect(zod.safeParse({ idea: { title: "" } }).success).toBe(false);
  });

  it("ACCEPTS `{title}` — the minimum valid object, and what the single control emits", async () => {
    const zod = jsonSchemaToZod(await compiledInputSchema());
    const parsed = zod.safeParse({ idea: { title: "human purpose in an age of agentic AI" } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      idea: { title: "human purpose in an age of agentic AI" },
    });
  });

  it("ACCEPTS the full object, so an upstream idea producer is unaffected", async () => {
    const zod = jsonSchemaToZod(await compiledInputSchema());
    expect(
      zod.safeParse({
        idea: {
          title: "t",
          summary: "s",
          outline: ["one", "two"],
        },
      }).success,
    ).toBe(true);
  });

  it("the derived-from-disk schema enforces the SAME three verdicts", () => {
    const zod = jsonSchemaToZod({ type: "object", properties: derivedInputSchema(), required: ["idea"] });
    expect(zod.safeParse({ idea: "plain text" }).success).toBe(false);
    expect(zod.safeParse({ idea: {} }).success).toBe(false);
    expect(zod.safeParse({ idea: { title: "a real idea" } }).success).toBe(true);
  });
});
