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
import { collectPublishingSteps, compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";

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

describe("cinatra#4150 — the action kinds are an allow-list", () => {
  const flowWith = (node: Node) => ({
    nodes: [{ $component_ref: "step" }],
    $referenced_components: { step: { id: "step", ...node } },
  });
  const declared = { metadata: { cinatra: { publishes: true } } };

  for (const kind of ["ApiNode", "AgentNode", "FlowNode", "ParallelFlowNode"]) {
    it(`accepts ${kind}`, () => {
      expect(collectPublishingSteps(flowWith({ component_type: kind, ...declared }))).toEqual({ ok: true, steps: ["step"] });
    });
  }

  for (const kind of [
    "StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "BranchingNode", "Flow",
    "TriggerWaitNode", "LlmNode", "ToolNode", "MapNode", "SomeFutureNode",
  ]) {
    it(`refuses ${kind}`, () => {
      const res = collectPublishingSteps(flowWith({ component_type: kind, ...declared }));
      expect(res).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MISPLACED: node "step" .*can be the publishing action$/) });
      expect((res as { error: string }).error).not.toMatch(new RegExp(`\\b${kind}\\b`));
    });
  }

  it("refuses a node with no kind, and a kind that is not a string", () => {
    for (const node of [declared, { component_type: 7, ...declared }]) {
      expect(collectPublishingSteps(flowWith(node))).toEqual({
        ok: false,
        error: expect.stringMatching(/^PUBLISHES_MISPLACED: node "step" .*can be the publishing action$/),
      });
    }
  });

  it("a kind outside the list may still say publishes: false", () => {
    const node = { component_type: "TriggerWaitNode", metadata: { cinatra: { publishes: false } } };
    expect(collectPublishingSteps(flowWith(node))).toEqual({ ok: true, steps: [] });
  });
});

describe("cinatra#4150 — every branch of the reader", () => {
  const api = (id: string, publishes?: unknown): Node => ({
    component_type: "ApiNode",
    id,
    ...(publishes === undefined ? {} : { metadata: { cinatra: { publishes } } }),
  });

  it("the flow root: a malformed value and true refuse, false passes", () => {
    const root = (publishes: unknown) => ({ metadata: { cinatra: { publishes } }, nodes: [], $referenced_components: {} });
    expect(collectPublishingSteps(root("yes"))).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MALFORMED: the flow root .* as a string;/) });
    expect(collectPublishingSteps(root(true))).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MISPLACED: the flow root/) });
    expect(collectPublishingSteps(root(false))).toEqual({ ok: true, steps: [] });
  });

  it("the reserved prefix refuses on a listed node and on start_node, with no component behind either", () => {
    const listed = { nodes: [{ $component_ref: "cinatra_publish_gate__a" }] };
    const start = { nodes: [], start_node: { $component_ref: "cinatra_publish_gate__b" } };
    expect(collectPublishingSteps(listed)).toEqual({ ok: false, error: expect.stringMatching(/^RESERVED_NODE_ID: .*cinatra_publish_gate__a/) });
    expect(collectPublishingSteps(start)).toEqual({ ok: false, error: expect.stringMatching(/^RESERVED_NODE_ID: .*cinatra_publish_gate__b/) });
  });

  it("the reserved prefix refuses on a component key and on a component id", () => {
    const byKey = { $referenced_components: { cinatra_publish_gate__c: api("clean") } };
    const byId = { $referenced_components: { clean: api("cinatra_publish_gate__d") } };
    expect(collectPublishingSteps(byKey)).toEqual({ ok: false, error: expect.stringMatching(/^RESERVED_NODE_ID: .*cinatra_publish_gate__c/) });
    expect(collectPublishingSteps(byId)).toEqual({ ok: false, error: expect.stringMatching(/^RESERVED_NODE_ID: .*cinatra_publish_gate__d/) });
  });

  it("an entry that is not an object is skipped: null, a string, an array", () => {
    const doc = { nodes: [], $referenced_components: { a: null, b: "text", c: [] } };
    expect(collectPublishingSteps(doc as Record<string, unknown>)).toEqual({ ok: true, steps: [] });
  });

  // The limit is INJECT_MAX_DEPTH = 16: the outermost component is depth 0, so
  // `levels` wrappers put the innermost node at depth `levels`.
  const nest = (deepest: Node, levels: number): Record<string, unknown> => {
    let inner: Node = deepest;
    for (let i = 0; i < levels; i++) inner = { component_type: "FlowNode", id: `level${i}`, subflow: inner };
    return { $referenced_components: { top: inner } };
  };

  it("a flow with no declaration compiles at any depth: the depth check runs only for a declaration", () => {
    for (const levels of [16, 17, 40, 2000]) {
      expect(collectPublishingSteps(nest(api("deepest"), levels))).toEqual({ ok: true, steps: [] });
    }
  });

  it("at the limit the node is still read; one level below it a publishes key refuses, false included", () => {
    expect(collectPublishingSteps(nest(api("deepest", false), 16))).toEqual({ ok: true, steps: [] });
    expect(collectPublishingSteps(nest(api("deepest", "yes"), 16))).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MALFORMED: node "deepest" /) });
    for (const value of [false, true, "yes"]) {
      expect(collectPublishingSteps(nest(api("deepest", value), 17))).toEqual({
        ok: false,
        error: "OAS_NESTING_TOO_DEEP: metadata.cinatra.publishes is declared below 16 levels of subflow nesting",
      });
    }
    expect(collectPublishingSteps(nest(api("deepest", true), 2000))).toEqual({ ok: false, error: expect.stringMatching(/^OAS_NESTING_TOO_DEEP: /) });
  });

  it("below the limit a reserved id still refuses as a reserved id, by component key or by id", () => {
    expect(collectPublishingSteps(nest(api("cinatra_publish_gate__deep"), 30))).toEqual({ ok: false, error: expect.stringMatching(/^RESERVED_NODE_ID: node "cinatra_publish_gate__deep" /) });
    const byKey = nest({ component_type: "Flow", id: "sub", $referenced_components: { cinatra_publish_gate__k: api("clean") } }, 20);
    expect(collectPublishingSteps(byKey)).toEqual({ ok: false, error: expect.stringMatching(/^RESERVED_NODE_ID: node "cinatra_publish_gate__k" /) });
  });

  it("an inline subflow is read: its flag refuses as nested, whatever its form", () => {
    const top = (node: Node) => ({ nodes: [{ $component_ref: "top" }], $referenced_components: { top: { component_type: "FlowNode", id: "top", ...node } } });
    for (const doc of [top({ subflow: api("inner", true) }), top({ subflows: [api("inner", true)] })]) {
      expect(collectPublishingSteps(doc)).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MISPLACED: node "inner" /) });
    }
    expect(collectPublishingSteps(top({ subflows: [api("inner", "yes")] }))).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MALFORMED: node "inner" /) });
  });

  it("a subflow by reference is not read as inline; its definition is read through the refs", () => {
    const doc = {
      nodes: [{ $component_ref: "top" }],
      $referenced_components: {
        top: { component_type: "FlowNode", id: "top", subflow: { $component_ref: "sub" }, subflows: [{ $component_ref: "sub" }, "text"] },
        sub: { component_type: "Flow", id: "sub", nodes: [], $referenced_components: { inner: api("inner", false) } },
      },
    };
    expect(collectPublishingSteps(doc)).toEqual({ ok: true, steps: [] });
  });

  it("a component in the refs but not in nodes cannot declare, even of an action kind", () => {
    const doc = { nodes: [], $referenced_components: { loose: api("loose", true) } };
    expect(collectPublishingSteps(doc)).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MISPLACED: node "loose" .*not a top-level node/) });
  });

  it("the list follows nodes, not the map's order", () => {
    const doc = {
      nodes: [{ $component_ref: "first" }, { $component_ref: "second" }],
      $referenced_components: { second: api("second", true), first: api("first", true) },
    };
    expect(collectPublishingSteps(doc)).toEqual({ ok: true, steps: ["first", "second"] });
  });
});

