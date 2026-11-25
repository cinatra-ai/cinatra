/**
 * AN EMBEDDED CHILD STEP ON A DEVELOPMENT INSTALLATION (cinatra#4154 follow-up).
 *
 * A development installation never materializes a source-tree package, so it
 * has no install row, edge or anchor for the parent or the child. A step of an
 * embedded child flow must still reach the child's own tool there, read by name
 * off the name-and-version root road at the version the child's source carries,
 * under every check the store road holds: the parent declares the child once as
 * an agent within a range the child's version meets, the step replays the
 * child's own node, the request names that node's fixed tool, and the child
 * marks the tool embeddable. Outside development nothing changes.
 *
 * Every read is injected but the real path of each root, which lies in a temporary directory. The
 * packages are fixtures.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-origin-development-child.test.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { CanonicalRowView } from "@/lib/extension-install-anchor";

import {
  ExtensionToolOriginRefusal,
  resolveExtensionToolOrigin,
  type ExtensionToolOriginDeps,
} from "../extension-tool-origin";

const ORG = "org-fixture";
const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
const PARENT_VERSION = "2.0.0";
const CHILD_VERSION = "0.2.2";
const SOURCE_BASE = realpathSync(mkdtempSync(path.join(tmpdir(), "cinatra-3033-origin-")));
const PARENT_SRC = path.join(SOURCE_BASE, "fixture-parent-agent");
const CHILD_SRC = path.join(SOURCE_BASE, "fixture-child-agent");
for (const dir of [PARENT_SRC, CHILD_SRC]) mkdirSync(dir);
afterAll(() => rmSync(SOURCE_BASE, { recursive: true, force: true }));
const TOOL = "child_tool";
const STEP = "child__embed_step";

type Doc = Record<string, unknown>;

const childNode = (): Doc => ({
  component_type: "ApiNode",
  url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
  data: { tool: "extension_tool", input: { name: TOOL, input: {} }, agent_run_id: "{{ agent_run_id }}" },
});

const childFlow = (): Doc => ({
  component_type: "Flow",
  id: "child-root",
  nodes: [{ $component_ref: "embed_step" }],
  $referenced_components: { embed_step: { ...childNode(), id: "embed_step" } },
});

const parentFlow = (): Doc => ({
  component_type: "Flow",
  id: "parent-root",
  nodes: [{ $component_ref: "own_step" }, { $component_ref: "child_flow" }],
  $referenced_components: {
    own_step: { component_type: "ApiNode", id: "own_step", data: { tool: "extension_tool", input: { name: "p" } } },
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
      $referenced_components: { [STEP]: { ...childNode(), id: STEP } },
    },
  },
});

const dependency = (range = "^0.2.2", kind = "agent") => ({
  packageName: CHILD, kind, edgeType: "runtime", requirement: "required",
  versionConstraint: { kind: "semver-range", range },
});

type World = {
  dev: boolean;
  versions: Record<string, string | null>;
  roots: Record<string, string | null>;
  manifests: Record<string, Doc>;
  flows: Record<string, unknown>;
  /** The canonical install rows per package; none in the normal development case. */
  records: Record<string, CanonicalRowView[] | Error>;
};

