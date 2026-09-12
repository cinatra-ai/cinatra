/**
 * THE PASSTHROUGH RUNS THE CALLING PACK'S OWN MODULE (cinatra#3249, epic #3023).
 *
 * One generic tool, `extension_tool`, dispatches to a module the CALLING pack
 * declares in its own manifest. The caller and its pinned version come from the
 * already-bound run context (the seam above this one), the NAME is resolved
 * against that pack's own manifest — never a host table of pack names — and the
 * module is loaded from the pack's tree at the pinned lock and invoked with the
 * ports.
 *
 * The pack under test is a FIXTURE pack under this directory: a fixture scope,
 * never a real organisation's slug, so nothing here names a pack, a table, a
 * type or a state.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-dispatch.test.ts
 */
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXTENSION_TOOL_REVIEW_TARGETS_KEY,
  ExtensionToolRefusal,
  dispatchExtensionTool,
  type ExtensionToolPorts,
} from "@/lib/extension-tool-dispatch";
import { buildExtensionDataStatement } from "@/lib/extension-data-tool";
import {
  ExtensionToolModuleRefusal,
  loadDeclaredToolModule,
  resolveDeclaredToolModulePath,
} from "@/lib/extension-tool-module-loader";
import { parseDeclaredTables } from "@cinatra-ai/sdk-extensions/manifest";
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PACK_ROOT = path.join(HERE, "fixtures", "extension-tool-pack");

const PACK = "@fixture-scope/fixture-tool-pack";
const PINNED = "1.2.3";

/** The fixture pack's own `cinatra` manifest block, as the run context reads it. */
const CINATRA = {
  apiVersion: "cinatra.ai/v1",
  kind: "agent",
  tools: [
    { name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" },
    { name: "fixture_silent_tool", module: "./cinatra/tools/fixture-silent-tool.mjs" },
    { name: "fixture_uncallable_tool", module: "./cinatra/tools/fixture-uncallable-tool.mjs" },
  ],
};

/** The pinned-lock resolver the host uses in production, stubbed to the fixture
 *  pack's own tree — and asserted to be asked for exactly the bound identity. */
function rootResolver(root = FIXTURE_PACK_ROOT) {
  return vi.fn(async (input: { packageName: string; packageVersion: string }) => {
    expect(input).toEqual({ packageName: PACK, packageVersion: PINNED });
    return root;
  });
}

function stubPorts() {
  const data = {
    select: vi.fn(async () => ({ rows: [{ kind: "one" }] })),
    insertIfAbsent: vi.fn(async () => ({ inserted: true, row: { kind: "one" } })),
    updateWhere: vi.fn(async () => ({ updated: 1 })),
  };
  const artifacts = {
    list: vi.fn(async () => ({ artifacts: [], nextCursor: null })),
    contentRead: vi.fn(async () => ({ text: "fixture text" })),
  };
  const clock = { now: vi.fn(() => new Date("2026-09-12T00:00:00.000Z")) };
  return { data, artifacts, clock } satisfies Omit<ExtensionToolPorts, "review">;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extension_tool — a declared name resolves to the declared module", () => {
  it("loads the module from the pack's own tree at the PINNED version and invokes it with the ports", async () => {
    const ports = stubPorts();
    const resolvePackageRoot = rootResolver();
    const result = (await dispatchExtensionTool({
      packageName: PACK,
      packageVersion: PINNED,
      cinatra: CINATRA,
      request: {
        name: "fixture_tool",
        input: {
          kind: "one",
          rowId: "row-1",
          type: "fixture-scope:thing",
          artifactId: "artifact-1",
        },
      },
      ports,
      deps: { resolvePackageRoot },
    })) as Record<string, unknown>;

    expect(resolvePackageRoot).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    // EVERY PORT REACHED THE MODULE: the caller's own table operations, the two
    // dependency-scoped artifact reads, the review-gate filing and the clock.
    expect(ports.data.select).toHaveBeenNthCalledWith(1, {
      table: "fixture_rows",
      where: { kind: "one", run_id: { boundRun: true } },
    });
    expect(ports.data.select).toHaveBeenNthCalledWith(2, {
      table: "fixture_rows",
      where: {
        kind: "one",
        scope_kind: { boundScope: true },
        scope_id: { boundScope: true },
      },
    });
    expect(ports.data.insertIfAbsent).toHaveBeenCalledWith({
      table: "fixture_rows",
      row: { id: "row-1", kind: "one", step: "first" },
      conflictKeys: ["kind"],
    });
    expect(ports.data.updateWhere).toHaveBeenCalledWith({
      table: "fixture_rows",
      set: { step: "second" },
      where: { kind: "one", run_id: { boundRun: true } },
      expect: { step: "first" },
    });
    expect(ports.artifacts.list).toHaveBeenCalledWith({
      types: ["fixture-scope:thing"],
      limit: 10,
    });
    expect(ports.artifacts.contentRead).toHaveBeenCalledWith({ artifactId: "artifact-1" });
    expect(ports.clock.now).toHaveBeenCalled();
    expect(result.at).toBe("2026-09-12T00:00:00.000Z");
    // The review-gate filing is the port's own: the targets the module filed
    // ride out under the reserved key, validated by the host's target parser.
    expect(result[EXTENSION_TOOL_REVIEW_TARGETS_KEY]).toEqual([
      { artifactId: "artifact-1", representationRevisionId: "rev-1" },
    ]);
  });

  it("leaves a result alone when the tool files no review target", async () => {
    const result = (await dispatchExtensionTool({
      packageName: PACK,
      packageVersion: PINNED,
      cinatra: CINATRA,
      request: { name: "fixture_silent_tool", input: { a: 1 } },
      ports: stubPorts(),
      deps: { resolvePackageRoot: rootResolver() },
    })) as Record<string, unknown>;
    expect(result).toEqual({ ok: true, echoed: { a: 1 } });
    expect(EXTENSION_TOOL_REVIEW_TARGETS_KEY in result).toBe(false);
  });

  it("refuses a module that exports no callable under the name the contract pins", async () => {
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        cinatra: CINATRA,
        request: { name: "fixture_uncallable_tool", input: {} },
        ports: stubPorts(),
        deps: { resolvePackageRoot: rootResolver() },
      }),
    ).rejects.toThrow(/exports no callable `extensionTool`/);
  });
});

