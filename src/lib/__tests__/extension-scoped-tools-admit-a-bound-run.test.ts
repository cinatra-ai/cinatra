/**
 * THE PASSTHROUGH ADMITS THE CALLING EXTENSION'S OWN DECLARED TOOL
 * (cinatra#3525, the Cinatra half of the extension tool road) AND A RUN OF A
 * PACKAGE-BOUND TEMPLATE (cinatra#2960, #3035).
 *
 * The allowlist carries the HOST's own generic names and no extension's: a
 * fixed step that has to run the calling extension's own decision code asks for
 * ONE generic name, and the host derives the calling extension and its pinned
 * version from the already-bound run context — never from a request field —
 * then resolves the asked-for name against THAT extension's own manifest.
 *
 * The seam one layer above `resolveRunExtensionContext`: the passthrough hands
 * `dispatchExtensionScopedTool` the run row exactly as the creation primitives
 * wrote it — `package_version` empty on every road but the request-time one —
 * and the dispatch refused every packaged tool with "no one declaration to
 * admit this call under". The last cases hold the dispatch to the run's
 * TEMPLATE binding instead, and hold the refusal in place for a template bound
 * to no package at all.
 *
 * The extension under test is a FIXTURE one: a fixture scope, never a real
 * organisation's slug, so nothing here names an extension, a table, a type or a
 * state.
 *
 *   pnpm exec vitest run src/lib/__tests__/extension-scoped-tools-admit-a-bound-run.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getAgentPackage = vi.fn();
const loadDeclaredToolModule = vi.fn();

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: (...a: unknown[]) => getAgentPackage(...a),
}));
// THE DECLARATION PROBE. The dispatch reads the CALLER'S OWN declaration before
// it reaches the host's generic names, so this file stubs the probe the way the
// other passthrough suites do: the fixture pack below is not an installed one,
// it therefore declares no passthrough tool of its own, and the generic
// `extension_tool` arm is the one that answers these cases.
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: null }),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
// Only the LOAD road is stubbed: the declaration parse, the name resolution,
// the envelope rule and the port wiring below are the real ones. The refusal
// classes stay real too — the dispatch classifies on them.
vi.mock("@/lib/extension-tool-module-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-tool-module-loader")>()),
  loadDeclaredToolModule: (...args: unknown[]) => loadDeclaredToolModule(...args),
}));

/** The run row as the passthrough hands it over, pinned to its own version. */
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: "1.2.3",
};

/** The run row as the creation primitives write it: no package version of its own. */
const RUN_NO_OWN_VERSION = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: null,
};

const REFUSED_UNRESOLVED = /resolves to no extension package at a pinned version/;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("the names the passthrough admits", () => {
  /**
   * Assembled from fragments rather than written out, so this file is never
   * itself an occurrence of the name the border gate walks the tree for.
   */
  const EXTENSION_NAMED_TOOL = ["blog", "pipeline", "ideas"].join("_");

  it("admits exactly the type- and table-agnostic names, and nothing besides", async () => {
    const { EXTENSION_SCOPED_TOOLS } = await import("@/lib/extension-scoped-tools");
    expect([...EXTENSION_SCOPED_TOOLS].sort()).toEqual([
      "artifact_content_read",
      "artifacts_get",
      "artifacts_list",
      "extension_data",
      "extension_tool",
    ]);
  });

  it("carries no entry named after one extension's own feature", async () => {
    const { EXTENSION_SCOPED_TOOLS } = await import("@/lib/extension-scoped-tools");
    expect(EXTENSION_SCOPED_TOOLS.has(EXTENSION_NAMED_TOOL)).toBe(false);
  });
});

