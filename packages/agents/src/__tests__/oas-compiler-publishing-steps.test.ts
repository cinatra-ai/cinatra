/**
 * cinatra#4150 — the publishing-step declaration in the OAS compiler.
 *
 * A pack marks the node that performs a publication with
 * `metadata.cinatra.publishes: true`. The compiler reads the key on every
 * top-level flow node (an `ApiNode` included, although an ApiNode produces no
 * approval step) and emits `publishingSteps`: the ids whose value is the
 * literal boolean `true`. The flag is trusted only to ADD a stop, never to
 * remove one, so everything that is not a clean declaration refuses the
 * compile instead of being ignored:
 *   - a `publishes` value that is not a JSON boolean (malformed);
 *   - `publishes: true` on a node that cannot be the publishing action, on a
 *     node inside a nested subflow, on a subflow definition or on the flow root
 *     (misplaced);
 *   - any node id that starts with the reserved gate prefix.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compiler-publishing-steps.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";

type Node = Record<string, unknown>;

function apiNode(id: string, cinatra?: Record<string, unknown>, extra: Node = {}): Node {
  return {
    component_type: "ApiNode",
    id,
    name: id,
    url: `https://example.invalid/${id}`,
    http_method: "POST",
    data: {},
    outputs: [{ title: `${id}_out`, type: "string" }],
    ...(cinatra === undefined ? {} : { metadata: { cinatra } }),
    ...extra,
  };
}

function startNode(cinatra: Record<string, unknown> = {}): Node {
  return {
    component_type: "StartNode",
    id: "start",
    name: "start",
    inputs: [],
    metadata: { cinatra: { required: [], ...cinatra } },
  };
}

function endNode(cinatra?: Record<string, unknown>): Node {
  return {
    component_type: "EndNode",
    id: "end",
    name: "end",
    outputs: [],
    ...(cinatra === undefined ? {} : { metadata: { cinatra } }),
  };
}

/**
 * A linear root flow: start -> middle[0] -> ... -> end. `extraRefs` are put in
 * `$referenced_components` without being listed in `nodes` (subflow
 * definitions, as packs author them).
 */
function buildFlow(opts: {
  middle: Node[];
  start?: Node;
  end?: Node;
  extraRefs?: Record<string, Node>;
  rootCinatra?: Record<string, unknown>;
}): Record<string, unknown> {
  const start = opts.start ?? startNode();
  const end = opts.end ?? endNode();
  const chain = [start, ...opts.middle, end];
  const refs: Record<string, Node> = {};
  for (const n of chain) refs[n.id as string] = n;
  Object.assign(refs, opts.extraRefs ?? {});
  const edges = chain.slice(1).map((n, i) => ({
    component_type: "ControlFlowEdge",
    name: `e${i}`,
    from_node: { $component_ref: chain[i]!.id as string },
    to_node: { $component_ref: n.id as string },
  }));
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "publish-flow",
    name: "Publish Flow",
    metadata: { cinatra: { type: "flow", ...(opts.rootCinatra ?? {}) } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: start.id as string },
    nodes: chain.map((n) => ({ $component_ref: n.id as string })),
    control_flow_connections: edges,
    data_flow_connections: [],
    $referenced_components: refs,
  };
}

/** A FlowNode `sub` wrapping the Flow component `sub_flow` (kept in the root refs). */
function withSubflow(nested: Node[]): { middle: Node[]; extraRefs: Record<string, Node> } {
  const inner = buildFlow({ middle: nested });
  return {
    middle: [
      {
        component_type: "FlowNode",
        id: "sub",
        name: "sub",
        subflow: { $component_ref: "sub_flow" },
      },
    ],
    extraRefs: { sub_flow: { ...inner, id: "sub_flow", name: "sub_flow" } },
  };
}

let tempDir: string;
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas4150-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

async function compile(doc: Record<string, unknown>) {
  const p = path.join(tempDir, "agent.json");
  writeFileSync(p, JSON.stringify(doc, null, 2));
  return compileOasAgentJson({
    packageName: "@cinatra-ai/publish-fixture-agent",
    oasSourcePath: p,
    registryPath: path.join(tempDir, "components.json"),
  });
}

