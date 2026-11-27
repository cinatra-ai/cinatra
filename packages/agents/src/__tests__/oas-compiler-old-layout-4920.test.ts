/**
 * cinatra#4920 (read paths): the compiler finds an agent's source by package
 * name at `<root>/<vendor>/<slug>/cinatra/oas.json` and nowhere else. A source
 * directory in the old layout (an `agent.json`, no `cinatra/oas.json`) is not
 * compiled and is not passed over in silence: the compile answers with one error
 * that names the directory and says to move it, and the child-renderer lookup
 * (a parent flow reading its child agent's own OAS) logs the same sentence.
 *
 * Fixtures sit under `<cwd>/extensions`, the dev source root.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compiler-old-layout-4920.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileOasAgentJson, __resetRegistryCacheForTests, type CompiledAgentOasStep } from "../oas-compiler";

const MOVE = "move it to cinatra/oas.json";
// A flat directory is not a read place: its message names the SCOPED place.
const MOVE_FLAT = "move the directory to ";
const CHILD_RENDERER = "@example-org/child-agent:output";

let tmpRoot: string;
let originalCwd: string;

function put(parts: string[], content: unknown): void {
  const abs = path.join(tmpRoot, "extensions", ...parts);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(content), "utf8");
}

/** A one-gate flow: the child agent's own OAS, whose gate names its renderer. */
function childFlow(): Record<string, unknown> {
  const gate = {
    component_type: "InputMessageNode",
    id: "review_gate",
    name: "review_gate",
    metadata: { cinatra: { requiresApproval: true, renderer: CHILD_RENDERER, riskClass: "high" } },
    outputs: [{ title: "review_gate_out", type: "string" }],
  };
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "child-flow",
    name: "Child",
    metadata: { cinatra: { type: "leaf" } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "review_gate" },
    nodes: [{ $component_ref: "review_gate" }],
    control_flow_connections: [],
    $referenced_components: { review_gate: gate },
  };
}

/** A parent flow with one FlowNode step that runs `childPackage`. */
function parentFlow(childPackage: string): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "parent-flow",
    name: "Parent",
    metadata: { cinatra: { type: "orchestrator" } },
    inputs: [{ title: "brief", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [{ $component_ref: "startNode" }, { $component_ref: "child_step" }, { $component_ref: "endNode" }],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "startNode" }, to_node: { $component_ref: "child_step" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "child_step" }, to_node: { $component_ref: "endNode" } },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Setup",
        inputs: [{ title: "brief", type: "string" }],
        metadata: { cinatra: { required: ["brief"] } },
      },
      child_step: {
        component_type: "FlowNode",
        id: "child_step",
        name: "Child step",
        subflow: { $component_ref: "child_subflow" },
        metadata: { cinatra: { packageName: childPackage } },
      },
      child_subflow: childFlow(),
      endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] },
    },
  };
}

async function compileSteps(parentSlug: string, childPackage: string): Promise<CompiledAgentOasStep[]> {
  const p = path.join(tmpRoot, "parent-oas.json");
  writeFileSync(p, JSON.stringify(parentFlow(childPackage)), "utf8");
  const res = await compileOasAgentJson({
    packageName: `@example-org/${parentSlug}`,
    oasSourcePath: p,
    registryPath: path.join(tmpRoot, "components.json"),
  });
  expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return res.value.approvalPolicy.steps;
}