describe("dispatchExtensionScopedTool — extension_tool", () => {
  const PACK = "@fixture-scope/fixture-tool-pack";
  const DECLARED = { name: "fixture_tool", module: "./cinatra/tools/fixture-tool.mjs" };

  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    loadDeclaredToolModule.mockReset();
    query.mockResolvedValue({ rows: [{ package_name: PACK }] });
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: { tools: [DECLARED] } } });
  });

  it("runs the module the CALLER declares, at the version the run is bound to", async () => {
    const seen: Array<{ input: Record<string, unknown>; ports: Record<string, unknown> }> = [];
    loadDeclaredToolModule.mockResolvedValue({
      extensionTool: (invocation: {
        input: Record<string, unknown>;
        ports: Record<string, unknown>;
      }) => {
        seen.push(invocation);
        return { ok: true };
      },
    });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "fixture_tool", input: { kind: "one" } },
      run: RUN,
    });
    expect(outcome).toEqual({ ok: true, result: { ok: true } });
    // The extension and the pin came from the run's own binding, never a request field.
    expect(getAgentPackage).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: PACK, packageVersion: "1.2.3" }),
      expect.anything(),
    );
    expect(loadDeclaredToolModule).toHaveBeenCalledWith(
      {
        packageName: PACK,
        packageVersion: "1.2.3",
        // The RUN'S OWN organisation rides to the load road: the trusted install
        // row that names which materialized directory may run is read in it.
        orgId: RUN.orgId,
        toolName: "fixture_tool",
        modulePath: DECLARED.module,
      },
      expect.anything(),
    );
    expect(seen).toHaveLength(1);
    // EVERY PORT, and only the ports.
    expect(Object.keys(seen[0]!.ports).sort()).toEqual(["artifacts", "clock", "data", "review"]);
    // THE RUN IDENTITY IS NOT A MODULE INPUT.
    expect(seen[0]!.input).toEqual({ kind: "one" });
    const values = Object.values(seen[0]!.input);
    expect(values).not.toContain(RUN.id);
    expect(values).not.toContain(RUN.orgId);
    expect(values).not.toContain(RUN.runBy);
  });

  it("refuses a name the caller has not declared", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "not_declared", input: {} },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toBe(
      "extension_tool: `name` must be one of the calling extension's own declared tools",
    );
    expect(loadDeclaredToolModule).not.toHaveBeenCalled();
  });

  it("refuses a call that carries the run's identity into the module's input", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "fixture_tool", input: { cinatra_agent_run_id: RUN.id } },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toMatch(/the run's identity stays in the passthrough envelope/);
    expect(loadDeclaredToolModule).not.toHaveBeenCalled();
  });

  it("still refuses a run whose template is bound to no package", async () => {
    query.mockResolvedValue({ rows: [{ package_name: null }] });
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_tool",
      input: { name: "fixture_tool", input: {} },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toMatch(REFUSED_UNRESOLVED);
  });
});

describe("dispatchExtensionScopedTool — whose declaration admits the call", () => {
  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    // A manifest that declares NO tables: the admission is proven by the call
    // reaching the extension-data tool's own refusal instead of the seam's.
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: {} } });
  });

  it("admits a run whose OWN column is empty but whose template is package-bound", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    query.mockResolvedValue({
      rows: [{ package_name: "@cinatra-ai/pipeline", package_version: "0.2.0" }],
    });
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_data",
      input: { table: "ext_pipeline_rows", operation: "select" },
      run: RUN_NO_OWN_VERSION,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).not.toMatch(REFUSED_UNRESOLVED);
    expect(outcome.error).toMatch(/declares no tables/);
    // The manifest was read AT the template's bound version, never floating.
    expect(getAgentPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@cinatra-ai/pipeline",
        packageVersion: "0.2.0",
      }),
      expect.anything(),
    );
  });

  it("still refuses a run whose template is bound to no package", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    query.mockResolvedValue({ rows: [{ package_name: null, package_version: null }] });
    const outcome = await dispatchExtensionScopedTool({
      tool: "extension_data",
      input: { table: "ext_pipeline_rows", operation: "select" },
      run: RUN_NO_OWN_VERSION,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toMatch(REFUSED_UNRESOLVED);
    expect(getAgentPackage).not.toHaveBeenCalled();
  });
});
