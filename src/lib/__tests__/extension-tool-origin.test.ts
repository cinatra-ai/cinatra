/**
 * WHICH PACKAGE'S CODE AN `extension_tool` CALL RUNS (cinatra#4154, part C).
 *
 * A step of the run package's own flow runs the run package's own tool. A step
 * of an embedded child flow runs the child's tool only when the step is proven,
 * the exact parent installation's flow places it directly in a definition its
 * root flow embeds under a FlowNode labelled with a declared agent dependency,
 * the parent's edge resolves to a live, materialized child installation, the
 * step is that child's own installed node apart from its id, the request names
 * that node's fixed tool, and the child marks the tool embeddable. Everything
 * else is a 403 with a fixed sentence and a fixed code.
 *
 * Pure: every read is injected, so no database and no store is touched. The
 * packages are fixtures; nothing here names an extension.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-origin.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

import {
  ExtensionToolOriginRefusal,
  resolveExtensionToolOrigin,
  type ExtensionToolOriginDeps,
  type ExtensionToolOriginRun,
} from "@/lib/extension-tool-origin";

const ORG = "org-fixture";
const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
const PARENT_ID = "install-parent";
const CHILD_ID = "install-child";
const CHILD_DEFAULT_ID = "install-child-default";
const PARENT_VERSION = "2.0.0";
const CHILD_VERSION = "0.1.1";
const PARENT_ROOT = "/fixture-store/agent/fixture-parent-agent/digest-parent";
const CHILD_ROOT = "/fixture-store/agent/fixture-child-agent/digest-child";
const DEV_ROOT = "/fixture-source/fixture-parent-agent";
const TOOL = "child_tool";
const STEP = "child-embed_step";
/** Text a thrown read carries that must never reach a refusal or a log line. */
const SECRET_TEXT = "/fixture/secret/store/path install-secret-id digest-secret";
const FIXED_SENTENCE = /^extension_tool: the calling step reaches no tool of this origin \([a-z-]+\)$/;

type Doc = Record<string, unknown>;

/** The fixture object at `path` under `doc`; a step that is not an object fails the test at once. */
function at(doc: unknown, ...path: string[]): Doc {
  let cur: unknown = doc;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) throw new Error(`fixture: no object at ${path.join(".")}`);
    cur = (cur as Doc)[key];
  }
  if (typeof cur !== "object" || cur === null || Array.isArray(cur)) {
    throw new Error(`fixture: no object at ${path.join(".")}`);
  }
  return cur as Doc;
}

/** The node the child authored in its own flow, without its id. */
function childNodeBody(): Doc {
  return {
    component_type: "ApiNode",
    name: "Embedded step",
    url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
    http_method: "POST",
    data: {
      tool: "extension_tool",
      input: { name: TOOL, input: { ref: "{{ ref }}" } },
      agent_run_id: "{{ agent_run_id }}",
    },
    inputs: [{ title: "agent_run_id", type: "string", default: "" }],
    // An ApiNode's own package label is not an embedding label.
    metadata: { cinatra: { packageName: CHILD } },
  };
}

function childDoc(): Doc {
  return {
    component_type: "Flow",
    id: "child-root",
    nodes: [{ $component_ref: "embed_step" }],
    $referenced_components: { embed_step: { ...childNodeBody(), id: "embed_step" } },
  };
}

function parentDoc(): Doc {
  return {
    component_type: "Flow",
    id: "parent-root",
    nodes: [{ $component_ref: "own_step" }, { $component_ref: "child_flow" }],
    $referenced_components: {
      own_step: {
        component_type: "ApiNode",
        id: "own_step",
        data: { tool: "extension_tool", input: { name: "parent_tool" } },
      },
      child_flow: {
        component_type: "FlowNode",
        id: "child_flow",
        subflow: { $component_ref: "child-subflow" },
        metadata: { cinatra: { packageName: CHILD } },
      },
      "child-subflow": {
        component_type: "Flow",
        id: "child-subflow",
        nodes: [{ $component_ref: STEP }],
        $referenced_components: { [STEP]: { ...childNodeBody(), id: STEP } },
      },
    },
  };
}