function makeWorld(edit: (w: World) => void = () => {}) {
  const w: World = {
    dev: true,
    versions: { [CHILD]: CHILD_VERSION },
    roots: { [`${PARENT}@${PARENT_VERSION}`]: PARENT_SRC, [`${CHILD}@${CHILD_VERSION}`]: CHILD_SRC },
    manifests: {
      [PARENT_SRC]: { name: PARENT, version: PARENT_VERSION,
        cinatra: { dependencies: [dependency()], tools: [{ name: TOOL, module: "./cinatra/tools/p.mjs" }] } },
      [CHILD_SRC]: { name: CHILD, version: CHILD_VERSION,
        cinatra: { tools: [{ name: TOOL, module: "./cinatra/tools/c.mjs", embeddable: true }] } },
    },
    flows: { [PARENT_SRC]: parentFlow(), [CHILD_SRC]: childFlow() },
    records: {},
  };
  edit(w);
  const deps = {
    // No canonical row: the run executes as no install.
    deriveDependentInstallId: vi.fn(async () => ({ kind: "none" as const })),
    isDevelopmentMode: vi.fn(() => w.dev),
    resolveDevelopmentRoot: vi.fn(
      async (i: { packageName: string; packageVersion: string; installId?: string }) =>
        i.installId === undefined ? (w.roots[`${i.packageName}@${i.packageVersion}`] ?? null) : null,
    ),
    readDevelopmentVersion: vi.fn(async (name: string) => w.versions[name] ?? null),
    readPackageJson: vi.fn(async (root: string) => {
      if (!(root in w.manifests)) throw new Error("ENOENT");
      return w.manifests[root];
    }),
    readFlowDocument: vi.fn(async (root: string) => {
      if (!(root in w.flows)) throw new Error("ENOENT");
      return w.flows[root];
    }),
    readInstalledExtensionById: vi.fn(async () => null),
    readInstallRecordRows: vi.fn(async (name: string) => {
      const rows = w.records[name] ?? [];
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  } satisfies ExtensionToolOriginDeps;
  return { w, deps };
}

function resolve(world: ReturnType<typeof makeWorld>, over: { step?: string; name?: string } = {}) {
  return resolveExtensionToolOrigin(
    {
      run: { id: "run-1", orgId: ORG, templateId: "tmpl-1", packageVersion: PARENT_VERSION,
        dependentInstallId: null, verifiedStepId: over.step ?? STEP },
      context: { packageName: PARENT, packageVersion: PARENT_VERSION, cinatra: {} },
      request: { name: over.name ?? TOOL, input: {} },
    },
    world.deps,
  );
}

async function refusedWith(p: Promise<unknown>, code: string) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(ExtensionToolOriginRefusal);
  expect((e as ExtensionToolOriginRefusal).code).toBe(code);
  for (const leak of [PARENT_SRC, CHILD_SRC, CHILD_VERSION]) expect((e as Error).message).not.toContain(leak);
}

describe("an embedded child step on a development installation", () => {
  it("resolves to the child's own tool, read from the child's source at its own version", async () => {
    const world = makeWorld();
    const origin = await resolve(world);
    expect(origin).toEqual({
      kind: "development-child",
      context: { packageName: CHILD, packageVersion: CHILD_VERSION,
        cinatra: { tools: [{ name: TOOL, module: "./cinatra/tools/c.mjs", embeddable: true }] } },
      source: { origin: "development-child", packageName: CHILD, packageVersion: CHILD_VERSION, realRoot: CHILD_SRC,
        installRecord: null, stillBound: expect.any(Function) },
    });
    expect(world.deps.readFlowDocument).toHaveBeenCalledWith(CHILD_SRC);
    // Neither side is read by an install id: there is none in development.
    for (const [arg] of world.deps.resolveDevelopmentRoot.mock.calls) expect(arg.installId).toBeUndefined();
  });

  it("keeps a parent step on the parent road and reads no child", async () => {
    const world = makeWorld();
    expect(await resolve(world, { step: "own_step", name: "p" })).toEqual({ kind: "parent" });
    expect(world.deps.readDevelopmentVersion).not.toHaveBeenCalled();
  });

  it("refuses outside development before any root is read", async () => {
    const world = makeWorld((w) => { w.dev = false; });
    await refusedWith(resolve(world), "parent-install-unresolved");
    expect(world.deps.resolveDevelopmentRoot).not.toHaveBeenCalled();
  });

  it("refuses a child the parent does not declare once as an agent", async () => {
    const cases: [Doc[], string][] = [
      [[], "not-a-dependency"],
      [[dependency(), dependency()], "dependency-duplicate"],
      [[dependency("^0.2.2", "artifact")], "dependency-wrong-kind"],
    ];
    for (const [dependencies, code] of cases) {
      const world = makeWorld((w) => {
        (w.manifests[PARENT_SRC].cinatra as Doc).dependencies = dependencies;
      });
      await refusedWith(resolve(world), code);
      expect(world.deps.resolveDevelopmentRoot).not.toHaveBeenCalledWith(expect.objectContaining({ packageName: CHILD }));
    }
  });

  it("refuses a child source whose version the parent's range does not admit", async () => {
    // A caret range below 1.0.0 holds the minor: ^0.2.2 admits 0.2.x from 0.2.2 on, and neither an
    // older patch nor the next minor. Each source is a real package at its own version; only the
    // parent's range turns it away, before the child's flow is read.
    for (const outside of ["0.2.1", "0.3.0"]) {
      const world = makeWorld((w) => {
        w.versions[CHILD] = outside;
        w.roots[`${CHILD}@${outside}`] = CHILD_SRC;
        w.manifests[CHILD_SRC].version = outside;
      });
      await refusedWith(resolve(world), "edge-constraint-unmet");
      expect(world.deps.readFlowDocument).not.toHaveBeenCalledWith(CHILD_SRC);
    }
  });

  it("refuses a child with no source version or no root at it", async () => {
    await refusedWith(resolve(makeWorld((w) => { w.versions[CHILD] = null; })), "child-not-materialized");
    await refusedWith(resolve(makeWorld((w) => { w.versions[CHILD] = " "; })), "child-not-materialized");
    await refusedWith(resolve(makeWorld((w) => { w.roots[`${CHILD}@${CHILD_VERSION}`] = null; })),
      "child-not-materialized");
  });

  it("refuses a manifest that is not the package at that version", async () => {
    await refusedWith(resolve(makeWorld((w) => { w.manifests[CHILD_SRC].version = "0.2.3"; })),
      "child-manifest-mismatch");
    await refusedWith(resolve(makeWorld((w) => { w.manifests[CHILD_SRC].name = PARENT; })),
      "child-manifest-mismatch");
    await refusedWith(resolve(makeWorld((w) => { delete w.manifests[CHILD_SRC].cinatra; })),
      "child-manifest-invalid");
    await refusedWith(resolve(makeWorld((w) => { w.manifests[PARENT_SRC].name = CHILD; })),
      "parent-manifest-mismatch");
  });

  it("holds the provenance, the bound name and the child's consent", async () => {
    await refusedWith(resolve(makeWorld((w) => {
      const step = (w.flows[CHILD_SRC] as { $referenced_components: Record<string, Doc> })
        .$referenced_components.embed_step;
      step.url = "{{CINATRA_BASE_URL}}/api/other";
    })), "provenance-mismatch");
    await refusedWith(resolve(makeWorld(), { name: "p" }), "name-not-bound");
    await refusedWith(resolve(makeWorld((w) => {
      w.manifests[CHILD_SRC].cinatra = { tools: [{ name: TOOL, module: "./cinatra/tools/c.mjs" }] };
    })), "not-embeddable");
    await refusedWith(resolve(makeWorld((w) => {
      w.manifests[CHILD_SRC].cinatra = { tools: [] };
    })), "child-tool-undeclared");
  });

  it("refuses a child the canonical store holds archived or otherwise not live, before its source is read", async () => {
    for (const status of ["archived", "uninstalled-tombstone"]) {
      const world = makeWorld((w) => {
        w.records[CHILD] = [row({ status })];
      });
      await refusedWith(resolve(world), "edge-not-live");
      expect(world.deps.resolveDevelopmentRoot).not.toHaveBeenCalledWith(expect.objectContaining({ packageName: CHILD }));
      expect(world.deps.readFlowDocument).not.toHaveBeenCalledWith(CHILD_SRC);
    }
  });

  it("admits a child with no install record, and a child whose record is live", async () => {
    for (const records of [[], [row({ status: "active" })], [row({ status: "locked", organizationId: ORG })]]) {
      const world = makeWorld((w) => {
        w.records[CHILD] = records;
      });
      expect((await resolve(world)).kind).toBe("development-child");
      expect(world.deps.readInstallRecordRows).toHaveBeenCalledWith(CHILD);
    }
  });

  it("refuses when the child's install record cannot be read, or is not an agent's", async () => {
    await refusedWith(resolve(makeWorld((w) => { w.records[CHILD] = new Error("store down"); })), "origin-unreadable");
    await refusedWith(resolve(makeWorld((w) => { w.records[CHILD] = [row({ kind: "artifact" })]; })),
      "edge-target-mismatch");
  });
});

function row(over: Partial<CanonicalRowView> = {}): CanonicalRowView {
  return { id: "install-child", status: "active", organizationId: null, kind: "agent", isDefault: true,
    version: CHILD_VERSION, ...over };
}
