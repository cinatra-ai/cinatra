/**
 * THE EXACT INSTALLATIONS AN EMBEDDED CHILD STEP'S TOOL MAY RUN FROM (cinatra#4154).
 *
 * A later change lets a step of an embedded child flow reach a tool of the
 * child's own package. Its code then has to come from the EXACT installation
 * the parent's own dependency edge resolved to, read from the root that
 * installation's anchor names. This file pins the validator that states that
 * binding: the parent's install row, its one edge to the child, the child's
 * install row, the organisation rule, the materialization by install id and the
 * two package.json files. Every refusal is a fixed code and nothing else, so
 * no path, install id, digest or version leaves it; every read that throws,
 * the package.json read and a field read of what it returns included, is
 * `origin-unreadable` and is logged without its text. A row counts as
 * platform-wide only with an explicit `organizationId: null`; a row that
 * carries no organisation field is refused.
 *
 * Pure: every read is injected, so no database and no store is touched.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-install-binding.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

import {
  bindChildInstall,
  bindParentInstall,
  childEdgeStillResolvesTo,
  selectChildEdge,
  type BoundInstall,
  type InstallBindingDeps,
} from "@/lib/extension-tool-install-binding";

const ORG = "org-fixture";
const OTHER_ORG = "org-other";
const PARENT = "@fixture-scope/fixture-parent-agent";
const CHILD = "@fixture-scope/fixture-child-agent";
const PARENT_ID = "install-parent";
const CHILD_ID = "install-child";
const CHILD_DEFAULT_ID = "install-child-default";
const PARENT_VERSION = "2.0.0";
const CHILD_VERSION = "0.1.1";
const PARENT_ROOT = "/fixture-store/agent/fixture-parent-agent/digest-parent";
const CHILD_ROOT = "/fixture-store/agent/fixture-child-agent/digest-child";
const CHILD_DEFAULT_ROOT = "/fixture-store/agent/fixture-child-agent/digest-child-default";
/** Text a thrown read carries that must never reach an outcome or a log line. */
const SECRET_TEXT = "/fixture/secret/store/path install-secret-id digest-secret";

function installRow(fields: Record<string, unknown>): InstalledExtension {
  return {
    status: "active",
    kind: "agent",
    organizationId: ORG,
    isDefault: true,
    dependencies: [],
    ...fields,
  } as unknown as InstalledExtension;
}

function childEdge(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: CHILD,
    kind: "agent",
    edgeType: "runtime",
    requirement: "required",
    versionConstraint: { kind: "semver-range", range: "^0.1.0" },
    resolvedInstallId: CHILD_ID,
    resolutionReason: "scoped:org",
    ...fields,
  };
}

function parentRow(fields: Record<string, unknown> = {}): InstalledExtension {
  return installRow({
    id: PARENT_ID,
    packageName: PARENT,
    version: PARENT_VERSION,
    dependencyEdges: [childEdge()],
    ...fields,
  });
}

function childRow(fields: Record<string, unknown> = {}): InstalledExtension {
  return installRow({ id: CHILD_ID, packageName: CHILD, version: CHILD_VERSION, ...fields });
}

/** The row with its `organizationId` field deleted, not set to null. */
function withoutOrganisation(row: InstalledExtension): InstalledExtension {
  const copy: Record<string, unknown> = { ...row };
  delete copy.organizationId;
  return copy as unknown as InstalledExtension;
}

type Anchor = { version: string | null; digest: string | null };

type World = {
  rows: Record<string, InstalledExtension | null>;
  /** The anchor each install id has in the run's organisation. */
  anchors: Record<string, Anchor | null>;
  /** The root each install id's exact anchor names. */
  roots: Record<string, string | null>;
  /** The package.json lying at each root; a root that is absent here does not read. */
  manifests: Record<string, unknown>;
};