const childDependency = { packageName: CHILD, kind: "agent", edgeType: "runtime", requirement: "required",
  versionConstraint: { kind: "semver-range", range: "^0.1.0" } };

function parentCinatra(): Doc {
  return { dependencies: [childDependency], tools: [{ name: "parent_tool", module: "./cinatra/tools/p.mjs" }] };
}

function installRow(fields: Record<string, unknown>): InstalledExtension {
  return { status: "active", kind: "agent", organizationId: ORG, isDefault: true, dependencies: [], ...fields } as
    unknown as InstalledExtension;
}

function childEdge(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...childDependency, resolvedInstallId: CHILD_ID, resolutionReason: "scoped:org", ...fields };
}

type World = {
  rows: Record<string, InstalledExtension | null>;
  anchors: Record<string, { version: string | null; digest: string | null } | null>;
  roots: Record<string, string | null>;
  manifests: Record<string, Doc>;
  flows: Record<string, unknown>;
  dev: boolean;
  devRoot: string | { realRoot: string } | null;
  derived: { kind: "none" } | { kind: "derived"; id: string } | { kind: "ambiguous"; message: string };
};

function makeWorld(edit: (w: World) => void = () => {}) {
  const w: World = {
    rows: {
      [PARENT_ID]: installRow({ id: PARENT_ID, packageName: PARENT, version: PARENT_VERSION,
        dependencyEdges: [childEdge()] }),
      [CHILD_ID]: installRow({ id: CHILD_ID, packageName: CHILD, version: CHILD_VERSION, isDefault: false }),
      [CHILD_DEFAULT_ID]: installRow({ id: CHILD_DEFAULT_ID, packageName: CHILD, version: "0.1.2" }),
    },
    anchors: {
      [PARENT_ID]: { version: PARENT_VERSION, digest: "digest-parent" },
      [CHILD_ID]: { version: CHILD_VERSION, digest: "digest-child" },
    },
    roots: { [PARENT_ID]: PARENT_ROOT, [CHILD_ID]: CHILD_ROOT },
    manifests: {
      [PARENT_ROOT]: { name: PARENT, version: PARENT_VERSION, cinatra: parentCinatra() },
      [CHILD_ROOT]: { name: CHILD, version: CHILD_VERSION,
        cinatra: { tools: [{ name: TOOL, module: "./cinatra/tools/c.mjs", embeddable: true }] } },
    },
    flows: { [PARENT_ROOT]: parentDoc(), [CHILD_ROOT]: childDoc(), [DEV_ROOT]: parentDoc() },
    dev: false,
    devRoot: DEV_ROOT,
    derived: { kind: "derived", id: PARENT_ID },
  };
  edit(w);
  const deps = {
    readInstalledExtensionById: vi.fn(async (id: string) => w.rows[id] ?? null),
    readInstallAnchor: vi.fn(async (i: { installId: string }) => w.anchors[i.installId] ?? null),
    resolvePackageRoot: vi.fn(async (i: { installId?: string }) =>
      i.installId === undefined ? null : (w.roots[i.installId] ?? null)),
    readPackageJson: vi.fn(async (root: string) => {
      if (!(root in w.manifests)) throw new Error(`ENOENT ${root}`);
      return w.manifests[root];
    }),
    readFlowDocument: vi.fn(async (root: string) => {
      if (!(root in w.flows)) throw new Error(`ENOENT ${SECRET_TEXT}`);
      return w.flows[root];
    }),
    deriveDependentInstallId: vi.fn(async () => w.derived),
    isDevelopmentMode: vi.fn(() => w.dev),
    resolveDevelopmentRoot: vi.fn(async () => w.devRoot),
  } satisfies ExtensionToolOriginDeps;
  return { w, deps };
}

function run(fields: Partial<ExtensionToolOriginRun> = {}): ExtensionToolOriginRun {
  return { id: "run-1", orgId: ORG, templateId: "tmpl-1", packageVersion: PARENT_VERSION, versionId: null,
    dependentInstallId: PARENT_ID, verifiedStepId: STEP, ...fields };
}

const context = (cinatra: Doc = parentCinatra()) => ({ packageName: PARENT, packageVersion: PARENT_VERSION, cinatra });

