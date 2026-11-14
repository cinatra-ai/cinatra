/**
 * cinatra#4150 — the rows the publish card shows, declared by the pack.
 *
 * A declared publishing node may add `metadata.cinatra.publishRows`: one or
 * two rows, each `{ label, input }`, where `label` is the pack's own words and
 * `input` names one of the node's own inputs (the values the stop surfaces).
 * The compiler reads the key into `publishRows`, keyed by node id. The key is
 * valid only beside `publishes: true` on a top-level node; any other place or
 * form refuses the compile, and the error names the field and the node id
 * only, never a label or an input the pack wrote.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compiler-publish-rows.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as compiler from "../oas-compiler";

type Node = Record<string, unknown>;
type Result = { ok: true; rows: Record<string, Array<{ label: string; input: string }>> } | { ok: false; error: string };
const collect = (doc: Record<string, unknown>, steps: string[]): Result =>
  (compiler as unknown as { collectPublishRows: (d: Record<string, unknown>, s: string[]) => Result }).collectPublishRows(doc, steps);

const INPUTS = [
  { title: "content", type: "string" },
  { title: "destination", type: "string" },
  { title: "account_ref", type: "string" },
];
const ROWS = [
  { label: "Post", input: "content" },
  { label: "Where", input: "destination" },
];

function publishNode(cinatra: Record<string, unknown>, extra: Node = {}): Node {
  return { component_type: "ApiNode", id: "publish", inputs: INPUTS, metadata: { cinatra }, ...extra };
}
const flowWith = (refs: Record<string, Node>, listed = Object.keys(refs)) => ({
  nodes: listed.map((id) => ({ $component_ref: id })),
  $referenced_components: refs,
});

describe("cinatra#4150 — publishRows on a declared publishing node", () => {
  it("reads one or two rows, in the declared order, keyed by node id", () => {
    expect(collect(flowWith({ publish: publishNode({ publishes: true, publishRows: ROWS }) }), ["publish"])).toEqual({
      ok: true,
      rows: { publish: ROWS },
    });
    expect(collect(flowWith({ publish: publishNode({ publishes: true, publishRows: [ROWS[1]] }) }), ["publish"])).toEqual({
      ok: true,
      rows: { publish: [ROWS[1]] },
    });
  });

  it("a declared node without the key, and a flow without any, give no entry", () => {
    expect(collect(flowWith({ publish: publishNode({ publishes: true }) }), ["publish"])).toEqual({ ok: true, rows: {} });
    expect(collect(flowWith({ draft: { component_type: "ApiNode", id: "draft" } }), [])).toEqual({ ok: true, rows: {} });
  });
});

describe("cinatra#4150 — publishRows anywhere else refuses the compile", () => {
  it("on a node that does not declare publishes: true (absent or false)", () => {
    for (const cinatra of [{ publishRows: ROWS }, { publishes: false, publishRows: ROWS }]) {
      const res = collect(flowWith({ publish: publishNode(cinatra) }), []);
      expect(res).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISH_ROWS_MISPLACED: node "publish" /) });
    }
  });

  it("on the flow root, and on a node inside a nested subflow", () => {
    const root = { ...flowWith({ publish: publishNode({ publishes: true }) }), metadata: { cinatra: { publishRows: ROWS } } };
    expect(collect(root, ["publish"])).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISH_ROWS_MISPLACED: /) });
    const nested = flowWith({
      sub: { component_type: "FlowNode", id: "sub", subflow: { $referenced_components: { inner: publishNode({ publishRows: ROWS }, { id: "inner" }) } } },
    });
    expect(collect(nested, [])).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISH_ROWS_MISPLACED: node "inner" /) });
  });
});

describe("cinatra#4150 — a malformed declaration refuses the compile", () => {
  const refused = (publishRows: unknown) => collect(flowWith({ publish: publishNode({ publishes: true, publishRows }) }), ["publish"]);

  for (const [label, value] of [
    ["an empty list", []],
    ["three rows", [...ROWS, { label: "Account", input: "account_ref" }]],
    ["an object", { label: "Post", input: "content" }],
    ["a string", "content"],
    ["null", null],
  ] as const) {
    it(`${label} is refused`, () => {
      expect(refused(value)).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISH_ROWS_MALFORMED: node "publish" /) });
    });
  }

  for (const [label, row] of [
    ["a row with an extra key", { label: "Post", input: "content", value: "x" }],
    ["a row with no input", { label: "Post" }],
    ["an empty label", { label: "", input: "content" }],
    ["a label with a line break", { label: "Po\nst", input: "content" }],
    ["a label with a leading space", { label: " Post", input: "content" }],
    ["a label over 60 characters", { label: "x".repeat(61), input: "content" }],
    ["a label that is not a string", { label: 7, input: "content" }],
  ] as const) {
    it(`${label} is refused`, () => {
      expect(refused([row])).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISH_ROWS_MALFORMED: node "publish" metadata\.cinatra\.publishRows\[0\]/) });
    });
  }

  it("an input that the node does not have is refused, and so is a repeated input", () => {
    expect(refused([{ label: "Post", input: "body" }])).toEqual({
      ok: false,
      error: expect.stringMatching(/^PUBLISH_ROWS_UNKNOWN_INPUT: node "publish" metadata\.cinatra\.publishRows\[0\]\.input /),
    });
    expect(refused([ROWS[0], { label: "Again", input: "content" }])).toEqual({
      ok: false,
      error: expect.stringMatching(/^PUBLISH_ROWS_MALFORMED: node "publish" metadata\.cinatra\.publishRows\[1\]\.input /),
    });
  });

  it("an error never quotes a label or an input the pack wrote", () => {
    const SECRET = "sk-live-SECRET-0123";
    for (const rows of [[{ label: SECRET, input: "content", x: 1 }], [{ label: "Post", input: SECRET }], [{ label: `${SECRET}\n`, input: "content" }]]) {
      const res = refused(rows);
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).not.toContain("SECRET");
    }
  });
});

// The compile emits the field and runs the check: a flow written the way the
// publishing-steps suite writes them.
let tempDir: string;
beforeEach(() => {
  compiler.__resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas4150rows-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

function linearFlow(middle: Node[]): Record<string, unknown> {
  const start = { component_type: "StartNode", id: "start", name: "start", inputs: [], metadata: { cinatra: { required: [] } } };
  const end = { component_type: "EndNode", id: "end", name: "end", outputs: [] };
  const chain: Node[] = [start, ...middle, end];
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "rows-flow",
    name: "Rows Flow",
    metadata: { cinatra: { type: "flow" } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: chain.map((n) => ({ $component_ref: n.id as string })),
    control_flow_connections: chain.slice(1).map((n, i) => ({
      component_type: "ControlFlowEdge",
      name: `e${i}`,
      from_node: { $component_ref: chain[i]!.id as string },
      to_node: { $component_ref: n.id as string },
    })),
    data_flow_connections: [],
    $referenced_components: Object.fromEntries(chain.map((n) => [n.id as string, n])),
  };
}
const apiNode = (id: string, cinatra?: Record<string, unknown>): Node => ({
  component_type: "ApiNode",
  id,
  name: id,
  url: `https://example.invalid/${id}`,
  http_method: "POST",
  data: {},
  outputs: [{ title: `${id}_out`, type: "string" }],
  ...(cinatra === undefined ? {} : { metadata: { cinatra } }),
});

async function compile(doc: Record<string, unknown>) {
  const p = path.join(tempDir, "agent.json");
  writeFileSync(p, JSON.stringify(doc, null, 2));
  return compiler.compileOasAgentJson({
    packageName: "@cinatra-ai/publish-fixture-agent",
    oasSourcePath: p,
    registryPath: path.join(tempDir, "components.json"),
  });
}

describe("cinatra#4150 — compileOasAgentJson emits publishRows", () => {
  it("a flow that declares no rows compiles with an empty map (not undefined)", async () => {
    const res = await compile(linearFlow([apiNode("publish", { publishes: true })]));
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect((res.value as unknown as { publishRows?: unknown }).publishRows).toEqual({});
  });

  it("rows on a node that does not publish refuse the compile", async () => {
    const res = await compile(linearFlow([apiNode("publish", { publishRows: [{ label: "Post", input: "content" }] })]));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/^PUBLISH_ROWS_MISPLACED: node "publish" /);
  });
});