function makeWorld(edit: (w: World) => void = () => {}) {
  const w: World = {
    rows: { [PARENT_ID]: parentRow(), [CHILD_ID]: childRow() },
    anchors: {
      [PARENT_ID]: { version: PARENT_VERSION, digest: "digest-parent" },
      [CHILD_ID]: { version: CHILD_VERSION, digest: "digest-child" },
    },
    roots: { [PARENT_ID]: PARENT_ROOT, [CHILD_ID]: CHILD_ROOT },
    manifests: {
      [PARENT_ROOT]: { name: PARENT, version: PARENT_VERSION, cinatra: { tools: [] } },
      [CHILD_ROOT]: {
        name: CHILD,
        version: CHILD_VERSION,
        cinatra: { tools: [{ name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" }] },
      },
    },
  };
  edit(w);
  const readRow = vi.fn(async (id: string) => (id in w.rows ? w.rows[id] : null) ?? null);
  const readAnchor = vi.fn(
    async (input: { packageName: string; orgId: string | null; installId: string }) =>
      w.anchors[input.installId] ?? null,
  );
  const resolveRoot = vi.fn(
    async (input: {
      packageName: string;
      packageVersion: string;
      orgId: string | null;
      installId?: string;
      installDigest?: string | null;
    }) => (input.installId === undefined ? null : (w.roots[input.installId] ?? null)),
  );
  const readPackageJson = vi.fn(async (root: string) => {
    if (!(root in w.manifests)) throw new Error(`ENOENT ${root}/package.json`);
    return w.manifests[root];
  });
  const deps: InstallBindingDeps = {
    readInstalledExtensionById: readRow,
    readInstallAnchor: readAnchor,
    resolvePackageRoot: resolveRoot,
    readPackageJson,
  };
  return { w, deps, readRow, readAnchor, resolveRoot, readPackageJson };
}

function bindParent(
  deps: InstallBindingDeps,
  fields: Partial<{ installId: string; packageName: string; packageVersion: string; orgId: string }> = {},
) {
  return bindParentInstall(
    { installId: PARENT_ID, packageName: PARENT, packageVersion: PARENT_VERSION, orgId: ORG, ...fields },
    deps,
  );
}

async function boundParent(deps: InstallBindingDeps): Promise<BoundInstall> {
  const outcome = await bindParent(deps);
  if (!outcome.ok) throw new Error(`the fixture parent did not bind: ${outcome.code}`);
  return outcome.value;
}

async function bindChild(deps: InstallBindingDeps) {
  return bindChildInstall({ parent: await boundParent(deps), childPackageName: CHILD, orgId: ORG }, deps);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the parent's install row", () => {
  it("binds a live parent install of the run's package, version and organisation to the root its exact anchor names", async () => {
    const { deps, resolveRoot } = makeWorld();
    const outcome = await bindParent(deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.row.id).toBe(PARENT_ID);
    expect(outcome.value.root).toBe(PARENT_ROOT);
    expect(outcome.value.digest).toBe("digest-parent");
    expect(outcome.value.cinatra).toEqual({ tools: [] });
    // The root is resolved BY THAT INSTALL ID and its anchor digest, never by name and version alone.
    expect(resolveRoot).toHaveBeenCalledWith({
      packageName: PARENT,
      packageVersion: PARENT_VERSION,
      orgId: ORG,
      installId: PARENT_ID,
      installDigest: "digest-parent",
    });
  });

  it("binds a root the resolver hands over as a checked real path at exactly that path", async () => {
    const { deps, readPackageJson } = makeWorld();
    const outcome = await bindParent({
      ...deps,
      resolvePackageRoot: async (input) =>
        input.installId === PARENT_ID ? { realRoot: PARENT_ROOT } : null,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.root).toBe(PARENT_ROOT);
    expect(readPackageJson).toHaveBeenCalledWith(PARENT_ROOT);
  });

  it("binds a locked parent install", async () => {
    const { deps } = makeWorld((w) => {
      w.rows[PARENT_ID] = parentRow({ status: "locked" });
    });
    expect((await bindParent(deps)).ok).toBe(true);
  });

  it.each([
    ["the row is missing", (w: World) => void (w.rows[PARENT_ID] = null), "parent-install-missing"],
    ["the row is archived", (w: World) => void (w.rows[PARENT_ID] = parentRow({ status: "archived" })), "parent-install-not-live"],
    ["the row is of another package", (w: World) => void (w.rows[PARENT_ID] = parentRow({ packageName: CHILD })), "parent-install-mismatch"],
    ["the row is at another version", (w: World) => void (w.rows[PARENT_ID] = parentRow({ version: "2.0.1" })), "parent-install-mismatch"],
    ["the row is of another kind", (w: World) => void (w.rows[PARENT_ID] = parentRow({ kind: "connector" })), "parent-install-mismatch"],
    ["the row answers with another id", (w: World) => void (w.rows[PARENT_ID] = parentRow({ id: "install-elsewhere" })), "parent-install-mismatch"],
    ["the row is of another organisation", (w: World) => void (w.rows[PARENT_ID] = parentRow({ organizationId: OTHER_ORG })), "parent-install-mismatch"],
    // The run's organisation materializes the install, so only the missing field refuses: it is not platform-wide.
    ["the row carries no organisation field", (w: World) => void (w.rows[PARENT_ID] = withoutOrganisation(parentRow())), "parent-install-mismatch"],
    ["the row is platform-wide and not materialized for the run's organisation", (w: World) => {
      w.rows[PARENT_ID] = parentRow({ organizationId: null });
      w.anchors[PARENT_ID] = null;
    }, "parent-not-materialized"],
    ["no anchor names the install", (w: World) => void (w.anchors[PARENT_ID] = null), "parent-not-materialized"],
    ["the anchor carries another version", (w: World) => void (w.anchors[PARENT_ID] = { version: "1.9.9", digest: "digest-parent" }), "parent-not-materialized"],
    ["no root is materialized for the install", (w: World) => void (w.roots[PARENT_ID] = null), "parent-not-materialized"],
    ["the package.json does not read", (w: World) => void delete w.manifests[PARENT_ROOT], "origin-unreadable"],
    ["the package.json is not an object", (w: World) => void (w.manifests[PARENT_ROOT] = ["not", "an", "object"]), "parent-manifest-invalid"],
    ["the package.json carries another name", (w: World) => void (w.manifests[PARENT_ROOT] = { name: CHILD, version: PARENT_VERSION, cinatra: {} }), "parent-manifest-mismatch"],
    ["the package.json carries another version", (w: World) => void (w.manifests[PARENT_ROOT] = { name: PARENT, version: "2.0.1", cinatra: {} }), "parent-manifest-mismatch"],
    ["the package.json carries no cinatra block", (w: World) => void (w.manifests[PARENT_ROOT] = { name: PARENT, version: PARENT_VERSION }), "parent-manifest-invalid"],
    ["the package.json cinatra block is not an object", (w: World) => void (w.manifests[PARENT_ROOT] = { name: PARENT, version: PARENT_VERSION, cinatra: "tools" }), "parent-manifest-invalid"],
  ])("refuses when %s", async (_label, edit, code) => {
    const { deps } = makeWorld(edit);
    expect(await bindParent(deps)).toEqual({ ok: false, code });
  });

  it("binds a platform-wide parent row that the run's organisation materializes", async () => {
    const { deps, readAnchor } = makeWorld((w) => {
      w.rows[PARENT_ID] = parentRow({ organizationId: null });
    });
    expect((await bindParent(deps)).ok).toBe(true);
    // The anchor is read in the RUN'S organisation for that exact install id.
    expect(readAnchor).toHaveBeenCalledWith({ packageName: PARENT, orgId: ORG, installId: PARENT_ID });
  });

  it("reads no anchor and no root for a row of another organisation", async () => {
    const { deps, readAnchor, resolveRoot } = makeWorld((w) => {
      w.rows[PARENT_ID] = parentRow({ organizationId: OTHER_ORG });
    });
    await bindParent(deps);
    expect(readAnchor).not.toHaveBeenCalled();
    expect(resolveRoot).not.toHaveBeenCalled();
  });

  it("refuses a blank expected version as a mismatch", async () => {
    const { deps } = makeWorld();
    expect(await bindParent(deps, { packageVersion: "" })).toEqual({
      ok: false,
      code: "parent-install-mismatch",
    });
  });
});

describe("the parent's one dependency edge to the child", () => {
  const withEdges = (edges: unknown) => parentRow({ dependencyEdges: edges });

  it("selects the one agent edge for the child and its resolved install id", () => {
    const outcome = selectChildEdge(withEdges([childEdge()]), CHILD);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.resolvedInstallId).toBe(CHILD_ID);
    expect(outcome.value.edge.packageName).toBe(CHILD);
  });

  it.each([
    ["the edge list is absent", undefined, "edge-list-invalid"],
    ["the edge list is not a list", { [CHILD]: childEdge() }, "edge-list-invalid"],
    ["an edge is not an object", [childEdge(), "edge"], "edge-list-invalid"],
    ["no edge names the child", [childEdge({ packageName: PARENT })], "edge-missing"],
    ["the list is empty", [], "edge-missing"],
    ["two edges name the child", [childEdge(), childEdge({ resolvedInstallId: CHILD_DEFAULT_ID })], "edge-duplicate"],
    ["the edge is of another kind", [childEdge({ kind: "skill" })], "edge-wrong-kind"],
    ["the edge carries no kind", [childEdge({ kind: undefined })], "edge-wrong-kind"],
    ["the edge is unresolved", [childEdge({ resolvedInstallId: null })], "edge-unresolved"],
    ["the edge resolves to a blank id", [childEdge({ resolvedInstallId: " " })], "edge-unresolved"],
  ])("refuses when %s", (_label, edges, code) => {
    expect(selectChildEdge(withEdges(edges), CHILD)).toEqual({ ok: false, code });
  });
});

describe("the child's install row and its materialization", () => {
  it("binds the exact child install the edge resolved to, at the root its exact anchor names", async () => {
    const { deps, resolveRoot } = makeWorld();
    const outcome = await bindChild(deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.row.id).toBe(CHILD_ID);
    expect(outcome.value.root).toBe(CHILD_ROOT);
    expect(outcome.value.digest).toBe("digest-child");
    expect(outcome.value.edge.resolvedInstallId).toBe(CHILD_ID);
    expect(outcome.value.cinatra).toEqual({
      tools: [{ name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" }],
    });
    expect(resolveRoot).toHaveBeenCalledWith({
      packageName: CHILD,
      packageVersion: CHILD_VERSION,
      orgId: ORG,
      installId: CHILD_ID,
      installDigest: "digest-child",
    });
  });

  it("binds the edge's non-default child install, never the package's default install", async () => {
    const { deps, readAnchor, resolveRoot } = makeWorld((w) => {
      w.rows[CHILD_ID] = childRow({ isDefault: false });
      w.rows[CHILD_DEFAULT_ID] = childRow({ id: CHILD_DEFAULT_ID, version: "0.1.2", isDefault: true });
      w.anchors[CHILD_DEFAULT_ID] = { version: "0.1.2", digest: "digest-child-default" };
      w.roots[CHILD_DEFAULT_ID] = CHILD_DEFAULT_ROOT;
      w.manifests[CHILD_DEFAULT_ROOT] = { name: CHILD, version: "0.1.2", cinatra: {} };
    });
    const outcome = await bindChild(deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.row.version).toBe(CHILD_VERSION);
    expect(outcome.value.root).toBe(CHILD_ROOT);
    expect(readAnchor).not.toHaveBeenCalledWith(expect.objectContaining({ installId: CHILD_DEFAULT_ID }));
    expect(resolveRoot).not.toHaveBeenCalledWith(expect.objectContaining({ installId: CHILD_DEFAULT_ID }));
  });

  it("binds a locked child install", async () => {
    const { deps } = makeWorld((w) => {
      w.rows[CHILD_ID] = childRow({ status: "locked" });
    });
    expect((await bindChild(deps)).ok).toBe(true);
  });

  it("binds a child install that satisfies an exact constraint", async () => {
    const { deps } = makeWorld((w) => {
      w.rows[PARENT_ID] = parentRow({
        dependencyEdges: [childEdge({ versionConstraint: { kind: "exact", version: CHILD_VERSION } })],
      });
    });
    expect((await bindChild(deps)).ok).toBe(true);
  });

  it("binds a platform-wide child row that the run's organisation materializes", async () => {
    const { deps } = makeWorld((w) => {
      w.rows[CHILD_ID] = childRow({ organizationId: null });
    });
    expect((await bindChild(deps)).ok).toBe(true);
  });

  const edgeOf = (fields: Record<string, unknown>) => (w: World) =>
    void (w.rows[PARENT_ID] = parentRow({ dependencyEdges: [childEdge(fields)] }));

  it.each([
    ["the parent has no edge to the child", (w: World) => void (w.rows[PARENT_ID] = parentRow({ dependencyEdges: [] })), "edge-missing"],
    ["the edge's install row is gone", (w: World) => void (w.rows[CHILD_ID] = null), "edge-dangling"],
    ["the edge's install row is archived", (w: World) => void (w.rows[CHILD_ID] = childRow({ status: "archived" })), "edge-not-live"],
    ["the edge's install row is of another package", (w: World) => void (w.rows[CHILD_ID] = childRow({ packageName: PARENT })), "edge-target-mismatch"],
    ["the edge's install row is of another kind", (w: World) => void (w.rows[CHILD_ID] = childRow({ kind: "connector" })), "edge-target-mismatch"],
    ["the edge's install row answers with another id", (w: World) => void (w.rows[CHILD_ID] = childRow({ id: CHILD_DEFAULT_ID })), "edge-target-mismatch"],
    ["the edge's install row carries no version", (w: World) => void (w.rows[CHILD_ID] = childRow({ version: undefined })), "edge-target-unversioned"],
    ["the edge's install row carries a blank version", (w: World) => void (w.rows[CHILD_ID] = childRow({ version: " " })), "edge-target-unversioned"],
    ["the child version does not satisfy the edge's range", edgeOf({ versionConstraint: { kind: "semver-range", range: "^0.2.0" } }), "edge-constraint-unmet"],
    ["the child version is not the edge's exact version", edgeOf({ versionConstraint: { kind: "exact", version: "0.1.2" } }), "edge-constraint-unmet"],
    ["the edge's constraint is a git ref", edgeOf({ versionConstraint: { kind: "git-ref", ref: "main" } }), "edge-constraint-unmet"],
    ["the edge's constraint is malformed", edgeOf({ versionConstraint: { kind: "semver-range" } }), "edge-constraint-unmet"],
    ["the edge carries no constraint", edgeOf({ versionConstraint: undefined }), "edge-constraint-unmet"],
    ["the edge's install row is of another organisation", (w: World) => void (w.rows[CHILD_ID] = childRow({ organizationId: OTHER_ORG })), "edge-target-scope"],
    // The run's organisation materializes the install, so only the missing field refuses: it is not platform-wide.
    ["the edge's install row carries no organisation field", (w: World) => void (w.rows[CHILD_ID] = withoutOrganisation(childRow())), "edge-target-scope"],
    ["the child row is platform-wide and not materialized for the run's organisation", (w: World) => {
      w.rows[CHILD_ID] = childRow({ organizationId: null });
      w.anchors[CHILD_ID] = null;
    }, "child-not-materialized"],
    ["no anchor names the child install", (w: World) => void (w.anchors[CHILD_ID] = null), "child-not-materialized"],
    ["the child anchor carries another version", (w: World) => void (w.anchors[CHILD_ID] = { version: "0.1.2", digest: "digest-child" }), "child-not-materialized"],
    ["no root is materialized for the child install", (w: World) => void (w.roots[CHILD_ID] = null), "child-not-materialized"],
    ["the child package.json does not read", (w: World) => void delete w.manifests[CHILD_ROOT], "origin-unreadable"],
    ["the child package.json is not an object", (w: World) => void (w.manifests[CHILD_ROOT] = "package"), "child-manifest-invalid"],
    ["the child package.json carries another name", (w: World) => void (w.manifests[CHILD_ROOT] = { name: PARENT, version: CHILD_VERSION, cinatra: {} }), "child-manifest-mismatch"],
    ["the child package.json carries another version", (w: World) => void (w.manifests[CHILD_ROOT] = { name: CHILD, version: "0.1.2", cinatra: {} }), "child-manifest-mismatch"],
    ["the child package.json cinatra block is not an object", (w: World) => void (w.manifests[CHILD_ROOT] = { name: CHILD, version: CHILD_VERSION, cinatra: [] }), "child-manifest-invalid"],
  ])("refuses when %s", async (_label, edit, code) => {
    const { deps } = makeWorld(edit);
    expect(await bindChild(deps)).toEqual({ ok: false, code });
  });

  it("reads no anchor and no root for a child row of another organisation", async () => {
    const { deps, readAnchor, resolveRoot } = makeWorld((w) => {
      w.rows[CHILD_ID] = childRow({ organizationId: OTHER_ORG });
    });
    await bindChild(deps);
    expect(readAnchor).not.toHaveBeenCalledWith(expect.objectContaining({ installId: CHILD_ID }));
    expect(resolveRoot).not.toHaveBeenCalledWith(expect.objectContaining({ installId: CHILD_ID }));
  });
});

describe("a read that throws is origin-unreadable, and its text goes nowhere", () => {
  const secret = () => {
    throw new Error(SECRET_TEXT);
  };

  it.each([
    ["the parent row read", (d: ReturnType<typeof makeWorld>) => d.readRow.mockImplementation(async () => secret())],
    ["the parent anchor read", (d: ReturnType<typeof makeWorld>) => d.readAnchor.mockImplementation(async () => secret())],
    ["the parent root resolution", (d: ReturnType<typeof makeWorld>) => d.resolveRoot.mockImplementation(async () => secret())],
  ])("%s", async (_label, arm) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = makeWorld();
    arm(d);
    const outcome = await bindParent(d.deps);
    expect(outcome).toEqual({ ok: false, code: "origin-unreadable" });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|install-secret-id|digest-secret/);
  });

  it("the child row read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = makeWorld();
    const parent = await boundParent(d.deps);
    d.readRow.mockImplementation(async (id: string) => (id === CHILD_ID ? secret() : (d.w.rows[id] ?? null)));
    const outcome = await bindChildInstall({ parent, childPackageName: CHILD, orgId: ORG }, d.deps);
    expect(outcome).toEqual({ ok: false, code: "origin-unreadable" });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|install-secret-id|digest-secret/);
  });

  it("the child anchor read and the child root resolution", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const which of ["anchor", "root"] as const) {
      const d = makeWorld();
      const parent = await boundParent(d.deps);
      if (which === "anchor") d.readAnchor.mockImplementation(async () => secret());
      else d.resolveRoot.mockImplementation(async () => secret());
      expect(await bindChildInstall({ parent, childPackageName: CHILD, orgId: ORG }, d.deps)).toEqual({
        ok: false,
        code: "origin-unreadable",
      });
    }
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|install-secret-id|digest-secret/);
  });

  it("the parent package.json read, logged by its read name and class word only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = makeWorld();
    d.readPackageJson.mockImplementation(async () => secret());
    const outcome = await bindParent(d.deps);
    expect(outcome).toEqual({ ok: false, code: "origin-unreadable" });
    expect(log.mock.calls).toEqual([
      ["[extension_tool] an install binding read failed", { read: "package-json", errorClass: "Error" }],
    ]);
  });

  it("the child package.json read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = makeWorld();
    const parent = await boundParent(d.deps);
    d.readPackageJson.mockImplementation(async () => secret());
    expect(await bindChildInstall({ parent, childPackageName: CHILD, orgId: ORG }, d.deps)).toEqual({
      ok: false,
      code: "origin-unreadable",
    });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|install-secret-id|digest-secret/);
  });

  it("a field of the package.json that throws on read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = makeWorld((w) => {
      w.manifests[PARENT_ROOT] = {
        get name(): string {
          throw new Error(SECRET_TEXT);
        },
      };
    });
    expect(await bindParent(d.deps)).toEqual({ ok: false, code: "origin-unreadable" });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|install-secret-id|digest-secret/);
  });
});