function resolve(world: ReturnType<typeof makeWorld>, over: { run?: Partial<ExtensionToolOriginRun>;
  cinatra?: Doc; name?: string } = {}) {
  return resolveExtensionToolOrigin(
    { run: run(over.run), context: context(over.cinatra), request: { name: over.name ?? TOOL, input: {} } },
    world.deps,
  );
}

async function refusedWith(p: Promise<unknown>, code: string) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(ExtensionToolOriginRefusal);
  expect((e as ExtensionToolOriginRefusal).code).toBe(code);
  expect((e as Error).message).toMatch(FIXED_SENTENCE);
  expect((e as Error).message).toContain(`(${code})`);
  for (const leak of [PARENT_ROOT, CHILD_ROOT, PARENT_ID, CHILD_ID, "digest-", SECRET_TEXT, CHILD_VERSION]) {
    expect((e as Error).message).not.toContain(leak);
  }
}

/** The parent world with the step's parent flow edited. */
const withParentFlow = (edit: (d: Doc) => void) =>
  makeWorld((w) => edit(at(w.flows[PARENT_ROOT])));
const refsOf = (d: Doc) => at(d, "$referenced_components");
const subflowOf = (d: Doc) => at(d, "$referenced_components", "child-subflow");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the run package's own road", () => {
  it("reads nothing when the run package declares no agent dependency, even without a proven step", async () => {
    const world = makeWorld();
    const origin = await resolve(world, { cinatra: { tools: [] }, run: { verifiedStepId: null } });
    expect(origin).toEqual({ kind: "parent" });
    expect(world.deps.readInstalledExtensionById).not.toHaveBeenCalled();
    expect(world.deps.readFlowDocument).not.toHaveBeenCalled();
  });

  it("refuses an unproven step once a child could be reachable", async () => {
    await refusedWith(resolve(makeWorld(), { run: { verifiedStepId: null } }), "step-unproven");
    await refusedWith(resolve(makeWorld(), { run: { verifiedStepId: "  " } }), "step-unproven");
  });

  it("keeps a step of the parent's own flow on the parent road, read from the exact parent root", async () => {
    const world = makeWorld();
    expect(await resolve(world, { run: { verifiedStepId: "own_step" }, name: "parent_tool" })).toEqual({
      kind: "parent",
    });
    expect(world.deps.readFlowDocument).toHaveBeenCalledWith(PARENT_ROOT);
  });

  it("keeps a step of an unlabelled internal subflow, and an inline subflow, on the parent road", async () => {
    const world = withParentFlow((d) => {
      delete at(d, "$referenced_components", "child_flow").metadata;
    });
    expect(await resolve(world)).toEqual({ kind: "parent" });
    const inline = withParentFlow((d) => {
      at(d, "$referenced_components", "child_flow").subflow = subflowOf(d);
      delete at(d, "$referenced_components")["child-subflow"];
      delete at(d, "$referenced_components", "child_flow").metadata;
    });
    expect(await resolve(inline)).toEqual({ kind: "parent" });
  });

  it("keeps a step under a FlowNode labelled with the parent's own package on the parent road", async () => {
    const world = withParentFlow((d) => {
      at(d, "$referenced_components", "child_flow", "metadata", "cinatra").packageName = PARENT;
    });
    expect(await resolve(world)).toEqual({ kind: "parent" });
  });

  it("runs a labelled inline child Flow that is a well-formed definition on the child road", async () => {
    const world = withParentFlow((d) => {
      at(d, "$referenced_components", "child_flow").subflow = subflowOf(d);
      delete at(d, "$referenced_components")["child-subflow"];
    });
    expect((await resolve(world)).kind).toBe("child");
  });

  it("does not index payload objects that carry an id but no component type", async () => {
    const world = withParentFlow((d) => {
      subflowOf(d).inputs = [{ id: "child-subflow" }, { id: STEP }];
    });
    expect((await resolve(world)).kind).toBe("child");
  });
});