beforeEach(() => {
  __resetRegistryCacheForTests();
  // The realpath: the compiler's dev source root is `<cwd>/extensions`, and
  // the cwd reads back as the real path.
  tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "oas-old-layout-4920-")));
  // An empty shared registry, so the compiler has nothing to warn about.
  writeFileSync(path.join(tmpRoot, "components.json"), JSON.stringify({ components: {} }), "utf8");
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("compileOasAgentJson by package name: cinatra/oas.json is the one source (cinatra#4920)", () => {
  const SLUG = "example-agent";
  const PACKAGE = `@example-org/${SLUG}`;
  const SCOPED = () => path.join(tmpRoot, "extensions", "cinatra-ai", SLUG);
  const OLD_LAYOUTS: Array<{ label: string; file: string[]; dir: string[]; move: () => string }> = [
    { label: "vendor dir, cinatra/agent.json", file: ["cinatra-ai", SLUG, "cinatra", "agent.json"], dir: ["cinatra-ai", SLUG], move: () => MOVE },
    { label: "vendor dir, root agent.json", file: ["cinatra-ai", SLUG, "agent.json"], dir: ["cinatra-ai", SLUG], move: () => MOVE },
    { label: "flat dir, cinatra/agent.json", file: [SLUG, "cinatra", "agent.json"], dir: [SLUG], move: () => MOVE_FLAT + SCOPED() },
    { label: "flat dir, root agent.json", file: [SLUG, "agent.json"], dir: [SLUG], move: () => MOVE_FLAT + SCOPED() },
  ];

  it("compiles the agent it finds at <vendor>/<slug>/cinatra/oas.json", async () => {
    put(["cinatra-ai", SLUG, "cinatra", "oas.json"], parentFlow("@example-org/child-agent"));
    const res = await compileOasAgentJson({ packageName: PACKAGE, registryPath: path.join(tmpRoot, "components.json") });
    expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  });

  it.each(OLD_LAYOUTS)("does not compile an agent.json-only tree ($label); the error names the directory and the move", async ({ file, dir, move }) => {
    put(file, parentFlow("@example-org/child-agent"));
    const res = await compileOasAgentJson({ packageName: PACKAGE, registryPath: path.join(tmpRoot, "components.json") });
    expect(res.ok).toBe(false);
    const error = (res as { error: string }).error;
    expect(error).toContain(`${path.join(tmpRoot, "extensions", ...dir)} is an agent in the old layout`);
    expect(error).toContain(move());
    expect(error).not.toContain("(tried");
  });

  it("names EVERY old-layout directory when two share the slug", async () => {
    put(["cinatra-ai", SLUG, "cinatra", "agent.json"], parentFlow("@example-org/child-agent"));
    put([SLUG, "agent.json"], parentFlow("@example-org/child-agent"));
    const res = await compileOasAgentJson({ packageName: PACKAGE, registryPath: path.join(tmpRoot, "components.json") });
    expect(res.ok).toBe(false);
    const error = (res as { error: string }).error;
    for (const dir of [path.join("cinatra-ai", SLUG), SLUG]) {
      expect(error).toContain(`${path.join(tmpRoot, "extensions", dir)} is an agent in the old layout`);
    }
    expect(error.split(MOVE)).toHaveLength(2);
    expect(error.split(MOVE_FLAT + path.join(tmpRoot, "extensions", "cinatra-ai", SLUG))).toHaveLength(2);
  });

  it("a slug with no source at all keeps the plain not-found error, which lists oas.json only", async () => {
    const res = await compileOasAgentJson({ packageName: PACKAGE, registryPath: path.join(tmpRoot, "components.json") });
    expect(res.ok).toBe(false);
    const error = (res as { error: string }).error;
    expect(error).toContain(`OAS source not found for ${PACKAGE}`);
    expect(error).toContain(path.join("cinatra-ai", SLUG, "cinatra", "oas.json"));
    expect(error).not.toContain("agent.json");
  });

  it("a directory holding both files compiles from oas.json", async () => {
    put(["cinatra-ai", SLUG, "cinatra", "oas.json"], parentFlow("@example-org/child-agent"));
    put(["cinatra-ai", SLUG, "cinatra", "agent.json"], { not: "a flow" });
    const res = await compileOasAgentJson({ packageName: PACKAGE, registryPath: path.join(tmpRoot, "components.json") });
    expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  });
});

describe("a parent flow reads its child's renderer from the child's oas.json only (cinatra#4920)", () => {
  it("logs EVERY old-layout directory of a child that has no oas.json anywhere", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    put(["cinatra-ai", "child-agent", "cinatra", "agent.json"], childFlow());
    put(["child-agent", "agent.json"], childFlow());

    await compileSteps("parent-agent", "@example-org/child-agent");

    for (const dir of [path.join("cinatra-ai", "child-agent"), "child-agent"]) {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`${path.join(tmpRoot, "extensions", dir)} is an agent in the old layout`),
      );
    }
  });

  it("derives the child's renderer from <vendor>/<slug>/cinatra/oas.json, with nothing logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    put(["cinatra-ai", "child-agent", "cinatra", "oas.json"], childFlow());

    const steps = await compileSteps("parent-agent", "@example-org/child-agent");

    expect(steps.find((s) => s.name === "Child step")?.xRenderer).toBe(CHILD_RENDERER);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not read the child from an agent.json; the compile goes on and the directory is named in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    put(["cinatra-ai", "child-agent", "cinatra", "agent.json"], childFlow());

    const steps = await compileSteps("parent-agent", "@example-org/child-agent");

    // No renderer came from the old file ...
    expect(steps.find((s) => s.name === "Child step")?.xRenderer).toBeUndefined();
    // ... and the gap is named, not silent.
    const dir = path.join(tmpRoot, "extensions", "cinatra-ai", "child-agent");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${dir} is an agent in the old layout`));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(MOVE));
  });
});