describe("cinatra#4150 — the error texts name the field and the node id, never the pack's value or kind", () => {
  const SECRET = "sk-live-0123456789-not-a-real-key";
  const one = (node: Node) => ({ nodes: [{ $component_ref: "step" }], $referenced_components: { step: { id: "step", ...node } } });

  it("a malformed string value is reported by its type only, on a node and on the root", () => {
    const onNode = collectPublishingSteps(one({ component_type: "ApiNode", metadata: { cinatra: { publishes: SECRET } } }));
    const onRoot = collectPublishingSteps({ metadata: { cinatra: { publishes: SECRET } }, nodes: [] });
    for (const res of [onNode, onRoot]) {
      expect(res.ok).toBe(false);
      const error = (res as { error: string }).error;
      expect(error).toMatch(/^PUBLISHES_MALFORMED: .*metadata\.cinatra\.publishes as a string;/);
      expect(error).not.toContain(SECRET);
    }
  });

  it("a kind outside the list is not echoed", () => {
    const res = collectPublishingSteps(one({ component_type: SECRET, metadata: { cinatra: { publishes: true } } }));
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MISPLACED: node "step" /) });
    expect((res as { error: string }).error).not.toContain(SECRET);
  });

  it("a node id is JSON-escaped and cut at 120 characters", () => {
    const odd = 'a"b\nc';
    const res = collectPublishingSteps({ nodes: [], $referenced_components: { [odd]: { component_type: "ApiNode", metadata: { cinatra: { publishes: true } } } } });
    expect((res as { error: string }).error).toContain(`node ${JSON.stringify(odd)} `);
    expect((res as { error: string }).error).not.toContain("\n");
    const long = `x${"y".repeat(300)}`;
    const resLong = collectPublishingSteps({ nodes: [], $referenced_components: { [long]: { component_type: "ApiNode", metadata: { cinatra: { publishes: true } } } } });
    expect((resLong as { error: string }).error).toContain(`node "${long.slice(0, 120)}..." `);
    expect((resLong as { error: string }).error).not.toContain(long);
  });

  it("a line or paragraph separator in a node id is escaped", () => {
    for (const sep of ["\u2028", "\u2029"]) {
      const odd = `a${sep}b`;
      const res = collectPublishingSteps({ nodes: [], $referenced_components: { [odd]: { component_type: "ApiNode", metadata: { cinatra: { publishes: true } } } } });
      const error = (res as { error: string }).error;
      expect(error).toMatch(/^PUBLISHES_MISPLACED: node "a\\u202[89]b" /);
      expect(error).not.toContain(sep);
    }
  });

  it("an inline subflow with no id is named as such", () => {
    const doc = { nodes: [{ $component_ref: "top" }], $referenced_components: { top: { component_type: "FlowNode", id: "top", subflow: { component_type: "Flow", metadata: { cinatra: { publishes: "x" } } } } } };
    expect(collectPublishingSteps(doc)).toEqual({ ok: false, error: expect.stringMatching(/^PUBLISHES_MALFORMED: an inline subflow declares /) });
  });
});