describe("the embedded child's road", () => {
  it("runs the child's tool from the exact child installation the edge resolved to", async () => {
    const world = makeWorld();
    const origin = await resolve(world);
    expect(origin.kind).toBe("child");
    if (origin.kind !== "child") return;
    expect(origin.codeInstallId).toBe(CHILD_ID);
    expect(origin.context).toEqual({
      packageName: CHILD,
      packageVersion: CHILD_VERSION,
      cinatra: world.w.manifests[CHILD_ROOT]!.cinatra,
    });
    expect(origin.install.installId).toBe(CHILD_ID);
    expect(origin.install.digest).toBe("digest-child");
    // The non-default install the edge names, never the package's default one.
    expect(world.deps.readFlowDocument).toHaveBeenCalledWith(CHILD_ROOT);
    expect(world.deps.readInstalledExtensionById).not.toHaveBeenCalledWith(CHILD_DEFAULT_ID);
  });

  it("matches the node whatever the key order", async () => {
    const world = makeWorld((w) => {
      const refs = at(w.flows[CHILD_ROOT], "$referenced_components");
      const reversed = Object.fromEntries(Object.entries(at(refs, "embed_step")).reverse());
      refs.embed_step = reversed;
    });
    expect((await resolve(world)).kind).toBe("child");
  });

  it("re-checks the edge just before the import: true while it resolves, false once it moved", async () => {
    const world = makeWorld();
    const origin = await resolve(world);
    if (origin.kind !== "child") throw new Error("expected the child road");
    expect(await origin.install.stillBound!()).toBe(true);
    world.w.rows[PARENT_ID] = installRow({ id: PARENT_ID, packageName: PARENT, version: PARENT_VERSION,
      dependencyEdges: [childEdge({ resolvedInstallId: CHILD_DEFAULT_ID })] });
    expect(await origin.install.stillBound!()).toBe(false);
  });

  it("refuses a tool the child does not mark embeddable", async () => {
    for (const embeddable of [undefined, false]) {
      const world = makeWorld((w) => {
        const tool: Doc = { name: TOOL, module: "./cinatra/tools/c.mjs" };
        if (embeddable !== undefined) tool.embeddable = embeddable;
        w.manifests[CHILD_ROOT]!.cinatra = { tools: [tool] };
      });
      await refusedWith(resolve(world), "not-embeddable");
    }
  });

  it("refuses a child tool the child's declaration does not declare, with a fixed code", async () => {
    const undeclared = makeWorld((w) => {
      w.manifests[CHILD_ROOT]!.cinatra = { tools: [] };
    });
    await refusedWith(resolve(undeclared), "child-tool-undeclared");
  });

  it("refuses a child declaration that does not parse at the origin, and echoes none of its text", async () => {
    // The parser's own error would carry the raw module value; the refusal is the fixed sentence only.
    const RAW = "/private/store/child-tool.mjs";
    for (const tools of [
      [{ name: TOOL, module: RAW, embeddable: true }],
      [{ name: "Not An Ident /private/store/name", module: "./cinatra/tools/c.mjs", embeddable: true }],
      "not a list",
    ]) {
      const world = makeWorld((w) => {
        w.manifests[CHILD_ROOT]!.cinatra = { tools };
      });
      const e = await resolve(world).then(() => null, (err: unknown) => err);
      await refusedWith(Promise.reject(e), "child-declaration-invalid");
      expect((e as Error).message).not.toContain("/private/store");
      expect((e as Error).message).not.toContain("declared-tools");
    }
  });
});