describe("extension_tool — the run- and scope-bound table a pack declares (cinatra#3249)", () => {
  /**
   * The fixture pack declares a table bound to the RUN and to the SCOPE that
   * run belongs to, and its module never names either: it writes a row without
   * them and asks for this run's rows, and for this scope's rows, with the two
   * markers the data contract defines. Here the ports COMPILE each request the
   * module makes, against the pack's OWN declared tables, so what the host
   * actually sends the database is read as text.
   */
  const SCOPE = { kind: "project", id: "project-fixture" } as const;

  const compilingPorts = async (runId: string, scope = SCOPE) => {
    const manifest = JSON.parse(
      await readFile(path.join(FIXTURE_PACK_ROOT, "package.json"), "utf8"),
    ) as { cinatra: { declaredTables?: unknown } };
    const tables = parseDeclaredTables(manifest.cinatra.declaredTables, PACK);
    const compiled: Record<string, { text: string; values: unknown[] }[]> = {};
    const compile = (operation: "select" | "insertIfAbsent" | "updateWhere") => async (
      request: Record<string, unknown>,
    ) => {
      const c = buildExtensionDataStatement({
        packageName: PACK,
        schemaName: "cinatra",
        tables,
        orgId: "org-fixture",
        runId,
        scope,
        request: { ...request, operation } as never,
      });
      (compiled[operation] ??= []).push({ text: c.text, values: c.values });
      return { rows: [] };
    };
    return {
      tables,
      compiled,
      ports: {
        data: {
          select: compile("select"),
          insertIfAbsent: compile("insertIfAbsent"),
          updateWhere: compile("updateWhere"),
        },
        artifacts: {
          list: async () => ({ artifacts: [], nextCursor: null }),
          contentRead: async () => ({ text: "fixture text" }),
        },
        clock: { now: () => new Date("2026-09-12T00:00:00.000Z") },
      } satisfies Omit<ExtensionToolPorts, "review">,
    };
  };

  it("declares the run column and the scope columns beside the organisation column", async () => {
    const { tables } = await compilingPorts("run-fixture");
    expect(
      tables.map((t) => [
        t.name,
        t.organizationColumn,
        t.runColumn,
        t.scopeKindColumn,
        t.scopeIdColumn,
      ]),
    ).toEqual([["fixture_rows", "org_id", "run_id", "scope_kind", "scope_id"]]);
  });

  it("writes the BOUND run and scope on the insert and substitutes them on the this-run and this-scope reads", async () => {
    const { compiled, ports } = await compilingPorts("run-fixture");
    await dispatchExtensionTool({
      packageName: PACK,
      packageVersion: PINNED,
      cinatra: CINATRA,
      request: {
        name: "fixture_tool",
        input: {
          kind: "one",
          rowId: "row-1",
          type: "fixture-scope:thing",
          artifactId: "artifact-1",
        },
      },
      ports,
      deps: { resolvePackageRoot: rootResolver() },
    });

    // The insert: the module named none of the organisation, the run and the
    // scope, and the host wrote all three.
    expect(compiled.insertIfAbsent?.[0]?.text).toContain(
      '("org_id", "run_id", "scope_kind", "scope_id", "id", "kind", "step") ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
    );
    expect(compiled.insertIfAbsent?.[0]?.values.slice(0, 4)).toEqual([
      "org-fixture",
      "run-fixture",
      "project",
      "project-fixture",
    ]);
    // This run's rows: the marker carried the run, never a value the module chose.
    // The scope floor stands first, with the organisation; the run marker
    // narrows to this run on top of it.
    expect(compiled.select?.[0]?.text).toContain(
      '"scope_kind" = $2 AND "scope_id" = $3 AND "kind" = $4 AND "run_id" = $5',
    );
    expect(compiled.select?.[0]?.values).toEqual([
      "org-fixture",
      "project",
      "project-fixture",
      "one",
      "run-fixture",
    ]);
    // This scope's rows: the second marker carried the kind and the id.
    expect(compiled.select?.[1]?.text).toContain(
      '"scope_kind" = $2 AND "scope_id" = $3 AND "kind" = $4',
    );
    expect(compiled.select?.[1]?.values).toEqual([
      "org-fixture",
      "project",
      "project-fixture",
      "one",
    ]);
    expect(compiled.updateWhere?.[0]?.text).toContain(
      '"scope_kind" = $3 AND "scope_id" = $4 AND "kind" = $5 AND "run_id" = $6',
    );
    expect(compiled.updateWhere?.[0]?.values).toEqual([
      "second",
      "org-fixture",
      "project",
      "project-fixture",
      "one",
      "run-fixture",
      "first",
    ]);
  });

  it("carries a WORKSPACE-anchored run's scope with the storage sentinel as its id", async () => {
    const { compiled, ports } = await compilingPorts("run-fixture", {
      kind: "workspace",
      id: WORKSPACE_SCOPE_SENTINEL,
    } as never);
    await dispatchExtensionTool({
      packageName: PACK,
      packageVersion: PINNED,
      cinatra: CINATRA,
      request: {
        name: "fixture_tool",
        input: {
          kind: "one",
          rowId: "row-1",
          type: "fixture-scope:thing",
          artifactId: "artifact-1",
        },
      },
      ports,
      deps: { resolvePackageRoot: rootResolver() },
    });
    expect(compiled.select?.[1]?.values).toEqual([
      "org-fixture",
      "workspace",
      WORKSPACE_SCOPE_SENTINEL,
      "one",
    ]);
  });
});