describe("the edge re-check before an import (the window between resolution and load)", () => {
  const recheck = (deps: InstallBindingDeps, childInstallId = CHILD_ID) =>
    childEdgeStillResolvesTo({ parentInstallId: PARENT_ID, childPackageName: CHILD, childInstallId }, deps);

  it("answers true while the parent's edge still resolves to the bound child install", async () => {
    expect(await recheck(makeWorld().deps)).toBe(true);
  });

  it.each([
    ["the edge moved to another install", (w: World) =>
      void (w.rows[PARENT_ID] = parentRow({ dependencyEdges: [childEdge({ resolvedInstallId: CHILD_DEFAULT_ID })] }))],
    ["the edge is gone", (w: World) => void (w.rows[PARENT_ID] = parentRow({ dependencyEdges: [] }))],
    ["the edge became unresolved", (w: World) =>
      void (w.rows[PARENT_ID] = parentRow({ dependencyEdges: [childEdge({ resolvedInstallId: null })] }))],
    ["the parent row is gone", (w: World) => void (w.rows[PARENT_ID] = null)],
    ["the parent row is archived", (w: World) => void (w.rows[PARENT_ID] = parentRow({ status: "archived" }))],
  ])("answers false when %s", async (_label, edit) => {
    expect(await recheck(makeWorld(edit).deps)).toBe(false);
  });

  it("answers false when the parent row read throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = makeWorld();
    d.readRow.mockImplementation(async () => {
      throw new Error(SECRET_TEXT);
    });
    expect(await recheck(d.deps)).toBe(false);
  });
});