describe("the parent installation", () => {
  it("derives the install when the run carries none", async () => {
    const world = makeWorld();
    expect((await resolve(world, { run: { dependentInstallId: null } })).kind).toBe("child");
    expect(world.deps.deriveDependentInstallId).toHaveBeenCalledTimes(1);
  });

  it("refuses an ambiguous derivation", async () => {
    const world = makeWorld((w) => {
      w.derived = { kind: "ambiguous", message: SECRET_TEXT };
    });
    await refusedWith(resolve(world, { run: { dependentInstallId: null } }), "parent-install-ambiguous");
  });

  it("refuses a run with no canonical row outside development", async () => {
    const world = makeWorld((w) => {
      w.derived = { kind: "none" };
    });
    await refusedWith(resolve(world, { run: { dependentInstallId: null } }), "parent-install-unresolved");
    expect(world.deps.resolveDevelopmentRoot).not.toHaveBeenCalled();
  });

  it("in development with no canonical row: a parent step proceeds, a child step is not materialized", async () => {
    const world = makeWorld((w) => {
      w.derived = { kind: "none" };
      w.dev = true;
    });
    expect(await resolve(world, { run: { dependentInstallId: null, verifiedStepId: "own_step" } })).toEqual({
      kind: "parent",
    });
    expect(world.deps.readFlowDocument).toHaveBeenCalledWith(DEV_ROOT);
    await refusedWith(resolve(world, { run: { dependentInstallId: null } }), "child-not-materialized");
    // A checked real root (the seed-copy road) is read at its real path.
    world.w.devRoot = { realRoot: DEV_ROOT };
    world.deps.readFlowDocument.mockClear();
    expect(await resolve(world, { run: { dependentInstallId: null, verifiedStepId: "own_step" } })).toEqual({
      kind: "parent",
    });
    expect(world.deps.readFlowDocument).toHaveBeenCalledWith(DEV_ROOT);
    world.w.devRoot = null;
    await refusedWith(resolve(world, { run: { dependentInstallId: null } }), "parent-not-materialized");
  });

  it("a canonical parent with no store record: the development road, else not materialized", async () => {
    const dev = makeWorld((w) => {
      w.anchors[PARENT_ID] = null;
      w.dev = true;
    });
    expect(await resolve(dev, { run: { verifiedStepId: "own_step" } })).toEqual({ kind: "parent" });
    const prod = makeWorld((w) => {
      w.anchors[PARENT_ID] = null;
    });
    await refusedWith(resolve(prod), "parent-not-materialized");
  });

  it("passes the binding's own codes through", async () => {
    await refusedWith(resolve(makeWorld((w) => { w.rows[PARENT_ID] = null; })), "parent-install-missing");
    await refusedWith(
      resolve(makeWorld((w) => { w.rows[PARENT_ID] = installRow({ id: PARENT_ID, packageName: PARENT,
        version: PARENT_VERSION, dependencyEdges: [] }); })),
      "edge-missing",
    );
    await refusedWith(resolve(makeWorld((w) => { w.anchors[CHILD_ID] = null; })), "child-not-materialized");
  });

  it("refuses a child install row with no version, or a blank one, and reads no child flow", async () => {
    for (const version of [undefined, "", "  "]) {
      const world = makeWorld((w) => {
        w.rows[CHILD_ID] = installRow({ id: CHILD_ID, packageName: CHILD, version, isDefault: false });
      });
      await refusedWith(resolve(world), "edge-target-unversioned");
      expect(world.deps.readFlowDocument).not.toHaveBeenCalledWith(CHILD_ROOT);
    }
  });

  it("answers a read that throws as origin-unreadable, and logs no text of it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const world = makeWorld((w) => {
      delete w.flows[PARENT_ROOT];
    });
    await refusedWith(resolve(world), "origin-unreadable");
    const derive = makeWorld();
    derive.deps.deriveDependentInstallId.mockRejectedValue(new Error(SECRET_TEXT));
    await refusedWith(resolve(derive, { run: { dependentInstallId: null } }), "origin-unreadable");
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET_TEXT);
  });
});

