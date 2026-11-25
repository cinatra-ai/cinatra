/**
 * A DEVELOPMENT CHILD'S TOOL LOADS FROM THE SOURCE ITS ORIGIN PROVED (cinatra#3033).
 *
 * On a development installation the origin resolver proves an embedded child
 * step against the child's source tree, read by name and version, and checks
 * the child's install lifecycle in the canonical store. The load must then read
 * that proven tree only: a different root on the name-and-version road, a
 * lifecycle that changed (an archive, here or in another organisation, or a
 * replaced row), or a missing or malformed binding is refused, and nothing is
 * imported.
 *
 * The real origin resolver and the real loader run on the real root road (the
 * generated record's source directory). The packages are real files in a
 * temporary directory; the canonical store and the generated record are the
 * stand-ins, with the run's install derivation (a store read) answering none.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-development-child-load.test.ts
 */
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "org-fixture";
const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
const PARENT_VERSION = "2.0.0";
const CHILD_VERSION = "0.2.2";
const TOOL = "child_tool";
const STEP = "child__embed_step";
const MODULE = "./cinatra/tools/child-tool.mjs";

/** The generated static manifest, in the fields the development road reads. */
const generated: Record<string, { version: string; sourceDir: string }> = {};
/** The canonical install rows per package, in the fields the readers take. */
type Row = { id: string; status: string; organizationId: string | null; kind: string; isDefault: boolean; version: string };
const rows: Record<string, Row[]> = {};

vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: generated }));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: async (name: string) => rows[name] ?? [],
}));
// A development installation: no store record and no install anchor for either package.
vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: async () => [],
  realStoreFs: { readFile: async (p: string) => (await import("node:fs/promises")).readFile(p, "utf8") },
}));
vi.mock("@/lib/extension-data-root", () => ({ resolveExtensionDataRoot: () => "/unused-by-this-test" }));
vi.mock("@/lib/extension-install-anchor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-install-anchor")>()),
  makeDefaultInstallAnchorsResolver: async () => async () => [],
}));

/** The child's tool module: a constant that answers the real path it was loaded from. */
const TOOL_MODULE_SOURCE = `import { fileURLToPath } from "node:url";
export function extensionTool() {
  return { from: fileURLToPath(import.meta.url) };
}
`;

const childStep = () => ({
  component_type: "ApiNode",
  url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
  data: { tool: "extension_tool", input: { name: TOOL, input: {} }, agent_run_id: "{{ agent_run_id }}" },
});

let base = "";
let previousMode: string | undefined;

async function writePackage(dir: string, manifest: Record<string, unknown>, flow: Record<string, unknown>) {
  await mkdir(path.join(dir, "cinatra", "tools"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "cinatra", "oas.json"), JSON.stringify(flow));
}

/** A child source tree at the pinned version, with its embeddable tool's module. */
async function writeChild(dir: string) {
  await writePackage(
    dir,
    { name: CHILD, version: CHILD_VERSION, cinatra: { tools: [{ name: TOOL, module: MODULE, embeddable: true }] } },
    {
      component_type: "Flow",
      id: "child-root",
      nodes: [{ $component_ref: "embed_step" }],
      $referenced_components: { embed_step: { ...childStep(), id: "embed_step" } },
    },
  );
  await writeFile(path.join(dir, MODULE), TOOL_MODULE_SOURCE);
}

const sourceDirOf = (dir: string) => path.relative(process.cwd(), dir);

beforeEach(async () => {
  previousMode = process.env.CINATRA_RUNTIME_MODE;
  process.env.CINATRA_RUNTIME_MODE = "development";
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cinatra-3033-dev-child-")));
  const parentDir = path.join(base, "parent");
  await writePackage(
    parentDir,
    {
      name: PARENT,
      version: PARENT_VERSION,
      cinatra: {
        dependencies: [{ packageName: CHILD, kind: "agent", edgeType: "runtime", requirement: "required",
          versionConstraint: { kind: "semver-range", range: "^0.2.2" } }],
        tools: [{ name: "p", module: "./cinatra/tools/p.mjs" }],
      },
    },
    {
      component_type: "Flow",
      id: "parent-root",
      nodes: [{ $component_ref: "child_flow" }],
      $referenced_components: {
        child_flow: { component_type: "FlowNode", id: "child_flow", subflow: { $component_ref: "child-subflow" },
          metadata: { cinatra: { packageName: CHILD } } },
        "child-subflow": { component_type: "Flow", id: "child-subflow", nodes: [{ $component_ref: STEP }],
          $referenced_components: { [STEP]: { ...childStep(), id: STEP } } },
      },
    },
  );
  await writeChild(path.join(base, "child-a"));
  for (const k of Object.keys(generated)) delete generated[k];
  for (const k of Object.keys(rows)) delete rows[k];
  generated[PARENT] = { version: PARENT_VERSION, sourceDir: sourceDirOf(parentDir) };
  generated[CHILD] = { version: CHILD_VERSION, sourceDir: sourceDirOf(path.join(base, "child-a")) };
});