describe("extension_tool — a name the caller has not declared", () => {
  const REFUSAL =
    "extension_tool: `name` must be one of the calling extension's own declared tools";

  it("is refused in the shape the passthrough's own type refusal uses", async () => {
    const resolvePackageRoot = rootResolver();
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        cinatra: CINATRA,
        request: { name: "not_declared", input: {} },
        ports: stubPorts(),
        deps: { resolvePackageRoot },
      }),
    ).rejects.toThrow(new ExtensionToolRefusal(REFUSAL));
    // Refused BEFORE the pack's tree is touched at all.
    expect(resolvePackageRoot).not.toHaveBeenCalled();
  });

  it("is refused when the call names no tool at all", async () => {
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        cinatra: CINATRA,
        request: { input: {} },
        ports: stubPorts(),
        deps: { resolvePackageRoot: rootResolver() },
      }),
    ).rejects.toThrow(REFUSAL);
  });

  it("is refused for a package that declares no tools at all", async () => {
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent" },
        request: { name: "fixture_tool", input: {} },
        ports: stubPorts(),
        deps: { resolvePackageRoot: rootResolver() },
      }),
    ).rejects.toThrow(REFUSAL);
  });
});

describe("extension_tool — a module path outside the pack's tree", () => {
  it("is refused by the dispatch before the pack's tree is reached", async () => {
    const resolvePackageRoot = rootResolver();
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        cinatra: { tools: [{ name: "escape", module: "./../outside.mjs" }] },
        request: { name: "escape", input: {} },
        ports: stubPorts(),
        deps: { resolvePackageRoot },
      }),
    ).rejects.toThrow(/parent-directory segment/);
    expect(resolvePackageRoot).not.toHaveBeenCalled();
  });

  it("is refused by the path resolver itself, whatever the manifest said", () => {
    expect(resolveDeclaredToolModulePath(FIXTURE_PACK_ROOT, "./../outside.mjs")).toBeNull();
    expect(resolveDeclaredToolModulePath(FIXTURE_PACK_ROOT, "/etc/passwd.mjs")).toBeNull();
    expect(
      resolveDeclaredToolModulePath(FIXTURE_PACK_ROOT, "./cinatra/tools/fixture-tool.mjs"),
    ).toBe(path.join(FIXTURE_PACK_ROOT, "cinatra", "tools", "fixture-tool.mjs"));
  });

  it("is refused when a LINK inside the tree resolves outside it", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "cinatra-3249-"));
    const root = path.join(tmp, "pack");
    await mkdir(path.join(root, "tools"), { recursive: true });
    await writeFile(path.join(tmp, "outside.mjs"), "export function extensionTool() { return 1; }\n");
    await symlink(path.join(tmp, "outside.mjs"), path.join(root, "tools", "escape.mjs"));
    await expect(
      loadDeclaredToolModule(
        {
          packageName: PACK,
          packageVersion: PINNED,
          toolName: "escape",
          modulePath: "./tools/escape.mjs",
        },
        { resolvePackageRoot: async () => root },
      ),
    ).rejects.toThrow(ExtensionToolModuleRefusal);
  });

  it("refuses a pack that is not materialized at the pinned version", async () => {
    await expect(
      loadDeclaredToolModule(
        {
          packageName: PACK,
          packageVersion: PINNED,
          toolName: "fixture_tool",
          modulePath: "./cinatra/tools/fixture-tool.mjs",
        },
        { resolvePackageRoot: async () => null },
      ),
    ).rejects.toThrow(/not materialized at the pinned version/);
  });
});