describe("the definition and reference graph", () => {
  it("refuses a flow document that is not a root Flow", async () => {
    await refusedWith(resolve(makeWorld((w) => { w.flows[PARENT_ROOT] = []; })), "parent-flow-invalid");
    await refusedWith(resolve(makeWorld((w) => { w.flows[PARENT_ROOT] = { component_type: "ApiNode", id: "x" }; })),
      "parent-flow-invalid");
  });

  it("refuses an unknown and a duplicate step", async () => {
    await refusedWith(resolve(makeWorld(), { run: { verifiedStepId: "no_such_step" } }), "step-unknown");
    await refusedWith(resolve(withParentFlow((d) => {
      refsOf(d).copy = { component_type: "ApiNode", id: STEP };
    })), "step-duplicate");
  });

  it("refuses a duplicate definition and a node that shares a definition's id", async () => {
    await refusedWith(resolve(withParentFlow((d) => {
      refsOf(d).dup = { component_type: "Flow", id: "child-subflow" };
    })), "graph-duplicate-definition");
    await refusedWith(resolve(withParentFlow((d) => {
      refsOf(d).clash = { component_type: "ApiNode", id: "child-subflow" };
    })), "graph-duplicate-definition");
  });

  it("refuses a FlowNode whose reference is missing, empty or names no definition", async () => {
    for (const subflow of [undefined, {}, { $component_ref: "" }, { $component_ref: "nowhere" }]) {
      await refusedWith(resolve(withParentFlow((d) => {
        at(d, "$referenced_components", "child_flow").subflow = subflow;
      })), "graph-bad-reference");
    }
  });

  it("refuses a labelled inline Flow without a string id instead of placing its step on the parent road", async () => {
    // Without an id the inline Flow is no definition: its step would inherit the root and run parent code.
    for (const id of [undefined, 7, null]) {
      const malformed = () => withParentFlow((d) => {
        const inline = { ...subflowOf(d) };
        if (id === undefined) delete inline.id;
        else inline.id = id;
        at(d, "$referenced_components", "child_flow").subflow = inline;
        delete at(d, "$referenced_components")["child-subflow"];
      });
      // A request for a parent-declared tool, and for the child's tool: both refuse.
      await refusedWith(resolve(malformed(), { name: "parent_tool" }), "graph-bad-reference");
      await refusedWith(resolve(malformed()), "graph-bad-reference");
    }
  });

  it("refuses a definition referenced by two FlowNodes", async () => {
    await refusedWith(resolve(withParentFlow((d) => {
      refsOf(d).second = { component_type: "FlowNode", id: "second",
        subflow: { $component_ref: "child-subflow" } };
    })), "graph-multiple-referencers");
  });

  it("refuses an unreferenced definition that encloses the step", async () => {
    await refusedWith(resolve(withParentFlow((d) => {
      delete refsOf(d).child_flow;
    })), "graph-unreferenced-definition");
  });

  it("refuses a back reference to an embedded definition, and a reference cycle", async () => {
    await refusedWith(resolve(withParentFlow((d) => {
      refsOf(subflowOf(d)).back = { component_type: "FlowNode", id: "back",
        subflow: { $component_ref: "loop" } };
      refsOf(d).loop = { component_type: "Flow", id: "loop", $referenced_components: {
        again: { component_type: "FlowNode", id: "again", subflow: { $component_ref: "child-subflow" } } } };
    })), "graph-multiple-referencers");
    await refusedWith(resolve(withParentFlow((d) => {
      refsOf(d).a = { component_type: "Flow", id: "a", $referenced_components: {
        toB: { component_type: "FlowNode", id: "toB", subflow: { $component_ref: "b" } } } };
      refsOf(d).b = { component_type: "Flow", id: "b", $referenced_components: {
        toA: { component_type: "FlowNode", id: "toA", subflow: { $component_ref: "a" } } } };
    })), "graph-cycle");
  });

  it("refuses an empty, blank or non-string label; case is exact", async () => {
    for (const label of ["", "  ", 7, null]) {
      await refusedWith(resolve(withParentFlow((d) => {
        at(d, "$referenced_components", "child_flow", "metadata", "cinatra").packageName = label;
      })), "graph-bad-label");
    }
    await refusedWith(resolve(withParentFlow((d) => {
      at(d, "$referenced_components", "child_flow", "metadata", "cinatra").packageName = CHILD.toUpperCase();
    })), "not-a-dependency");
  });

  it("refuses a nested embedding", async () => {
    // A labelled FlowNode inside the embedded definition, the step one level deeper.
    await refusedWith(resolve(withParentFlow((d) => {
      const sub = at(subflowOf(d), "$referenced_components");
      const step = sub[STEP];
      delete sub[STEP];
      sub.inner = { component_type: "FlowNode", id: "inner",
        subflow: { $component_ref: "inner-def" }, metadata: { cinatra: { packageName: CHILD } } };
      at(d, "$referenced_components")["inner-def"] = { component_type: "Flow", id: "inner-def",
        $referenced_components: { [STEP]: step } };
    })), "nested-embedding");
    // A label higher up with an unlabelled definition between.
    await refusedWith(resolve(withParentFlow((d) => {
      const sub = at(subflowOf(d), "$referenced_components");
      const step = sub[STEP];
      delete sub[STEP];
      sub.inner = { component_type: "FlowNode", id: "inner",
        subflow: { $component_ref: "inner-def" } };
      at(d, "$referenced_components")["inner-def"] = { component_type: "Flow", id: "inner-def",
        $referenced_components: { [STEP]: step } };
    })), "nested-embedding");
  });
});