afterEach(async () => {
  if (previousMode === undefined) delete process.env.CINATRA_RUNTIME_MODE;
  else process.env.CINATRA_RUNTIME_MODE = previousMode;
  await rm(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function proveOrigin() {
  const { resolveExtensionToolOrigin } = await import("@/lib/extension-tool-origin");
  return resolveExtensionToolOrigin(
    {
      run: { id: "run-1", orgId: ORG, templateId: "tmpl-1", packageVersion: PARENT_VERSION,
        dependentInstallId: null, verifiedStepId: STEP },
      context: { packageName: PARENT, packageVersion: PARENT_VERSION, cinatra: {} },
      request: { name: TOOL, input: {} },
    },
    { deriveDependentInstallId: async () => ({ kind: "none" as const }) },
  );
}

/** The load exactly as the scoped dispatch hands a development child's origin to it. */
async function loadFor(origin: Record<string, unknown> & { context: { packageName: string; packageVersion: string } },
  importModule?: (p: string) => Promise<unknown>) {
  const { loadDeclaredToolModule } = await import("@/lib/extension-tool-module-loader");
  return loadDeclaredToolModule(
    {
      packageName: origin.context.packageName,
      packageVersion: origin.context.packageVersion,
      orgId: ORG,
      toolName: TOOL,
      modulePath: MODULE,
      developmentSource: origin.source as never,
    },
    importModule ? { importModule } : {},
  );
}

async function provenDevelopmentChild() {
  const origin = await proveOrigin();
  expect(origin.kind).toBe("development-child");
  return origin as typeof origin & { kind: "development-child" };
}

/** The load refuses, and nothing was imported. */
async function refusesUnloaded(origin: Parameters<typeof loadFor>[0], text: string) {
  const importModule = vi.fn(async () => ({}));
  await expect(loadFor(origin, importModule)).rejects.toThrow(text);
  expect(importModule).not.toHaveBeenCalled();
}

const liveRow = (over: Partial<Row> = {}): Row => ({
  id: "install-child", status: "active", organizationId: null, kind: "agent", isDefault: true,
  version: CHILD_VERSION, ...over,
});

describe("a development child's tool loads from the proven source only", () => {
  it("loads the proven root's module", async () => {
    const origin = await provenDevelopmentChild();
    const ns = (await loadFor(origin)) as { extensionTool: () => { from: string } };
    expect(ns.extensionTool().from).toBe(path.join(base, "child-a", MODULE));
  });

  it("never loads from a second root the name-and-version road answers after the proof", async () => {
    const origin = await provenDevelopmentChild();
    // A second tree of the same name and version, beside the proven one, now named by the road.
    await writeChild(path.join(base, "child-b"));
    generated[CHILD] = { version: CHILD_VERSION, sourceDir: sourceDirOf(path.join(base, "child-b")) };
    await refusesUnloaded(origin, "changed before its module was loaded");
  });

  it("refuses a same-version reinstall to another folder between the proof and the load", async () => {
    const origin = await provenDevelopmentChild();
    await rename(path.join(base, "child-a"), path.join(base, "child-reinstalled"));
    generated[CHILD] = { version: CHILD_VERSION, sourceDir: sourceDirOf(path.join(base, "child-reinstalled")) };
    await refusesUnloaded(origin, "changed before its module was loaded");
  });

  it("refuses a child archived between the proof and the load, here or in another organisation", async () => {
    for (const archived of [liveRow({ status: "archived" }), liveRow({ status: "archived", organizationId: "org-other" })]) {
      delete rows[CHILD];
      const origin = await provenDevelopmentChild();
      rows[CHILD] = [archived];
      await refusesUnloaded(origin, "changed before its module was loaded");
    }
  });

  it("refuses when the live row the proof read is archived or replaced before the load", async () => {
    for (const next of [[liveRow({ status: "archived" })], [liveRow({ id: "install-child-2" })]]) {
      rows[CHILD] = [liveRow()];
      const origin = await provenDevelopmentChild();
      expect(origin.source.installRecord).toEqual({ rowId: "install-child", status: "active", version: CHILD_VERSION });
      rows[CHILD] = next;
      await refusesUnloaded(origin, "changed before its module was loaded");
    }
  });

  it("refuses a missing or malformed binding for a development child", async () => {
    const origin = await provenDevelopmentChild();
    const malformed: unknown[] = [
      undefined,
      null,
      { ...origin.source, realRoot: "relative/root" },
      { ...origin.source, packageVersion: "0.2.3" },
      { ...origin.source, origin: "child" },
      { ...origin.source, installRecord: undefined },
      { ...origin.source, stillBound: undefined },
    ];
    for (const source of malformed) {
      await refusesUnloaded({ ...origin, source }, "is not a usable binding");
    }
  });
});