describe("extension_tool — the run identity stays in the passthrough envelope", () => {
  it("hands the module EXACTLY the call's own `input`, and nothing of the run", async () => {
    let seen: unknown;
    const result = (await dispatchExtensionTool({
      packageName: PACK,
      packageVersion: PINNED,
      cinatra: CINATRA,
      request: { name: "fixture_silent_tool", input: { kind: "one" } },
      ports: stubPorts(),
      deps: {
        resolvePackageRoot: rootResolver(),
        importModule: async () => ({
          extensionTool: (invocation: { input: Record<string, unknown> }) => {
            seen = invocation.input;
            return { ok: true };
          },
        }),
      },
    })) as Record<string, unknown>;
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual({ kind: "one" });
    // Nothing of the run's identity is added by the host on the way in.
    expect(Object.keys(seen as Record<string, unknown>)).toEqual(["kind"]);
  });

  it("refuses a call that tries to carry the run's identity INTO the module's input", async () => {
    for (const key of ["agent_run_id", "cinatra_agent_run_id", "cinatra_run_id"]) {
      await expect(
        dispatchExtensionTool({
          packageName: PACK,
          packageVersion: PINNED,
          cinatra: CINATRA,
          request: { name: "fixture_silent_tool", input: { [key]: "run-1" } },
          ports: stubPorts(),
          deps: { resolvePackageRoot: rootResolver() },
        }),
      ).rejects.toThrow(/the run's identity stays in the passthrough envelope/);
    }
  });

  it("refuses an `input` that is not an object", async () => {
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        cinatra: CINATRA,
        request: { name: "fixture_silent_tool", input: "not an object" },
        ports: stubPorts(),
        deps: { resolvePackageRoot: rootResolver() },
      }),
    ).rejects.toThrow(/`input` must be an object/);
  });
});

describe("extension_tool — the review-gate filing is validated by the host", () => {
  it("refuses a target set the host's own review-target parser rejects", async () => {
    await expect(
      dispatchExtensionTool({
        packageName: PACK,
        packageVersion: PINNED,
        cinatra: CINATRA,
        request: { name: "fixture_silent_tool", input: {} },
        ports: stubPorts(),
        deps: {
          resolvePackageRoot: rootResolver(),
          importModule: async () => ({
            extensionTool: ({ ports }: { ports: ExtensionToolPorts }) => {
              ports.review.file([{ artifactId: "", representationRevisionId: "" }]);
              return { ok: true };
            },
          }),
        },
      }),
    ).rejects.toThrow(ExtensionToolRefusal);
  });
});