describe("the dependency and the provenance", () => {
  it("reads the dependency from the exact parent root, not the run package's context", async () => {
    const world = makeWorld((w) => {
      w.manifests[PARENT_ROOT]!.cinatra = { dependencies: [{ packageName: "@fixture-scope/other", kind: "agent" }] };
    });
    await refusedWith(resolve(world), "not-a-dependency");
  });

  it("refuses a duplicate and a wrong-kind dependency", async () => {
    await refusedWith(resolve(makeWorld((w) => {
      w.manifests[PARENT_ROOT]!.cinatra = { dependencies: [childDependency, childDependency] };
    })), "dependency-duplicate");
    await refusedWith(resolve(makeWorld((w) => {
      w.manifests[PARENT_ROOT]!.cinatra = { dependencies: [{ ...childDependency, kind: "connector" }] };
    })), "dependency-wrong-kind");
  });

  it("refuses a step that is not the child's node apart from its id", async () => {
    await refusedWith(resolve(withParentFlow((d) => {
      at(subflowOf(d), "$referenced_components", STEP, "data", "input", "input").ref = "{{ other }}";
    })), "provenance-mismatch");
    // The same id as the child's node: no prefix.
    await refusedWith(resolve(withParentFlow((d) => {
      const sub = at(subflowOf(d), "$referenced_components");
      sub.embed_step = { ...at(sub, STEP), id: "embed_step" };
      delete sub[STEP];
    }), { run: { verifiedStepId: "embed_step" } }), "provenance-mismatch");
  });

  it("refuses a step two child nodes could have authored", async () => {
    await refusedWith(resolve(makeWorld((w) => {
      at(w.flows[CHILD_ROOT], "$referenced_components").step = { ...childNodeBody(), id: "step" };
    })), "provenance-ambiguous");
  });

  it("refuses a child node that sits in an embedding of the child's own flow", async () => {
    await refusedWith(resolve(makeWorld((w) => {
      const refs = at(w.flows[CHILD_ROOT], "$referenced_components");
      const node = refs.embed_step;
      delete refs.embed_step;
      refs.grand = { component_type: "FlowNode", id: "grand",
        subflow: { $component_ref: "grand-def" }, metadata: { cinatra: { packageName: "@fixture-scope/grand" } } };
      refs["grand-def"] = { component_type: "Flow", id: "grand-def",
        $referenced_components: { embed_step: node } };
    })), "provenance-nested");
  });

  it("refuses a node whose tool name is not fixed", async () => {
    for (const edit of [
      (n: Doc) => { at(n, "data", "input").name = "{{ tool }}"; },
      (n: Doc) => { at(n, "data", "input").name = ""; },
      (n: Doc) => { at(n, "data").tool = "extension_data"; },
    ]) {
      await refusedWith(resolve(makeWorld((w) => {
        edit(at(w.flows[CHILD_ROOT], "$referenced_components", "embed_step"));
        edit(at(w.flows[PARENT_ROOT], "$referenced_components", "child-subflow", "$referenced_components", STEP));
      })), "provenance-unnamed");
    }
  });

  it("refuses a request for any other tool than the node's fixed one", async () => {
    await refusedWith(resolve(makeWorld(), { name: "parent_tool" }), "name-not-bound");
    await refusedWith(resolve(makeWorld(), { name: "other_child_tool" }), "name-not-bound");
  });

  it("refuses an unreadable or malformed child flow with the child's own codes", async () => {
    await refusedWith(resolve(makeWorld((w) => { w.flows[CHILD_ROOT] = "not json"; })), "child-flow-invalid");
    await refusedWith(resolve(makeWorld((w) => {
      at(w.flows[CHILD_ROOT], "$referenced_components").dup = { component_type: "Flow", id: "child-root" };
    })), "child-graph-duplicate-definition");
  });
});