async function publishingStepsOf(doc: Record<string, unknown>): Promise<string[]> {
  const res = await compile(doc);
  expect(res.ok, res.ok ? "" : res.error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return res.value.publishingSteps;
}

async function compileError(doc: Record<string, unknown>): Promise<string> {
  const res = await compile(doc);
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  return res.error;
}

describe("cinatra#4150 — publishingSteps is the set of nodes declared publishes: true", () => {
  it("reads the flag on an ApiNode: true is listed, an explicit false is not", async () => {
    const steps = await publishingStepsOf(
      buildFlow({
        middle: [apiNode("publish", { riskClass: "write", publishes: true }), apiNode("write_address", { riskClass: "write", publishes: false })],
      }),
    );
    expect(steps).toEqual(["publish"]);
  });

  it("a flow with no declaration anywhere emits an empty list", async () => {
    expect(await publishingStepsOf(buildFlow({ middle: [apiNode("draft"), apiNode("publish", { riskClass: "write" })] }))).toEqual([]);
  });

  it("lists every declared node once, in node order", async () => {
    const steps = await publishingStepsOf(
      buildFlow({ middle: [apiNode("first", { publishes: true }), apiNode("between"), apiNode("second", { publishes: true })] }),
    );
    expect(steps).toEqual(["first", "second"]);
  });

  it("a case-varied key is not the key: Publishes: true leaves the node undeclared", async () => {
    expect(await publishingStepsOf(buildFlow({ middle: [apiNode("publish", { Publishes: true })] }))).toEqual([]);
  });

  it("the key outside metadata.cinatra is not the declaration", async () => {
    const node = apiNode("publish");
    node.metadata = { publishes: true };
    expect(await publishingStepsOf(buildFlow({ middle: [node] }))).toEqual([]);
  });

  it("an explicit false inside a nested subflow is allowed and lists nothing", async () => {
    const sub = withSubflow([apiNode("inner_write", { publishes: false })]);
    expect(await publishingStepsOf(buildFlow(sub))).toEqual([]);
  });
});

describe("cinatra#4150 — a malformed flag refuses the compile", () => {
  for (const [label, value] of [
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["null", null],
    ["an object", {}],
    ["an array", [true]],
  ] as const) {
    it(`publishes: ${label} is refused, not read as a declaration`, async () => {
      const error = await compileError(buildFlow({ middle: [apiNode("publish", { publishes: value })] }));
      expect(error).toMatch(/^PUBLISHES_MALFORMED: /);
      expect(error).toContain('"publish"');
    });
  }

  it("a malformed flag inside a nested subflow is refused too", async () => {
    const sub = withSubflow([apiNode("inner_write", { publishes: "false" })]);
    expect(await compileError(buildFlow(sub))).toMatch(/^PUBLISHES_MALFORMED: .*"inner_write"/);
  });
});

describe("cinatra#4150 — a misplaced flag refuses the compile", () => {
  it("publishes: true on the StartNode", async () => {
    const error = await compileError(buildFlow({ start: startNode({ publishes: true }), middle: [apiNode("draft")] }));
    expect(error).toMatch(/^PUBLISHES_MISPLACED: .*"start"/);
  });

  it("publishes: true on the EndNode", async () => {
    const error = await compileError(buildFlow({ end: endNode({ publishes: true }), middle: [apiNode("draft")] }));
    expect(error).toMatch(/^PUBLISHES_MISPLACED: .*"end"/);
  });

  for (const componentType of ["InputMessageNode", "OutputMessageNode", "BranchingNode"]) {
    it(`publishes: true on a ${componentType}`, async () => {
      const node: Node = {
        component_type: componentType,
        id: "not_an_action",
        name: "not_an_action",
        outputs: [{ title: "answer", type: "string" }],
        metadata: { cinatra: { publishes: true } },
      };
      const error = await compileError(buildFlow({ middle: [node] }));
      expect(error).toMatch(/^PUBLISHES_MISPLACED: .*"not_an_action"/);
    });
  }

  it("publishes: true on a node inside a nested subflow", async () => {
    const sub = withSubflow([apiNode("inner_publish", { publishes: true })]);
    expect(await compileError(buildFlow(sub))).toMatch(/^PUBLISHES_MISPLACED: .*"inner_publish"/);
  });

  it("publishes: true on a subflow definition (a Flow component, not a step)", async () => {
    const sub = withSubflow([apiNode("inner")]);
    (sub.extraRefs.sub_flow!.metadata as { cinatra: Record<string, unknown> }).cinatra.publishes = true;
    expect(await compileError(buildFlow(sub))).toMatch(/^PUBLISHES_MISPLACED: .*"sub_flow"/);
  });

  it("publishes: true on the flow root", async () => {
    const error = await compileError(buildFlow({ middle: [apiNode("draft")], rootCinatra: { publishes: true } }));
    expect(error).toMatch(/^PUBLISHES_MISPLACED: /);
  });
});

describe("cinatra#4150 — the gate prefix is reserved for the host", () => {
  it("a top-level node id with the prefix is refused", async () => {
    const error = await compileError(buildFlow({ middle: [apiNode("cinatra_publish_gate__publish")] }));
    expect(error).toMatch(/^RESERVED_NODE_ID: .*"cinatra_publish_gate__publish"/);
  });

  it("a node id with the prefix inside a nested subflow is refused", async () => {
    const sub = withSubflow([apiNode("cinatra_publish_gate__inner")]);
    expect(await compileError(buildFlow(sub))).toMatch(/^RESERVED_NODE_ID: .*"cinatra_publish_gate__inner"/);
  });

  it("a component key with the prefix is refused even when its id field differs", async () => {
    const doc = buildFlow({ middle: [apiNode("draft")] });
    (doc.$referenced_components as Record<string, Node>)["cinatra_publish_gate__x"] = apiNode("x");
    expect(await compileError(doc)).toMatch(/^RESERVED_NODE_ID: .*"cinatra_publish_gate__x"/);
  });

  it("an id that only contains the prefix later is not reserved", async () => {
    expect(await publishingStepsOf(buildFlow({ middle: [apiNode("my_cinatra_publish_gate__x", { publishes: true })] }))).toEqual([
      "my_cinatra_publish_gate__x",
    ]);
  });
});
